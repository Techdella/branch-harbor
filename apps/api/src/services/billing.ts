import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type Stripe from 'stripe';
import {
  NETWORK_INCLUDED_LOCATIONS, PRICE_BOOK_VERSION, TRIAL_DAYS, TRIAL_REMINDER_DAYS, assertBillingCurrency, asBusinessModel, isPriceListKey, listPriceMinor,
  planQuote, priceListCurrency, priceListForCountry, priceListTier, splitLocationFee, taxIdCountry, type BillingInterval, type LocationFeePayer, type PlanPriceKey,
  type PlanQuote, type PriceListKey,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Db, Exec, Tx } from '../db/client.ts';
import {
  billingInvoices, billingTrialClaims, franchiseeBillingAccounts, locationFeePayers, locations, organizations, ownerGroups, roleAssignments, subscriptions, users,
} from '../db/schema/index.ts';
import { CardDeclinedError, invoiceFromStripe, subscriptionPeriodEnd, type CardDetails, type PlatformInvoice, type SubscriptionLine } from '../integrations/platform-billing.ts';
import { sha256 } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { stripeEventExtensions } from './payments.ts';

/**
 * BranchHarbor plan billing: the paid 14-day trial, checkout with a locked billing country, cancellation, billing
 * country changes, who pays each network location's fee, franchisee billing accounts, invoices, trial reminders and the
 * Stripe webhook for platform subscriptions. Prices come from the shared price book (@bh/shared pricing.ts).
 */

type Sub = typeof subscriptions.$inferSelect;
type Org = typeof organizations.$inferSelect;
const DAY = 86_400_000;

/** Plans a business can check out with, by business model. */
export function plansFor(model: string): PlanPriceKey[] {
  return asBusinessModel(model) === 'independent' ? ['solo'] : ['connector', 'hosted', 'network'];
}

/** Locations that count for billing: operating, opening soon or in onboarding, and not archived (oldest first). */
export async function billableLocations(db: Exec, orgId: string) {
  const rows = await db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt))).orderBy(asc(locations.createdAt));
  return rows.filter((l) => ['operating', 'opening_soon', 'onboarding'].includes(l.status));
}

export function subPriceList(sub: Pick<Sub, 'priceList' | 'currency' | 'billingCountry'>): PriceListKey {
  if (isPriceListKey(sub.priceList)) return sub.priceList;
  if (sub.billingCountry) return priceListForCountry(sub.billingCountry).key;
  return isPriceListKey(sub.currency) ? sub.currency : 'USD';
}

export function subPlan(sub: Pick<Sub, 'plan'>, model: string): PlanPriceKey {
  const p = sub.plan as PlanPriceKey;
  if (['solo', 'connector', 'hosted', 'network'].includes(p)) return p;
  return asBusinessModel(model) === 'independent' ? 'solo' : 'network';
}

export async function loadSub(db: Exec, orgId: string): Promise<Sub> {
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.organizationId, orgId));
  if (!sub) throw notFound('Subscription');
  return sub;
}

async function loadOrgRow(db: Exec, orgId: string): Promise<Org> {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!o) throw notFound('Organisation');
  return o;
}

/** Owners' emails (organisation-scope org_owner). */
export async function ownerEmails(db: Exec, orgId: string): Promise<{ email: string; name: string; locale: string }[]> {
  return db.select({ email: users.email, name: users.name, locale: users.locale }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.role, 'org_owner'), eq(roleAssignments.scopeKind, 'organization'), isNull(users.deletedAt)));
}

/* ------------------------------------------------------------------ */
/* Who pays each location's fee                                        */
/* ------------------------------------------------------------------ */

export interface LocationBillingRow {
  id: string; name: string; status: string; ownerGroupId: string | null; country: string;
  included: boolean; payer: LocationFeePayer; franchiseePercent: number; source: 'location' | 'owner_group' | 'default';
  feeMinor: number; hqMinor: number; franchiseeMinor: number;
}

/**
 * The location fee of each billable location and who pays it. Network: the first 3 billable locations (oldest
 * first) are included in the HQ platform fee and cost nothing more; every further location pays the Network
 * per-location fee, split by the payer setting (location → owner group → HQ). Other plans: HQ pays every location.
 */
export async function locationBilling(db: Exec, orgId: string, sub: Sub, model: string): Promise<LocationBillingRow[]> {
  const plan = subPlan(sub, model);
  const list = subPriceList(sub);
  const locs = await billableLocations(db, orgId);
  const payers = await db.select().from(locationFeePayers).where(eq(locationFeePayers.organizationId, orgId));
  const byLoc = new Map(payers.filter((p) => p.scopeKind === 'location').map((p) => [p.scopeId, p]));
  const byGroup = new Map(payers.filter((p) => p.scopeKind === 'owner_group').map((p) => [p.scopeId, p]));
  const months = sub.billingInterval === 'year' ? 10 : 1;
  return locs.map((l, i) => {
    const included = plan === 'network' && i < NETWORK_INCLUDED_LOCATIONS;
    const fee = plan === 'solo' ? (i === 0 ? listPriceMinor(list, 'solo') * months : 0) : included ? 0 : listPriceMinor(list, plan) * months;
    const rule = plan === 'network' ? byLoc.get(l.id) ?? (l.ownerGroupId ? byGroup.get(l.ownerGroupId) : undefined) : undefined;
    const payer = (rule?.payer ?? 'hq') as LocationFeePayer;
    const pct = rule?.franchiseePercent ?? 0;
    const split = splitLocationFee(fee, payer, payer === 'split' ? pct : 0);
    return {
      id: l.id, name: l.name, status: l.status, ownerGroupId: l.ownerGroupId, country: l.country, included, payer, franchiseePercent: payer === 'franchisee' ? 100 : payer === 'split' ? pct : 0,
      source: rule ? (rule.scopeKind === 'location' ? 'location' : 'owner_group') : 'default', feeMinor: fee, hqMinor: split.hqMinor, franchiseeMinor: split.franchiseeMinor,
    };
  });
}

/** HQ's own amount per interval: platform/plan lines minus what franchisees pay. */
export function hqTotal(quote: PlanQuote, rows: LocationBillingRow[]): number {
  return quote.totalMinor - rows.reduce((s, r) => s + r.franchiseeMinor, 0);
}

/* ------------------------------------------------------------------ */
/* Trial eligibility                                                   */
/* ------------------------------------------------------------------ */

/** Webmail domains are not a business identity: the full address is used instead. */
const WEBMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'yandex.com', 'mail.com', 'qq.com', '163.com']);
export function emailIdentity(email: string): string {
  const e = email.trim().toLowerCase();
  const domain = e.split('@')[1] ?? e;
  return WEBMAIL.has(domain) ? e : domain;
}

export interface TrialEligibility { eligible: boolean; reason: null | 'org_used' | 'card_used' | 'email_domain_used' }

/** One paid trial per business, per card (fingerprint) and per business email domain. */
export async function trialEligibility(db: Exec, orgId: string, input: { email: string | null; cardFingerprint?: string | null }): Promise<TrialEligibility> {
  const claims: { kind: string; valueHash: string }[] = [{ kind: 'org', valueHash: sha256(`org:${orgId}`) }];
  if (input.email) claims.push({ kind: 'email_domain', valueHash: sha256(`email:${emailIdentity(input.email)}`) });
  if (input.cardFingerprint) claims.push({ kind: 'card', valueHash: sha256(`card:${input.cardFingerprint}`) });
  const rows = await db.select().from(billingTrialClaims).where(inArray(billingTrialClaims.valueHash, claims.map((c) => c.valueHash)));
  const hit = (kind: string) => rows.some((r) => r.kind === kind && claims.some((c) => c.kind === kind && c.valueHash === r.valueHash));
  if (hit('org')) return { eligible: false, reason: 'org_used' };
  if (rows.some((r) => r.kind === 'card' && r.organizationId !== orgId) && hit('card')) return { eligible: false, reason: 'card_used' };
  if (rows.some((r) => r.kind === 'email_domain' && r.organizationId !== orgId) && hit('email_domain')) return { eligible: false, reason: 'email_domain_used' };
  return { eligible: true, reason: null };
}

async function recordTrialClaims(tx: Exec, orgId: string, input: { email: string | null; cardFingerprint: string | null }) {
  const values = [{ kind: 'org', valueHash: sha256(`org:${orgId}`), organizationId: orgId }];
  if (input.email) values.push({ kind: 'email_domain', valueHash: sha256(`email:${emailIdentity(input.email)}`), organizationId: orgId });
  if (input.cardFingerprint) values.push({ kind: 'card', valueHash: sha256(`card:${input.cardFingerprint}`), organizationId: orgId });
  await tx.insert(billingTrialClaims).values(values).onConflictDoNothing();
}

/* ------------------------------------------------------------------ */
/* Country lock                                                        */
/* ------------------------------------------------------------------ */

const regionName = (c: string) => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) ?? c;
  } catch {
    return c;
  }
};

/** Throws a clear 409 when the card (or tax ID) does not match the billing country. Returns the locked price list. */
export function lockBillingCountry(input: { billingCountry: string; currency: string; card: CardDetails | null; taxId?: string | null }) {
  const billing = input.billingCountry.toUpperCase();
  let taxCountry: string | null = null;
  if (input.taxId) {
    taxCountry = taxIdCountry(input.taxId, billing);
    if (!taxCountry) throw new AppError(400, 'invalid_tax_id', `This doesn't look like a ${regionName(billing)} business tax ID. Check the number, or leave it empty and use a card issued in ${regionName(billing)}.`, { taxId: 'Not a valid tax ID for the billing country' });
  }
  if (!input.card?.country) throw new AppError(400, 'card_country_unknown', 'We could not read the country of this card. Try another card.');
  const check = assertBillingCurrency({ billingCountry: billing, requestedCurrency: input.currency, cardCountry: input.card.country, taxIdCountry: taxCountry });
  if (!check.ok) {
    if (check.reason === 'currency_mismatch') throw conflict('currency_mismatch', `Your billing country ${regionName(billing)} is billed in ${check.expected}. Start the checkout again from your billing country.`, { expected: check.expected });
    throw new AppError(409, 'card_country_mismatch', `This card was issued in ${regionName(input.card.country)}, but your billing country is ${regionName(billing)}. Use a card issued in ${regionName(billing)}, or add your ${regionName(billing)} business tax ID.`, { card: 'Card country does not match the billing country' }, { billingCountry: billing, cardCountry: input.card.country });
  }
  return { priceList: check.priceList, evidence: check.evidence, taxIdCountry: taxCountry };
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function billingTerms(country: string | null) {
  return {
    trialDays: TRIAL_DAYS,
    reminderDays: [...TRIAL_REMINDER_DAYS],
    autoStarts: true,
    cancelAnytime: true,
    cancellationFee: false,
    freeDataExport: true,
    annualMonthsIncluded: 2,
    taxExclusive: country !== 'US',
    taxCollected: false as boolean,
  };
}

export function quoteFor(sub: Pick<Sub, 'priceList' | 'currency' | 'billingCountry'>, plan: PlanPriceKey, interval: BillingInterval, locationCount: number) {
  return planQuote({ priceList: subPriceList(sub), plan, interval, locations: locationCount });
}

export function serializeInvoice(i: typeof billingInvoices.$inferSelect) {
  return {
    id: i.id, number: i.number, kind: i.kind, payer: i.payer, status: i.status, description: i.description,
    subtotal: { amount: i.subtotalMinor, currency: i.currency }, tax: { amount: i.taxMinor, currency: i.currency }, total: { amount: i.totalMinor, currency: i.currency },
    lines: i.lines, periodStart: iso(i.periodStart), periodEnd: iso(i.periodEnd), hostedUrl: i.hostedUrl, createdAt: i.createdAt.toISOString(),
  };
}

/** Everything the Billing screen shows. */
export async function billingView(s: Services, orgId: string) {
  const org = await loadOrgRow(s.db, orgId);
  const sub = await loadSub(s.db, orgId);
  const plan = subPlan(sub, org.model);
  const list = subPriceList(sub);
  const rows = await locationBilling(s.db, orgId, sub, org.model);
  const quote = planQuote({ priceList: list, plan, interval: sub.billingInterval === 'year' ? 'year' : 'month', locations: rows.length });
  const invoices = await s.db.select().from(billingInvoices).where(and(eq(billingInvoices.organizationId, orgId), eq(billingInvoices.payer, 'hq'))).orderBy(desc(billingInvoices.createdAt)).limit(24);
  const payers = await s.db.select().from(locationFeePayers).where(eq(locationFeePayers.organizationId, orgId));
  const groups = asBusinessModel(org.model) === 'network' ? await s.db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, orgId)) : [];
  const now = Date.now();
  const trialEnds = sub.status === 'trialing' ? sub.trialEndsAt : null;
  const country = sub.billingCountry ?? org.country;
  return {
    status: sub.status,
    plan,
    plans: plansFor(org.model),
    businessModel: asBusinessModel(org.model),
    interval: sub.billingInterval,
    billingCountry: country,
    countryLocked: !!sub.countryEvidence,
    countryEvidence: sub.countryEvidence,
    currency: priceListCurrency(list),
    priceList: list,
    tier: priceListTier(list),
    priceBookVersion: sub.priceBookVersion ?? PRICE_BOOK_VERSION,
    trial: {
      days: TRIAL_DAYS,
      fee: { amount: sub.trialFeeMinor ?? listPriceMinor(list, 'trial'), currency: priceListCurrency(list) },
      endsAt: iso(trialEnds),
      daysLeft: trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - now) / DAY)) : null,
      remindersSent: sub.trialRemindersSent,
    },
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: iso(sub.canceledAt),
    currentPeriodEnd: iso(sub.currentPeriodEnd),
    nextChargeAt: sub.status === 'trialing' || sub.status === 'active' ? (sub.cancelAtPeriodEnd ? null : iso(trialEnds ?? sub.currentPeriodEnd)) : null,
    quote,
    hqTotal: { amount: hqTotal(quote, rows), currency: quote.currency, interval: quote.interval },
    platformFee: plan === 'network' ? { amount: listPriceMinor(list, 'platform'), currency: quote.currency, includedLocations: NETWORK_INCLUDED_LOCATIONS } : null,
    card: sub.card ? { brand: sub.card.brand, last4: sub.card.last4, country: sub.card.country } : null,
    taxId: sub.taxId,
    pendingChange: sub.pendingChange,
    locations: rows,
    payers: payers.map((p) => ({ id: p.id, scopeKind: p.scopeKind, scopeId: p.scopeId, payer: p.payer, franchiseePercent: p.franchiseePercent })),
    ownerGroups: groups,
    invoices: invoices.map(serializeInvoice),
    provider: s.billing.mode === 'live' ? 'stripe' : 'sandbox',
    publishableKey: s.billing.publishableKey,
    terms: { ...billingTerms(country), taxCollected: s.cfg.STRIPE_TAX_ENABLED },
    collectionFee: { perCollection: { amount: listPriceMinor(list, 'collection'), currency: quote.currency }, monthlyCapPerLocation: { amount: listPriceMinor(list, 'collectionCap'), currency: quote.currency } },
    paymentFeeBps: org.applicationFeeBps ?? s.cfg.STRIPE_APPLICATION_FEE_BPS,
  };
}

/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

export interface CheckoutState {
  plan: PlanPriceKey; interval: BillingInterval; locations: number; billingCountry: string; priceList: PriceListKey; currency: string;
  customerId: string; setupIntentId: string; startedAt: string; startedBy: string;
}

/** Subscription items: one recurring price per line at the interval amount (a year = 10 months). */
function linesFor(quote: PlanQuote): SubscriptionLine[] {
  return quote.lines.map((l) => ({
    lookupKey: l.kind === 'platform' ? 'network_platform' : `${quote.plan}_${l.kind}`,
    productName: l.kind === 'platform' ? 'BranchHarbor Network platform fee' : quote.plan === 'solo' ? 'BranchHarbor Solo' : `BranchHarbor ${quote.plan[0]!.toUpperCase()}${quote.plan.slice(1)} (per location)`,
    unitAmountMinor: l.unitMinor, quantity: l.quantity,
  }));
}

/** Step 1: lock a quote from the billing country and open a card setup. */
export async function startCheckout(s: Services, orgId: string, input: { plan: PlanPriceKey; interval: BillingInterval; billingCountry: string; locations?: number; currency?: string | null }, actor: { userId: string; email: string | null; ip?: string | null }) {
  const org = await loadOrgRow(s.db, orgId);
  const sub = await loadSub(s.db, orgId);
  if (sub.status === 'trialing' || sub.status === 'active' || sub.status === 'past_due') throw conflict('already_subscribed', 'This business already has a plan. Change it from Settings → Billing.');
  if (!plansFor(org.model).includes(input.plan)) throw badRequest(`The ${input.plan} plan is not available for this business.`, { plan: `Choose one of: ${plansFor(org.model).join(', ')}` });
  const billingCountry = input.billingCountry.toUpperCase();
  const check = assertBillingCurrency({ billingCountry, requestedCurrency: input.currency ?? null });
  if (!check.ok) {
    if (check.reason === 'invalid_country') throw badRequest('Choose your billing country.', { billingCountry: 'Use an ISO country code such as GB' });
    throw conflict('currency_mismatch', `Customers billed in ${regionName(billingCountry)} pay in ${check.expected}.`, { expected: check.expected });
  }
  const billable = await billableLocations(s.db, orgId);
  const quote = planQuote({ priceList: check.priceList, plan: input.plan, interval: input.interval, locations: Math.max(input.locations ?? 0, billable.length) });
  const eligibility = await trialEligibility(s.db, orgId, { email: actor.email });
  const customer = sub.stripeCustomerId && sub.currency === check.currency && sub.billingCountry === billingCountry
    ? { id: sub.stripeCustomerId }
    : await s.billing.createCustomer({ email: actor.email, name: org.name, country: billingCountry, metadata: { bh_org: orgId, bh_billing_country: billingCountry }, idempotencyKey: `bh-billing-customer:${orgId}:${billingCountry}` });
  const si = await s.billing.createSetupIntent({ customerId: customer.id, metadata: { bh_org: orgId, bh_kind: 'platform_checkout' }, idempotencyKey: `bh-billing-setup:${orgId}:${Date.now()}` });
  const state: CheckoutState = {
    plan: input.plan, interval: input.interval, locations: quote.locations, billingCountry, priceList: check.priceList, currency: check.currency,
    customerId: customer.id, setupIntentId: si.id, startedAt: new Date().toISOString(), startedBy: actor.userId,
  };
  await s.db.update(subscriptions).set({ checkout: state as unknown as Record<string, unknown>, stripeCustomerId: customer.id, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
  return {
    quote, trial: { eligible: eligibility.eligible, reason: eligibility.reason, days: TRIAL_DAYS, fee: { amount: quote.trialFeeMinor, currency: quote.currency } },
    billingCountry, terms: { ...billingTerms(billingCountry), taxCollected: s.cfg.STRIPE_TAX_ENABLED },
    setup: { mode: s.billing.mode, clientSecret: si.clientSecret, publishableKey: s.billing.publishableKey, setupIntentId: si.id },
  };
}

/** Step 2: the card is saved — check its country, then start the paid trial (or the plan when no trial is left). */
export async function confirmCheckout(s: Services, orgId: string, input: { setupIntentId?: string | null; paymentMethodId?: string | null; taxId?: string | null }, actor: { userId: string; email: string | null; ip?: string | null }) {
  const org = await loadOrgRow(s.db, orgId);
  const sub = await loadSub(s.db, orgId);
  const co = sub.checkout as unknown as CheckoutState | null;
  if (!co) throw conflict('checkout_not_started', 'Start the checkout first.');
  if (Date.now() - Date.parse(co.startedAt) > DAY) throw conflict('checkout_expired', 'This checkout has expired. Start again so the price is up to date.');
  if (sub.status === 'trialing' || sub.status === 'active') throw conflict('already_subscribed', 'This business already has a plan.');
  let pm: string | null = null;
  if (s.billing.mode === 'live') {
    if (!input.setupIntentId || input.setupIntentId !== co.setupIntentId) throw badRequest('Confirm your card first.', { setupIntentId: 'Required' });
    pm = await s.billing.setupIntentPaymentMethod(input.setupIntentId, co.customerId);
    if (!pm) throw new AppError(402, 'payment_method_required', 'Your card has not been confirmed yet. Enter it again.');
  } else {
    pm = input.paymentMethodId ?? null;
    if (!pm) throw badRequest('Add a card to start your trial.', { paymentMethodId: 'Required' });
  }
  const card = await s.billing.retrieveCard(pm);
  // Country lock: card issued in the billing country, or a business tax ID from it.
  const lock = lockBillingCountry({ billingCountry: co.billingCountry, currency: co.currency, card, taxId: input.taxId });
  if (lock.priceList !== co.priceList) throw conflict('price_changed', 'The price for your billing country has changed. Start the checkout again.');
  const eligibility = await trialEligibility(s.db, orgId, { email: actor.email, cardFingerprint: card?.fingerprint ?? null });
  const quote = planQuote({ priceList: co.priceList, plan: co.plan, interval: co.interval, locations: co.locations });
  if (input.taxId) await s.billing.addTaxId(co.customerId, co.billingCountry, input.taxId);
  let created;
  try {
    created = await s.billing.createSubscription({
      customerId: co.customerId, paymentMethodId: pm, currency: quote.currency, interval: co.interval, lines: linesFor(quote),
      trialDays: eligibility.eligible ? TRIAL_DAYS : null,
      trialFee: eligibility.eligible ? { amountMinor: quote.trialFeeMinor, description: `${TRIAL_DAYS}-day trial` } : null,
      metadata: { bh_org: orgId, bh_kind: 'platform', bh_plan: co.plan, bh_price_list: co.priceList, bh_billing_country: co.billingCountry, bh_price_book: PRICE_BOOK_VERSION },
      idempotencyKey: `bh-billing-sub:${orgId}:${co.setupIntentId}`,
    });
  } catch (err) {
    if (err instanceof CardDeclinedError) throw new AppError(402, err.code, err.message);
    throw err;
  }
  const now = new Date();
  const trialEndsAt = eligibility.eligible ? created.trialEnd ?? new Date(now.getTime() + TRIAL_DAYS * DAY) : null;
  const status = created.status === 'trialing' ? 'trialing' : created.status === 'active' ? 'active' : created.status;
  const months = co.interval === 'year' ? 10 : 1;
  await s.db.transaction(async (tx) => {
    if (eligibility.eligible) await recordTrialClaims(tx, orgId, { email: actor.email, cardFingerprint: card?.fingerprint ?? null });
    await tx.update(subscriptions).set({
      plan: co.plan, status, billingInterval: co.interval, billingCountry: co.billingCountry, currency: quote.currency, priceList: co.priceList, priceBookVersion: PRICE_BOOK_VERSION,
      platformFeeMinor: co.plan === 'network' ? listPriceMinor(co.priceList, 'platform') * months : null, includedLocations: quote.includedLocations,
      pricePerLocationMinor: listPriceMinor(co.priceList, co.plan) * months, billedLocationCount: quote.locations,
      trialEndsAt, trialFeeMinor: eligibility.eligible ? quote.trialFeeMinor : null, trialRemindersSent: [],
      currentPeriodEnd: created.currentPeriodEnd ?? trialEndsAt, cancelAtPeriodEnd: false, canceledAt: null,
      stripeCustomerId: co.customerId, stripeSubscriptionId: created.id, stripePaymentMethodId: pm,
      card: card ? { brand: card.brand, last4: card.last4, country: card.country, expMonth: card.expMonth, expYear: card.expYear } : null,
      taxId: input.taxId ?? null, taxIdCountry: lock.taxIdCountry, countryEvidence: lock.evidence, checkout: null, pendingChange: null, updatedAt: now,
    }).where(eq(subscriptions.id, sub.id));
    if (created.latestInvoice && created.latestInvoice.total > 0) {
      await upsertInvoice(tx, orgId, created.latestInvoice, {
        kind: eligibility.eligible ? 'trial_fee' : 'subscription', description: eligibility.eligible ? `${TRIAL_DAYS}-day trial` : `${co.plan} plan`,
        lines: eligibility.eligible ? [{ description: `${TRIAL_DAYS}-day trial`, quantity: 1, amountMinor: quote.trialFeeMinor }] : quote.lines.map((l) => ({ description: l.kind, quantity: l.quantity, amountMinor: l.amountMinor })),
      });
    }
    await audit(tx, {
      organizationId: orgId, actorUserId: actor.userId, ip: actor.ip ?? null, action: eligibility.eligible ? 'billing.trial_started' : 'billing.plan_started',
      scopeKind: 'organization', scopeId: orgId, targetType: 'subscription', targetId: sub.id,
      metadata: { plan: co.plan, interval: co.interval, billingCountry: co.billingCountry, priceList: co.priceList, evidence: lock.evidence, cardCountry: card?.country ?? null, trialRefusedReason: eligibility.reason },
    });
  });
  const fmtAmt = (m: number) => `${quote.currency} ${(m / 10 ** (quote.currency === 'JPY' ? 0 : 2)).toFixed(quote.currency === 'JPY' ? 0 : 2)}`;
  for (const o of await ownerEmails(s.db, orgId)) {
    await s.mailer.send({
      to: o.email, tag: 'billing',
      subject: eligibility.eligible ? `Your ${TRIAL_DAYS}-day BranchHarbor trial has started` : 'Your BranchHarbor plan has started',
      text: eligibility.eligible
        ? `Hi ${o.name},\n\nThanks for starting your ${TRIAL_DAYS}-day trial of ${org.name} on BranchHarbor. We charged ${fmtAmt(quote.trialFeeMinor)} for the trial.\n\nYour ${co.plan} plan starts automatically on ${trialEndsAt!.toISOString().slice(0, 10)} at ${fmtAmt(quote.totalMinor)} per ${co.interval}${s.cfg.STRIPE_TAX_ENABLED ? ' plus applicable tax' : ''}, unless you cancel before then in Settings → Billing. We'll remind you 3 days and 1 day before. There is no cancellation fee, and you can export your data for free at any time.\n`
        : `Hi ${o.name},\n\nYour ${co.plan} plan for ${org.name} has started (a trial was already used for this business, card or email domain). We charged ${fmtAmt(quote.totalMinor)} for the first ${co.interval}. Cancel any time in Settings → Billing; no cancellation fee.\n`,
    }).catch((err) => s.log.warn({ err }, '[billing] confirmation email failed'));
  }
  return { status, trialEndsAt: iso(trialEndsAt), trialUsed: !eligibility.eligible, trialRefusedReason: eligibility.reason, evidence: lock.evidence };
}

async function nextInvoiceNumber(tx: Exec, orgId: string): Promise<string> {
  const rows = await tx.select({ id: billingInvoices.id }).from(billingInvoices).where(eq(billingInvoices.organizationId, orgId));
  return `BH-${orgId.slice(0, 6).toUpperCase()}-${String(rows.length + 1).padStart(4, '0')}`;
}

export async function upsertInvoice(tx: Exec, orgId: string, inv: PlatformInvoice, extra: { kind: string; description?: string; payer?: 'hq' | 'franchisee'; franchiseeAccountId?: string | null; lines?: { description: string; quantity: number; amountMinor: number }[] }) {
  const [existing] = await tx.select().from(billingInvoices).where(eq(billingInvoices.stripeInvoiceId, inv.id));
  const status = inv.status === 'paid' ? 'paid' : inv.status === 'void' ? 'void' : inv.status === 'uncollectible' ? 'uncollectible' : 'open';
  if (existing) {
    await tx.update(billingInvoices).set({ status, taxMinor: inv.tax, totalMinor: inv.total, hostedUrl: inv.hostedUrl ?? existing.hostedUrl }).where(eq(billingInvoices.id, existing.id));
    return existing.id;
  }
  const [row] = await tx.insert(billingInvoices).values({
    organizationId: orgId, payer: extra.payer ?? 'hq', franchiseeAccountId: extra.franchiseeAccountId ?? null, kind: extra.kind, number: inv.number ?? (await nextInvoiceNumber(tx, orgId)),
    currency: inv.currency, subtotalMinor: inv.subtotal, taxMinor: inv.tax, totalMinor: inv.total, status, description: extra.description ?? null, lines: extra.lines ?? [],
    periodStart: inv.periodStart, periodEnd: inv.periodEnd, stripeInvoiceId: inv.id, hostedUrl: inv.hostedUrl,
  }).returning();
  return row!.id;
}

/* ------------------------------------------------------------------ */
/* Cancel / resume                                                     */
/* ------------------------------------------------------------------ */

export async function setCancellation(s: Services, orgId: string, cancel: boolean, actor: { userId: string; ip?: string | null; reason?: string | null }) {
  const sub = await loadSub(s.db, orgId);
  if (!['trialing', 'active', 'past_due'].includes(sub.status)) throw conflict('not_subscribed', 'There is no plan to cancel.');
  if (sub.stripeSubscriptionId) await s.billing.setCancelAtPeriodEnd(sub.stripeSubscriptionId, cancel);
  await s.db.update(subscriptions).set({ cancelAtPeriodEnd: cancel, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
  await audit(s.db, {
    organizationId: orgId, actorUserId: actor.userId, ip: actor.ip ?? null, action: cancel ? 'billing.cancel_scheduled' : 'billing.cancel_withdrawn', scopeKind: 'organization', scopeId: orgId,
    targetType: 'subscription', targetId: sub.id, metadata: { status: sub.status, endsAt: iso(sub.status === 'trialing' ? sub.trialEndsAt : sub.currentPeriodEnd), reason: actor.reason ?? null },
  });
  return { cancelAtPeriodEnd: cancel, endsAt: iso(sub.status === 'trialing' ? sub.trialEndsAt : sub.currentPeriodEnd) };
}

/* ------------------------------------------------------------------ */
/* Billing country change (next cycle, matching payment method)        */
/* ------------------------------------------------------------------ */

export async function startCountryChange(s: Services, orgId: string, input: { billingCountry: string }, actor: { userId: string; email: string | null }) {
  const org = await loadOrgRow(s.db, orgId);
  const sub = await loadSub(s.db, orgId);
  if (!['trialing', 'active'].includes(sub.status)) throw conflict('not_subscribed', 'Start your plan first.');
  const country = input.billingCountry.toUpperCase();
  if (country === sub.billingCountry) throw badRequest('That is already your billing country.', { billingCountry: 'Unchanged' });
  const target = priceListForCountry(country);
  const customer = await s.billing.createCustomer({ email: actor.email, name: org.name, country, metadata: { bh_org: orgId, bh_billing_country: country }, idempotencyKey: `bh-billing-customer:${orgId}:${country}` });
  const si = await s.billing.createSetupIntent({ customerId: customer.id, metadata: { bh_org: orgId, bh_kind: 'platform_country_change' }, idempotencyKey: `bh-billing-country:${orgId}:${Date.now()}` });
  const effectiveAt = iso(sub.status === 'trialing' ? sub.trialEndsAt : sub.currentPeriodEnd);
  const pending = { status: 'awaiting_payment_method', billingCountry: country, priceList: target.key, currency: target.currency, customerId: customer.id, setupIntentId: si.id, effectiveAt, requestedBy: actor.userId, requestedAt: new Date().toISOString() };
  await s.db.update(subscriptions).set({ pendingChange: pending, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
  const plan = subPlan(sub, org.model);
  return {
    pendingChange: pending, quote: planQuote({ priceList: target.key, plan, interval: sub.billingInterval === 'year' ? 'year' : 'month', locations: sub.billedLocationCount || 1 }),
    setup: { mode: s.billing.mode, clientSecret: si.clientSecret, publishableKey: s.billing.publishableKey, setupIntentId: si.id },
  };
}

export async function confirmCountryChange(s: Services, orgId: string, input: { setupIntentId?: string | null; paymentMethodId?: string | null; taxId?: string | null }, actor: { userId: string; ip?: string | null }) {
  const sub = await loadSub(s.db, orgId);
  const p = sub.pendingChange as Record<string, string> | null;
  if (!p || p.status !== 'awaiting_payment_method') throw conflict('no_pending_change', 'Start the billing country change first.');
  let pm: string | null = input.paymentMethodId ?? null;
  if (s.billing.mode === 'live') {
    if (!input.setupIntentId || input.setupIntentId !== p.setupIntentId) throw badRequest('Confirm the card for the new billing country first.', { setupIntentId: 'Required' });
    pm = await s.billing.setupIntentPaymentMethod(input.setupIntentId, p.customerId!);
  }
  if (!pm) throw new AppError(402, 'payment_method_required', 'Add a card issued in your new billing country.');
  const card = await s.billing.retrieveCard(pm);
  const lock = lockBillingCountry({ billingCountry: p.billingCountry!, currency: p.currency!, card, taxId: input.taxId });
  if (input.taxId) await s.billing.addTaxId(p.customerId!, p.billingCountry!, input.taxId);
  // The current subscription runs to the end of its period; the new country's plan starts from the next cycle.
  if (sub.stripeSubscriptionId) await s.billing.setCancelAtPeriodEnd(sub.stripeSubscriptionId, true);
  const pending = {
    ...p, status: 'scheduled', paymentMethodId: pm, evidence: lock.evidence, taxId: input.taxId ?? null, taxIdCountry: lock.taxIdCountry,
    card: card ? { brand: card.brand, last4: card.last4, country: card.country, expMonth: card.expMonth, expYear: card.expYear } : null,
  };
  await s.db.update(subscriptions).set({ pendingChange: pending, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
  await audit(s.db, { organizationId: orgId, actorUserId: actor.userId, ip: actor.ip ?? null, action: 'billing.country_change_scheduled', scopeKind: 'organization', scopeId: orgId, targetType: 'subscription', targetId: sub.id, metadata: { from: sub.billingCountry, to: p.billingCountry, effectiveAt: p.effectiveAt, evidence: lock.evidence } });
  return { pendingChange: pending };
}

export async function cancelCountryChange(s: Services, orgId: string, actor: { userId: string }) {
  const sub = await loadSub(s.db, orgId);
  if (!sub.pendingChange) throw conflict('no_pending_change', 'There is no billing country change to cancel.');
  if ((sub.pendingChange as Record<string, string>).status === 'scheduled' && sub.stripeSubscriptionId && !sub.cancelAtPeriodEnd) await s.billing.setCancelAtPeriodEnd(sub.stripeSubscriptionId, false);
  await s.db.update(subscriptions).set({ pendingChange: null, updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
  await audit(s.db, { organizationId: orgId, actorUserId: actor.userId, action: 'billing.country_change_cancelled', scopeKind: 'organization', scopeId: orgId, targetType: 'subscription', targetId: sub.id });
}

/** Moves the subscription to the scheduled billing country (new customer, currency and price list) at the cycle boundary. */
async function applyCountryChange(s: Services, sub: Sub, model: string, now: Date, db: Exec = s.db) {
  const p = sub.pendingChange as Record<string, any>;
  const plan = subPlan(sub, model);
  const interval: BillingInterval = sub.billingInterval === 'year' ? 'year' : 'month';
  const quote = planQuote({ priceList: p.priceList, plan, interval, locations: sub.billedLocationCount || 1 });
  const created = await s.billing.createSubscription({
    customerId: p.customerId, paymentMethodId: p.paymentMethodId, currency: quote.currency, interval, lines: linesFor(quote), trialDays: null, trialFee: null,
    metadata: { bh_org: sub.organizationId, bh_kind: 'platform', bh_plan: plan, bh_price_list: p.priceList, bh_billing_country: p.billingCountry, bh_price_book: PRICE_BOOK_VERSION },
    idempotencyKey: `bh-billing-country-apply:${sub.id}:${p.setupIntentId}`,
  });
  const months = interval === 'year' ? 10 : 1;
  await (db as Db).transaction(async (tx) => {
    await tx.update(subscriptions).set({
      status: created.status === 'active' ? 'active' : created.status, billingCountry: p.billingCountry, currency: quote.currency, priceList: p.priceList, priceBookVersion: PRICE_BOOK_VERSION,
      platformFeeMinor: plan === 'network' ? listPriceMinor(p.priceList, 'platform') * months : null, pricePerLocationMinor: listPriceMinor(p.priceList, plan) * months,
      stripeCustomerId: p.customerId, stripeSubscriptionId: created.id, stripePaymentMethodId: p.paymentMethodId, card: p.card ?? null, taxId: p.taxId ?? null, taxIdCountry: p.taxIdCountry ?? null,
      countryEvidence: p.evidence, currentPeriodEnd: created.currentPeriodEnd, trialEndsAt: null, cancelAtPeriodEnd: false, pendingChange: null, updatedAt: now,
    }).where(eq(subscriptions.id, sub.id));
    if (created.latestInvoice && created.latestInvoice.total > 0) await upsertInvoice(tx, sub.organizationId, created.latestInvoice, { kind: 'subscription', description: `${plan} plan`, lines: quote.lines.map((l) => ({ description: l.kind, quantity: l.quantity, amountMinor: l.amountMinor })) });
    await audit(tx, { organizationId: sub.organizationId, actorUserId: null, actorType: 'system', action: 'billing.country_changed', scopeKind: 'organization', scopeId: sub.organizationId, targetType: 'subscription', targetId: sub.id, metadata: { from: sub.billingCountry, to: p.billingCountry, priceList: p.priceList } });
  });
}

/* ------------------------------------------------------------------ */
/* Payer settings and franchisee billing                               */
/* ------------------------------------------------------------------ */

export async function setPayer(s: Services, orgId: string, input: { scopeKind: 'location' | 'owner_group'; scopeId: string; payer: LocationFeePayer; franchiseePercent?: number }, actor: { userId: string; ip?: string | null }) {
  const org = await loadOrgRow(s.db, orgId);
  if (asBusinessModel(org.model) !== 'network') throw conflict('network_only', 'Only networks can pass location fees to franchisees.');
  const table = input.scopeKind === 'location' ? locations : ownerGroups;
  const [target] = await s.db.select({ id: table.id }).from(table).where(and(eq(table.id, input.scopeId), eq(table.organizationId, orgId)));
  if (!target) throw notFound(input.scopeKind === 'location' ? 'Location' : 'Owner group');
  if (input.payer === 'split' && (input.franchiseePercent == null || input.franchiseePercent <= 0 || input.franchiseePercent >= 100)) throw badRequest('Choose the franchisee share (1–99%).', { franchiseePercent: 'Between 1 and 99' });
  const pct = input.payer === 'split' ? input.franchiseePercent! : input.payer === 'franchisee' ? 100 : 0;
  const [row] = await s.db.insert(locationFeePayers).values({ organizationId: orgId, scopeKind: input.scopeKind, scopeId: input.scopeId, payer: input.payer, franchiseePercent: pct, updatedBy: actor.userId })
    .onConflictDoUpdate({ target: [locationFeePayers.organizationId, locationFeePayers.scopeKind, locationFeePayers.scopeId], set: { payer: input.payer, franchiseePercent: pct, updatedBy: actor.userId, updatedAt: new Date() } }).returning();
  await audit(s.db, { organizationId: orgId, actorUserId: actor.userId, ip: actor.ip ?? null, action: 'billing.payer_set', scopeKind: input.scopeKind, scopeId: input.scopeId, targetType: 'location_fee_payer', targetId: row!.id, metadata: { payer: input.payer, franchiseePercent: pct } });
  return row!;
}

export async function removePayer(s: Services, orgId: string, id: string, actor: { userId: string }) {
  const [row] = await s.db.delete(locationFeePayers).where(and(eq(locationFeePayers.id, id), eq(locationFeePayers.organizationId, orgId))).returning();
  if (!row) throw notFound('Payer setting');
  await audit(s.db, { organizationId: orgId, actorUserId: actor.userId, action: 'billing.payer_removed', scopeKind: row.scopeKind, scopeId: row.scopeId, targetType: 'location_fee_payer', targetId: row.id });
}

/**
 * Franchisee billing view: the locations in the franchisee's own scopes whose fee (or part of it) they pay, priced
 * in THEIR billing country's price list once they have a billing account (HQ's list until then).
 */
export async function franchiseeBillingView(s: Services, orgId: string, scopes: { kind: 'location' | 'owner_group'; id: string }[]) {
  const org = await loadOrgRow(s.db, orgId);
  const sub = await loadSub(s.db, orgId);
  const rows = await locationBilling(s.db, orgId, sub, org.model);
  const groupIds = new Set(scopes.filter((x) => x.kind === 'owner_group').map((x) => x.id));
  const locIds = new Set(scopes.filter((x) => x.kind === 'location').map((x) => x.id));
  const mine = rows.filter((r) => locIds.has(r.id) || (r.ownerGroupId && groupIds.has(r.ownerGroupId)));
  const accounts = scopes.length
    ? await s.db.select().from(franchiseeBillingAccounts).where(and(eq(franchiseeBillingAccounts.organizationId, orgId), inArray(franchiseeBillingAccounts.scopeId, scopes.map((x) => x.id))))
    : [];
  const accountFor = (r: LocationBillingRow) => accounts.find((a) => a.scopeId === r.id) ?? (r.ownerGroupId ? accounts.find((a) => a.scopeId === r.ownerGroupId) : undefined);
  const plan = subPlan(sub, org.model);
  const months = sub.billingInterval === 'year' ? 10 : 1;
  const items = mine.map((r) => {
    const acct = accountFor(r);
    const list = (acct && isPriceListKey(acct.priceList) ? acct.priceList : subPriceList(sub)) as PriceListKey;
    const fee = r.included || plan !== 'network' ? 0 : listPriceMinor(list, 'network') * months;
    const share = splitLocationFee(fee, r.payer, r.franchiseePercent).franchiseeMinor;
    return { locationId: r.id, name: r.name, payer: r.payer, franchiseePercent: r.franchiseePercent, included: r.included, amount: { amount: share, currency: priceListCurrency(list) }, accountId: acct?.id ?? null };
  });
  const invoices = accounts.length
    ? await s.db.select().from(billingInvoices).where(and(eq(billingInvoices.organizationId, orgId), inArray(billingInvoices.franchiseeAccountId, accounts.map((a) => a.id)))).orderBy(desc(billingInvoices.createdAt)).limit(24)
    : [];
  return {
    plan, interval: sub.billingInterval, hqStatus: sub.status,
    scopes, locations: items,
    accounts: accounts.map((a) => ({ id: a.id, scopeKind: a.scopeKind, scopeId: a.scopeId, billingCountry: a.billingCountry, currency: a.currency, priceList: a.priceList, status: a.status, card: a.card })),
    invoices: invoices.map(serializeInvoice),
    provider: s.billing.mode === 'live' ? 'stripe' : 'sandbox', publishableKey: s.billing.publishableKey,
  };
}

export async function startFranchiseeSetup(s: Services, orgId: string, input: { scopeKind: 'location' | 'owner_group'; scopeId: string; billingCountry: string }, actor: { userId: string; email: string | null }) {
  const org = await loadOrgRow(s.db, orgId);
  const country = input.billingCountry.toUpperCase();
  const target = priceListForCountry(country);
  const customer = await s.billing.createCustomer({ email: actor.email, name: `${org.name} franchisee`, country, metadata: { bh_org: orgId, bh_scope: `${input.scopeKind}:${input.scopeId}` }, idempotencyKey: `bh-franchisee-customer:${input.scopeId}:${country}` });
  const si = await s.billing.createSetupIntent({ customerId: customer.id, metadata: { bh_org: orgId, bh_kind: 'franchisee_billing' }, idempotencyKey: `bh-franchisee-setup:${input.scopeId}:${Date.now()}` });
  const setup = { customerId: customer.id, setupIntentId: si.id, billingCountry: country, priceList: target.key, currency: target.currency };
  const [row] = await s.db.insert(franchiseeBillingAccounts).values({
    organizationId: orgId, scopeKind: input.scopeKind, scopeId: input.scopeId, billingCountry: country, currency: target.currency, priceList: target.key, stripeCustomerId: customer.id, setup, createdBy: actor.userId,
  }).onConflictDoUpdate({
    target: [franchiseeBillingAccounts.organizationId, franchiseeBillingAccounts.scopeKind, franchiseeBillingAccounts.scopeId],
    set: { setup, updatedAt: new Date() },
  }).returning();
  return { accountId: row!.id, priceList: target.key, currency: target.currency, setup: { mode: s.billing.mode, clientSecret: si.clientSecret, publishableKey: s.billing.publishableKey, setupIntentId: si.id } };
}

export async function confirmFranchiseeSetup(s: Services, orgId: string, input: { scopeKind: 'location' | 'owner_group'; scopeId: string; setupIntentId?: string | null; paymentMethodId?: string | null; taxId?: string | null }, actor: { userId: string; ip?: string | null }) {
  const [acct] = await s.db.select().from(franchiseeBillingAccounts).where(and(eq(franchiseeBillingAccounts.organizationId, orgId), eq(franchiseeBillingAccounts.scopeKind, input.scopeKind), eq(franchiseeBillingAccounts.scopeId, input.scopeId)));
  const setup = acct?.setup as Record<string, string> | null;
  if (!acct || !setup) throw conflict('setup_not_started', 'Start the billing setup first.');
  let pm: string | null = input.paymentMethodId ?? null;
  if (s.billing.mode === 'live') {
    if (input.setupIntentId !== setup.setupIntentId) throw badRequest('Confirm your card first.', { setupIntentId: 'Required' });
    pm = await s.billing.setupIntentPaymentMethod(setup.setupIntentId!, setup.customerId!);
  }
  if (!pm) throw new AppError(402, 'payment_method_required', 'Add a card to pay your location fees.');
  const card = await s.billing.retrieveCard(pm);
  const lock = lockBillingCountry({ billingCountry: setup.billingCountry!, currency: setup.currency!, card, taxId: input.taxId });
  if (input.taxId) await s.billing.addTaxId(setup.customerId!, setup.billingCountry!, input.taxId);
  await s.db.update(franchiseeBillingAccounts).set({
    billingCountry: setup.billingCountry!, currency: setup.currency!, priceList: lock.priceList, stripeCustomerId: setup.customerId!, stripePaymentMethodId: pm,
    card: card ? { brand: card.brand, last4: card.last4, country: card.country } : null, taxId: input.taxId ?? null, status: 'active', setup: null, updatedAt: new Date(),
  }).where(eq(franchiseeBillingAccounts.id, acct.id));
  await audit(s.db, { organizationId: orgId, actorUserId: actor.userId, ip: actor.ip ?? null, action: 'billing.franchisee_account_ready', scopeKind: input.scopeKind, scopeId: input.scopeId, targetType: 'franchisee_billing_account', targetId: acct.id, metadata: { billingCountry: setup.billingCountry, evidence: lock.evidence } });
  return { accountId: acct.id, status: 'active' };
}

/** Sandbox: bill each active franchisee account its share for the period that just started (live: Stripe invoices). */
async function billFranchisees(s: Services, tx: Tx, sub: Sub, model: string, periodStart: Date, periodEnd: Date) {
  const view = await franchiseeBillingView(s, sub.organizationId, (await tx.select({ kind: franchiseeBillingAccounts.scopeKind, id: franchiseeBillingAccounts.scopeId }).from(franchiseeBillingAccounts)
    .where(and(eq(franchiseeBillingAccounts.organizationId, sub.organizationId), eq(franchiseeBillingAccounts.status, 'active')))) as { kind: 'location' | 'owner_group'; id: string }[]);
  const byAccount = new Map<string, typeof view.locations>();
  for (const l of view.locations) if (l.accountId && l.amount.amount > 0) byAccount.set(l.accountId, [...(byAccount.get(l.accountId) ?? []), l]);
  for (const [accountId, ls] of byAccount) {
    const total = ls.reduce((a, l) => a + l.amount.amount, 0);
    await tx.insert(billingInvoices).values({
      organizationId: sub.organizationId, payer: 'franchisee', franchiseeAccountId: accountId, kind: 'franchisee_fee', number: await nextInvoiceNumber(tx, sub.organizationId),
      currency: ls[0]!.amount.currency, subtotalMinor: total, taxMinor: 0, totalMinor: total, status: 'paid', description: 'Location fees',
      lines: ls.map((l) => ({ description: `${l.name} (${l.franchiseePercent}%)`, quantity: 1, amountMinor: l.amount.amount })), periodStart, periodEnd,
      stripeInvoiceId: `in_sandbox_fr_${accountId.slice(0, 8)}_${periodStart.getTime()}`,
    }).onConflictDoNothing();
  }
  void model;
}

/* ------------------------------------------------------------------ */
/* Sweep: trial reminders, sandbox conversions and renewals            */
/* ------------------------------------------------------------------ */

const isSandboxSub = (sub: Sub) => !sub.stripeSubscriptionId || sub.stripeSubscriptionId.includes('_sandbox_');

/**
 * Runs every BILLING_SWEEP_MINUTES. Sends the trial reminders (3 days and 1 day before the plan starts) in every mode.
 * In sandbox it also does what Stripe does in live mode: converts ended trials (or cancels them when the customer
 * cancelled), renews periods and applies scheduled billing-country changes.
 */
export async function runBillingSweep(s: Services, now = new Date()) {
  const result = { reminders: 0, converted: 0, canceled: 0, renewed: 0, countryChanges: 0 };
  const trialing = await s.db.select().from(subscriptions).where(eq(subscriptions.status, 'trialing'));
  for (const sub of trialing) {
    if (!sub.trialEndsAt) continue;
    const left = sub.trialEndsAt.getTime() - now.getTime();
    if (left > 0 && !sub.cancelAtPeriodEnd) {
      const due = TRIAL_REMINDER_DAYS.filter((d) => left <= d * DAY && !sub.trialRemindersSent.includes(d));
      if (due.length) {
        const day = Math.min(...due);
        await sendTrialReminder(s, sub, day);
        await s.db.update(subscriptions).set({ trialRemindersSent: [...sub.trialRemindersSent, ...due], updatedAt: now }).where(eq(subscriptions.id, sub.id));
        result.reminders++;
      }
    }
  }
  const due = await s.db.select().from(subscriptions).where(and(inArray(subscriptions.status, ['trialing', 'active']), lte(subscriptions.currentPeriodEnd, now)));
  for (const sub of due) {
    if (!isSandboxSub(sub)) continue;
    const org = await loadOrgRow(s.db, sub.organizationId);
    if (sub.cancelAtPeriodEnd) {
      await s.db.update(subscriptions).set({ status: 'canceled', canceledAt: now, updatedAt: now }).where(eq(subscriptions.id, sub.id));
      await audit(s.db, { organizationId: sub.organizationId, actorUserId: null, actorType: 'system', action: 'billing.canceled', scopeKind: 'organization', scopeId: sub.organizationId, targetType: 'subscription', targetId: sub.id, metadata: { wasTrial: sub.status === 'trialing' } });
      result.canceled++;
      continue;
    }
    if ((sub.pendingChange as Record<string, string> | null)?.status === 'scheduled') {
      await applyCountryChange(s, sub, org.model, now);
      result.countryChanges++;
      continue;
    }
    const plan = subPlan(sub, org.model);
    const rows = await locationBilling(s.db, sub.organizationId, sub, org.model);
    const interval: BillingInterval = sub.billingInterval === 'year' ? 'year' : 'month';
    const quote = planQuote({ priceList: subPriceList(sub), plan, interval, locations: rows.length });
    const start = sub.currentPeriodEnd!;
    const end = new Date(start.getTime() + (interval === 'year' ? 365 : 30) * DAY);
    const amount = hqTotal(quote, rows);
    await s.db.transaction(async (tx) => {
      await tx.update(subscriptions).set({ status: 'active', trialEndsAt: sub.status === 'trialing' ? sub.trialEndsAt : sub.trialEndsAt, currentPeriodEnd: end, billedLocationCount: quote.locations, updatedAt: now }).where(eq(subscriptions.id, sub.id));
      await upsertInvoice(tx, sub.organizationId, { id: `in_sandbox_${sub.id.slice(0, 8)}_${start.getTime()}`, number: null, status: 'paid', amountPaid: amount, amountDue: amount, tax: 0, total: amount, subtotal: amount, currency: quote.currency, hostedUrl: null, periodStart: start, periodEnd: end }, {
        kind: 'subscription', description: `${plan} plan`, lines: quote.lines.map((l) => ({ description: l.kind, quantity: l.quantity, amountMinor: l.amountMinor })),
      });
      if (plan === 'network') await billFranchisees(s, tx, sub, org.model, start, end);
      await audit(tx, { organizationId: sub.organizationId, actorUserId: null, actorType: 'system', action: sub.status === 'trialing' ? 'billing.trial_converted' : 'billing.renewed', scopeKind: 'organization', scopeId: sub.organizationId, targetType: 'subscription', targetId: sub.id, metadata: { amount, currency: quote.currency } });
    });
    if (sub.status === 'trialing') {
      result.converted++;
      for (const o of await ownerEmails(s.db, sub.organizationId)) {
        await s.mailer.send({ to: o.email, tag: 'billing', subject: 'Your BranchHarbor plan has started', text: `Hi ${o.name},\n\nYour trial has ended and your ${plan} plan for ${org.name} has started. Invoices are in Settings → Billing. Cancel any time; there is no cancellation fee.\n` }).catch(() => undefined);
      }
    } else result.renewed++;
  }
  return result;
}

async function sendTrialReminder(s: Services, sub: Sub, days: number) {
  const org = await loadOrgRow(s.db, sub.organizationId);
  const plan = subPlan(sub, org.model);
  const rows = await locationBilling(s.db, sub.organizationId, sub, org.model);
  const quote = planQuote({ priceList: subPriceList(sub), plan, interval: sub.billingInterval === 'year' ? 'year' : 'month', locations: rows.length });
  const amount = hqTotal(quote, rows);
  const exp = quote.currency === 'JPY' ? 0 : 2;
  const price = `${quote.currency} ${(amount / 10 ** exp).toFixed(exp)}`;
  const date = sub.trialEndsAt!.toISOString().slice(0, 10);
  for (const o of await ownerEmails(s.db, sub.organizationId)) {
    await s.mailer.send({
      to: o.email, tag: 'billing-trial-reminder',
      subject: days === 1 ? `Your BranchHarbor trial ends tomorrow (${date})` : `Your BranchHarbor trial ends in ${days} days (${date})`,
      text: `Hi ${o.name},\n\nYour ${TRIAL_DAYS}-day trial of BranchHarbor for ${org.name} ends on ${date}. Your ${plan} plan then starts automatically and we will charge ${price} per ${quote.interval}${s.cfg.STRIPE_TAX_ENABLED ? ' plus applicable tax' : ''} to the card ending ${sub.card?.last4 ?? '••••'}.\n\nDon't want to continue? Cancel before ${date} in Settings → Billing (${s.cfg.APP_URL.replace(/\/$/, '')}/settings#billing). There is no cancellation fee, and you can export your data for free.\n`,
    }).catch((err) => s.log.warn({ err }, '[billing] trial reminder failed'));
  }
}

/* ------------------------------------------------------------------ */
/* Stripe webhook (platform account)                                   */
/* ------------------------------------------------------------------ */

const STRIPE_STATUS: Record<string, string> = { trialing: 'trialing', active: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete: 'checkout_required', incomplete_expired: 'canceled', paused: 'past_due' };

/**
 * Platform subscription events (no `account`): keeps status, trial end and period in sync, records invoices, applies a
 * scheduled billing-country change when the old subscription ends, and RE-CHECKS THE COUNTRY LOCK: the
 * subscription's currency must be the billing country's and the card on it must be from that country (or a tax ID
 * from it was given). A mismatch cancels the subscription at once.
 */
export async function processPlatformBillingEvent(tx: Tx, event: Stripe.Event, s: Services): Promise<{ note: string; organizationId: string | null } | null> {
  if ((event as { account?: string }).account) return null;
  if (!event.type.startsWith('customer.subscription.') && !event.type.startsWith('invoice.')) return null;
  const obj = event.data.object as unknown as Record<string, any>;
  const subId: string | null = event.type.startsWith('customer.subscription.') ? obj.id : typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id ?? obj.parent?.subscription_details?.subscription ?? null;
  if (!subId) return null;
  const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, subId)).for('update');
  if (!sub) {
    const [fa] = await tx.select().from(franchiseeBillingAccounts).where(eq(franchiseeBillingAccounts.stripeSubscriptionId, subId));
    if (fa && event.type.startsWith('invoice.')) {
      await upsertInvoice(tx, fa.organizationId, invoiceFromStripe(obj), { kind: 'franchisee_fee', payer: 'franchisee', franchiseeAccountId: fa.id, description: 'Location fees' });
      return { note: 'Franchisee invoice recorded', organizationId: fa.organizationId };
    }
    return null;
  }
  const orgId = sub.organizationId;
  if (event.type.startsWith('invoice.')) {
    const inv = invoiceFromStripe(obj);
    if (inv.total > 0 || inv.amountPaid > 0) {
      const trial = obj.billing_reason === 'subscription_create' && sub.trialFeeMinor != null;
      await upsertInvoice(tx, orgId, inv, { kind: trial ? 'trial_fee' : 'subscription', description: trial ? `${TRIAL_DAYS}-day trial` : `${sub.plan} plan` });
    }
    if (event.type === 'invoice.payment_failed') await tx.update(subscriptions).set({ status: 'past_due', updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
    return { note: `Platform invoice ${inv.status}`, organizationId: orgId };
  }
  // customer.subscription.*: re-check the billing country lock.
  const currency = String(obj.currency ?? sub.currency).toUpperCase();
  const pmId = typeof obj.default_payment_method === 'string' ? obj.default_payment_method : obj.default_payment_method?.id ?? null;
  let cardCountry = sub.card?.country ?? null;
  if (pmId && pmId !== sub.stripePaymentMethodId) cardCountry = (await s.billing.retrieveCard(pmId))?.country ?? null;
  const country = sub.billingCountry ?? obj.metadata?.bh_billing_country ?? null;
  const check = country ? assertBillingCurrency({ billingCountry: country, requestedCurrency: currency, cardCountry, taxIdCountry: sub.taxIdCountry }) : { ok: true as const };
  if (!check.ok && event.type !== 'customer.subscription.deleted') {
    await s.billing.cancelNow(subId);
    await tx.update(subscriptions).set({ status: 'canceled', canceledAt: new Date(), updatedAt: new Date() }).where(eq(subscriptions.id, sub.id));
    await audit(tx, { organizationId: orgId, actorUserId: null, actorType: 'webhook', action: 'billing.country_lock_violation', scopeKind: 'organization', scopeId: orgId, targetType: 'subscription', targetId: sub.id, metadata: { eventId: event.id, reason: check.reason, billingCountry: country, currency, cardCountry } });
    return { note: `Country lock violation (${check.reason}); subscription cancelled`, organizationId: orgId };
  }
  if (event.type === 'customer.subscription.deleted' && (sub.pendingChange as Record<string, string> | null)?.status === 'scheduled') {
    const [org] = await tx.select({ model: organizations.model }).from(organizations).where(eq(organizations.id, orgId));
    await applyCountryChange(s, sub, org?.model ?? 'network', new Date(), tx);
    return { note: 'Billing country change applied', organizationId: orgId };
  }
  const status = STRIPE_STATUS[String(obj.status)] ?? sub.status;
  await tx.update(subscriptions).set({
    status, trialEndsAt: typeof obj.trial_end === 'number' ? new Date(obj.trial_end * 1000) : sub.trialEndsAt, currentPeriodEnd: subscriptionPeriodEnd(obj) ?? sub.currentPeriodEnd,
    cancelAtPeriodEnd: !!obj.cancel_at_period_end && !(sub.pendingChange as Record<string, string> | null), canceledAt: status === 'canceled' ? new Date() : sub.canceledAt, updatedAt: new Date(),
  }).where(eq(subscriptions.id, sub.id));
  return { note: `Platform subscription ${status}`, organizationId: orgId };
}

stripeEventExtensions.push(async (tx, event, s) => processPlatformBillingEvent(tx, event, s));
