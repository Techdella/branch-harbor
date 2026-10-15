/**
 * Franchise development and the new-location flow: jurisdiction rules, prospects and stages, cadences, disclosure
 * delivery with e-receipts, agreement e-signature, fee invoices, onboarding projects, provisioning and go-live.
 *
 * The rules engine (@bh/shared evaluateFranchiseCompliance) is consulted at every step that could break a waiting
 * period or registration requirement: sending the agreement, signing it, and taking any payment.
 */
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  DEFAULT_CADENCES, DEFAULT_EMAIL_TEMPLATES, DEFAULT_JURISDICTION_RULES, ONBOARDING_TEMPLATE, evaluateFranchiseCompliance, jurisdictionCode, stageIndex,
  type ComplianceResult, type FranchiseStage, type JurisdictionRule, type Permission,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  campaigns, fieldOverrides, franchiseActivities, franchiseAgreements, franchiseCadences, franchiseDeliveries, franchiseDocuments, franchiseEmailTemplates,
  franchiseFeeInvoices, franchiseJurisdictionRules, franchiseProjects, franchiseProspects, franchiseRegistrations, franchiseSignatures, franchiseTasks,
  franchiseTerritories, invitations, locations, organizations, ownerGroups, pages, templates, users, websites,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { hasPerm, requireMember, requirePerm } from './authz.ts';
import { approvalExtensions, insertApproval, notifyApprovers } from './approvals.ts';
import { usersWithPermissionAt } from './notifications.ts';
import { createPaymentForTarget, paymentTargetExtensions, type TargetType } from './payments.ts';
import { esignProviders, type ESignProviderKey } from '../integrations/esign.ts';
import { uniqueSlug } from '../routes/locations.ts';
import { originFor } from '../routes/websites.ts';
import { slugify } from '../lib/slug.ts';

export type Prospect = typeof franchiseProspects.$inferSelect;
export type Project = typeof franchiseProjects.$inferSelect;
const DAY = 86_400_000;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

const orgScope = (organizationId: string) => ({ organizationId, kind: 'organization' as const, id: organizationId });

export async function requireOrgPerm(req: FastifyRequest, db: Exec, organizationId: string, perm: Permission) {
  await requirePerm(req, db, perm, orgScope(organizationId));
}

/** Passes when the user holds any of `perms` organisation-wide; 403 otherwise (404 for non-members). */
export async function requireAnyOrgPerm(req: FastifyRequest, db: Exec, organizationId: string, perms: Permission[]) {
  await requireMember(req, db, organizationId);
  for (const p of perms) if (await hasPerm(req, db, p, orgScope(organizationId))) return p;
  throw forbidden(`Missing permission ${perms.join(' or ')}`);
}

export const orgHas = (req: FastifyRequest, db: Exec, organizationId: string, perm: Permission) => hasPerm(req, db, perm, orgScope(organizationId));

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const seeded = new WeakSet<object>();

/** Inserts the shipped platform rules (idempotent). Runs once per database handle. */
export async function ensurePlatformRules(db: Exec) {
  if (seeded.has(db)) return;
  await db.insert(franchiseJurisdictionRules).values(DEFAULT_JURISDICTION_RULES.map((r) => ({
    organizationId: null, code: r.code, country: r.country, region: r.region, version: r.version, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, data: r, reviewedByCounsel: false,
  }))).onConflictDoNothing();
  seeded.add(db);
}

type RuleRow = typeof franchiseJurisdictionRules.$inferSelect;
export function ruleFromRow(r: RuleRow): JurisdictionRule & { id: string; origin: 'platform' | 'organization'; reviewedAt: string | null; reviewNote: string | null } {
  return {
    ...r.data, code: r.code, country: r.country, region: r.region, version: r.version, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo,
    reviewedByCounsel: r.reviewedByCounsel, needsCounselReview: !r.reviewedByCounsel,
    id: r.id, origin: r.organizationId ? 'organization' : 'platform', reviewedAt: iso(r.reviewedAt), reviewNote: r.reviewNote,
  };
}

/** Rules visible to an organisation: platform rows plus its own versions; an organisation row wins for the same code + version. */
export async function loadRules(db: Exec, organizationId: string) {
  await ensurePlatformRules(db);
  const rows = await db.select().from(franchiseJurisdictionRules).where(or(isNull(franchiseJurisdictionRules.organizationId), eq(franchiseJurisdictionRules.organizationId, organizationId)));
  const byKey = new Map<string, RuleRow>();
  for (const r of rows.sort((a, b) => (a.organizationId ? 1 : 0) - (b.organizationId ? 1 : 0))) byKey.set(`${r.code}@${r.version}`, r);
  return [...byKey.values()].map(ruleFromRow).sort((a, b) => a.code.localeCompare(b.code) || b.version.localeCompare(a.version));
}

export function franchiseSettings(org: { country: string; settings: Record<string, unknown> }) {
  const f = (org.settings.franchise ?? {}) as { homeRegion?: string | null; enquiryFormEnabled?: boolean; defaultOwnerUserId?: string | null; collectLocationId?: string | null };
  return { homeCountry: org.country, homeRegion: f.homeRegion ?? null, enquiryFormEnabled: f.enquiryFormEnabled ?? false, defaultOwnerUserId: f.defaultOwnerUserId ?? null, collectLocationId: f.collectLocationId ?? null };
}

async function orgRow(db: Exec, organizationId: string) {
  const [o] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!o) throw notFound('Organisation');
  return o;
}

/** Compliance for a prospect right now (or at `now`). */
export async function prospectCompliance(db: Exec, p: Prospect, now = new Date()): Promise<ComplianceResult> {
  const org = await orgRow(db, p.organizationId);
  const fs = franchiseSettings(org);
  const rules = await loadRules(db, p.organizationId);
  const dels = await db.select({ d: franchiseDeliveries, doc: { jurisdictions: franchiseDocuments.jurisdictions } }).from(franchiseDeliveries)
    .innerJoin(franchiseDocuments, eq(franchiseDocuments.id, franchiseDeliveries.documentId)).where(eq(franchiseDeliveries.prospectId, p.id));
  const regs = await db.select().from(franchiseRegistrations).where(eq(franchiseRegistrations.organizationId, p.organizationId));
  const [signed] = await db.select().from(franchiseSignatures).where(and(eq(franchiseSignatures.prospectId, p.id), eq(franchiseSignatures.status, 'signed'))).orderBy(asc(franchiseSignatures.signedAt)).limit(1);
  const [paid] = await db.select().from(franchiseFeeInvoices).where(and(eq(franchiseFeeInvoices.prospectId, p.id), eq(franchiseFeeInvoices.status, 'paid'))).orderBy(asc(franchiseFeeInvoices.paidAt)).limit(1);
  return evaluateFranchiseCompliance({
    franchisor: { country: fs.homeCountry, region: fs.homeRegion },
    prospect: { country: p.country, region: p.region },
    rules, now,
    deliveries: dels.map(({ d, doc }) => ({ id: d.id, kind: d.kind as 'disclosure' | 'agreement', jurisdictions: doc.jurisdictions, deliveredAt: d.deliveredAt, receiptSignedAt: d.receiptSignedAt, materialChange: d.materialChange })),
    registrations: regs.map((r) => ({ jurisdiction: r.jurisdiction, status: r.status as 'registered', effectiveFrom: r.effectiveFrom, expiresAt: r.expiresAt })),
    agreementSignedAt: signed?.signedAt ?? null,
    firstPaymentAt: paid?.paidAt ?? null,
  });
}

export function blockedError(kind: 'signing' | 'payment' | 'agreement', c: ComplianceResult, blockers = kind === 'payment' ? c.paymentBlockers : c.signingBlockers) {
  const first = blockers[0];
  return new AppError(409, 'franchise_blocked', `${kind === 'payment' ? 'Payment' : kind === 'agreement' ? 'Sending the agreement' : 'Signing'} is blocked: ${first?.message ?? 'requirements not met'}`, undefined, {
    blockers, earliestSigningAt: c.earliestSigningAt, earliestPaymentAt: c.earliestPaymentAt, disclaimer: c.disclaimer,
  });
}

/* ------------------------------------------------------------------ */
/* Defaults, stages, cadences                                          */
/* ------------------------------------------------------------------ */

export async function ensureFranchiseDefaults(db: Exec, organizationId: string) {
  const [c] = await db.select({ id: franchiseCadences.id }).from(franchiseCadences).where(eq(franchiseCadences.organizationId, organizationId)).limit(1);
  if (!c) await db.insert(franchiseCadences).values(DEFAULT_CADENCES.map((d) => ({ organizationId, stage: d.stage, name: d.name, steps: d.steps })));
  await db.insert(franchiseEmailTemplates).values(DEFAULT_EMAIL_TEMPLATES.map((t) => ({ organizationId, ...t }))).onConflictDoNothing();
}

export async function addActivity(db: Exec, p: Pick<Prospect, 'id' | 'organizationId'>, kind: string, body: string | null, actorUserId: string | null, metadata: Record<string, unknown> = {}) {
  await db.insert(franchiseActivities).values({ organizationId: p.organizationId, prospectId: p.id, kind, body, actorUserId, metadata });
}

/** Creates the cadence tasks for the stage the prospect just entered (idempotent per stage entry). */
export async function generateCadenceTasks(db: Exec, p: Prospect) {
  const cads = await db.select().from(franchiseCadences).where(and(eq(franchiseCadences.organizationId, p.organizationId), eq(franchiseCadences.stage, p.stage), eq(franchiseCadences.active, true)));
  let created = 0;
  for (const c of cads) {
    for (const [i, step] of c.steps.entries()) {
      const rows = await db.insert(franchiseTasks).values({
        organizationId: p.organizationId, prospectId: p.id, cadenceId: c.id, sourceKey: `cad:${c.id}:${i}:${p.id}:${p.stageEnteredAt.getTime()}`,
        kind: step.kind, title: step.title, templateKey: step.templateKey ?? null, assignee: 'hq', ownerUserId: step.ownerUserId ?? p.ownerUserId,
        dueAt: new Date(p.stageEnteredAt.getTime() + step.offsetDays * DAY),
      }).onConflictDoNothing().returning({ id: franchiseTasks.id });
      created += rows.length;
    }
  }
  return created;
}

/** Move a prospect to a stage: timeline entry, open cadence tasks of the old stage skipped, new cadence tasks created. */
export async function setStage(db: Exec, p: Prospect, to: FranchiseStage, actorUserId: string | null, note?: string | null, extra: Partial<typeof franchiseProspects.$inferInsert> = {}) {
  if (p.stage === to) return p;
  const now = new Date();
  const [u] = await db.update(franchiseProspects).set({ stage: to, stageEnteredAt: now, updatedAt: now, ...extra }).where(eq(franchiseProspects.id, p.id)).returning();
  await db.update(franchiseTasks).set({ status: 'skipped' }).where(and(eq(franchiseTasks.prospectId, p.id), eq(franchiseTasks.status, 'open'), sql`${franchiseTasks.cadenceId} is not null`));
  await addActivity(db, p, 'stage', note ?? null, actorUserId, { from: p.stage, to });
  await audit(db, { organizationId: p.organizationId, actorUserId, action: 'franchise.prospect_stage', targetType: 'franchise_prospect', targetId: p.id, metadata: { from: p.stage, to } });
  await generateCadenceTasks(db, u!);
  return u!;
}

export async function getProspect(db: Exec, organizationId: string, id: string) {
  const [p] = await db.select().from(franchiseProspects).where(and(eq(franchiseProspects.id, id), eq(franchiseProspects.organizationId, organizationId)));
  if (!p) throw notFound('Prospect');
  return p;
}

/* ------------------------------------------------------------------ */
/* Email                                                               */
/* ------------------------------------------------------------------ */

export function renderTemplate(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

async function templateVars(db: Exec, p: Prospect) {
  const org = await orgRow(db, p.organizationId);
  const [owner] = p.ownerUserId ? await db.select({ name: users.name }).from(users).where(eq(users.id, p.ownerUserId)) : [];
  return { brand: org.name, first_name: p.name.split(/\s+/)[0] ?? p.name, name: p.name, owner_name: owner?.name ?? `${org.name} franchise development` };
}

export async function sendTemplateEmail(s: Services, p: Prospect, templateKey: string, actorUserId: string | null) {
  const [t] = await s.db.select().from(franchiseEmailTemplates).where(and(eq(franchiseEmailTemplates.organizationId, p.organizationId), eq(franchiseEmailTemplates.key, templateKey)));
  if (!t) return false;
  const vars = await templateVars(s.db, p);
  const subject = renderTemplate(t.subject, vars);
  await s.jobs.enqueue('email.send', { to: p.email, subject, text: renderTemplate(t.body, vars), tag: 'franchise' });
  await addActivity(s.db, p, 'email', subject, actorUserId, { templateKey });
  return true;
}

/* ------------------------------------------------------------------ */
/* Public enquiry                                                      */
/* ------------------------------------------------------------------ */

export async function createEnquiry(s: Services, org: typeof organizations.$inferSelect, b: {
  name: string; email: string; phone?: string; country: string; region?: string; city?: string; territoryId?: string; desiredTerritory?: string;
  liquidCapital?: number; netWorth?: number; currency?: string; message?: string; utm?: Record<string, string | undefined>; locale: string; source: string;
}) {
  await ensureFranchiseDefaults(s.db, org.id);
  const fs = franchiseSettings(org);
  let territoryId: string | null = null;
  if (b.territoryId) {
    const [t] = await s.db.select().from(franchiseTerritories).where(and(eq(franchiseTerritories.id, b.territoryId), eq(franchiseTerritories.organizationId, org.id)));
    territoryId = t?.id ?? null;
  }
  const currency = b.currency ?? org.defaultCurrency;
  const toMinor = (v?: number) => (v == null ? null : v * 100);
  const attribution = Object.fromEntries(Object.entries(b.utm ?? {}).filter(([, v]) => !!v)) as Record<string, string>;
  const source = attribution.medium && /cpc|paid|ads?/i.test(attribution.medium) ? 'ads' : attribution.campaign ? 'campaign' : b.source;
  const p = await s.db.transaction(async (tx) => {
    const [p] = await tx.insert(franchiseProspects).values({
      organizationId: org.id, name: b.name, email: b.email.toLowerCase(), phone: b.phone ?? null, country: b.country, region: b.region?.toUpperCase() ?? null, city: b.city ?? null,
      territoryId, desiredTerritory: b.desiredTerritory ?? null, liquidCapitalMinor: toMinor(b.liquidCapital), netWorthMinor: toMinor(b.netWorth), currency,
      source, attribution, message: b.message ?? null, ownerUserId: fs.defaultOwnerUserId, locale: b.locale,
    }).returning();
    await addActivity(tx, p!, 'enquiry', b.message ?? null, null, { source, attribution });
    await audit(tx, { organizationId: org.id, actorUserId: null, actorType: 'system', action: 'franchise.enquiry_received', targetType: 'franchise_prospect', targetId: p!.id, metadata: { source } });
    await generateCadenceTasks(tx, p!);
    return p!;
  });
  // Tell the development team.
  const team = await usersWithPermissionAt(s.db, org.id, null, 'franchise.pipeline.edit');
  const recips = team.length ? await s.db.select({ email: users.email }).from(users).where(inArray(users.id, fs.defaultOwnerUserId ? [fs.defaultOwnerUserId] : team)) : [];
  for (const r of recips) {
    await s.jobs.enqueue('email.send', { to: r.email, subject: `New franchise enquiry: ${p.name} (${jurisdictionCode(p.country, p.region)})`, text: `${p.name} <${p.email}> asked about a franchise${p.desiredTerritory ? ` in ${p.desiredTerritory}` : ''}.\nOpen the pipeline: ${s.cfg.APP_URL}/franchise/prospects?id=${p.id}`, tag: 'franchise' });
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export const MAX_DOC_BYTES = 8 * 1024 * 1024;
export const LEGAL_ONLY_KINDS = new Set(['executed_agreement', 'vault']);

export function decodeUpload(contentBase64: string) {
  const buf = Buffer.from(contentBase64, 'base64');
  if (!buf.length) throw validationError('The file is empty', { contentBase64: 'Empty file' });
  if (buf.length > MAX_DOC_BYTES) throw validationError('The file is larger than 8 MB', { contentBase64: 'Max 8 MB' });
  return { buf, sha: createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

export function serializeDocument(d: typeof franchiseDocuments.$inferSelect) {
  return {
    id: d.id, kind: d.kind, title: d.title, version: d.version, jurisdictions: d.jurisdictions, status: d.status, issuedOn: d.issuedOn,
    fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, sha256: d.sha256, prospectId: d.prospectId, ownerGroupId: d.ownerGroupId, agreementId: d.agreementId,
    createdAt: d.createdAt.toISOString(),
  };
}

/** Who may read a document: legal kinds need legal.view; disclosure / templates need pipeline view or legal view. */
export async function assertCanReadDocument(req: FastifyRequest, db: Exec, d: typeof franchiseDocuments.$inferSelect) {
  if (LEGAL_ONLY_KINDS.has(d.kind)) await requireOrgPerm(req, db, d.organizationId, 'legal.view');
  else await requireAnyOrgPerm(req, db, d.organizationId, ['franchise.pipeline.view', 'legal.view']);
}

/* ------------------------------------------------------------------ */
/* Disclosure delivery + e-receipt                                     */
/* ------------------------------------------------------------------ */

const siteUrl = (s: Services, slug: string, path: string) => `${s.cfg.SITES_BASE_URL}/${slug}${path}`;

export async function sendDisclosure(s: Services, req: FastifyRequest, p: Prospect, documentId: string) {
  const [doc] = await s.db.select().from(franchiseDocuments).where(and(eq(franchiseDocuments.id, documentId), eq(franchiseDocuments.organizationId, p.organizationId)));
  if (!doc || doc.kind !== 'disclosure') throw validationError('Choose a disclosure document', { documentId: 'Not a disclosure document' });
  if (doc.status !== 'current') throw conflict('document_not_current', 'This disclosure document is not the current version');
  if (p.stage === 'lost' || stageIndex(p.stage as FranchiseStage) >= stageIndex('signed')) throw conflict('invalid_stage', 'The prospect is past disclosure');
  const before = await prospectCompliance(s.db, p);
  const code = jurisdictionCode(p.country, p.region);
  const coversProspect = doc.jurisdictions.some((j) => j === code || j === p.country);
  const token = randomToken();
  const org = await orgRow(s.db, p.organizationId);
  const out = await s.db.transaction(async (tx) => {
    const [d] = await tx.insert(franchiseDeliveries).values({ organizationId: p.organizationId, prospectId: p.id, documentId: doc.id, kind: 'disclosure', tokenHash: sha256(token), deliveredBy: req.user!.id }).returning();
    await addActivity(tx, p, 'disclosure_sent', `${doc.title} v${doc.version}`, req.user!.id, { documentId: doc.id, deliveryId: d!.id, jurisdictions: doc.jurisdictions });
    await audit(tx, { organizationId: p.organizationId, actorUserId: req.user!.id, action: 'franchise.disclosure_sent', targetType: 'franchise_prospect', targetId: p.id, metadata: { documentId: doc.id, deliveryId: d!.id }, ip: req.ip });
    const updated = stageIndex(p.stage as FranchiseStage) < stageIndex('disclosure_sent') ? await setStage(tx, p, 'disclosure_sent', req.user!.id) : p;
    return { delivery: d!, prospect: updated };
  });
  const link = siteUrl(s, org.slug, `/franchise/disclosure?token=${encodeURIComponent(token)}`);
  await s.jobs.enqueue('email.send', {
    to: p.email, subject: `${org.name}: franchise disclosure document`,
    text: `Hi ${p.name.split(/\s+/)[0]},\n\nYour ${doc.title} is ready. Open it and sign the receipt here:\n${link}\n\nSigning the receipt only confirms that you received the document. It is not an agreement to buy a franchise. Take time to review it with a lawyer and an accountant.\n\n${org.name}`,
    tag: 'franchise_disclosure',
  });
  const warnings = [
    ...(coversProspect ? [] : [{ code: 'document_jurisdiction_mismatch', message: `This document is not marked for ${code}. Check it is the right disclosure document for the prospect’s location.` }]),
    ...before.warnings.filter((w) => w.code === 'offer_before_registration'),
  ];
  return { ...out, link, devToken: s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS ? token : undefined, warnings };
}

export async function deliveryByToken(db: Exec, token: string) {
  const [d] = await db.select().from(franchiseDeliveries).where(eq(franchiseDeliveries.tokenHash, sha256(token)));
  if (!d) throw notFound('Document');
  const [doc] = await db.select().from(franchiseDocuments).where(eq(franchiseDocuments.id, d.documentId));
  const [p] = await db.select().from(franchiseProspects).where(eq(franchiseProspects.id, d.prospectId));
  const org = await orgRow(db, d.organizationId);
  return { d, doc: doc!, p: p!, org };
}

/** E-receipt: records timestamp, IP, user agent and typed name once; the waiting period starts now. */
export async function signReceipt(s: Services, token: string, name: string, ip: string, userAgent: string | null) {
  const { d, p } = await deliveryByToken(s.db, token);
  if (d.receiptSignedAt) return { alreadySigned: true, receiptSignedAt: d.receiptSignedAt, compliance: await prospectCompliance(s.db, p) };
  const now = new Date();
  await s.db.transaction(async (tx) => {
    await tx.update(franchiseDeliveries).set({ receiptSignedAt: now, receiptName: name, receiptIp: ip, receiptUserAgent: userAgent?.slice(0, 300) ?? null, openedAt: d.openedAt ?? now }).where(eq(franchiseDeliveries.id, d.id));
    await addActivity(tx, p, 'receipt_signed', name, null, { deliveryId: d.id, ip, at: now.toISOString() });
    await audit(tx, { organizationId: p.organizationId, actorUserId: null, actorType: 'system', action: 'franchise.receipt_signed', targetType: 'franchise_prospect', targetId: p.id, metadata: { deliveryId: d.id }, ip });
  });
  const c = await prospectCompliance(s.db, p);
  if (d.kind === 'disclosure' && stageIndex(p.stage as FranchiseStage) < stageIndex('waiting_period') && p.stage !== 'lost') {
    const waiting = c.signingBlockers.some((b) => b.code === 'waiting_period');
    await setStage(s.db, p, waiting ? 'waiting_period' : 'disclosure_receipt_signed', null, null);
  }
  return { alreadySigned: false, receiptSignedAt: now, compliance: c };
}

/* ------------------------------------------------------------------ */
/* Agreement e-signature                                               */
/* ------------------------------------------------------------------ */

export interface AgreementTerms {
  startDate?: string; termYears?: number; renewalOption?: string; royaltyBps?: number; marketingFundBps?: number; territory?: string; units?: number;
}

export async function sendAgreement(s: Services, req: FastifyRequest, p: Prospect, b: { documentId: string; provider: ESignProviderKey; materialChange: boolean; terms: AgreementTerms }) {
  const [doc] = await s.db.select().from(franchiseDocuments).where(and(eq(franchiseDocuments.id, b.documentId), eq(franchiseDocuments.organizationId, p.organizationId)));
  if (!doc || doc.kind !== 'agreement_template') throw validationError('Choose an agreement document', { documentId: 'Not an agreement document' });
  if (p.stage === 'lost' || stageIndex(p.stage as FranchiseStage) >= stageIndex('signed')) throw conflict('invalid_stage', 'The agreement is already signed or the prospect is lost');
  const c = await prospectCompliance(s.db, p);
  // Sending the agreement is part of the offer: registration must already be in effect.
  const reg = c.signingBlockers.filter((x) => x.code === 'registration_required');
  if (reg.length) {
    await addActivity(s.db, p, 'blocked', reg[0]!.message, req.user!.id, { step: 'agreement_send', blockers: reg });
    throw blockedError('agreement', c, reg);
  }
  const provider = esignProviders()[b.provider];
  const org = await orgRow(s.db, p.organizationId);
  const env = await provider.send({ organizationId: p.organizationId, prospectId: p.id, documentTitle: doc.title, signer: { name: p.name, email: p.email } });
  const deliveryToken = randomToken();
  const out = await s.db.transaction(async (tx) => {
    const [d] = await tx.insert(franchiseDeliveries).values({ organizationId: p.organizationId, prospectId: p.id, documentId: doc.id, kind: 'agreement', materialChange: b.materialChange, tokenHash: sha256(deliveryToken), deliveredBy: req.user!.id }).returning();
    const [sig] = await tx.insert(franchiseSignatures).values({
      organizationId: p.organizationId, prospectId: p.id, documentId: doc.id, deliveryId: d!.id, provider: env.provider, providerEnvelopeId: env.envelopeId,
      tokenHash: env.token ? sha256(env.token) : null, terms: b.terms as Record<string, unknown>, sentBy: req.user!.id,
    }).returning();
    await addActivity(tx, p, 'agreement_sent', `${doc.title} v${doc.version}`, req.user!.id, { signatureId: sig!.id, provider: env.provider, materialChange: b.materialChange });
    await audit(tx, { organizationId: p.organizationId, actorUserId: req.user!.id, action: 'franchise.agreement_sent', targetType: 'franchise_prospect', targetId: p.id, metadata: { signatureId: sig!.id, provider: env.provider }, ip: req.ip });
    const updated = await setStage(tx, p, 'agreement_sent', req.user!.id);
    return { signature: sig!, prospect: updated };
  });
  const link = env.token ? siteUrl(s, org.slug, `/franchise/sign?token=${encodeURIComponent(env.token)}`) : null;
  if (link) {
    const after = await prospectCompliance(s.db, out.prospect);
    await s.jobs.enqueue('email.send', {
      to: p.email, subject: `${org.name}: your franchise agreement`,
      text: `Hi ${p.name.split(/\s+/)[0]},\n\nYour franchise agreement is ready to review${after.earliestSigningAt ? `. It can be signed from ${after.earliestSigningAt.slice(0, 10)}` : ''}:\n${link}\n\n${org.name}`,
      tag: 'franchise_agreement',
    });
  }
  return { ...out, link, devToken: env.token && s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS ? env.token : undefined };
}

export async function signatureByToken(db: Exec, token: string) {
  const [sig] = await db.select().from(franchiseSignatures).where(eq(franchiseSignatures.tokenHash, sha256(token)));
  if (!sig) throw notFound('Agreement');
  const [doc] = await db.select().from(franchiseDocuments).where(eq(franchiseDocuments.id, sig.documentId));
  const [p] = await db.select().from(franchiseProspects).where(eq(franchiseProspects.id, sig.prospectId));
  const org = await orgRow(db, sig.organizationId);
  return { sig, doc: doc!, p: p!, org };
}

/**
 * Complete a signature (built-in link, provider callback or a recorded wet-ink signature). Re-checks the rules at
 * this moment and refuses while any signing blocker remains. On success: agreements register entry, owner group,
 * territory sold, onboarding project.
 */
export async function completeSignature(s: Services, sigId: string, signer: { name: string; ip: string | null; userAgent: string | null; actorUserId: string | null }) {
  const [sig] = await s.db.select().from(franchiseSignatures).where(eq(franchiseSignatures.id, sigId));
  if (!sig) throw notFound('Agreement');
  if (sig.status === 'signed') throw conflict('already_signed', 'This agreement is already signed');
  if (sig.status !== 'sent') throw conflict('envelope_closed', `This agreement was ${sig.status}`);
  const p = await getProspect(s.db, sig.organizationId, sig.prospectId);
  const c = await prospectCompliance(s.db, p);
  if (!c.canSign) {
    await addActivity(s.db, p, 'blocked', c.signingBlockers[0]?.message ?? null, signer.actorUserId, { step: 'signing', blockers: c.signingBlockers });
    throw blockedError('signing', c);
  }
  const now = new Date();
  const org = await orgRow(s.db, p.organizationId);
  const terms = sig.terms as AgreementTerms;
  const result = await s.db.transaction(async (tx) => {
    const [claimed] = await tx.update(franchiseSignatures).set({ status: 'signed', signedAt: now, signerName: signer.name, signerIp: signer.ip, signerUserAgent: signer.userAgent?.slice(0, 300) ?? null })
      .where(and(eq(franchiseSignatures.id, sig.id), eq(franchiseSignatures.status, 'sent'))).returning();
    if (!claimed) throw conflict('already_signed', 'This agreement is already signed');
    await tx.update(franchiseSignatures).set({ status: 'voided' }).where(and(eq(franchiseSignatures.prospectId, p.id), eq(franchiseSignatures.status, 'sent')));
    const [group] = await tx.insert(ownerGroups).values({ organizationId: p.organizationId, name: p.name, legalName: p.name }).returning();
    let territoryName = terms.territory ?? p.desiredTerritory ?? null;
    if (p.territoryId) {
      const [t] = await tx.update(franchiseTerritories).set({ status: 'sold', ownerGroupId: group!.id, reservedForProspectId: null, updatedAt: now }).where(eq(franchiseTerritories.id, p.territoryId)).returning();
      territoryName = territoryName ?? t?.name ?? null;
    }
    const start = terms.startDate ?? now.toISOString().slice(0, 10);
    const years = terms.termYears ?? 10;
    const end = new Date(`${start}T00:00:00Z`);
    end.setUTCFullYear(end.getUTCFullYear() + years);
    const [ag] = await tx.insert(franchiseAgreements).values({
      organizationId: p.organizationId, ownerGroupId: group!.id, prospectId: p.id, territoryId: p.territoryId, territory: territoryName, jurisdiction: jurisdictionCode(p.country, p.region),
      startDate: start, endDate: end.toISOString().slice(0, 10), termYears: years, renewalOption: terms.renewalOption ?? null,
      royaltyBps: terms.royaltyBps ?? null, marketingFundBps: terms.marketingFundBps ?? null, terms: { ...terms, signatureId: sig.id }, documentId: sig.documentId, createdBy: signer.actorUserId,
    }).returning();
    await addActivity(tx, p, 'agreement_signed', signer.name, signer.actorUserId, { signatureId: sig.id, agreementId: ag!.id, ip: signer.ip });
    await audit(tx, { organizationId: p.organizationId, actorUserId: signer.actorUserId, actorType: signer.actorUserId ? 'user' : 'system', action: 'franchise.agreement_signed', targetType: 'franchise_prospect', targetId: p.id, metadata: { signatureId: sig.id, agreementId: ag!.id }, ip: signer.ip });
    const signedP = await setStage(tx, p, 'signed', signer.actorUserId, null, { ownerGroupId: group!.id });
    const project = await startOnboarding(tx, signedP, org.name);
    const onboardingP = await setStage(tx, signedP, 'onboarding', signer.actorUserId);
    return { agreement: ag!, ownerGroup: group!, project, prospect: onboardingP };
  });
  return { ...result, compliance: await prospectCompliance(s.db, result.prospect) };
}

/* ------------------------------------------------------------------ */
/* Fee invoices (existing payments)                                    */
/* ------------------------------------------------------------------ */

export async function createFeeInvoice(s: Services, req: FastifyRequest, p: Prospect, b: { amountMinor: number; currency: string; description: string; collectLocationId?: string }) {
  const c = await prospectCompliance(s.db, p);
  if (!c.canPay) {
    await addActivity(s.db, p, 'blocked', c.paymentBlockers[0]?.message ?? null, req.user!.id, { step: 'payment', blockers: c.paymentBlockers });
    throw blockedError('payment', c);
  }
  // Rules first (so the reason is always visible to the development team), then the payments permission.
  await requireOrgPerm(req, s.db, p.organizationId, 'payments.read');
  const org = await orgRow(s.db, p.organizationId);
  const collectLocationId = b.collectLocationId ?? franchiseSettings(org).collectLocationId;
  if (!collectLocationId) throw validationError('Choose the HQ location whose payment account collects franchise fees', { collectLocationId: 'Required' });
  const [inv] = await s.db.insert(franchiseFeeInvoices).values({ organizationId: p.organizationId, prospectId: p.id, collectLocationId, description: b.description, amountMinor: b.amountMinor, currency: b.currency, createdBy: req.user!.id }).returning();
  try {
    const pay = await createPaymentForTarget(s, { organizationId: p.organizationId, locationId: collectLocationId, amountMinor: b.amountMinor, currency: b.currency, targetType: 'franchise_fee' as TargetType, targetId: inv!.id, description: `${org.name}: ${b.description}` });
    const [u] = await s.db.update(franchiseFeeInvoices).set({ paymentId: pay.payment.id }).where(eq(franchiseFeeInvoices.id, inv!.id)).returning();
    await addActivity(s.db, p, 'payment', b.description, req.user!.id, { invoiceId: inv!.id, amountMinor: b.amountMinor, currency: b.currency, state: 'requested' });
    return { invoice: u!, payment: pay.payment, clientSecret: pay.clientSecret, sandbox: pay.sandbox };
  } catch (err) {
    await s.db.delete(franchiseFeeInvoices).where(eq(franchiseFeeInvoices.id, inv!.id));
    throw err;
  }
}

paymentTargetExtensions.franchise_fee = {
  async fulfil(tx, pay) {
    const [inv] = await tx.select().from(franchiseFeeInvoices).where(eq(franchiseFeeInvoices.id, pay.targetId!)).for('update');
    if (!inv) return { fulfilled: false, note: 'Fee invoice missing' };
    if (inv.status === 'paid') return { fulfilled: true, note: 'Already paid' };
    await tx.update(franchiseFeeInvoices).set({ status: 'paid', paidAt: new Date() }).where(eq(franchiseFeeInvoices.id, inv.id));
    await tx.insert(franchiseActivities).values({ organizationId: inv.organizationId, prospectId: inv.prospectId, kind: 'payment', body: inv.description, metadata: { invoiceId: inv.id, state: 'paid', amountMinor: inv.amountMinor, currency: inv.currency } });
    return { fulfilled: true, note: 'Franchise fee paid' };
  },
  async isRecorded(db, pay) {
    const [inv] = await db.select().from(franchiseFeeInvoices).where(eq(franchiseFeeInvoices.id, pay.targetId!));
    return { ok: inv?.status === 'paid', expected: inv ? { amount: inv.amountMinor, currency: inv.currency } : null };
  },
};

/* ------------------------------------------------------------------ */
/* Onboarding, provisioning, go-live                                   */
/* ------------------------------------------------------------------ */

export async function startOnboarding(db: Exec, p: Prospect, brand: string) {
  const [existing] = await db.select().from(franchiseProjects).where(and(eq(franchiseProjects.prospectId, p.id), sql`${franchiseProjects.status} <> 'cancelled'`));
  if (existing) return existing;
  const start = new Date();
  const [proj] = await db.insert(franchiseProjects).values({
    organizationId: p.organizationId, prospectId: p.id, ownerGroupId: p.ownerGroupId, templateKey: ONBOARDING_TEMPLATE.key,
    name: `${brand} ${p.city ?? p.desiredTerritory ?? p.name}`, hqOwnerUserId: p.ownerUserId, ownerEmail: p.email,
    targetOpenDate: new Date(start.getTime() + 120 * DAY).toISOString().slice(0, 10), startedAt: start,
  }).returning();
  await db.insert(franchiseTasks).values(ONBOARDING_TEMPLATE.tasks.map((t) => ({
    organizationId: p.organizationId, projectId: proj!.id, sourceKey: `proj:${proj!.id}:${t.key}`, section: t.section, kind: 'task', title: t.title,
    assignee: t.assignee, ownerUserId: t.assignee === 'hq' ? p.ownerUserId : null, gate: !!t.gate, dueAt: new Date(start.getTime() + t.offsetDays * DAY),
  })));
  return proj!;
}

export async function getProject(db: Exec, organizationId: string, id: string) {
  const [proj] = await db.select().from(franchiseProjects).where(and(eq(franchiseProjects.id, id), eq(franchiseProjects.organizationId, organizationId)));
  if (!proj) throw notFound('Project');
  return proj;
}

/** HQ (pipeline view) sees every project; a franchise owner sees the project of a location they operate. */
export async function assertProjectAccess(req: FastifyRequest, db: Exec, proj: Project, write: boolean) {
  if (await orgHas(req, db, proj.organizationId, write ? 'franchise.pipeline.edit' : 'franchise.pipeline.view')) return 'hq' as const;
  if (proj.locationId && (await hasPerm(req, db, write ? 'operations.write' : 'operations.read', { organizationId: proj.organizationId, kind: 'location', id: proj.locationId }))) return 'owner' as const;
  await requireMember(req, db, proj.organizationId);
  throw forbidden('You cannot open this onboarding project');
}

export interface ProvisionInput {
  name: string; code: string; address: { line1: string; line2?: string; city: string; region?: string; postalCode?: string; country: string };
  timeZone: string; currency: string; locale?: string; regionId?: string; templateId?: string; ownerEmail?: string;
}

/** Create the location from the brand template (draft website, not public), the "coming soon" campaign, and invite the owner. */
export async function provisionLocation(s: Services, req: FastifyRequest, proj: Project, b: ProvisionInput) {
  if (proj.locationId) throw conflict('already_provisioned', 'This project already has a location');
  if (proj.status !== 'active') throw conflict('project_not_active', `The project is ${proj.status}`);
  const org = await orgRow(s.db, proj.organizationId);
  const [dupe] = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, org.id), eq(locations.code, b.code)));
  if (dupe) throw validationError('Location code already in use', { code: 'Each location needs a unique internal code' });
  const [tpl] = b.templateId
    ? await s.db.select().from(templates).where(and(eq(templates.id, b.templateId), eq(templates.organizationId, org.id)))
    : await s.db.select().from(templates).where(eq(templates.organizationId, org.id)).orderBy(asc(templates.createdAt)).limit(1);
  if (b.templateId && !tpl) throw notFound('Template');
  const geo = await s.geocoder.geocode(`${b.address.line1}, ${b.address.city}, ${b.address.country}`);
  const ownerEmail = (b.ownerEmail ?? proj.ownerEmail ?? '').toLowerCase();
  const token = randomToken();
  const out = await s.db.transaction(async (tx) => {
    const [loc] = await tx.insert(locations).values({
      organizationId: org.id, regionId: b.regionId ?? null, ownerGroupId: proj.ownerGroupId, name: b.name, code: b.code, slug: await uniqueSlug(tx, org.id, b.name),
      address: b.address, country: b.address.country, timeZone: b.timeZone, currency: b.currency, locale: b.locale ?? org.defaultLocale, templateId: tpl?.id ?? null,
      status: 'onboarding', publiclyVisible: false, geo,
    }).returning();
    await audit(tx, { organizationId: org.id, actorUserId: req.user!.id, action: 'location.created', scopeKind: 'location', scopeId: loc!.id, targetType: 'location', targetId: loc!.id, metadata: { via: 'franchise_project', projectId: proj.id }, ip: req.ip });
    const [site] = await tx.insert(websites).values({ organizationId: org.id, locationId: loc!.id, kind: 'hosted', templateId: tpl?.id ?? null, includedAddress: `${s.cfg.SITES_BASE_URL}/${org.slug}/${loc!.slug}` }).returning();
    const [page] = await tx.insert(pages).values({ organizationId: org.id, websiteId: site!.id, locationId: loc!.id, templateId: tpl?.id ?? null, slug: slugify('home'), title: 'Home' }).returning();
    if (tpl?.fields.length) {
      await tx.insert(fieldOverrides).values(tpl.fields.map((f) => ({ organizationId: org.id, pageId: page!.id, fieldKey: f.key, origin: originFor(f.policy), value: f.defaultValue ?? null, hqValue: f.defaultValue ?? null })));
    }
    const [camp] = await tx.insert(campaigns).values({ organizationId: org.id, scopeKind: 'location', scopeId: loc!.id, name: `Coming soon: ${b.name}`, channel: 'email', status: 'draft', content: { kind: 'coming_soon', projectId: proj.id }, currency: b.currency, createdBy: req.user!.id }).returning();
    let invitationId: string | null = null;
    if (ownerEmail && proj.ownerGroupId) {
      const [inv] = await tx.insert(invitations).values({ organizationId: org.id, email: ownerEmail, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: proj.ownerGroupId, tokenHash: sha256(token), invitedBy: req.user!.id, expiresAt: new Date(Date.now() + 14 * DAY) }).returning();
      invitationId = inv!.id;
      await audit(tx, { organizationId: org.id, actorUserId: req.user!.id, action: 'member.invited', scopeKind: 'owner_group', scopeId: proj.ownerGroupId, targetType: 'invitation', targetId: inv!.id, metadata: { email: ownerEmail, role: 'franchise_owner', via: 'franchise_project' }, ip: req.ip });
    }
    const [u] = await tx.update(franchiseProjects).set({ locationId: loc!.id, ownerInvitationId: invitationId, ownerEmail: ownerEmail || null, updatedAt: new Date() }).where(eq(franchiseProjects.id, proj.id)).returning();
    await tx.update(franchiseTasks).set({ status: 'done', completedAt: new Date(), completedBy: req.user!.id }).where(and(eq(franchiseTasks.projectId, proj.id), eq(franchiseTasks.sourceKey, `proj:${proj.id}:systems_provisioned`)));
    if (proj.prospectId) {
      await tx.update(franchiseAgreements).set({ locationIds: sql`array_append(${franchiseAgreements.locationIds}, ${loc!.id}::uuid)`, updatedAt: new Date() }).where(eq(franchiseAgreements.prospectId, proj.prospectId));
      await tx.insert(franchiseActivities).values({ organizationId: org.id, prospectId: proj.prospectId, kind: 'note', body: `Location provisioned: ${b.name}`, actorUserId: req.user!.id, metadata: { locationId: loc!.id } });
    }
    return { project: u!, location: loc!, websiteId: site!.id, campaignId: camp!.id, invitationId };
  });
  if (out.invitationId) {
    await s.jobs.enqueue('email.send', {
      to: ownerEmail, subject: `Welcome to ${org.name} on BranchHarbor`,
      text: `You've been invited to run ${b.name} as a ${org.name} franchise owner.\nAccept: ${s.cfg.APP_URL}/invitations/accept?token=${encodeURIComponent(token)}\nThis invitation expires in 14 days.`,
      tag: 'invitation',
    });
  }
  return { ...out, devInvitationToken: out.invitationId && s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS && s.mailer.mode === 'log' ? token : undefined };
}

export async function requestGoLive(s: Services, req: FastifyRequest, proj: Project, comment?: string) {
  if (proj.status === 'go_live_requested') throw conflict('already_requested', 'Opening approval was already requested');
  if (proj.status !== 'active') throw conflict('project_not_active', `The project is ${proj.status}`);
  if (!proj.locationId) throw conflict('not_provisioned', 'Provision the location before requesting the opening');
  const gates = await s.db.select().from(franchiseTasks).where(and(eq(franchiseTasks.projectId, proj.id), eq(franchiseTasks.gate, true)));
  const open = gates.filter((g) => g.status !== 'done');
  if (open.length) throw new AppError(409, 'checklist_incomplete', `${open.length} pre-opening checks are not done yet`, undefined, { open: open.map((g) => ({ id: g.id, title: g.title })) });
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, proj.locationId));
  const ap = await s.db.transaction(async (tx) => {
    const ap = await insertApproval(tx, {
      organizationId: proj.organizationId, locationId: proj.locationId, kind: 'location_go_live', targetId: proj.id, title: `Open ${loc?.name ?? proj.name}`,
      titleI18n: { code: 'location_go_live', params: { location: loc?.name ?? proj.name } }, payload: { projectId: proj.id, locationId: proj.locationId }, requestedBy: req.user!.id, comment: comment ?? null,
    }, req.ip);
    await tx.update(franchiseProjects).set({ status: 'go_live_requested', approvalId: ap.id, updatedAt: new Date() }).where(eq(franchiseProjects.id, proj.id));
    return ap;
  });
  await notifyApprovers(s, ap).catch(() => {});
  return ap;
}

/** Approval executor: open the location, finish the project, move the prospect to opened, make sure the owner is invited. */
async function executeGoLive(s: Services, projectId: string, approverId: string, ip: string) {
  return s.db.transaction(async (tx) => {
    const [proj] = await tx.select().from(franchiseProjects).where(eq(franchiseProjects.id, projectId)).for('update');
    if (!proj || proj.status !== 'go_live_requested' || !proj.locationId) throw conflict('project_changed', 'The project is no longer waiting for opening approval');
    const now = new Date();
    const [loc] = await tx.update(locations).set({ status: 'operating', publiclyVisible: true, updatedAt: now }).where(eq(locations.id, proj.locationId)).returning();
    await tx.update(franchiseProjects).set({ status: 'opened', openedAt: now, updatedAt: now }).where(eq(franchiseProjects.id, proj.id));
    let invitationId = proj.ownerInvitationId;
    let devToken: string | undefined;
    if (!invitationId && proj.ownerEmail && proj.ownerGroupId) {
      const token = randomToken();
      const [inv] = await tx.insert(invitations).values({ organizationId: proj.organizationId, email: proj.ownerEmail, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: proj.ownerGroupId, tokenHash: sha256(token), invitedBy: approverId, expiresAt: new Date(Date.now() + 14 * DAY) }).returning();
      invitationId = inv!.id;
      devToken = token;
      await tx.update(franchiseProjects).set({ ownerInvitationId: invitationId }).where(eq(franchiseProjects.id, proj.id));
    }
    if (proj.prospectId) {
      const [p] = await tx.select().from(franchiseProspects).where(eq(franchiseProspects.id, proj.prospectId));
      if (p && p.stage !== 'opened') await setStage(tx, p, 'opened', approverId, `Opened: ${loc?.name}`);
    }
    await audit(tx, { organizationId: proj.organizationId, actorUserId: approverId, action: 'location.opened', scopeKind: 'location', scopeId: proj.locationId, targetType: 'location', targetId: proj.locationId, metadata: { projectId: proj.id }, ip });
    return { projectId: proj.id, locationId: proj.locationId, locationStatus: loc?.status ?? null, publiclyVisible: loc?.publiclyVisible ?? null, ownerInvitationId: invitationId, ...(devToken && s.cfg.NODE_ENV !== 'production' ? { devInvitationToken: devToken } : {}) };
  });
}

approvalExtensions.location_go_live = {
  execute: (s, ap, approverId, ip) => executeGoLive(s, ap.targetId, approverId, ip),
  async reject(tx, ap) {
    await tx.update(franchiseProjects).set({ status: 'active', approvalId: null, updatedAt: new Date() }).where(and(eq(franchiseProjects.id, ap.targetId), eq(franchiseProjects.status, 'go_live_requested')));
  },
};

/* ------------------------------------------------------------------ */
/* Reminders (cadence emails, task reminders, agreement expiry)        */
/* ------------------------------------------------------------------ */

export const EXPIRY_REMINDER_DAYS = [180, 90, 30] as const;

export async function runFranchiseJobs(s: Services, now = new Date(), organizationId?: string) {
  const inOrg = (col: typeof franchiseTasks.organizationId | typeof franchiseAgreements.organizationId) => (organizationId ? eq(col, organizationId) : undefined);
  let emails = 0, reminders = 0, expiry = 0, skipped = 0;
  // Cadence emails that are due: send while the prospect is still in the stage the cadence belongs to.
  const due = await s.db.select({ t: franchiseTasks, p: franchiseProspects, c: franchiseCadences }).from(franchiseTasks)
    .innerJoin(franchiseProspects, eq(franchiseProspects.id, franchiseTasks.prospectId))
    .innerJoin(franchiseCadences, eq(franchiseCadences.id, franchiseTasks.cadenceId))
    .where(and(eq(franchiseTasks.status, 'open'), eq(franchiseTasks.kind, 'email'), lte(franchiseTasks.dueAt, now), inOrg(franchiseTasks.organizationId)));
  for (const { t, p, c } of due) {
    if (p.stage !== c.stage) { await s.db.update(franchiseTasks).set({ status: 'skipped' }).where(eq(franchiseTasks.id, t.id)); skipped++; continue; }
    const [claimed] = await s.db.update(franchiseTasks).set({ status: 'done', completedAt: now }).where(and(eq(franchiseTasks.id, t.id), eq(franchiseTasks.status, 'open'))).returning();
    if (claimed && t.templateKey && (await sendTemplateEmail(s, p, t.templateKey, null))) emails++;
  }
  // Calls / tasks due today and not yet reminded: remind the owner by email.
  const todo = await s.db.select({ t: franchiseTasks, email: users.email }).from(franchiseTasks).innerJoin(users, eq(users.id, franchiseTasks.ownerUserId))
    .where(and(eq(franchiseTasks.status, 'open'), sql`${franchiseTasks.kind} <> 'email'`, lte(franchiseTasks.dueAt, now), isNull(franchiseTasks.remindedAt), inOrg(franchiseTasks.organizationId)));
  for (const { t, email } of todo) {
    await s.jobs.enqueue('email.send', { to: email, subject: `Due: ${t.title}`, text: `${t.title} is due.\nOpen: ${s.cfg.APP_URL}/franchise/${t.projectId ? 'onboarding' : 'pipeline'}`, tag: 'franchise_task' });
    await s.db.update(franchiseTasks).set({ remindedAt: now }).where(eq(franchiseTasks.id, t.id));
    reminders++;
  }
  // Agreement expiry / renewal reminders to legal.
  const today = now.toISOString().slice(0, 10);
  const ags = await s.db.select().from(franchiseAgreements).where(and(eq(franchiseAgreements.status, 'active'), inOrg(franchiseAgreements.organizationId)));
  for (const a of ags) {
    if (a.endDate < today) { await s.db.update(franchiseAgreements).set({ status: 'expired', updatedAt: now }).where(eq(franchiseAgreements.id, a.id)); continue; }
    const daysLeft = Math.ceil((new Date(`${a.endDate}T00:00:00Z`).getTime() - now.getTime()) / DAY);
    const step = EXPIRY_REMINDER_DAYS.filter((d) => daysLeft <= d && !a.remindersSent.includes(d)).sort((x, y) => x - y)[0];
    if (step === undefined) continue;
    const legal = await usersWithPermissionAt(s.db, a.organizationId, null, 'legal.view');
    const emailsTo = legal.length ? await s.db.select({ email: users.email }).from(users).where(inArray(users.id, legal)) : [];
    const [g] = a.ownerGroupId ? await s.db.select({ name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.id, a.ownerGroupId)) : [];
    for (const r of emailsTo) {
      await s.jobs.enqueue('email.send', { to: r.email, subject: `Franchise agreement expires in ${daysLeft} days: ${g?.name ?? a.territory ?? ''}`, text: `The franchise agreement for ${g?.name ?? 'a franchisee'} ends on ${a.endDate}.${a.renewalOption ? `\nRenewal option: ${a.renewalOption}` : ''}\nCheck the renewal and notice rules for ${a.jurisdiction ?? 'the jurisdiction'} with counsel.\nOpen: ${s.cfg.APP_URL}/franchise/agreements`, tag: 'franchise_agreement_expiry' });
    }
    await s.db.update(franchiseAgreements).set({ remindersSent: [...a.remindersSent, ...EXPIRY_REMINDER_DAYS.filter((d) => d >= step && !a.remindersSent.includes(d))], updatedAt: now }).where(eq(franchiseAgreements.id, a.id));
    expiry++;
  }
  return { emails, reminders, expiry, skipped };
}

/* ------------------------------------------------------------------ */
/* Serializers                                                         */
/* ------------------------------------------------------------------ */

const money = (amount: number | null, currency: string | null) => (amount != null && currency ? { amount, currency } : null);

export function serializeProspect(p: Prospect, extra: { territoryName?: string | null; ownerName?: string | null; compliance?: ComplianceResult | null } = {}) {
  return {
    id: p.id, name: p.name, email: p.email, phone: p.phone, country: p.country, region: p.region, city: p.city, jurisdiction: jurisdictionCode(p.country, p.region),
    territoryId: p.territoryId, territoryName: extra.territoryName ?? null, desiredTerritory: p.desiredTerritory,
    liquidCapital: money(p.liquidCapitalMinor, p.currency), netWorth: money(p.netWorthMinor, p.currency), selfDeclared: true, units: p.units,
    source: p.source, campaignId: p.campaignId, attribution: p.attribution, message: p.message, stage: p.stage, stageEnteredAt: p.stageEnteredAt.toISOString(),
    ownerUserId: p.ownerUserId, ownerName: extra.ownerName ?? null, lostReason: p.lostReason, ownerGroupId: p.ownerGroupId, locale: p.locale,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
    ...(extra.compliance !== undefined ? { compliance: extra.compliance } : {}),
  };
}

export function serializeTask(t: typeof franchiseTasks.$inferSelect, ownerName?: string | null) {
  return {
    id: t.id, prospectId: t.prospectId, projectId: t.projectId, cadenceId: t.cadenceId, section: t.section, kind: t.kind, title: t.title, templateKey: t.templateKey,
    assignee: t.assignee, ownerUserId: t.ownerUserId, ownerName: ownerName ?? null, gate: t.gate, dueAt: iso(t.dueAt), status: t.status, completedAt: iso(t.completedAt),
    overdue: t.status === 'open' && !!t.dueAt && t.dueAt < new Date(),
  };
}

export async function userNames(db: Exec, ids: Array<string | null | undefined>) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const rows = uniq.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq)) : [];
  return new Map(rows.map((r) => [r.id, r.name]));
}

export function serializeAgreement(a: typeof franchiseAgreements.$inferSelect, ownerGroupName: string | null, now = new Date()) {
  const daysLeft = Math.ceil((new Date(`${a.endDate}T00:00:00Z`).getTime() - now.getTime()) / DAY);
  return {
    id: a.id, ownerGroupId: a.ownerGroupId, ownerGroupName, prospectId: a.prospectId, territoryId: a.territoryId, territory: a.territory, locationIds: a.locationIds, jurisdiction: a.jurisdiction,
    startDate: a.startDate, endDate: a.endDate, termYears: a.termYears, renewalOption: a.renewalOption, royaltyBps: a.royaltyBps, marketingFundBps: a.marketingFundBps,
    terms: a.terms, status: a.status, documentId: a.documentId, daysToExpiry: daysLeft, expiringSoon: a.status === 'active' && daysLeft <= 180, remindersSent: a.remindersSent,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listOrderedActivities(db: Exec, prospectId: string) {
  return db.select().from(franchiseActivities).where(eq(franchiseActivities.prospectId, prospectId)).orderBy(desc(franchiseActivities.createdAt));
}
