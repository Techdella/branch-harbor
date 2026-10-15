import { and, asc, desc, eq, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AMENDMENT_FIELDS, COUNSEL_NOTICE, DEFAULT_CURE_DAYS, DEVELOPMENT_ITEM_STATUSES, NOTICE_KINDS, NOTICE_REASONS, RENEWAL_CONDITIONS, TRANSFER_APPROVAL_STEPS, TRANSFER_STEPS, addDaysYmd, addMonthsYmd,
  currency, renderNotice, renewalPhase, renewalWindow, scheduleProgress, type NoticeKind, type NoticeReason,
} from '@bh/shared';
import type { Services } from '../context.ts';
import {
  agreementAmendments, agreementNotices, agreementRenewals, agreementTransfers, developmentAgreements, developmentScheduleItems, franchiseAgreements, franchiseProspects, franchiseTerritories,
  locations, organizations, ownerGroups, territories, type TransferStepState,
} from '../db/schema/index.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { renderPdf } from '../lib/pdf.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { hasCapability, requireMember } from '../services/authz.ts';
import { loadRules } from '../services/franchise.ts';
import { orgToday } from '../services/franchise-dev/surveys.ts';
import { networkNotify } from '../services/network-notify.ts';
import { userNames } from '../services/network-access.ts';
import { usersWithCapability } from '../services/audits.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';

const tags = ['legal'];
const MODULE = 'legal.lifecycle';
const org = (organizationId: string) => ({ organizationId, kind: 'organization' as const, id: organizationId });
type Agreement = typeof franchiseAgreements.$inferSelect;
type Notice = typeof agreementNotices.$inferSelect;
type Transfer = typeof agreementTransfers.$inferSelect;

/** Default renewal option window, overridable per agreement in `terms.renewalWindowMonths` ([open, close]). */
const windowOf = (a: Agreement) => {
  const w = (a.terms as { renewalWindowMonths?: [number, number] }).renewalWindowMonths;
  return renewalWindow(a.endDate, w?.[0] ?? 12, w?.[1] ?? 6);
};

/**
 * Agreement lifecycle (`/v1/orgs/:orgId/lifecycle`, module `legal.lifecycle`, organisation-wide): transfers, notices
 * of default with cure periods and termination, amendments, renewals with option windows and multi-unit development
 * schedules. Franchise owners see their own (issued notices, transfers, renewals and schedules) at `/lifecycle/mine`.
 */
export const lifecycleRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  const can = (req: Parameters<typeof hasCapability>[0], orgId: string, action: 'view' | 'edit' | 'publish' | 'export') => hasCapability(req, db, MODULE, action, org(orgId));
  const need = async (req: Parameters<typeof hasCapability>[0], orgId: string, action: 'view' | 'edit' | 'publish' | 'export') => {
    await requireMember(req, db, orgId);
    if (!(await can(req, orgId, action))) throw forbidden(`You don't have ${action} access to the agreement lifecycle`);
  };
  const agreement = async (orgId: string, id: string) => {
    const [a] = await db.select().from(franchiseAgreements).where(and(eq(franchiseAgreements.id, id), eq(franchiseAgreements.organizationId, orgId)));
    if (!a) throw notFound('Agreement');
    return a;
  };
  const groupNames = async (orgId: string) => new Map((await db.select({ id: ownerGroups.id, name: ownerGroups.name }).from(ownerGroups).where(eq(ownerGroups.organizationId, orgId))).map((g) => [g.id, g.name]));

  /* ------------------------------- overview ------------------------------- */

  app.get('/orgs/:orgId/lifecycle/overview', { schema: { tags, security: secured, params: orgParams, summary: 'Open transfers, notices with cure deadlines, renewal windows and development schedules behind' } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const today = await orgToday(db, orgId);
    const transfers = await db.select({ n: sql<number>`count(*)::int` }).from(agreementTransfers).where(and(eq(agreementTransfers.organizationId, orgId), inArray(agreementTransfers.status, ['draft', 'in_review', 'approved'])));
    const notices = await db.select().from(agreementNotices).where(and(eq(agreementNotices.organizationId, orgId), inArray(agreementNotices.status, ['draft', 'issued', 'escalated'])));
    const ags = await db.select().from(franchiseAgreements).where(and(eq(franchiseAgreements.organizationId, orgId), eq(franchiseAgreements.status, 'active')));
    const devs = await db.select().from(developmentAgreements).where(and(eq(developmentAgreements.organizationId, orgId), eq(developmentAgreements.status, 'active')));
    const items = devs.length ? await db.select().from(developmentScheduleItems).where(inArray(developmentScheduleItems.developmentAgreementId, devs.map((d) => d.id))) : [];
    return {
      today, transfersOpen: transfers[0]?.n ?? 0,
      noticesOpen: notices.length, curePeriodsEnding: notices.filter((n) => n.status === 'issued' && n.cureDeadline && n.cureDeadline <= addDaysYmd(today, 7)).length, curesOverdue: notices.filter((n) => n.status === 'issued' && n.cureDeadline && n.cureDeadline < today).length,
      renewalWindowsOpen: ags.filter((a) => renewalPhase(today, windowOf(a), a.endDate) === 'window_open').length,
      developmentBehind: devs.filter((d) => scheduleProgress(items.filter((i) => i.developmentAgreementId === d.id), today).behind).length,
      can: { edit: await can(req, orgId, 'edit'), publish: await can(req, orgId, 'publish'), export: await can(req, orgId, 'export') }, counselNotice: COUNSEL_NOTICE,
    };
  });

  app.get('/orgs/:orgId/lifecycle/agreements', { schema: { tags, security: secured, params: orgParams, summary: 'Active agreements to pick from (owner group, territory, dates)' } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const rows = await db.select({ a: franchiseAgreements, g: ownerGroups.name }).from(franchiseAgreements).leftJoin(ownerGroups, eq(ownerGroups.id, franchiseAgreements.ownerGroupId))
      .where(and(eq(franchiseAgreements.organizationId, orgId), inArray(franchiseAgreements.status, ['active']))).orderBy(asc(ownerGroups.name));
    return { items: rows.map(({ a, g }) => ({ id: a.id, ownerGroupId: a.ownerGroupId, ownerGroupName: g, territory: a.territory, jurisdiction: a.jurisdiction, startDate: a.startDate, endDate: a.endDate, royaltyBps: a.royaltyBps, marketingFundBps: a.marketingFundBps, renewalOption: a.renewalOption, locationIds: a.locationIds })) };
  });

  /* ------------------------------- transfers ------------------------------ */

  const transferOut = (t: Transfer, names: Map<string, string>, a?: Agreement) => {
    const done = new Set(t.steps.filter((x) => x.done).map((x) => x.key));
    return {
      id: t.id, agreementId: t.agreementId, territory: a?.territory ?? null, fromOwnerGroupId: t.fromOwnerGroupId, fromOwnerGroupName: names.get(t.fromOwnerGroupId ?? '') ?? null, toOwnerGroupId: t.toOwnerGroupId, toOwnerGroupName: names.get(t.toOwnerGroupId ?? '') ?? null,
      toProspectId: t.toProspectId, buyerName: t.buyerName, status: t.status, steps: t.steps, transferFee: { amountMinor: t.transferFeeMinor, currency: t.currency }, feePaidAt: iso(t.feePaidAt), effectiveDate: t.effectiveDate, reason: t.reason,
      decidedAt: iso(t.decidedAt), decisionNote: t.decisionNote, completedAt: iso(t.completedAt), createdAt: t.createdAt.toISOString(),
      readyForApproval: TRANSFER_APPROVAL_STEPS.every((k) => done.has(k)), readyToComplete: TRANSFER_STEPS.every((k) => done.has(k)), progress: { done: done.size, total: TRANSFER_STEPS.length },
    };
  };
  const loadTransfer = async (orgId: string, id: string) => {
    const [t] = await db.select().from(agreementTransfers).where(and(eq(agreementTransfers.id, id), eq(agreementTransfers.organizationId, orgId)));
    if (!t) throw notFound('Transfer');
    return t;
  };

  app.get('/orgs/:orgId/lifecycle/transfers', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.string().max(20).optional() }) } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const rows = await db.select({ t: agreementTransfers, a: franchiseAgreements }).from(agreementTransfers).innerJoin(franchiseAgreements, eq(franchiseAgreements.id, agreementTransfers.agreementId))
      .where(and(eq(agreementTransfers.organizationId, orgId), ...(req.query.status ? [eq(agreementTransfers.status, req.query.status)] : []))).orderBy(desc(agreementTransfers.createdAt));
    const names = await groupNames(orgId);
    return { items: rows.map(({ t, a }) => transferOut(t, names, a)), steps: TRANSFER_STEPS, approvalSteps: TRANSFER_APPROVAL_STEPS };
  });

  app.post('/orgs/:orgId/lifecycle/transfers', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ agreementId: z.uuid(), toOwnerGroupId: z.uuid().nullable().optional(), toProspectId: z.uuid().nullable().optional(), buyerName: z.string().trim().min(1).max(200).optional(), transferFeeMinor: z.number().int().min(0).default(0), currency: currency.optional(), effectiveDate: z.iso.date().nullable().optional(), reason: z.string().max(2000).nullable().optional() }), summary: 'Start a transfer of an agreement to a new owner (buyer: an existing owner group, a prospect, or a name)' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await need(req, orgId, 'edit');
    const b = req.body;
    const a = await agreement(orgId, b.agreementId);
    if (a.status !== 'active') throw conflict('agreement_not_active', 'Only active agreements can be transferred');
    const [open] = await db.select({ id: agreementTransfers.id }).from(agreementTransfers).where(and(eq(agreementTransfers.agreementId, a.id), inArray(agreementTransfers.status, ['draft', 'in_review', 'approved'])));
    if (open) throw conflict('transfer_in_progress', 'A transfer of this agreement is already in progress');
    let buyerName = b.buyerName ?? null;
    if (b.toOwnerGroupId) { const [g] = await db.select().from(ownerGroups).where(and(eq(ownerGroups.id, b.toOwnerGroupId), eq(ownerGroups.organizationId, orgId))); if (!g) throw notFound('Owner group'); buyerName ??= g.name; }
    if (b.toProspectId) { const [p] = await db.select().from(franchiseProspects).where(and(eq(franchiseProspects.id, b.toProspectId), eq(franchiseProspects.organizationId, orgId))); if (!p) throw notFound('Prospect'); buyerName ??= p.name; }
    if (!buyerName) throw validationError('Name the buyer', { buyerName: 'Required' });
    const [o] = await db.select({ c: organizations.defaultCurrency }).from(organizations).where(eq(organizations.id, orgId));
    const steps: TransferStepState[] = TRANSFER_STEPS.map((key) => ({ key, done: false, doneAt: null, doneBy: null, note: null }));
    const [t] = await db.insert(agreementTransfers).values({ organizationId: orgId, agreementId: a.id, fromOwnerGroupId: a.ownerGroupId, toOwnerGroupId: b.toOwnerGroupId ?? null, toProspectId: b.toProspectId ?? null, buyerName, steps, transferFeeMinor: b.transferFeeMinor, currency: b.currency ?? o!.c, effectiveDate: b.effectiveDate ?? null, reason: b.reason ?? null, createdBy: req.user!.id }).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.transfer_started', targetType: 'agreement_transfer', targetId: t!.id, metadata: { agreementId: a.id, buyerName }, ip: req.ip });
    return reply.code(201).send(transferOut(t!, await groupNames(orgId), a));
  });

  app.post('/orgs/:orgId/lifecycle/transfers/:id/steps/:key', { schema: { tags, security: secured, params: idParams.extend({ key: z.enum(TRANSFER_STEPS) }), body: z.object({ done: z.boolean(), note: z.string().max(1000).nullable().optional() }) } }, async (req) => {
    const { orgId, id, key } = req.params;
    await need(req, orgId, 'edit');
    const t = await loadTransfer(orgId, id);
    if (['completed', 'rejected', 'cancelled'].includes(t.status)) throw conflict('transfer_closed', `This transfer is ${t.status}`);
    const steps = t.steps.map((x) => (x.key === key ? { ...x, done: req.body.done, doneAt: req.body.done ? new Date().toISOString() : null, doneBy: req.body.done ? req.user!.id : null, note: req.body.note ?? x.note } : x));
    const [row] = await db.update(agreementTransfers).set({ steps, ...(key === 'transfer_fee_paid' ? { feePaidAt: req.body.done ? new Date() : null } : {}), ...(t.status === 'draft' ? { status: 'in_review' } : {}), updatedAt: new Date() }).where(eq(agreementTransfers.id, id)).returning();
    return transferOut(row!, await groupNames(orgId));
  });

  app.post('/orgs/:orgId/lifecycle/transfers/:id/decide', { schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(2000).nullable().optional() }), summary: 'HQ approval of the buyer (legal.lifecycle publish). Approval needs the application, qualification, disclosure and financial review done.' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const t = await loadTransfer(orgId, id);
    if (!['draft', 'in_review'].includes(t.status)) throw conflict('transfer_not_in_review', `This transfer is ${t.status}`);
    const done = new Set(t.steps.filter((x) => x.done).map((x) => x.key));
    const missing = TRANSFER_APPROVAL_STEPS.filter((k) => !done.has(k));
    if (req.body.decision === 'approve' && missing.length) throw conflict('transfer_steps_missing', 'Finish the buyer review steps before approving', { missing });
    const [row] = await db.update(agreementTransfers).set({ status: req.body.decision === 'approve' ? 'approved' : 'rejected', decidedBy: req.user!.id, decidedAt: new Date(), decisionNote: req.body.note ?? null, updatedAt: new Date() }).where(eq(agreementTransfers.id, id)).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: `lifecycle.transfer_${req.body.decision === 'approve' ? 'approved' : 'rejected'}`, targetType: 'agreement_transfer', targetId: id, ip: req.ip });
    return transferOut(row!, await groupNames(orgId));
  });

  app.post('/orgs/:orgId/lifecycle/transfers/:id/complete', { schema: { tags, security: secured, params: idParams, summary: 'Complete an approved transfer: the agreement, its locations and territory move to the buyer (a new owner group is created when needed)' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const t = await loadTransfer(orgId, id);
    if (t.status !== 'approved') throw conflict('transfer_not_approved', 'Approve the transfer first');
    const done = new Set(t.steps.filter((x) => x.done).map((x) => x.key));
    const missing = TRANSFER_STEPS.filter((k) => !done.has(k));
    if (missing.length) throw conflict('transfer_steps_missing', 'Finish every step before completing the transfer', { missing });
    const a = await agreement(orgId, t.agreementId);
    const row = await db.transaction(async (tx) => {
      let to = t.toOwnerGroupId;
      if (!to) { const [g] = await tx.insert(ownerGroups).values({ organizationId: orgId, name: t.buyerName, legalName: t.buyerName }).returning(); to = g!.id; }
      await tx.update(franchiseAgreements).set({ ownerGroupId: to, terms: { ...a.terms, transferredFrom: a.ownerGroupId, transferId: t.id }, updatedAt: new Date() }).where(eq(franchiseAgreements.id, a.id));
      if (a.locationIds.length) await tx.update(locations).set({ ownerGroupId: to, updatedAt: new Date() }).where(and(eq(locations.organizationId, orgId), inArray(locations.id, a.locationIds)));
      if (a.territoryId) await tx.update(franchiseTerritories).set({ ownerGroupId: to, updatedAt: new Date() }).where(eq(franchiseTerritories.id, a.territoryId));
      if (t.toProspectId) await tx.update(franchiseProspects).set({ ownerGroupId: to, updatedAt: new Date() }).where(eq(franchiseProspects.id, t.toProspectId));
      const [r] = await tx.update(agreementTransfers).set({ status: 'completed', toOwnerGroupId: to, completedAt: new Date(), effectiveDate: t.effectiveDate ?? new Date().toISOString().slice(0, 10), updatedAt: new Date() }).where(eq(agreementTransfers.id, id)).returning();
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.transfer_completed', targetType: 'franchise_agreement', targetId: a.id, metadata: { from: a.ownerGroupId, to, locations: a.locationIds.length }, ip: req.ip });
      return r!;
    });
    return transferOut(row, await groupNames(orgId), a);
  });

  app.post('/orgs/:orgId/lifecycle/transfers/:id/cancel', { schema: { tags, security: secured, params: idParams, body: z.object({ note: z.string().max(2000).nullable().optional() }).default({}) } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'edit');
    const t = await loadTransfer(orgId, id);
    if (['completed', 'cancelled'].includes(t.status)) throw conflict('transfer_closed', `This transfer is ${t.status}`);
    const [row] = await db.update(agreementTransfers).set({ status: 'cancelled', decisionNote: req.body.note ?? t.decisionNote, updatedAt: new Date() }).where(eq(agreementTransfers.id, id)).returning();
    return transferOut(row!, await groupNames(orgId));
  });

  /* -------------------------------- notices ------------------------------- */

  const noticeOut = (n: Notice, today: string, names: Map<string, string>) => ({
    id: n.id, agreementId: n.agreementId, ownerGroupId: n.ownerGroupId, ownerGroupName: names.get(n.ownerGroupId ?? '') ?? null, parentId: n.parentId, kind: n.kind, reason: n.reason, details: n.details, subject: n.subject, body: n.body,
    cureDays: n.cureDays, cureDeadline: n.cureDeadline, daysLeft: n.cureDeadline ? Math.round((Date.parse(n.cureDeadline) - Date.parse(today)) / 86_400_000) : null, cureOverdue: n.status === 'issued' && !!n.cureDeadline && n.cureDeadline < today,
    status: n.status, escalationLevel: n.escalationLevel, counselReviewed: n.counselReviewed, counselReviewedAt: iso(n.counselReviewedAt), counselNote: n.counselNote, issuedAt: iso(n.issuedAt), deliveredTo: n.deliveredTo, resolvedAt: iso(n.resolvedAt), resolutionNote: n.resolutionNote, createdAt: n.createdAt.toISOString(),
  });
  const loadNotice = async (orgId: string, id: string) => {
    const [n] = await db.select().from(agreementNotices).where(and(eq(agreementNotices.id, id), eq(agreementNotices.organizationId, orgId)));
    if (!n) throw notFound('Notice');
    return n;
  };

  app.get('/orgs/:orgId/lifecycle/notices', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ agreementId: z.uuid().optional(), status: z.string().max(20).optional() }) } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const rows = await db.select().from(agreementNotices).where(and(eq(agreementNotices.organizationId, orgId), ...(req.query.agreementId ? [eq(agreementNotices.agreementId, req.query.agreementId)] : []), ...(req.query.status ? [eq(agreementNotices.status, req.query.status)] : []))).orderBy(desc(agreementNotices.createdAt));
    const today = await orgToday(db, orgId);
    const names = await groupNames(orgId);
    return { items: rows.map((n) => noticeOut(n, today, names)), defaultCureDays: DEFAULT_CURE_DAYS, counselNotice: COUNSEL_NOTICE };
  });

  app.get('/orgs/:orgId/lifecycle/notices/:id', { schema: { tags, security: secured, params: idParams, summary: 'A notice with its agreement and the jurisdiction rule’s renewal / termination note' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'view');
    const n = await loadNotice(orgId, id);
    const a = await agreement(orgId, n.agreementId);
    const rules = a.jurisdiction ? (await loadRules(db, orgId)).filter((r) => r.code === a.jurisdiction || r.code === a.jurisdiction!.slice(0, 2)) : [];
    const chain = await db.select().from(agreementNotices).where(and(eq(agreementNotices.organizationId, orgId), eq(agreementNotices.agreementId, n.agreementId))).orderBy(asc(agreementNotices.createdAt));
    const today = await orgToday(db, orgId);
    const names = await groupNames(orgId);
    return { ...noticeOut(n, today, names), agreement: { id: a.id, territory: a.territory, jurisdiction: a.jurisdiction, startDate: a.startDate, endDate: a.endDate, status: a.status }, jurisdictionNotes: rules.map((r) => ({ code: r.code, name: r.name, renewalTermination: r.renewalTermination, reviewedByCounsel: r.reviewedByCounsel })).filter((r) => r.renewalTermination), history: chain.map((x) => noticeOut(x, today, names)), counselNotice: COUNSEL_NOTICE };
  });

  async function draftNotice(orgId: string, a: Agreement, kind: NoticeKind, reason: NoticeReason, details: string, cureDays: number | null, parentId: string | null, actor: string, cureDeadline?: string | null) {
    const [o] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const names = await groupNames(orgId);
    const today = await orgToday(db, orgId);
    const days = cureDays ?? (kind === 'default' ? DEFAULT_CURE_DAYS[reason] : 0);
    const deadline = cureDeadline ?? addDaysYmd(today, days);
    const r = renderNotice(kind, { franchisee: names.get(a.ownerGroupId ?? '') ?? 'Franchisee', brand: o!.name, agreementDate: a.startDate, reason, details, cureDays: days, cureDeadline: deadline, date: today });
    const [n] = await db.insert(agreementNotices).values({ organizationId: orgId, agreementId: a.id, ownerGroupId: a.ownerGroupId, parentId, kind, reason, details, subject: r.subject, body: r.body, cureDays: kind === 'default' ? days : null, cureDeadline: kind === 'default' || kind === 'cure_reminder' ? deadline : null, createdBy: actor }).returning();
    return n!;
  }

  app.post('/orgs/:orgId/lifecycle/notices', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ agreementId: z.uuid(), kind: z.enum(NOTICE_KINDS).default('default'), reason: z.enum(NOTICE_REASONS), details: z.string().max(4000).default(''), cureDays: z.number().int().min(0).max(365).nullable().optional() }), summary: 'Draft a notice from the template (needs counsel review before it can be issued)' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await need(req, orgId, 'edit');
    const a = await agreement(orgId, req.body.agreementId);
    if (a.status !== 'active') throw conflict('agreement_not_active', 'Notices are for active agreements');
    const n = await draftNotice(orgId, a, req.body.kind, req.body.reason, req.body.details, req.body.cureDays ?? null, null, req.user!.id);
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.notice_drafted', targetType: 'agreement_notice', targetId: n.id, metadata: { kind: n.kind, reason: n.reason }, ip: req.ip });
    return reply.code(201).send(noticeOut(n, await orgToday(db, orgId), await groupNames(orgId)));
  });

  app.patch('/orgs/:orgId/lifecycle/notices/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ subject: z.string().min(1).max(300).optional(), body: z.string().min(1).max(20_000).optional(), details: z.string().max(4000).optional(), cureDays: z.number().int().min(0).max(365).optional() }), summary: 'Edit a draft. Any change clears the counsel review.' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'edit');
    const n = await loadNotice(orgId, id);
    if (n.status !== 'draft') throw conflict('notice_issued', 'Issued notices can’t be edited');
    const [row] = await db.update(agreementNotices).set({ ...req.body, counselReviewed: false, counselReviewedAt: null, counselReviewedBy: null, updatedAt: new Date() }).where(eq(agreementNotices.id, id)).returning();
    return noticeOut(row!, await orgToday(db, orgId), await groupNames(orgId));
  });

  app.post('/orgs/:orgId/lifecycle/notices/:id/counsel-review', { schema: { tags, security: secured, params: idParams, body: z.object({ reviewed: z.boolean(), note: z.string().max(2000).nullable().optional() }), summary: 'Record that franchise counsel reviewed the notice (legal.lifecycle publish)' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const n = await loadNotice(orgId, id);
    if (n.status !== 'draft') throw conflict('notice_issued', 'This notice is already issued');
    const [row] = await db.update(agreementNotices).set({ counselReviewed: req.body.reviewed, counselReviewedBy: req.user!.id, counselReviewedAt: new Date(), counselNote: req.body.note ?? null, updatedAt: new Date() }).where(eq(agreementNotices.id, id)).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.notice_counsel_review', targetType: 'agreement_notice', targetId: id, metadata: { reviewed: req.body.reviewed }, ip: req.ip });
    return noticeOut(row!, await orgToday(db, orgId), await groupNames(orgId));
  });

  app.post('/orgs/:orgId/lifecycle/notices/:id/issue', { schema: { tags, security: secured, params: idParams, body: z.object({ deliveredTo: z.string().max(500).nullable().optional() }).default({}), summary: 'Issue a reviewed notice: the cure period starts today; a termination notice terminates the agreement' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const n = await loadNotice(orgId, id);
    if (n.status !== 'draft') throw conflict('notice_issued', 'This notice is already issued');
    if (!n.counselReviewed) throw conflict('counsel_review_required', 'Record franchise counsel’s review before issuing this notice');
    const today = await orgToday(db, orgId);
    const a = await agreement(orgId, n.agreementId);
    const cureDeadline = n.kind === 'default' && n.cureDays != null ? addDaysYmd(today, n.cureDays) : n.cureDeadline;
    const row = await db.transaction(async (tx) => {
      const [r] = await tx.update(agreementNotices).set({ status: n.kind === 'termination' ? 'terminated' : n.kind === 'withdrawal' ? 'withdrawn' : 'issued', issuedAt: new Date(), issuedBy: req.user!.id, cureDeadline, deliveredTo: req.body.deliveredTo ?? null, updatedAt: new Date() }).where(eq(agreementNotices.id, id)).returning();
      if (n.kind === 'termination') {
        await tx.update(franchiseAgreements).set({ status: 'terminated', updatedAt: new Date() }).where(eq(franchiseAgreements.id, a.id));
        if (n.parentId) await tx.update(agreementNotices).set({ status: 'terminated', resolvedAt: new Date(), updatedAt: new Date() }).where(eq(agreementNotices.id, n.parentId));
      }
      if (n.kind === 'withdrawal' && n.parentId) await tx.update(agreementNotices).set({ status: 'withdrawn', resolvedAt: new Date(), updatedAt: new Date() }).where(eq(agreementNotices.id, n.parentId));
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: `lifecycle.notice_issued`, targetType: 'agreement_notice', targetId: id, metadata: { kind: n.kind, agreementId: a.id, cureDeadline }, ip: req.ip });
      return r!;
    });
    if (a.ownerGroupId) {
      const owners = await usersWithCapabilityInGroup(s, orgId, a.ownerGroupId);
      await networkNotify(s, { organizationId: orgId, userIds: owners, kind: 'agreement_notice', title: n.subject, body: n.kind === 'default' ? `Cure by ${cureDeadline}` : null, link: '/franchise/agreements' });
    }
    return noticeOut(row, today, await groupNames(orgId));
  });

  app.post('/orgs/:orgId/lifecycle/notices/:id/resolve', {
    schema: { tags, security: secured, params: idParams, body: z.object({ outcome: z.enum(['cured', 'escalate', 'terminate', 'withdraw']), note: z.string().max(2000).nullable().optional(), extendDays: z.number().int().min(1).max(180).optional() }), summary: 'Close a default notice as cured, escalate it (cure reminder draft), or draft the termination / withdrawal notice' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const n = await loadNotice(orgId, id);
    if (n.kind !== 'default' || !['issued', 'escalated'].includes(n.status)) throw conflict('notice_not_open', 'Only issued notices of default can be resolved');
    const today = await orgToday(db, orgId);
    if (req.body.outcome === 'cured') {
      const [row] = await db.update(agreementNotices).set({ status: 'cured', resolvedAt: new Date(), resolutionNote: req.body.note ?? null, updatedAt: new Date() }).where(eq(agreementNotices.id, id)).returning();
      await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.notice_cured', targetType: 'agreement_notice', targetId: id, ip: req.ip });
      return reply.send(noticeOut(row!, today, await groupNames(orgId)));
    }
    const a = await agreement(orgId, n.agreementId);
    if (req.body.outcome === 'terminate' && n.cureDeadline && n.cureDeadline >= today) throw conflict('cure_period_running', `The cure period runs until ${n.cureDeadline}`);
    const kind: NoticeKind = req.body.outcome === 'terminate' ? 'termination' : req.body.outcome === 'withdraw' ? 'withdrawal' : 'cure_reminder';
    const deadline = kind === 'cure_reminder' && req.body.extendDays ? addDaysYmd(n.cureDeadline ?? today, req.body.extendDays) : n.cureDeadline;
    const child = await draftNotice(orgId, a, kind, n.reason as NoticeReason, n.details, null, n.id, req.user!.id, deadline);
    if (kind === 'cure_reminder') await db.update(agreementNotices).set({ status: 'escalated', escalationLevel: n.escalationLevel + 1, cureDeadline: deadline, resolutionNote: req.body.note ?? n.resolutionNote, updatedAt: new Date() }).where(eq(agreementNotices.id, id));
    return reply.code(201).send(noticeOut(child, today, await groupNames(orgId)));
  });

  app.get('/orgs/:orgId/lifecycle/notices/:id/pdf', { schema: { tags, security: secured, params: idParams } }, async (req, reply) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'view');
    const n = await loadNotice(orgId, id);
    const texts: Array<{ x: number; y: number; text: string; size?: number; bold?: boolean }> = [];
    let y = 800;
    texts.push({ x: 50, y, text: n.subject, size: 14, bold: true }); y -= 28;
    for (const para of n.body.split('\n')) {
      let line = '';
      for (const w of para.split(/\s+/)) { if ((line + ' ' + w).trim().length > 95) { texts.push({ x: 50, y, text: line.trim() }); y -= 14; line = w; } else line += ` ${w}`; }
      texts.push({ x: 50, y, text: line.trim() }); y -= 14;
    }
    if (n.status === 'draft') texts.push({ x: 50, y: 60, text: `DRAFT${n.counselReviewed ? '' : ' - not reviewed by counsel'}`, size: 9, bold: true });
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="notice-${n.id.slice(0, 8)}.pdf"`).send(renderPdf([{ texts }], { title: n.subject }));
  });

  /* ------------------------------ amendments ------------------------------ */

  const amendmentChanges = z.object({ endDate: z.iso.date().optional(), royaltyBps: z.number().int().min(0).max(10_000).optional(), marketingFundBps: z.number().int().min(0).max(10_000).optional(), territory: z.string().max(200).optional(), renewalOption: z.string().max(500).optional() })
    .refine((c) => Object.keys(c).length > 0, 'Change at least one term');

  app.get('/orgs/:orgId/lifecycle/amendments', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ agreementId: z.uuid().optional() }) } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const rows = await db.select().from(agreementAmendments).where(and(eq(agreementAmendments.organizationId, orgId), ...(req.query.agreementId ? [eq(agreementAmendments.agreementId, req.query.agreementId)] : []))).orderBy(desc(agreementAmendments.createdAt));
    return { items: rows.map((m) => ({ id: m.id, agreementId: m.agreementId, title: m.title, summary: m.summary, changes: m.changes, previous: m.previous, effectiveDate: m.effectiveDate, status: m.status, counselReviewed: m.counselReviewed, signedAt: iso(m.signedAt), createdAt: m.createdAt.toISOString() })), fields: AMENDMENT_FIELDS };
  });

  app.post('/orgs/:orgId/lifecycle/amendments', { schema: { tags, security: secured, params: orgParams, body: z.object({ agreementId: z.uuid(), title: z.string().trim().min(1).max(200), summary: z.string().max(4000).nullable().optional(), changes: amendmentChanges, effectiveDate: z.iso.date() }) } }, async (req, reply) => {
    const { orgId } = req.params;
    await need(req, orgId, 'edit');
    const a = await agreement(orgId, req.body.agreementId);
    if (req.body.changes.endDate && req.body.changes.endDate <= a.startDate) throw validationError('The end date must be after the start date', { endDate: 'After start date' });
    const [m] = await db.insert(agreementAmendments).values({ organizationId: orgId, agreementId: a.id, title: req.body.title, summary: req.body.summary ?? null, changes: req.body.changes, effectiveDate: req.body.effectiveDate, createdBy: req.user!.id }).returning();
    return reply.code(201).send({ id: m!.id, status: m!.status });
  });

  app.post('/orgs/:orgId/lifecycle/amendments/:id/sign', { schema: { tags, security: secured, params: idParams, body: z.object({ counselReviewed: z.literal(true), documentId: z.uuid().nullable().optional() }), summary: 'Record the signed amendment and apply its changes to the agreements register (publish)' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const [m] = await db.select().from(agreementAmendments).where(and(eq(agreementAmendments.id, id), eq(agreementAmendments.organizationId, orgId)));
    if (!m) throw notFound('Amendment');
    if (m.status !== 'draft') throw conflict('amendment_closed', `This amendment is ${m.status}`);
    const a = await agreement(orgId, m.agreementId);
    const previous = Object.fromEntries(Object.keys(m.changes).map((k) => [k, (a as unknown as Record<string, string | number | null>)[k] ?? null]));
    await db.transaction(async (tx) => {
      await tx.update(franchiseAgreements).set({ ...m.changes, ...(m.changes.endDate ? { remindersSent: [] } : {}), updatedAt: new Date() }).where(eq(franchiseAgreements.id, a.id));
      await tx.update(agreementAmendments).set({ status: 'signed', signedAt: new Date(), counselReviewed: true, previous, appliedBy: req.user!.id, documentId: req.body.documentId ?? null, updatedAt: new Date() }).where(eq(agreementAmendments.id, id));
      if (m.changes.endDate) await tx.delete(agreementRenewals).where(and(eq(agreementRenewals.agreementId, a.id), inArray(agreementRenewals.status, ['upcoming', 'window_open'])));
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.amendment_signed', targetType: 'franchise_agreement', targetId: a.id, metadata: { amendmentId: id, changes: m.changes, previous }, ip: req.ip });
    });
    return { id, status: 'signed', previous };
  });

  app.post('/orgs/:orgId/lifecycle/amendments/:id/cancel', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'edit');
    const [m] = await db.update(agreementAmendments).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(agreementAmendments.id, id), eq(agreementAmendments.organizationId, orgId), eq(agreementAmendments.status, 'draft'))).returning();
    if (!m) throw notFound('Amendment');
    return { id, status: 'cancelled' };
  });

  /* -------------------------------- renewals ------------------------------ */

  async function ensureRenewals(orgId: string, today: string) {
    const ags = await db.select().from(franchiseAgreements).where(and(eq(franchiseAgreements.organizationId, orgId), eq(franchiseAgreements.status, 'active'), lte(franchiseAgreements.endDate, addMonthsYmd(today, 24))));
    const [o] = await db.select({ c: organizations.defaultCurrency }).from(organizations).where(eq(organizations.id, orgId));
    for (const a of ags) {
      const w = windowOf(a);
      await db.insert(agreementRenewals).values({ organizationId: orgId, agreementId: a.id, windowOpensOn: w.opensOn, windowClosesOn: w.closesOn, currency: o!.c, conditions: RENEWAL_CONDITIONS.map((key) => ({ key, done: false, doneAt: null })) }).onConflictDoNothing();
    }
  }

  const renewalOut = (r: typeof agreementRenewals.$inferSelect, a: Agreement, today: string, names: Map<string, string>) => {
    const phase = renewalPhase(today, { opensOn: r.windowOpensOn, closesOn: r.windowClosesOn }, a.endDate);
    const status = ['upcoming', 'window_open'].includes(r.status) ? (phase === 'window_open' ? 'window_open' : phase === 'upcoming' ? 'upcoming' : 'lapsed') : r.status;
    return {
      id: a.id, renewalId: r.id, agreementId: a.id, ownerGroupName: names.get(a.ownerGroupId ?? '') ?? null, territory: a.territory, endDate: a.endDate, renewalOption: a.renewalOption, windowOpensOn: r.windowOpensOn, windowClosesOn: r.windowClosesOn, phase, status,
      daysToWindowClose: Math.round((Date.parse(r.windowClosesOn) - Date.parse(today)) / 86_400_000), noticeReceivedOn: r.noticeReceivedOn, conditions: r.conditions, renewalFee: { amountMinor: r.renewalFeeMinor, currency: r.currency }, newTermYears: r.newTermYears, newAgreementId: r.newAgreementId, decisionNote: r.decisionNote,
    };
  };
  const loadRenewal = async (orgId: string, agreementId: string) => {
    const [r] = await db.select().from(agreementRenewals).where(and(eq(agreementRenewals.agreementId, agreementId), eq(agreementRenewals.organizationId, orgId)));
    if (!r) throw notFound('Renewal');
    return r;
  };

  app.get('/orgs/:orgId/lifecycle/renewals', { schema: { tags, security: secured, params: orgParams, summary: 'Agreements ending within two years with their renewal option window and workflow' } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const today = await orgToday(db, orgId);
    await ensureRenewals(orgId, today);
    const rows = await db.select({ r: agreementRenewals, a: franchiseAgreements }).from(agreementRenewals).innerJoin(franchiseAgreements, eq(franchiseAgreements.id, agreementRenewals.agreementId)).where(eq(agreementRenewals.organizationId, orgId)).orderBy(asc(franchiseAgreements.endDate));
    const names = await groupNames(orgId);
    return { items: rows.map(({ r, a }) => renewalOut(r, a, today, names)), conditions: RENEWAL_CONDITIONS };
  });

  app.post('/orgs/:orgId/lifecycle/renewals/:id/notice', { schema: { tags, security: secured, params: idParams, body: z.object({ receivedOn: z.iso.date() }), summary: 'Record the franchisee’s renewal notice (must fall inside the option window)' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'edit');
    const r = await loadRenewal(orgId, id);
    if (req.body.receivedOn < r.windowOpensOn || req.body.receivedOn > r.windowClosesOn) throw conflict('outside_option_window', `Notice must be given between ${r.windowOpensOn} and ${r.windowClosesOn}`);
    const conditions = r.conditions.map((c) => (c.key === 'notice_given' ? { ...c, done: true, doneAt: new Date().toISOString() } : c));
    await db.update(agreementRenewals).set({ status: 'notice_received', noticeReceivedOn: req.body.receivedOn, conditions, updatedAt: new Date() }).where(eq(agreementRenewals.id, r.id));
    return { id: r.id, status: 'notice_received' };
  });

  app.post('/orgs/:orgId/lifecycle/renewals/:id/conditions/:key', { schema: { tags, security: secured, params: idParams.extend({ key: z.enum(RENEWAL_CONDITIONS) }), body: z.object({ done: z.boolean() }) } }, async (req) => {
    const { orgId, id, key } = req.params;
    await need(req, orgId, 'edit');
    const r = await loadRenewal(orgId, id);
    const conditions = r.conditions.map((c) => (c.key === key ? { ...c, done: req.body.done, doneAt: req.body.done ? new Date().toISOString() : null } : c));
    await db.update(agreementRenewals).set({ conditions, updatedAt: new Date() }).where(eq(agreementRenewals.id, r.id));
    return { id: r.id, conditions };
  });

  app.post('/orgs/:orgId/lifecycle/renewals/:id/decide', { schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'decline']), newTermYears: z.number().int().min(1).max(30).optional(), renewalFeeMinor: z.number().int().min(0).optional(), note: z.string().max(2000).nullable().optional() }) } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const r = await loadRenewal(orgId, id);
    if (!['notice_received', 'window_open', 'upcoming'].includes(r.status)) throw conflict('renewal_decided', `This renewal is ${r.status}`);
    if (req.body.decision === 'approve') {
      const [open] = await db.select({ id: agreementNotices.id }).from(agreementNotices).where(and(eq(agreementNotices.agreementId, id), inArray(agreementNotices.status, ['issued', 'escalated'])));
      if (open) throw conflict('open_default', 'This agreement has an open notice of default');
    }
    await db.update(agreementRenewals).set({ status: req.body.decision === 'approve' ? 'approved' : 'declined', newTermYears: req.body.newTermYears ?? r.newTermYears, renewalFeeMinor: req.body.renewalFeeMinor ?? r.renewalFeeMinor, decisionNote: req.body.note ?? null, decidedBy: req.user!.id, decidedAt: new Date(), updatedAt: new Date() }).where(eq(agreementRenewals.id, r.id));
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: `lifecycle.renewal_${req.body.decision}d`, targetType: 'franchise_agreement', targetId: id, ip: req.ip });
    return { id: r.id, status: req.body.decision === 'approve' ? 'approved' : 'declined' };
  });

  app.post('/orgs/:orgId/lifecycle/renewals/:id/complete', { schema: { tags, security: secured, params: idParams, summary: 'Renew: adds the new agreement to the register (from the day after the old one ends) and marks the old one renewed' } }, async (req) => {
    const { orgId, id } = req.params;
    await need(req, orgId, 'publish');
    const r = await loadRenewal(orgId, id);
    if (r.status !== 'approved') throw conflict('renewal_not_approved', 'Approve the renewal first');
    const missing = r.conditions.filter((c) => !c.done).map((c) => c.key);
    if (missing.length) throw conflict('renewal_conditions_missing', 'Every renewal condition must be met', { missing });
    const a = await agreement(orgId, id);
    const years = r.newTermYears ?? a.termYears ?? 10;
    const start = addDaysYmd(a.endDate, 1);
    const end = addDaysYmd(addMonthsYmd(start, years * 12), -1);
    const newId = await db.transaction(async (tx) => {
      const [n] = await tx.insert(franchiseAgreements).values({ organizationId: orgId, ownerGroupId: a.ownerGroupId, prospectId: a.prospectId, territoryId: a.territoryId, territory: a.territory, locationIds: a.locationIds, jurisdiction: a.jurisdiction, startDate: start, endDate: end, termYears: years, renewalOption: null, royaltyBps: a.royaltyBps, marketingFundBps: a.marketingFundBps, terms: { ...a.terms, renewalOf: a.id }, createdBy: req.user!.id }).returning();
      await tx.update(franchiseAgreements).set({ status: 'renewed', updatedAt: new Date() }).where(eq(franchiseAgreements.id, a.id));
      await tx.update(agreementRenewals).set({ status: 'renewed', newAgreementId: n!.id, updatedAt: new Date() }).where(eq(agreementRenewals.id, r.id));
      if (a.territoryId) await tx.update(franchiseTerritories).set({ agreementId: n!.id, updatedAt: new Date() }).where(eq(franchiseTerritories.id, a.territoryId));
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.renewed', targetType: 'franchise_agreement', targetId: a.id, metadata: { newAgreementId: n!.id, start, end }, ip: req.ip });
      return n!.id;
    });
    return { id: r.id, status: 'renewed', newAgreementId: newId, startDate: start, endDate: end };
  });

  /* ------------------------- development schedules ------------------------ */

  const devOut = async (orgId: string, rows: Array<typeof developmentAgreements.$inferSelect>, today: string) => {
    const items = rows.length ? await db.select().from(developmentScheduleItems).where(inArray(developmentScheduleItems.developmentAgreementId, rows.map((d) => d.id))).orderBy(asc(developmentScheduleItems.sequence)) : [];
    const names = await groupNames(orgId);
    const locIds = items.map((i) => i.locationId).filter((x): x is string => !!x);
    const locs = locIds.length ? await db.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, locIds)) : [];
    const terr = await db.select({ id: franchiseTerritories.id, name: franchiseTerritories.name }).from(franchiseTerritories).where(eq(franchiseTerritories.organizationId, orgId));
    return rows.map((d) => {
      const mine = items.filter((i) => i.developmentAgreementId === d.id);
      return {
        id: d.id, ownerGroupId: d.ownerGroupId, scopeTerritoryId: d.scopeTerritoryId, ownerGroupName: names.get(d.ownerGroupId) ?? null, agreementId: d.agreementId, name: d.name, unitsTotal: d.unitsTotal, startDate: d.startDate, status: d.status,
        territories: d.territoryIds.map((tid) => ({ id: tid, name: terr.find((t) => t.id === tid)?.name ?? null })), developmentFee: { amountMinor: d.developmentFeeMinor, currency: d.currency }, notes: d.notes,
        progress: scheduleProgress(mine, today),
        items: mine.map((i) => ({ id: i.id, sequence: i.sequence, label: i.label, territoryId: i.territoryId, territoryName: terr.find((t) => t.id === i.territoryId)?.name ?? null, signByDate: i.signByDate, openByDate: i.openByDate, status: i.status, locationId: i.locationId, locationName: locs.find((l) => l.id === i.locationId)?.name ?? null, unitAgreementId: i.unitAgreementId, signedOn: i.signedOn, openedOn: i.openedOn, note: i.note, overdue: i.status !== 'opened' && i.status !== 'waived' && (i.openByDate < today || (i.status === 'pending' && !!i.signByDate && i.signByDate < today)) })),
      };
    });
  };

  app.get('/orgs/:orgId/lifecycle/development', { schema: { tags, security: secured, params: orgParams, summary: 'Multi-unit development agreements with their schedules and progress' } }, async (req) => {
    const { orgId } = req.params;
    await need(req, orgId, 'view');
    const rows = await db.select().from(developmentAgreements).where(eq(developmentAgreements.organizationId, orgId)).orderBy(asc(developmentAgreements.startDate));
    return { items: await devOut(orgId, rows, await orgToday(db, orgId)) };
  });

  const item = z.object({ label: z.string().trim().min(1).max(120), territoryId: z.uuid().nullable().optional(), signByDate: z.iso.date().nullable().optional(), openByDate: z.iso.date() });
  app.post('/orgs/:orgId/lifecycle/development', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ ownerGroupId: z.uuid(), scopeTerritoryId: z.uuid().nullable().optional(), agreementId: z.uuid().nullable().optional(), name: z.string().trim().min(1).max(200), unitsTotal: z.number().int().min(1).max(200), startDate: z.iso.date(), territoryIds: z.array(z.uuid()).max(50).default([]), developmentFeeMinor: z.number().int().min(0).default(0), currency: currency.optional(), notes: z.string().max(4000).nullable().optional(), schedule: z.array(item).max(200).optional(), intervalMonths: z.number().int().min(1).max(60).default(12) }), summary: 'Create a development agreement with N units: an explicit schedule, or one unit every `intervalMonths` (sign 6 months before opening)' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await need(req, orgId, 'edit');
    const b = req.body;
    const [g] = await db.select().from(ownerGroups).where(and(eq(ownerGroups.id, b.ownerGroupId), eq(ownerGroups.organizationId, orgId)));
    if (!g) throw notFound('Owner group');
    if (b.scopeTerritoryId) { const [tt] = await db.select({ id: territories.id }).from(territories).where(and(eq(territories.id, b.scopeTerritoryId), eq(territories.organizationId, orgId))); if (!tt) throw notFound('Territory'); }
    if (b.schedule && b.schedule.length !== b.unitsTotal) throw validationError('The schedule needs one line per unit', { schedule: `${b.unitsTotal} lines` });
    const [o] = await db.select({ c: organizations.defaultCurrency }).from(organizations).where(eq(organizations.id, orgId));
    const schedule = b.schedule ?? Array.from({ length: b.unitsTotal }, (_, i) => { const open = addMonthsYmd(b.startDate, b.intervalMonths * (i + 1)); return { label: `Unit ${i + 1}`, territoryId: b.territoryIds[i] ?? null, signByDate: addMonthsYmd(open, -6), openByDate: open }; });
    const d = await db.transaction(async (tx) => {
      const [d] = await tx.insert(developmentAgreements).values({ organizationId: orgId, ownerGroupId: g.id, scopeTerritoryId: b.scopeTerritoryId ?? null, agreementId: b.agreementId ?? null, name: b.name, unitsTotal: b.unitsTotal, startDate: b.startDate, territoryIds: b.territoryIds, developmentFeeMinor: b.developmentFeeMinor, currency: b.currency ?? o!.c, notes: b.notes ?? null, createdBy: req.user!.id }).returning();
      await tx.insert(developmentScheduleItems).values(schedule.map((x, i) => ({ organizationId: orgId, developmentAgreementId: d!.id, sequence: i + 1, label: x.label, territoryId: x.territoryId ?? null, signByDate: x.signByDate ?? null, openByDate: x.openByDate })));
      await audit(tx, { organizationId: orgId, actorUserId: req.user!.id, action: 'lifecycle.development_created', targetType: 'development_agreement', targetId: d!.id, metadata: { units: b.unitsTotal }, ip: req.ip });
      return d!;
    });
    return reply.code(201).send((await devOut(orgId, [d], await orgToday(db, orgId)))[0]);
  });

  app.patch('/orgs/:orgId/lifecycle/development/:id/items/:itemId', {
    schema: { tags, security: secured, params: idParams.extend({ itemId: z.uuid() }), body: z.object({ status: z.enum(DEVELOPMENT_ITEM_STATUSES).optional(), locationId: z.uuid().nullable().optional(), unitAgreementId: z.uuid().nullable().optional(), signByDate: z.iso.date().nullable().optional(), openByDate: z.iso.date().optional(), signedOn: z.iso.date().nullable().optional(), openedOn: z.iso.date().nullable().optional(), note: z.string().max(2000).nullable().optional() }) },
  }, async (req) => {
    const { orgId, id, itemId } = req.params;
    await need(req, orgId, req.body.status === 'waived' || req.body.openByDate || req.body.signByDate !== undefined ? 'publish' : 'edit');
    const today = await orgToday(db, orgId);
    const b = req.body;
    const [row] = await db.update(developmentScheduleItems).set({ ...b, ...(b.status === 'signed' && !b.signedOn ? { signedOn: today } : {}), ...(b.status === 'opened' && !b.openedOn ? { openedOn: today } : {}), updatedAt: new Date() })
      .where(and(eq(developmentScheduleItems.id, itemId), eq(developmentScheduleItems.developmentAgreementId, id), eq(developmentScheduleItems.organizationId, orgId))).returning();
    if (!row) throw notFound('Schedule item');
    const [d] = await db.select().from(developmentAgreements).where(eq(developmentAgreements.id, id));
    return (await devOut(orgId, [d!], today))[0];
  });

  /* ------------------------------ franchisee ------------------------------ */

  app.get('/orgs/:orgId/lifecycle/mine', { schema: { tags, security: secured, params: orgParams, summary: 'For franchise owners: issued notices, transfers, renewals and development schedules of their own owner groups' } }, async (req) => {
    const { orgId } = req.params;
    const mine = await requireMember(req, db, orgId);
    const groups = mine.filter((a) => a.scopeKind === 'owner_group' && a.capabilities?.has('network.onboarding:view')).map((a) => a.scopeId);
    // Area developers hold a territory-scope role: they see the development schedules of their territory.
    const terrs = mine.filter((a) => a.scopeKind === 'territory' && a.capabilities?.has('network.onboarding:view')).map((a) => a.scopeId);
    if (!groups.length && !terrs.length) throw forbidden('No franchise agreements in your access');
    const today = await orgToday(db, orgId);
    const names = await groupNames(orgId);
    const ags = groups.length ? await db.select().from(franchiseAgreements).where(and(eq(franchiseAgreements.organizationId, orgId), inArray(franchiseAgreements.ownerGroupId, groups))) : [];
    const notices = ags.length ? await db.select().from(agreementNotices).where(and(inArray(agreementNotices.agreementId, ags.map((a) => a.id)), sql`${agreementNotices.issuedAt} is not null`)).orderBy(desc(agreementNotices.issuedAt)) : [];
    const renewals = ags.length ? await db.select().from(agreementRenewals).where(inArray(agreementRenewals.agreementId, ags.map((a) => a.id))) : [];
    const devs = await db.select().from(developmentAgreements).where(and(eq(developmentAgreements.organizationId, orgId), or(
      ...(groups.length ? [inArray(developmentAgreements.ownerGroupId, groups)] : []), ...(terrs.length ? [inArray(developmentAgreements.scopeTerritoryId, terrs)] : []),
    )));
    return {
      notices: notices.map((n) => noticeOut(n, today, names)),
      renewals: renewals.map((r) => renewalOut(r, ags.find((a) => a.id === r.agreementId)!, today, names)),
      development: await devOut(orgId, devs, today),
    };
  });
};

async function usersWithCapabilityInGroup(s: Services, orgId: string, ownerGroupId: string) {
  const [loc] = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), eq(locations.ownerGroupId, ownerGroupId))).limit(1);
  return loc ? usersWithCapability(s.db, orgId, loc.id, 'network.onboarding', 'view') : [];
}

/** Hourly: issued notices whose cure period ended are flagged to HQ once (escalation level 1). */
export async function runLifecycleJobs(s: Services, now = new Date(), organizationId?: string) {
  const issued = await s.db.select().from(agreementNotices).where(and(eq(agreementNotices.status, 'issued'), eq(agreementNotices.escalationLevel, 0), ...(organizationId ? [eq(agreementNotices.organizationId, organizationId)] : [])));
  let flagged = 0;
  for (const n of issued) {
    const today = await orgToday(s.db, n.organizationId, now);
    if (!n.cureDeadline || n.cureDeadline >= today) continue;
    const [row] = await s.db.update(agreementNotices).set({ escalationLevel: 1, updatedAt: new Date() }).where(and(eq(agreementNotices.id, n.id), eq(agreementNotices.escalationLevel, 0))).returning();
    if (!row) continue;
    flagged++;
    const hq = await usersWithCapability(s.db, n.organizationId, null, MODULE, 'publish');
    await networkNotify(s, { organizationId: n.organizationId, userIds: hq, kind: 'agreement_notice', title: 'Cure period ended', body: `${n.subject} (cure deadline ${n.cureDeadline}). Decide: cured, extend, or termination.`, link: `/franchise/lifecycle?tab=notices` });
  }
  return { flagged };
}
