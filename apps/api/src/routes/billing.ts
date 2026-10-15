import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { BILLING_INTERVALS, LOCATION_FEE_PAYERS, PLAN_PRICE_KEYS, planQuote, priceListForCountry } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { locations, users } from '../db/schema/index.ts';
import { forbidden } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { hasPerm, requireMember, requirePerm } from '../services/authz.ts';
import {
  billingTerms, billingView, cancelCountryChange, confirmCheckout, confirmCountryChange, confirmFranchiseeSetup, franchiseeBillingView, removePayer, setCancellation,
  setPayer, startCheckout, startCountryChange, startFranchiseeSetup, trialEligibility,
} from '../services/billing.ts';
import { buildExport, exportBytes, listExports, requestExport, serializeExport } from '../services/data-export.ts';
import { orgParams, secured } from './_common.ts';

const country = z.string().regex(/^[A-Za-z]{2}$/, 'Use an ISO country code such as GB').transform((v) => v.toUpperCase());

/**
 * BranchHarbor plan billing (Settings → Billing), franchisee billing and the free data export. Customer payments are
 * separate (routes/payments.ts). Prices come from the shared price book; the billing country is locked at checkout.
 */
export const billingRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  s.jobs.register('data-export.build', async ({ exportId }: { exportId: string }) => buildExport(s, exportId));

  // Public: the emailed export link (token-checked, expires after 7 days).
  app.get('/exports/:exportId/download', {
    schema: { tags: ['billing'], summary: 'Download a data export with the emailed link (valid 7 days)', params: z.object({ exportId: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
  }, async (req, reply) => {
    const f = await exportBytes(s, req.params.exportId, { token: req.query.token });
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${f.fileName}"`).header('cache-control', 'no-store').send(f.bytes);
  });

  const authed: FastifyPluginAsyncZod = async (r) => {
    r.addHook('preHandler', authenticate);
    const me = async (req: Parameters<typeof requireUser>[0]) => {
      const u = requireUser(req);
      const [row] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, u.id));
      return { userId: u.id, email: row?.email ?? null, ip: req.ip };
    };
    const manage = (req: Parameters<typeof requireUser>[0], orgId: string) => requirePerm(req, s.db, 'billing.manage', { organizationId: orgId, kind: 'organization', id: orgId });
    const requireOwner = async (req: Parameters<typeof requireUser>[0], orgId: string) => {
      const mine = await requireMember(req, s.db, orgId);
      if (!mine.some((a) => a.role === 'org_owner' && a.scopeKind === 'organization')) throw forbidden('Only the business owner can export the business data');
    };

    r.get('/orgs/:orgId/billing', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Plan, paid trial, billing country, who pays each location, invoices' },
    }, async (req) => {
      await manage(req, req.params.orgId);
      const view = await billingView(s, req.params.orgId);
      const actor = await me(req);
      const eligibility = view.status === 'checkout_required' || view.status === 'canceled' ? await trialEligibility(s.db, req.params.orgId, { email: actor.email }) : null;
      return { ...view, trialEligibility: eligibility };
    });

    r.get('/orgs/:orgId/billing/quote', {
      schema: {
        tags: ['billing'], security: secured, params: orgParams, summary: 'Price for a plan, recomputed from the billing country (no side effects)',
        querystring: z.object({ plan: z.enum(PLAN_PRICE_KEYS), interval: z.enum(BILLING_INTERVALS).default('month'), billingCountry: country, locations: z.coerce.number().int().min(0).max(5000).optional() }),
      },
    }, async (req) => {
      await manage(req, req.params.orgId);
      const list = priceListForCountry(req.query.billingCountry);
      return { quote: planQuote({ priceList: list.key, plan: req.query.plan, interval: req.query.interval, locations: req.query.locations ?? 1 }), billingCountry: req.query.billingCountry, terms: { ...billingTerms(req.query.billingCountry), taxCollected: s.cfg.STRIPE_TAX_ENABLED } };
    });

    r.post('/orgs/:orgId/billing/checkout', {
      schema: {
        tags: ['billing'], security: secured, params: orgParams,
        summary: 'Start the paid-trial checkout: locks the price from the billing country and opens a card setup (Stripe SetupIntent)',
        body: z.object({ plan: z.enum(PLAN_PRICE_KEYS), interval: z.enum(BILLING_INTERVALS).default('month'), billingCountry: country, locations: z.number().int().min(0).max(5000).optional(), currency: z.string().length(3).optional() }),
      },
    }, async (req) => {
      await manage(req, req.params.orgId);
      return startCheckout(s, req.params.orgId, req.body, await me(req));
    });

    r.post('/orgs/:orgId/billing/checkout/confirm', {
      schema: {
        tags: ['billing'], security: secured, params: orgParams,
        summary: 'Confirm the checkout: the card must be issued in the billing country (or give a tax ID from it); starts the 14-day paid trial',
        description: 'Live: pass the confirmed `setupIntentId`. Sandbox: pass `paymentMethodId` such as pm_sandbox_card_GB. `acceptTerms` confirms the trial terms shown at checkout.',
        body: z.object({ setupIntentId: z.string().optional(), paymentMethodId: z.string().optional(), taxId: z.string().max(40).optional(), acceptTerms: z.literal(true, { error: 'Accept the trial terms to continue' }) }),
      },
    }, async (req) => {
      await manage(req, req.params.orgId);
      const r2 = await confirmCheckout(s, req.params.orgId, { setupIntentId: req.body.setupIntentId, paymentMethodId: req.body.paymentMethodId, taxId: req.body.taxId?.trim() || null }, await me(req));
      return { ...r2, billing: await billingView(s, req.params.orgId) };
    });

    r.post('/orgs/:orgId/billing/cancel', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Cancel at the end of the trial or period (no cancellation fee)', body: z.object({ reason: z.string().max(500).optional() }).default({}) },
    }, async (req) => {
      await manage(req, req.params.orgId);
      const actor = await me(req);
      return setCancellation(s, req.params.orgId, true, { ...actor, reason: req.body.reason ?? null });
    });

    r.post('/orgs/:orgId/billing/resume', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Withdraw a scheduled cancellation' },
    }, async (req) => {
      await manage(req, req.params.orgId);
      return setCancellation(s, req.params.orgId, false, await me(req));
    });

    r.post('/orgs/:orgId/billing/country', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Change the billing country (next cycle): opens a card setup for the new country', body: z.object({ billingCountry: country }) },
    }, async (req) => {
      await manage(req, req.params.orgId);
      return startCountryChange(s, req.params.orgId, req.body, await me(req));
    });

    r.post('/orgs/:orgId/billing/country/confirm', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Confirm a billing country change with a card from that country (or its tax ID); takes effect next cycle', body: z.object({ setupIntentId: z.string().optional(), paymentMethodId: z.string().optional(), taxId: z.string().max(40).optional() }) },
    }, async (req) => {
      await manage(req, req.params.orgId);
      return confirmCountryChange(s, req.params.orgId, { ...req.body, taxId: req.body.taxId?.trim() || null }, await me(req));
    });

    r.delete('/orgs/:orgId/billing/country', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Cancel a pending billing country change' },
    }, async (req, reply) => {
      await manage(req, req.params.orgId);
      await cancelCountryChange(s, req.params.orgId, await me(req));
      return reply.code(204).send();
    });

    r.put('/orgs/:orgId/billing/payers', {
      schema: {
        tags: ['billing'], security: secured, params: orgParams, summary: 'Network: who pays a location\'s fee (HQ, franchisee or a split), per location or owner group',
        body: z.object({ scopeKind: z.enum(['location', 'owner_group']), scopeId: z.uuid(), payer: z.enum(LOCATION_FEE_PAYERS), franchiseePercent: z.number().int().min(0).max(100).optional() }),
      },
    }, async (req) => {
      await manage(req, req.params.orgId);
      return setPayer(s, req.params.orgId, req.body, await me(req));
    });

    r.delete('/orgs/:orgId/billing/payers/:payerId', {
      schema: { tags: ['billing'], security: secured, params: orgParams.extend({ payerId: z.uuid() }), summary: 'Remove a payer setting (falls back to the owner group, then HQ)' },
    }, async (req, reply) => {
      await manage(req, req.params.orgId);
      await removePayer(s, req.params.orgId, req.params.payerId, await me(req));
      return reply.code(204).send();
    });

    // ── Franchisee billing: location fees HQ passes on to the franchisee ──
    /** Owner-group / location scopes the caller holds in this organisation (or any scope for billing managers). */
    const franchiseeScopes = async (req: Parameters<typeof requireUser>[0], orgId: string, want?: { kind: 'location' | 'owner_group'; id: string }) => {
      const mine = await requireMember(req, s.db, orgId);
      const own = mine.filter((a) => a.scopeKind === 'owner_group' || a.scopeKind === 'location').map((a) => ({ kind: a.scopeKind as 'location' | 'owner_group', id: a.scopeId }));
      const unique = [...new Map(own.map((x) => [`${x.kind}:${x.id}`, x])).values()];
      if (want) {
        const holds = unique.some((x) => x.kind === want.kind && x.id === want.id);
        if (holds) return [want];
        if (want.kind === 'location') {
          const [l] = await s.db.select({ ownerGroupId: locations.ownerGroupId }).from(locations).where(and(eq(locations.id, want.id), eq(locations.organizationId, orgId)));
          if (l?.ownerGroupId && unique.some((x) => x.kind === 'owner_group' && x.id === l.ownerGroupId)) return [want];
        }
        if (await hasPerm(req, s.db, 'billing.manage', { organizationId: orgId, kind: 'organization', id: orgId })) return [want];
        throw forbidden('You can only manage billing for your own locations');
      }
      return unique;
    };

    r.get('/orgs/:orgId/franchisee-billing', {
      schema: { tags: ['billing'], security: secured, params: orgParams, querystring: z.object({ scopeKind: z.enum(['location', 'owner_group']).optional(), scopeId: z.uuid().optional() }), summary: 'Franchisee billing: the location fees you pay, your billing account and invoices' },
    }, async (req) => {
      const want = req.query.scopeKind && req.query.scopeId ? { kind: req.query.scopeKind, id: req.query.scopeId } : undefined;
      const scopes = await franchiseeScopes(req, req.params.orgId, want);
      return franchiseeBillingView(s, req.params.orgId, scopes);
    });

    r.post('/orgs/:orgId/franchisee-billing/setup', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Open a franchisee billing account (card setup in your billing country)', body: z.object({ scopeKind: z.enum(['location', 'owner_group']), scopeId: z.uuid(), billingCountry: country }) },
    }, async (req) => {
      await franchiseeScopes(req, req.params.orgId, { kind: req.body.scopeKind, id: req.body.scopeId });
      return startFranchiseeSetup(s, req.params.orgId, req.body, await me(req));
    });

    r.post('/orgs/:orgId/franchisee-billing/confirm', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Confirm the franchisee card (issued in the billing country, or give a tax ID from it)', body: z.object({ scopeKind: z.enum(['location', 'owner_group']), scopeId: z.uuid(), setupIntentId: z.string().optional(), paymentMethodId: z.string().optional(), taxId: z.string().max(40).optional() }) },
    }, async (req) => {
      await franchiseeScopes(req, req.params.orgId, { kind: req.body.scopeKind, id: req.body.scopeId });
      return confirmFranchiseeSetup(s, req.params.orgId, { ...req.body, taxId: req.body.taxId?.trim() || null }, await me(req));
    });

    // ── Free data export (owner only) ──
    r.post('/orgs/:orgId/exports', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Export your data: a ZIP of CSVs of the business\'s core tables, emailed as a 7-day link (owner only, free)' },
    }, async (req, reply) => {
      await requireOwner(req, req.params.orgId);
      const row = await requestExport(s, req.params.orgId, await me(req));
      return reply.code(202).send(serializeExport(row));
    });

    r.get('/orgs/:orgId/exports', {
      schema: { tags: ['billing'], security: secured, params: orgParams, summary: 'Recent data exports (owner only)' },
    }, async (req) => {
      await requireOwner(req, req.params.orgId);
      return { items: await listExports(s, req.params.orgId) };
    });

    r.get('/orgs/:orgId/exports/:exportId/download', {
      schema: { tags: ['billing'], security: secured, params: orgParams.extend({ exportId: z.uuid() }), summary: 'Download a data export (owner only, while valid)' },
    }, async (req, reply) => {
      await requireOwner(req, req.params.orgId);
      const f = await exportBytes(s, req.params.exportId, { orgId: req.params.orgId });
      return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${f.fileName}"`).header('cache-control', 'no-store').send(f.bytes);
    });
  };
  await app.register(authed);
};
