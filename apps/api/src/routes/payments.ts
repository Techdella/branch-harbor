import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { locations, organizations, paymentReferences, refunds, webhookEvents } from '../db/schema/index.ts';
import { AppError, conflict, notFound, unavailable, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requirePerm } from '../services/authz.ts';
import { processStripeEvent, reconciliationQueue, recreateRecordFromPayment, refundPayment, sandboxEvent, serializePayment } from '../services/payments.ts';
import { idParams, orgParams, secured } from './_common.ts';

/** POST /v1/webhooks/stripe — raw body, signature verified, idempotent via webhook_events. */
export const webhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/stripe', {
    config: { rateLimit: false },
    schema: { tags: ['webhooks'], summary: 'Stripe webhook (signature-verified, idempotent)', headers: z.object({ 'stripe-signature': z.string().optional() }).loose() },
  }, async (req, reply) => {
    if (!s.payments.webhooksEnabled) throw unavailable('webhooks_disabled', 'Stripe webhooks are not configured (STRIPE_WEBHOOK_SECRET)');
    const sig = req.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') throw new AppError(400, 'missing_signature', 'Missing Stripe-Signature header');
    let event;
    try {
      event = s.payments.constructWebhookEvent(req.body as Buffer, sig);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'stripe webhook signature verification failed');
      throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed');
    }
    const outcome = await processStripeEvent(s, event);
    return reply.code(200).send({ received: true, ...outcome });
  });
};

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  // Sandbox only: simulate the provider confirming a payment, through the same event processor.
  app.post('/public/payments/:paymentId/sandbox-confirm', {
    schema: {
      tags: ['payments'], summary: 'SANDBOX ONLY: simulate Stripe confirming (or failing) a payment',
      params: z.object({ paymentId: z.uuid() }), body: z.object({ outcome: z.enum(['succeeded', 'failed']).default('succeeded'), amountMinor: z.number().int().optional() }).default({ outcome: 'succeeded' }),
    },
  }, async (req) => {
    if (s.payments.mode !== 'sandbox' || s.cfg.NODE_ENV === 'production') throw notFound('Route');
    const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, req.params.paymentId));
    if (!p || p.sandbox !== 1) throw notFound('Payment');
    const outcome = await processStripeEvent(s, sandboxEvent(p, req.body.outcome === 'succeeded' ? 'payment_intent.succeeded' : 'payment_intent.payment_failed', req.body.amountMinor));
    const [after] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, p.id));
    return { outcome, payment: serializePayment(after!) };
  });

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    priv.post('/orgs/:orgId/payments/connect/onboarding', {
      schema: {
        tags: ['payments'], security: secured, params: orgParams,
        summary: 'Stripe Connect onboarding link. per_location mode: one account per location; shared mode: one org account.',
        body: z.object({ locationId: z.uuid().optional(), returnUrl: z.url().optional(), refreshUrl: z.url().optional() }),
      },
    }, async (req) => {
      const { orgId } = req.params;
      await requirePerm(req, s.db, 'billing.manage', { organizationId: orgId, kind: 'organization', id: orgId });
      const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
      if (!org) throw notFound('Organisation');
      const shared = org.paymentAccountMode === 'shared';
      if (!shared && !req.body.locationId) throw validationError('locationId is required in per-location mode', { locationId: 'Required' });
      const [loc] = req.body.locationId ? await s.db.select().from(locations).where(and(eq(locations.id, req.body.locationId), eq(locations.organizationId, orgId))) : [];
      if (req.body.locationId && !loc) throw notFound('Location');
      let accountId = shared ? org.stripeAccountId : loc!.stripeAccountId;
      if (!accountId) {
        accountId = (await s.payments.createConnectedAccount({ country: shared ? org.country : loc!.country, email: loc?.email ?? null, businessName: shared ? org.name : `${org.name} — ${loc!.name}` })).accountId;
        if (shared) await s.db.update(organizations).set({ stripeAccountId: accountId }).where(eq(organizations.id, orgId));
        else await s.db.update(locations).set({ stripeAccountId: accountId }).where(eq(locations.id, loc!.id));
      }
      const ret = req.body.returnUrl ?? `${s.cfg.APP_URL}/payments/setup/complete`;
      const link = await s.payments.createOnboardingLink(accountId, req.body.refreshUrl ?? `${s.cfg.APP_URL}/payments/setup`, ret);
      if (s.payments.mode === 'sandbox') {
        // Sandbox accounts are immediately enabled so flows can be tested end to end.
        if (shared) await s.db.update(locations).set({ paymentsEnabled: true }).where(eq(locations.organizationId, orgId));
        else await s.db.update(locations).set({ paymentsEnabled: true }).where(eq(locations.id, loc!.id));
      }
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'payments.onboarding_started', scopeKind: loc ? 'location' : 'organization', scopeId: loc?.id ?? orgId, metadata: { accountId, mode: org.paymentAccountMode } });
      return { accountId, url: link.url, expiresAt: link.expiresAt?.toISOString() ?? null, mode: s.payments.mode, accountScope: shared ? 'organization' : 'location' };
    });

    priv.get('/orgs/:orgId/payments/connect/status', { schema: { tags: ['payments'], security: secured, params: orgParams } }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'payments.read');
      const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
      const locs = await s.db.select().from(locations).where(eq(locations.organizationId, orgId));
      return {
        mode: org!.paymentAccountMode, provider: 'stripe', providerMode: s.payments.mode, applicationFeeBps: org!.applicationFeeBps,
        locations: locs.filter((l) => allowed === 'all' || allowed.has(l.id)).map((l) => ({ id: l.id, name: l.name, currency: l.currency, accountId: org!.paymentAccountMode === 'shared' ? org!.stripeAccountId : l.stripeAccountId, paymentsEnabled: l.paymentsEnabled })),
      };
    });

    priv.get('/orgs/:orgId/payments', {
      schema: { tags: ['payments'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), state: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }) },
    }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'payments.read');
      const conds = [eq(paymentReferences.organizationId, orgId)];
      if (req.query.locationId) conds.push(eq(paymentReferences.locationId, req.query.locationId));
      if (req.query.state) conds.push(eq(paymentReferences.state, req.query.state));
      if (allowed !== 'all') {
        if (!allowed.size) return { items: [] };
        conds.push(inArray(paymentReferences.locationId, [...allowed]));
      }
      const rows = await s.db.select().from(paymentReferences).where(and(...conds)).orderBy(desc(paymentReferences.createdAt)).limit(req.query.limit);
      return { items: rows.map(serializePayment) };
    });

    const loadPayment = async (orgId: string, id: string) => {
      const [p] = await s.db.select().from(paymentReferences).where(and(eq(paymentReferences.id, id), eq(paymentReferences.organizationId, orgId)));
      if (!p) throw notFound('Payment');
      return p;
    };

    priv.get('/orgs/:orgId/payments/:id', { schema: { tags: ['payments'], security: secured, params: idParams, summary: 'Payment detail with refunds and source events timeline' } }, async (req) => {
      const p = await loadPayment(req.params.orgId, req.params.id);
      if (p.locationId) await requirePerm(req, s.db, 'payments.read', { organizationId: p.organizationId, kind: 'location', id: p.locationId });
      else await requirePerm(req, s.db, 'payments.read', { organizationId: p.organizationId, kind: 'organization', id: p.organizationId });
      const r = await s.db.select().from(refunds).where(eq(refunds.paymentId, p.id)).orderBy(desc(refunds.createdAt));
      const events = await s.db.select({ id: webhookEvents.eventId, type: webhookEvents.type, status: webhookEvents.status, receivedAt: webhookEvents.receivedAt }).from(webhookEvents).where(eq(webhookEvents.paymentId, p.id)).orderBy(webhookEvents.receivedAt);
      return { ...serializePayment(p), refunds: r, events };
    });

    priv.post('/orgs/:orgId/payments/:id/refunds', {
      schema: {
        tags: ['payments'], security: secured, params: idParams,
        summary: 'Partial or full refund (payments.refund). Amount in the payment currency minor units; `confirmCurrency` must match.',
        body: z.object({ amountMinor: z.number().int().positive(), confirmCurrency: z.string().length(3), reason: z.string().max(500).optional() }),
      },
    }, async (req, reply) => {
      const p = await loadPayment(req.params.orgId, req.params.id);
      await requirePerm(req, s.db, 'payments.refund', p.locationId ? { organizationId: p.organizationId, kind: 'location', id: p.locationId } : { organizationId: p.organizationId, kind: 'organization', id: p.organizationId });
      if (req.body.confirmCurrency.toUpperCase() !== p.currency) throw validationError(`This payment is in ${p.currency}`, { confirmCurrency: `Must be ${p.currency}` });
      const r = await refundPayment(s, p.id, req.body.amountMinor, { actorUserId: req.user!.id, reason: req.body.reason, ip: req.ip });
      return reply.code(201).send({ payment: serializePayment(r.payment), refund: r.refund });
    });

    priv.get('/orgs/:orgId/payments/reconciliation', {
      schema: { tags: ['payments'], security: secured, params: orgParams, summary: 'Recovery queue: paid without fulfilled record, unpaid but confirmed record, amount mismatch' },
    }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'payments.read');
      if (allowed !== 'all' && !allowed.size) return { items: [], counts: {} };
      const items = await reconciliationQueue(s.db, req.params.orgId, allowed);
      const counts: Record<string, number> = {};
      for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
      return { items, counts, generatedAt: new Date().toISOString() };
    });

    priv.post('/orgs/:orgId/payments/:id/recreate-record', {
      schema: {
        tags: ['payments'], security: secured, params: idParams, summary: 'Recover the business record for a succeeded payment',
        body: z.object({ allowOverCapacity: z.boolean().default(false) }).default({ allowOverCapacity: false }),
      },
    }, async (req) => {
      const p = await loadPayment(req.params.orgId, req.params.id);
      const scope = p.locationId ? { organizationId: p.organizationId, kind: 'location' as const, id: p.locationId } : { organizationId: p.organizationId, kind: 'organization' as const, id: p.organizationId };
      await requirePerm(req, s.db, 'payments.refund', scope);
      await requirePerm(req, s.db, 'operations.write', scope);
      const result = await recreateRecordFromPayment(s, p.id, req.user!.id, { allowOverCapacity: req.body.allowOverCapacity });
      if (!result.fulfilled) throw conflict('recovery_failed', result.note);
      return result;
    });
  });
};
