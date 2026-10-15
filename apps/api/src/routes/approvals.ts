import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { currency } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { approvals, campaigns, orders, paymentReferences, refunds } from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasPerm, requireLocationPerm, requireMember } from '../services/authz.ts';
import { APPROVAL_KINDS, canDecide, decideApproval, formatMinor, insertApproval, notifyApprovers, refundNeedsApproval, serializeApprovals, type ApprovalTitle } from '../services/approvals.ts';
import { refundCommerceOrder } from '../services/commerce.ts';
import { refundPayment, serializePayment } from '../services/payments.ts';
import { idParams, orgParams, secured } from './_common.ts';

/**
 * One approvals inbox for owners/HQ: website changes, refunds above the organisation's threshold, local
 * ad spend and shift swaps. Approve/reject with a comment; the underlying action runs only on approval
 * and every step is audited.
 */
export const approvalRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  app.get('/orgs/:orgId/approvals', {
    schema: {
      tags: ['approvals'], security: secured, params: orgParams,
      summary: 'Approval requests the caller can decide (or requested). Filter by status and kind.',
      querystring: z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending'), kind: z.enum(APPROVAL_KINDS).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const me = requireUser(req);
    await requireMember(req, s.db, orgId);
    const conds = [eq(approvals.organizationId, orgId)];
    if (req.query.status !== 'all') conds.push(eq(approvals.status, req.query.status));
    if (req.query.kind) conds.push(eq(approvals.targetType, req.query.kind));
    const rows = await s.db.select().from(approvals).where(and(...conds)).orderBy(desc(approvals.createdAt)).limit(req.query.limit);
    const visible = [];
    for (const r of rows) if (r.requestedBy === me.id || (await canDecide(req, s.db, r))) visible.push(r);
    return { items: await serializeApprovals(req, s.db, visible) };
  });

  app.post('/orgs/:orgId/approvals/:id/decision', {
    schema: {
      tags: ['approvals'], security: secured, params: idParams,
      summary: 'Approve (runs the underlying action) or reject. No self-approval. Website rejections need a comment.',
      body: z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional() }),
    },
  }, async (req) => {
    const updated = await decideApproval(s, req, req.params.orgId, req.params.id, req.body.decision, req.body.comment);
    return (await serializeApprovals(req, s.db, [updated]))[0]!;
  });

  app.post('/orgs/:orgId/approvals/:id/cancel', {
    schema: { tags: ['approvals'], security: secured, params: idParams, summary: 'The requester withdraws a pending request' },
  }, async (req) => {
    const me = requireUser(req);
    const { orgId, id } = req.params;
    await requireMember(req, s.db, orgId);
    const [ap] = await s.db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.organizationId, orgId)));
    if (!ap) throw notFound('Approval');
    if (ap.requestedBy !== me.id) throw forbidden('Only the requester can withdraw this request');
    await s.db.transaction(async (tx) => {
      const [u] = await tx.update(approvals).set({ status: 'cancelled', decidedAt: new Date() }).where(and(eq(approvals.id, id), eq(approvals.status, 'pending'))).returning();
      if (!u) throw conflict('already_decided', `This request was already ${ap.status}`);
      if (ap.targetType === 'ad_spend') await tx.update(campaigns).set({ status: 'archived', updatedAt: new Date() }).where(eq(campaigns.id, ap.targetId));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'approval.cancelled', targetType: ap.targetType, targetId: ap.targetId, metadata: { approvalId: id } });
    });
    const [u] = await s.db.select().from(approvals).where(eq(approvals.id, id));
    return (await serializeApprovals(req, s.db, [u!]))[0]!;
  });

  // ── Refund requests ──
  app.post('/orgs/:orgId/refund-requests', {
    schema: {
      tags: ['approvals'], security: secured, params: orgParams,
      summary: 'Request a refund of a payment or commerce order. Within the org threshold and with payments.refund it runs immediately; otherwise it waits for approval.',
      body: z.object({
        paymentId: z.uuid().optional(), orderId: z.uuid().optional(),
        amountMinor: z.number().int().positive(), currency, reason: z.string().trim().min(1).max(500),
        restock: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1) })).default([]),
      }).refine((b) => !!b.paymentId !== !!b.orderId, { message: 'Provide exactly one of paymentId or orderId', path: ['paymentId'] }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const me = requireUser(req);
    const b = req.body;
    let locationId: string | null;
    let cur: string;
    let remaining: number;
    let label: string;
    let titleI18n: ApprovalTitle;
    if (b.paymentId) {
      const [p] = await s.db.select().from(paymentReferences).where(and(eq(paymentReferences.id, b.paymentId), eq(paymentReferences.organizationId, orgId)));
      if (!p) throw notFound('Payment');
      if (p.state !== 'succeeded') throw conflict('payment_not_refundable', `Only succeeded payments can be refunded (payment is ${p.state})`);
      locationId = p.locationId;
      cur = p.currency;
      const pending = await s.db.select({ amt: refunds.amountMinor }).from(refunds).where(and(eq(refunds.paymentId, p.id), eq(refunds.state, 'pending')));
      remaining = p.amountMinor - p.refundedMinor - pending.reduce((a, r) => a + r.amt, 0);
      label = `Refund for payment ${p.externalId.slice(-8)}`;
      titleI18n = { code: 'refund_payment', params: { ref: p.externalId.slice(-8), amountMinor: b.amountMinor, currency: p.currency } };
    } else {
      const [o] = await s.db.select().from(orders).where(and(eq(orders.id, b.orderId!), eq(orders.organizationId, orgId)));
      if (!o) throw notFound('Order');
      locationId = o.locationId;
      cur = o.currency;
      remaining = o.totalMinor - o.refundedMinor;
      label = `Refund for order ${o.externalId ?? o.id.slice(0, 8)}`;
      titleI18n = { code: 'refund_order', params: { ref: o.externalId ?? o.id.slice(0, 8), amountMinor: b.amountMinor, currency: o.currency } };
    }
    if (!locationId) throw validationError('This payment is not linked to a location', { paymentId: 'No location' });
    await requireLocationPerm(req, s.db, orgId, locationId, 'payments.read');
    if (b.currency !== cur) throw validationError(`This ${b.paymentId ? 'payment' : 'order'} is in ${cur}`, { currency: `Must be ${cur}` });
    if (b.amountMinor > remaining) throw new AppError(409, 'refund_exceeds_remaining', `Refund exceeds the refundable amount (${remaining} ${cur} minor units remain)`, undefined, { remainingMinor: remaining, currency: cur });

    const canRefund = await hasPerm(req, s.db, 'payments.refund', { organizationId: orgId, kind: 'location', id: locationId });
    const threshold = await refundNeedsApproval(req, s.db, orgId, b.amountMinor, cur);
    if (canRefund && !threshold.required) {
      if (b.orderId) {
        const r = await refundCommerceOrder(s, b.orderId, { amountMinor: b.amountMinor, reason: b.reason, restock: b.restock, actorUserId: me.id, ip: req.ip });
        return reply.code(201).send({ status: 'executed' as const, approval: null, result: { orderId: b.orderId, refundState: r.refundState } });
      }
      const r = await refundPayment(s, b.paymentId!, b.amountMinor, { actorUserId: me.id, reason: b.reason, ip: req.ip });
      return reply.code(201).send({ status: 'executed' as const, approval: null, result: { paymentId: b.paymentId, refundState: r.refund.state, payment: serializePayment(r.payment) } });
    }
    const [dupe] = await s.db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.organizationId, orgId), eq(approvals.targetType, 'refund'), eq(approvals.targetId, (b.paymentId ?? b.orderId)!), inArray(approvals.status, ['pending', 'executing'])));
    if (dupe) throw conflict('request_pending', 'A refund request for this is already waiting for approval', { approvalId: dupe.id });
    const ap = await s.db.transaction((tx) => insertApproval(tx, {
      organizationId: orgId, locationId, kind: 'refund', targetId: (b.paymentId ?? b.orderId)!, title: `${label} · ${formatMinor(b.amountMinor, cur)}`, titleI18n,
      payload: { paymentId: b.paymentId ?? null, orderId: b.orderId ?? null, amountMinor: b.amountMinor, currency: cur, reason: b.reason, restock: b.restock },
      amountMinor: b.amountMinor, currency: cur, requestedBy: me.id, comment: b.reason,
    }, req.ip));
    await notifyApprovers(s, ap);
    return reply.code(202).send({ status: 'pending_approval' as const, approval: (await serializeApprovals(req, s.db, [ap]))[0]!, result: null, thresholdMinor: threshold.threshold });
  });

  // ── Local ad spend requests ──
  app.post('/orgs/:orgId/ad-spend-requests', {
    schema: {
      tags: ['approvals'], security: secured, params: orgParams,
      summary: 'A location asks to spend on local ads (amount + currency + location). Creates a campaign awaiting approval; approval schedules it.',
      body: z.object({
        locationId: z.uuid(), amountMinor: z.number().int().positive(), currency,
        channel: z.enum(['google_ads', 'meta_ads', 'local_print', 'other']), durationDays: z.number().int().min(1).max(90),
        startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), title: z.string().trim().min(1).max(120), description: z.string().max(1000).optional(),
      }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const me = requireUser(req);
    const b = req.body;
    const loc = await requireLocationPerm(req, s.db, orgId, b.locationId, 'marketing.draft');
    if (b.currency !== loc.currency) throw validationError(`Ad spend at ${loc.name} is budgeted in ${loc.currency}`, { currency: `Must be ${loc.currency}` });
    const ap = await s.db.transaction(async (tx) => {
      const [c] = await tx.insert(campaigns).values({
        organizationId: orgId, scopeKind: 'location', scopeId: loc.id, name: b.title, channel: b.channel, status: 'pending_approval',
        content: { adSpend: { durationDays: b.durationDays, startsOn: b.startsOn ?? null, description: b.description ?? null } }, budgetMinor: b.amountMinor, currency: loc.currency, createdBy: me.id,
      }).returning();
      return insertApproval(tx, {
        organizationId: orgId, locationId: loc.id, kind: 'ad_spend', targetId: c!.id, title: b.title,
        payload: { campaignId: c!.id, channel: b.channel, durationDays: b.durationDays, startsOn: b.startsOn ?? null, description: b.description ?? null },
        amountMinor: b.amountMinor, currency: loc.currency, requestedBy: me.id, comment: b.description ?? null,
      }, req.ip);
    });
    await notifyApprovers(s, ap);
    return reply.code(201).send((await serializeApprovals(req, s.db, [ap]))[0]!);
  });
};
