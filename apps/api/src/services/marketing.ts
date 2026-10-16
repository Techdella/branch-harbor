/**
 * Marketing workspace core: brand for emails, settings, consent, tags, segments, email sending (campaigns and
 * automation steps) and the durable marketing event inbox that starts automations.
 */
import { and, desc, eq, gte, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import {
  emailDocumentSchema, marketingSettingsSchema, resolveTheme, segmentRulesSchema,
  type EmailDocument, type EmailToken, type MarketingSettings, type SegmentRules, type SiteFont,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { campaigns, consentRecords, contactTags, customers, emailSends, leads, locations, marketingEvents, organizations } from '../db/schema/index.ts';
import { randomToken } from '../lib/crypto.ts';
import { audit } from './audit.ts';
import { renderEmail, type EmailBrand } from './email-render.ts';
import { segmentConditions } from './segments.ts';
import { emailIdentity } from './brands.ts';

export type CustomerRow = typeof customers.$inferSelect;
export const CONSENT_FOR_CHANNEL = { email: 'marketing_email', sms: 'marketing_sms', whatsapp: 'marketing_whatsapp' } as const;

export function marketingSettingsOf(org: { settings: Record<string, unknown> }): MarketingSettings {
  const parsed = marketingSettingsSchema.safeParse(org.settings.marketing ?? {});
  return parsed.success ? parsed.data : marketingSettingsSchema.parse({});
}

/** Email brand from the website theme + brand overrides (one look across site and email). */
export async function emailBrandFor(db: Exec, orgId: string): Promise<{ brand: EmailBrand; org: typeof organizations.$inferSelect }> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  const site = (org!.settings.site ?? {}) as { themeId?: string; colorMode?: 'theme' | 'brand'; primaryColor?: string; accentColor?: string | null; headingFont?: SiteFont | null; bodyFont?: SiteFont | null; logoUrl?: string | null };
  const theme = resolveTheme(site.themeId ?? 'classic', { colorMode: site.colorMode ?? (site.themeId ? 'theme' : 'brand'), primaryColor: site.primaryColor ?? null, accentColor: site.accentColor ?? null, headingFont: site.headingFont ?? null, bodyFont: site.bodyFont ?? null });
  return { org: org!, brand: { name: org!.name, logoUrl: site.logoUrl ?? null, palette: theme.light, fonts: theme.fonts } };
}

/** Latest consent decision per purpose for a customer (withdrawals win when newer). */
export async function hasConsent(db: Exec, customerId: string, purpose: string): Promise<boolean> {
  const [row] = await db.select({ granted: consentRecords.granted }).from(consentRecords).where(and(eq(consentRecords.customerId, customerId), eq(consentRecords.purpose, purpose))).orderBy(desc(consentRecords.recordedAt)).limit(1);
  return row?.granted === true;
}

export async function consentedCustomerIds(db: Exec, customerIds: string[], purpose: string): Promise<Set<string>> {
  if (!customerIds.length) return new Set();
  const rows = await db.select({ customerId: consentRecords.customerId, granted: consentRecords.granted }).from(consentRecords)
    .where(and(inArray(consentRecords.customerId, customerIds), eq(consentRecords.purpose, purpose))).orderBy(desc(consentRecords.recordedAt));
  const latest = new Map<string, boolean>();
  for (const r of rows) if (r.customerId && !latest.has(r.customerId)) latest.set(r.customerId, r.granted);
  return new Set([...latest].filter(([, g]) => g).map(([id]) => id));
}

export function personalValues(c: Pick<CustomerRow, 'name' | 'email'> | null, extra: { locationName?: string | null; businessName: string }): Partial<Record<EmailToken, string | null>> {
  const name = c?.name ?? '';
  return { first_name: name.split(/\s+/)[0] ?? '', name, email: c?.email ?? '', location_name: extra.locationName ?? '', business_name: extra.businessName };
}

// ───────── Tags ─────────

export async function addTag(s: Services, orgId: string, customerId: string, tag: string, sourceKey: string) {
  const inserted = await s.db.insert(contactTags).values({ organizationId: orgId, customerId, tag }).onConflictDoNothing().returning();
  if (inserted.length) {
    const [c] = await s.db.select({ locationId: customers.locationId }).from(customers).where(eq(customers.id, customerId));
    await emitMarketingEvent(s, { organizationId: orgId, type: 'tag.added', key: `${customerId}:${tag}:${sourceKey}`, customerId, locationId: c?.locationId ?? null, data: { tag } });
  }
  return inserted.length > 0;
}

export async function removeTag(db: Exec, customerId: string, tag: string) {
  await db.delete(contactTags).where(and(eq(contactTags.customerId, customerId), eq(contactTags.tag, tag)));
}

// ───────── Segments ─────────

export function parseRules(raw: unknown): SegmentRules {
  return segmentRulesSchema.parse(raw ?? {});
}

/**
 * Contacts matching a segment (contact_segments, shared with the inbox) within the locations the caller may reach.
 * Consent is NOT applied here (each channel applies its own consent when sending); erased contacts and contacts
 * without a location in scope never match.
 */
export async function segmentMembers(db: Exec, orgId: string, rules: SegmentRules, allowedLocationIds: string[] | 'all'): Promise<CustomerRow[]> {
  if (allowedLocationIds !== 'all' && !allowedLocationIds.length) return [];
  return db.select().from(customers).where(and(...segmentConditions(orgId, rules, allowedLocationIds === 'all' ? null : allowedLocationIds))).limit(50_000);
}

// ───────── Email sending ─────────

export interface SendEmailInput {
  organizationId: string;
  customer: CustomerRow | null;
  /** Test sends go to a person (no customer) and skip consent. */
  to?: string;
  locationId: string | null;
  document: EmailDocument;
  subject: string;
  preheader?: string;
  campaignId?: string | null;
  automationStepId?: string | null;
  test?: boolean;
}

/**
 * Send one marketing email. Consent (marketing_email) is required for real sends; every email carries the postal
 * address and an unsubscribe link tied to a per-recipient token. Idempotent per campaign + customer (unique row).
 */
export async function sendMarketingEmail(s: Services, input: SendEmailInput): Promise<{ status: string; sendId: string | null; skipReason?: string }> {
  const email = input.to ?? input.customer?.email ?? null;
  if (!email) return { status: 'skipped', sendId: null, skipReason: 'no_email' };
  if (!input.test && input.customer && !(await hasConsent(s.db, input.customer.id, 'marketing_email'))) return { status: 'skipped', sendId: null, skipReason: 'no_consent' };
  // Multi-brand HQ: email from a location goes out as its brand (name, logo, palette, sender and reply-to).
  const { email: brand, org, sender } = await emailIdentity(s.db, input.organizationId, input.locationId);
  const settings = marketingSettingsOf(org);
  const [loc] = input.locationId ? await s.db.select().from(locations).where(eq(locations.id, input.locationId)) : [];
  const address = settings.postalAddress || (loc ? [loc.address.line1, loc.address.line2, loc.address.postalCode, loc.address.city, loc.country].filter(Boolean).join(', ') : '');
  // The postal address is legally required in marketing email: never send without one (tests excepted).
  if (!address && !input.test) return { status: 'skipped', sendId: null, skipReason: 'no_postal_address' };
  const token = randomToken(24);
  let sendId: string | null = null;
  if (input.campaignId && input.customer) {
    const [row] = await s.db.insert(emailSends).values({ organizationId: input.organizationId, campaignId: input.campaignId, customerId: input.customer.id, locationId: input.locationId, email, subject: input.subject, token, status: 'sending', test: !!input.test }).onConflictDoNothing().returning();
    if (!row) return { status: 'duplicate', sendId: null, skipReason: 'already_sent' };
    sendId = row.id;
  } else {
    const [row] = await s.db.insert(emailSends).values({ organizationId: input.organizationId, campaignId: input.campaignId ?? null, automationStepId: input.automationStepId ?? null, customerId: input.customer?.id ?? null, locationId: input.locationId, email, subject: input.subject, token, status: 'sending', test: !!input.test }).returning();
    sendId = row!.id;
  }
  const base = s.cfg.PUBLIC_API_URL.replace(/\/$/, '');
  try {
    const rendered = await renderEmail({
      document: input.document, subject: input.subject, preheader: input.preheader, brand, locale: input.customer?.locale ?? loc?.locale ?? org.defaultLocale,
      values: personalValues(input.customer ?? { name: '', email }, { locationName: loc?.name, businessName: brand.name }),
      postalAddress: address, unsubscribeUrl: `${base}/v1/public/email/unsubscribe/${token}`,
      trackLink: settings.tracking.clicks && !input.test ? (_href, i) => `${base}/v1/public/email/c/${token}/${i}` : undefined,
      openPixelUrl: settings.tracking.opens && !input.test ? `${base}/v1/public/email/o/${token}.gif` : null,
    });
    const res = await s.mailer.send({ to: email, subject: rendered.subject, text: rendered.text, html: rendered.html, tag: input.campaignId ? 'campaign' : input.test ? 'marketing-test' : 'automation', fromName: sender.fromName, replyTo: sender.replyTo });
    const status = res.delivered ? 'sent' : 'sandbox';
    await s.db.update(emailSends).set({ status, links: rendered.links, sentAt: new Date() }).where(eq(emailSends.id, sendId));
    return { status, sendId };
  } catch (err) {
    await s.db.update(emailSends).set({ status: 'failed', error: (err as Error).message.slice(0, 500) }).where(eq(emailSends.id, sendId));
    return { status: 'failed', sendId, skipReason: 'send_failed' };
  }
}

export function campaignContent(raw: Record<string, unknown>): { subject: string; preheader: string; document: EmailDocument; segmentId: string | null; templateId: string | null } {
  return {
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    preheader: typeof raw.preheader === 'string' ? raw.preheader : '',
    document: emailDocumentSchema.parse(raw.document ?? { blocks: [] }),
    segmentId: typeof raw.segmentId === 'string' ? raw.segmentId : null,
    templateId: typeof raw.templateId === 'string' ? raw.templateId : null,
  };
}

/** Deliver a queued campaign to its recipient list (stored at send time). Safe to re-run: sent rows are skipped. */
export async function deliverCampaign(s: Services, campaignId: string) {
  const [c] = await s.db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!c || c.status !== 'active') return { sent: 0 };
  const content = campaignContent(c.content);
  const recipients = Array.isArray(c.content.recipients) ? (c.content.recipients as string[]) : [];
  const done = new Set((await s.db.select({ id: emailSends.customerId }).from(emailSends).where(eq(emailSends.campaignId, campaignId))).map((r) => r.id));
  const todo = recipients.filter((id) => !done.has(id));
  const rows = todo.length ? await s.db.select().from(customers).where(inArray(customers.id, todo)) : [];
  const consented = await consentedCustomerIds(s.db, rows.map((r) => r.id), 'marketing_email');
  let sent = 0, skipped = 0;
  for (const cust of rows) {
    if (cust.erasedAt || !cust.email || !consented.has(cust.id)) {
      // Record the skip so the campaign report explains every recipient.
      await s.db.insert(emailSends).values({ organizationId: c.organizationId, campaignId, customerId: cust.id, locationId: cust.locationId, email: cust.email ?? '', subject: content.subject, token: randomToken(24), status: 'skipped', skipReason: !cust.email || cust.erasedAt ? 'no_email' : 'no_consent' }).onConflictDoNothing();
      skipped++;
      continue;
    }
    const r = await sendMarketingEmail(s, { organizationId: c.organizationId, customer: cust, locationId: cust.locationId, document: content.document, subject: content.subject, preheader: content.preheader, campaignId });
    if (r.status === 'sent' || r.status === 'sandbox') sent++;
    else if (r.status === 'skipped' && !r.sendId) {
      await s.db.insert(emailSends).values({ organizationId: c.organizationId, campaignId, customerId: cust.id, locationId: cust.locationId, email: cust.email, subject: content.subject, token: randomToken(24), status: 'skipped', skipReason: r.skipReason ?? 'skipped' }).onConflictDoNothing();
      skipped++;
    }
  }
  const remaining = recipients.length - (await s.db.select({ id: emailSends.id }).from(emailSends).where(eq(emailSends.campaignId, campaignId))).length;
  if (remaining <= 0) await s.db.update(campaigns).set({ status: 'completed', endsAt: new Date(), updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
  await audit(s.db, { organizationId: c.organizationId, actorUserId: null, action: 'campaign.delivered', targetType: 'campaign', targetId: campaignId, metadata: { sent, skipped } });
  return { sent, skipped };
}

export async function campaignStats(db: Exec, campaignId: string) {
  const rows = await db.execute<{ status: string; n: number; opened: number; clicked: number; unsubscribed: number }>(sql`
    select status, count(*)::int as n, count(opened_at)::int as opened, count(clicked_at)::int as clicked, count(unsubscribed_at)::int as unsubscribed
    from email_sends where campaign_id = ${campaignId} group by status`);
  const out = { total: 0, sent: 0, sandbox: 0, skipped: 0, failed: 0, opened: 0, clicked: 0, unsubscribed: 0 };
  for (const r of rows) {
    out.total += r.n;
    const o = out as Record<string, number>;
    if (r.status in o) o[r.status] = (o[r.status] ?? 0) + r.n;
    out.opened += r.opened; out.clicked += r.clicked; out.unsubscribed += r.unsubscribed;
  }
  return out;
}

// ───────── Events → automations ─────────

export interface MarketingEventInput {
  organizationId: string;
  type: string;
  /** Business identity of the event (e.g. `lead:<id>`): the same event never starts an automation twice. */
  key: string;
  customerId: string | null;
  locationId: string | null;
  data?: Record<string, unknown>;
}

export async function emitMarketingEvent(s: Services, e: MarketingEventInput): Promise<string | null> {
  const [row] = await s.db.insert(marketingEvents).values({ organizationId: e.organizationId, type: e.type, key: e.key, customerId: e.customerId, locationId: e.locationId, data: e.data ?? {} }).onConflictDoNothing().returning({ id: marketingEvents.id });
  if (!row) return null;
  await s.jobs.enqueue('marketing.event', { eventId: row.id });
  return row.id;
}

/** Upsert a contact from a lead/form (by email within the organisation). */
export async function upsertContact(db: Exec, orgId: string, input: { name: string | null; email: string | null; phone: string | null; locationId: string | null; locale?: string | null }): Promise<CustomerRow | null> {
  if (!input.email && !input.phone) return null;
  if (input.email) {
    const [existing] = await db.select().from(customers).where(and(eq(customers.organizationId, orgId), sql`lower(${customers.email}) = lower(${input.email})`, isNull(customers.erasedAt))).limit(1);
    if (existing) {
      if ((!existing.phone && input.phone) || (!existing.locationId && input.locationId)) {
        const [u] = await db.update(customers).set({ phone: existing.phone ?? input.phone, locationId: existing.locationId ?? input.locationId, updatedAt: new Date() }).where(eq(customers.id, existing.id)).returning();
        return u!;
      }
      return existing;
    }
  }
  const [c] = await db.insert(customers).values({ organizationId: orgId, locationId: input.locationId, name: input.name || input.email || input.phone || '', email: input.email, phone: input.phone, locale: input.locale ?? null }).returning();
  return c!;
}
