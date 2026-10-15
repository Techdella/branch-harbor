import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { approvals, campaigns, fieldOverrides, locations, organizations, pages, shiftSwapRequests, shifts, users } from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { hasPerm } from './authz.ts';
import { refundCommerceOrder } from './commerce.ts';
import { notify, usersWithPermissionAt } from './notifications.ts';
import { orgPolicies } from './orgSettings.ts';
import { refundPayment, serializePayment } from './payments.ts';
import { applySectionApproval, clearSectionApproval } from './site-builder.ts';

export const APPROVAL_KINDS = ['page', 'field', 'section', 'refund', 'ad_spend', 'shift_swap'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
export type ApprovalRow = typeof approvals.$inferSelect;

/**
 * Who may decide each kind of request. Managers (shift swaps) need operations.write AND locations.read at the
 * location — the same rule as instructor cover — so general staff can never approve swaps.
 */
export const DECIDER: Record<ApprovalKind, { perm: Permission; also?: Permission; label: string }> = {
  page: { perm: 'website.approve', label: 'Website page' },
  field: { perm: 'website.approve', label: 'Website change' },
  section: { perm: 'website.approve', label: 'Website section change' },
  refund: { perm: 'payments.refund', label: 'Refund' },
  ad_spend: { perm: 'marketing.publish', label: 'Local ad spend' },
  shift_swap: { perm: 'operations.write', also: 'locations.read', label: 'Shift swap' },
};

const kindOf = (ap: Pick<ApprovalRow, 'targetType'>): ApprovalKind => (APPROVAL_KINDS.includes(ap.targetType as ApprovalKind) ? (ap.targetType as ApprovalKind) : 'field');

const scopeOf = (orgId: string, locationId: string | null) => (locationId ? { organizationId: orgId, kind: 'location' as const, id: locationId } : { organizationId: orgId, kind: 'organization' as const, id: orgId });

export async function canDecide(req: FastifyRequest, db: Exec, ap: Pick<ApprovalRow, 'organizationId' | 'locationId' | 'targetType'>): Promise<boolean> {
  const d = DECIDER[kindOf(ap)];
  const scope = scopeOf(ap.organizationId, ap.locationId);
  if (!(await hasPerm(req, db, d.perm, scope))) return false;
  return !d.also || (await hasPerm(req, db, d.also, scope));
}

/**
 * Refunds above the organisation's threshold (per currency) need approval. Organisation-wide refunders
 * (owners, org-level finance) are the approvers themselves and are not blocked.
 */
export async function refundNeedsApproval(req: FastifyRequest, db: Exec, orgId: string, amountMinor: number, currency: string) {
  const [org] = await db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
  const threshold = org ? orgPolicies(org).refundApprovalThresholds[currency] : undefined;
  if (threshold === undefined || amountMinor <= threshold) return { required: false as const, threshold: threshold ?? null };
  const orgWide = await hasPerm(req, db, 'payments.refund', scopeOf(orgId, null));
  return { required: !orgWide, threshold };
}

export async function assertRefundWithinThreshold(req: FastifyRequest, db: Exec, orgId: string, amountMinor: number, currency: string) {
  const r = await refundNeedsApproval(req, db, orgId, amountMinor, currency);
  if (r.required) {
    throw new AppError(409, 'approval_required', `Refunds above ${r.threshold} ${currency} minor units need approval. Send a refund request instead.`, undefined, { thresholdMinor: r.threshold, currency, requestEndpoint: `/v1/orgs/${orgId}/refund-requests` });
  }
}

/** Structured title: a stable code plus arguments, so apps can phrase it in the viewer's language. */
export interface ApprovalTitle { code: ApprovalTitleCode; params: Record<string, string | number> }
export type ApprovalTitleCode = 'refund_payment' | 'refund_order' | 'refund_pickup_order' | 'refund_return' | 'shift_swap' | 'website_change' | 'page_submitted' | 'website_section_change';

export interface NewApproval {
  organizationId: string;
  locationId: string | null;
  kind: Exclude<ApprovalKind, 'page' | 'field' | 'section'>;
  targetId: string;
  title: string;
  /** Stored in the payload as `titleI18n` and returned as `titleCode` / `titleParams` (titles typed by people have none). */
  titleI18n?: ApprovalTitle;
  payload: Record<string, unknown>;
  amountMinor?: number | null;
  currency?: string | null;
  requestedBy: string;
  comment?: string | null;
}

/** Insert a pending approval request (call inside the transaction that creates the underlying request). */
export async function insertApproval(tx: Exec, a: NewApproval, ip?: string) {
  const [row] = await tx.insert(approvals).values({
    organizationId: a.organizationId, locationId: a.locationId, targetType: a.kind, targetId: a.targetId, title: a.title, payload: a.titleI18n ? { ...a.payload, titleI18n: a.titleI18n } : a.payload,
    amountMinor: a.amountMinor ?? null, currency: a.currency ?? null, requestedBy: a.requestedBy, requestComment: a.comment ?? null,
  }).returning();
  await audit(tx, { organizationId: a.organizationId, actorUserId: a.requestedBy, action: 'approval.requested', scopeKind: a.locationId ? 'location' : 'organization', scopeId: a.locationId ?? a.organizationId, targetType: a.kind, targetId: a.targetId, metadata: { approvalId: row!.id, amountMinor: a.amountMinor ?? null, currency: a.currency ?? null }, ip: ip ?? null });
  return row!;
}

/** Push "approval needed" to everyone who can decide it (never the requester). */
export async function notifyApprovers(s: Services, ap: ApprovalRow) {
  const d = DECIDER[kindOf(ap)];
  const userIds = (await usersWithPermissionAt(s.db, ap.organizationId, ap.locationId, d.perm, d.also)).filter((id) => id !== ap.requestedBy);
  const [loc] = ap.locationId ? await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, ap.locationId)) : [];
  const money = ap.amountMinor != null && ap.currency ? ` · ${formatMinor(ap.amountMinor, ap.currency)}` : '';
  await notify(s, {
    userIds, organizationId: ap.organizationId, category: 'approval_request',
    title: `${d.label} needs approval`, body: `${ap.title ?? d.label}${money}${loc ? ` · ${loc.name}` : ''}`,
    data: { approvalId: ap.id, kind: kindOf(ap), url: 'branchharbor://owner/approvals' },
  });
}

export function formatMinor(amountMinor: number, currency: string) {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'code' }).format(amountMinor / 10 ** digits);
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

/**
 * Decide a request. The underlying action runs ONLY on approval, after the request is atomically claimed
 * (pending → executing) so two approvers can never execute it twice. If execution fails the request returns
 * to pending, the failure is audited and the error is surfaced.
 */
export async function decideApproval(s: Services, req: FastifyRequest, orgId: string, id: string, decision: 'approve' | 'reject', comment: string | undefined) {
  const me = req.user!;
  const [ap] = await s.db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.organizationId, orgId)));
  if (!ap) throw notFound('Approval');
  const kind = kindOf(ap);
  if (!(await canDecide(req, s.db, ap))) {
    const d = DECIDER[kind];
    throw forbidden(`Missing permission ${d.perm}${d.also ? ` and ${d.also}` : ''} to decide this request`);
  }
  if (ap.status !== 'pending') throw conflict('already_decided', `This request was already ${ap.status}`);
  if (ap.requestedBy === me.id) throw forbidden('You cannot approve your own request');
  if (decision === 'reject' && (kind === 'page' || kind === 'field' || kind === 'section') && !comment) throw validationError('Explain why the change was rejected', { comment: 'Required when rejecting' });
  const scopeKind = ap.locationId ? 'location' : 'organization';
  const scopeId = ap.locationId ?? orgId;

  if (decision === 'reject') {
    await s.db.transaction(async (tx) => {
      const [claimed] = await tx.update(approvals).set({ status: 'rejected', decidedBy: me.id, decisionComment: comment ?? null, decidedAt: new Date() }).where(and(eq(approvals.id, id), eq(approvals.status, 'pending'))).returning();
      if (!claimed) throw conflict('already_decided', 'This request was already decided');
      if (kind === 'field') {
        await tx.update(fieldOverrides).set({ pendingValue: null, pendingApprovalId: null }).where(eq(fieldOverrides.id, ap.targetId));
      } else if (kind === 'section') {
        await clearSectionApproval(tx, ap);
      } else if (kind === 'page') {
        await tx.update(pages).set({ status: 'draft', updatedAt: new Date() }).where(eq(pages.id, ap.targetId));
      } else if (kind === 'ad_spend') {
        await tx.update(campaigns).set({ status: 'archived', updatedAt: new Date() }).where(eq(campaigns.id, ap.targetId));
      } else if (kind === 'shift_swap') {
        await tx.update(shiftSwapRequests).set({ status: 'rejected', decidedBy: me.id, decidedAt: new Date() }).where(eq(shiftSwapRequests.id, ap.targetId));
      }
      await audit(tx, { organizationId: orgId, actorUserId: me.id, action: 'approval.rejected', scopeKind, scopeId, targetType: ap.targetType, targetId: ap.targetId, metadata: { approvalId: id, comment }, ip: req.ip });
    });
    return reload(s, id);
  }

  // Approve: claim first, then execute the underlying action.
  const [claimed] = await s.db.update(approvals).set({ status: 'executing', decidedBy: me.id, decisionComment: comment ?? null, decidedAt: new Date() }).where(and(eq(approvals.id, id), eq(approvals.status, 'pending'))).returning();
  if (!claimed) throw conflict('already_decided', 'This request was already decided');
  let result: Record<string, unknown>;
  try {
    result = await execute(s, ap, me.id, req.ip);
  } catch (err) {
    await s.db.update(approvals).set({ status: 'pending', decidedBy: null, decisionComment: null, decidedAt: null }).where(eq(approvals.id, id));
    await audit(s.db, { organizationId: orgId, actorUserId: me.id, action: 'approval.execution_failed', scopeKind, scopeId, targetType: ap.targetType, targetId: ap.targetId, metadata: { approvalId: id, error: (err as Error).message }, ip: req.ip });
    throw err;
  }
  await s.db.transaction(async (tx) => {
    await tx.update(approvals).set({ status: 'approved', executedAt: new Date(), executionResult: result }).where(eq(approvals.id, id));
    await audit(tx, { organizationId: orgId, actorUserId: me.id, action: 'approval.approved', scopeKind, scopeId, targetType: ap.targetType, targetId: ap.targetId, metadata: { approvalId: id, comment, result }, ip: req.ip });
  });
  return reload(s, id);
}

async function reload(s: Services, id: string) {
  const [u] = await s.db.select().from(approvals).where(eq(approvals.id, id));
  return u!;
}

async function execute(s: Services, ap: ApprovalRow, approverId: string, ip: string): Promise<Record<string, unknown>> {
  switch (kindOf(ap)) {
    case 'field': {
      const [f] = await s.db.select().from(fieldOverrides).where(eq(fieldOverrides.id, ap.targetId));
      if (f) await s.db.update(fieldOverrides).set({ value: f.pendingValue, pendingValue: null, pendingApprovalId: null, updatedBy: ap.requestedBy, updatedAt: new Date() }).where(eq(fieldOverrides.id, f.id));
      return { applied: !!f };
    }
    case 'section':
      return applySectionApproval(s.db, ap, approverId);
    case 'page':
      await s.db.update(pages).set({ status: 'approved', updatedAt: new Date() }).where(eq(pages.id, ap.targetId));
      return { pageStatus: 'approved' };
    case 'refund': {
      const p = ap.payload as { paymentId?: string; orderId?: string; returnId?: string; amountMinor: number; currency: string; reason?: string; restock?: Array<{ variantId: string; quantity: number }> };
      if (p.orderId) {
        const r = await refundCommerceOrder(s, p.orderId, { amountMinor: p.amountMinor, reason: p.reason, restock: p.restock, actorUserId: approverId, ip, returnId: p.returnId ?? null });
        return { orderId: p.orderId, refundState: r.refundState, refundedMinor: r.order.refundedMinor, currency: r.order.currency };
      }
      const r = await refundPayment(s, p.paymentId!, p.amountMinor, { actorUserId: approverId, reason: p.reason, ip });
      if (r.refund.state === 'failed') throw new AppError(502, 'refund_failed', 'The payment provider could not process the refund');
      return { paymentId: p.paymentId, refundId: r.refund.id, refundState: r.refund.state, payment: serializePayment(r.payment) as unknown as Record<string, unknown> };
    }
    case 'ad_spend': {
      const [c] = await s.db.select().from(campaigns).where(eq(campaigns.id, ap.targetId));
      if (!c) throw notFound('Campaign');
      const startsOn = (ap.payload as { startsOn?: string }).startsOn;
      const durationDays = Number((ap.payload as { durationDays?: number }).durationDays ?? 7);
      const startsAt = startsOn ? new Date(`${startsOn}T00:00:00Z`) : new Date();
      const [u] = await s.db.update(campaigns).set({ status: 'scheduled', startsAt, endsAt: new Date(startsAt.getTime() + durationDays * 86400_000), updatedAt: new Date() }).where(eq(campaigns.id, c.id)).returning();
      await audit(s.db, { organizationId: ap.organizationId, actorUserId: approverId, action: 'campaign.budget_approved', scopeKind: 'location', scopeId: ap.locationId, targetType: 'campaign', targetId: c.id, metadata: { budgetMinor: c.budgetMinor, currency: c.currency } });
      return { campaignId: c.id, campaignStatus: u!.status, budgetMinor: c.budgetMinor, currency: c.currency };
    }
    case 'shift_swap':
      return executeShiftSwap(s, ap.targetId, approverId);
  }
}

/** Reassign the shift(s) of an approved swap. Re-checks that nothing changed since the request. */
async function executeShiftSwap(s: Services, swapId: string, approverId: string) {
  return s.db.transaction(async (tx) => {
    const [sw] = await tx.select().from(shiftSwapRequests).where(eq(shiftSwapRequests.id, swapId)).for('update');
    if (!sw || sw.status !== 'pending') throw conflict('swap_not_pending', 'This swap request is no longer pending');
    const ids = [sw.shiftId, ...(sw.toShiftId ? [sw.toShiftId] : [])];
    const rows = await tx.select().from(shifts).where(inArray(shifts.id, ids)).for('update');
    const mine = rows.find((r) => r.id === sw.shiftId);
    const theirs = sw.toShiftId ? rows.find((r) => r.id === sw.toShiftId) : null;
    if (!mine || mine.status !== 'scheduled' || mine.userId !== sw.requestedBy) throw conflict('shift_changed', 'The shift changed since the swap was requested');
    if (sw.toShiftId && (!theirs || theirs.status !== 'scheduled' || theirs.userId !== sw.toUserId)) throw conflict('shift_changed', 'The colleague’s shift changed since the swap was requested');
    await tx.update(shifts).set({ userId: sw.toUserId, updatedAt: new Date() }).where(eq(shifts.id, mine.id));
    if (theirs) await tx.update(shifts).set({ userId: sw.requestedBy, updatedAt: new Date() }).where(eq(shifts.id, theirs.id));
    await tx.update(shiftSwapRequests).set({ status: 'approved', decidedBy: approverId, decidedAt: new Date() }).where(eq(shiftSwapRequests.id, sw.id));
    await audit(tx, { organizationId: sw.organizationId, actorUserId: approverId, action: 'shift.swapped', scopeKind: 'location', scopeId: sw.locationId, targetType: 'shift', targetId: mine.id, metadata: { swapId: sw.id, from: sw.requestedBy, to: sw.toUserId, toShiftId: sw.toShiftId } });
    return { swapId: sw.id, shiftId: mine.id, nowAssignedTo: sw.toUserId, swappedShiftId: theirs?.id ?? null };
  });
}

/**
 * Structured title for an approval row: the code stored at creation, or one derived for website changes (which have
 * no stored title). Requests titled by a person (local ad spend) return null and keep their own `title`.
 */
export function approvalTitleOf(r: Pick<ApprovalRow, 'title' | 'targetType' | 'payload'>): ApprovalTitle | null {
  const p = (r.payload ?? {}) as { titleI18n?: ApprovalTitle; fieldKey?: string };
  if (p.titleI18n?.code) return p.titleI18n;
  if (r.title) return null;
  if (r.targetType === 'page') return { code: 'page_submitted', params: {} };
  if (r.targetType === 'field') return { code: 'website_change', params: { fieldKey: String(p.fieldKey ?? 'field') } };
  return null;
}

/** View model for the approvals inbox: kind, title, money, location, people and whether the viewer can decide. */
export async function serializeApprovals(req: FastifyRequest, db: Exec, rows: ApprovalRow[]) {
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy].filter((x): x is string => !!x)))];
  const locIds = [...new Set(rows.map((r) => r.locationId).filter((x): x is string => !!x))];
  const people = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
  const locs = locIds.length ? await db.select({ id: locations.id, name: locations.name, currency: locations.currency, timeZone: locations.timeZone }).from(locations).where(inArray(locations.id, locIds)) : [];
  const name = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? 'Someone' : null);
  return Promise.all(rows.map(async (r) => ({
    ...r,
    kind: kindOf(r),
    kindLabel: DECIDER[kindOf(r)].label,
    titleCode: approvalTitleOf(r)?.code ?? null,
    titleParams: approvalTitleOf(r)?.params ?? null,
    title: r.title ?? (r.targetType === 'page' ? 'Page submitted for approval' : r.targetType === 'field' ? `Website change: ${String((r.payload as { fieldKey?: string }).fieldKey ?? 'field')}` : DECIDER[kindOf(r)].label),
    amount: r.amountMinor != null && r.currency ? { amount: r.amountMinor, currency: r.currency } : null,
    location: locs.find((l) => l.id === r.locationId) ?? null,
    requester: { id: r.requestedBy, name: name(r.requestedBy) },
    decider: r.decidedBy ? { id: r.decidedBy, name: name(r.decidedBy) } : null,
    canDecide: r.status === 'pending' && r.requestedBy !== req.user?.id && (await canDecide(req, db, r)),
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    executedAt: r.executedAt?.toISOString() ?? null,
  })));
}
