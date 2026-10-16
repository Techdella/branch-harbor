import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AD_PLATFORMS, currency, splitBudget } from '@bh/shared';
import { adCampaignLocations, adCampaignResults, adCampaigns, campaigns, consentRecords, leads, locations, marketingFundSpendEvents } from '../db/schema/index.ts';
import { adsOauthUrl, fetchInsights } from '../integrations/ads.ts';
import { signState } from '../integrations/social.ts';
import { conflict, forbidden, notFound, unavailable, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { insertApproval, notifyApprovers } from '../services/approvals.ts';
import { actor, audit } from '../services/audit.ts';
import { hasAt, requireAnyAt, requireAt, scopeFor } from '../services/comms-scope.ts';
import { createRoutedLead } from '../services/lead-routing.ts';
import { FUNDED_KINDS, markConsumed, recordFundSpend } from '../services/marketing-fund.ts';
import { callCountsByCampaign } from '../services/call-tracking.ts';
import { idParams, orgParams, secured } from './_common.ts';
import { brandSharedCond } from '../services/brands.ts';

const NC = 'marketing.network_campaigns';
const ADS = 'marketing.ads';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ONBOARDING = ['draft', 'onboarding', 'opening_soon'];
const creative = z.object({ headline: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(1000), imageUrl: z.url().max(2000).nullable().optional(), assetId: z.string().max(100).nullable().optional(), cta: z.string().max(40).nullable().optional(), landingUrl: z.url().max(2000).nullable().optional() });
const comingSoon = z.object({ openingDate: day, presaleOffer: z.string().trim().min(1).max(300), formFields: z.array(z.enum(['name', 'email', 'phone'])).min(1).default(['name', 'email']), consentText: z.string().trim().min(1).max(500).default('Send me news and offers about the opening. I can unsubscribe at any time.') });

type CampaignRow = typeof adCampaigns.$inferSelect;

/**
 * Paid campaigns: network campaigns HQ runs for all / some locations (budget split per location in each location's
 * currency, geo radius per location, creative from brand assets), coming-soon campaigns for locations in onboarding
 * (opening date, pre-sale offer, public lead form), course campaigns (teacher-training leads → instructors) and a
 * location's own local campaigns (budget approval in the approvals inbox). Spend and results are entered by hand
 * (ads adapters are scaffolding only); leads are attributed to campaign and location; funded spend is published to
 * the marketing fund ledger.
 */
export const adCampaignRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  /** Local campaigns follow their ad_spend approval: approved → scheduled, rejected/cancelled → rejected. */
  const syncApproval = async (c: CampaignRow): Promise<CampaignRow> => {
    if (c.status !== 'pending_approval' || !c.approvalCampaignId) return c;
    const [legacy] = await s.db.select({ status: campaigns.status }).from(campaigns).where(eq(campaigns.id, c.approvalCampaignId));
    const next = legacy?.status === 'scheduled' ? 'scheduled' : legacy?.status === 'archived' ? 'rejected' : null;
    if (!next) return c;
    const [u] = await s.db.update(adCampaigns).set({ status: next, updatedAt: new Date() }).where(and(eq(adCampaigns.id, c.id), eq(adCampaigns.status, 'pending_approval'))).returning();
    return u ?? c;
  };

  async function details(orgId: string, rows: CampaignRow[], visibleLocs: string[] | null) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const locRows = await s.db.select({ cl: adCampaignLocations, name: locations.name, status: locations.status, city: sql<string>`${locations.address}->>'city'` }).from(adCampaignLocations).innerJoin(locations, eq(locations.id, adCampaignLocations.locationId)).where(inArray(adCampaignLocations.campaignId, ids)).orderBy(asc(locations.name));
    const results = await s.db.select({ campaignId: adCampaignResults.campaignId, locationId: adCampaignResults.locationId, spend: sql<number>`sum(${adCampaignResults.spendMinor})::bigint`, impressions: sql<number>`sum(${adCampaignResults.impressions})::int`, clicks: sql<number>`sum(${adCampaignResults.clicks})::int`, platformLeads: sql<number>`sum(${adCampaignResults.platformLeads})::int` })
      .from(adCampaignResults).where(inArray(adCampaignResults.campaignId, ids)).groupBy(adCampaignResults.campaignId, adCampaignResults.locationId);
    const leadCounts = await s.db.select({ campaignId: leads.adCampaignId, locationId: leads.locationId, n: sql<number>`count(*)::int` }).from(leads).where(and(eq(leads.organizationId, orgId), inArray(leads.adCampaignId, ids))).groupBy(leads.adCampaignId, leads.locationId);
    // Calls to the campaign's tracking numbers (Marketing → Call tracking).
    const callCounts = await callCountsByCampaign(s.db, orgId, ids);
    return rows.map((c) => {
      const locs = locRows.filter((l) => l.cl.campaignId === c.id && (!visibleLocs || visibleLocs.includes(l.cl.locationId))).map((l) => {
        const r = results.find((x) => x.campaignId === c.id && x.locationId === l.cl.locationId);
        const leadsN = leadCounts.find((x) => x.campaignId === c.id && x.locationId === l.cl.locationId)?.n ?? 0;
        const calls = callCounts.find((x) => x.campaignId === c.id && x.locationId === l.cl.locationId);
        const spend = Number(r?.spend ?? 0);
        return {
          locationId: l.cl.locationId, name: l.name, city: l.city, locationStatus: l.status, budget: { amount: l.cl.budgetMinor, currency: l.cl.currency }, radiusKm: l.cl.radiusKm,
          spend: { amount: spend, currency: l.cl.currency }, impressions: r?.impressions ?? 0, clicks: r?.clicks ?? 0, platformLeads: r?.platformLeads ?? 0, leads: leadsN, calls: calls?.calls ?? 0, answeredCalls: calls?.answered ?? 0,
          costPerLead: leadsN ? { amount: Math.round(spend / leadsN), currency: l.cl.currency } : null,
        };
      });
      const byCur = new Map<string, { budget: number; spend: number; leads: number }>();
      for (const l of locs) {
        const t = byCur.get(l.budget.currency) ?? { budget: 0, spend: 0, leads: 0 };
        byCur.set(l.budget.currency, { budget: t.budget + l.budget.amount, spend: t.spend + l.spend.amount, leads: t.leads + l.leads });
      }
      return {
        id: c.id, kind: c.kind, name: c.name, objective: c.objective, platforms: c.platforms, status: c.status, startsOn: c.startsOn, endsOn: c.endsOn, creative: c.creative, comingSoon: c.comingSoon,
        approvalId: c.approvalId, createdAt: c.createdAt.toISOString(), leadFormPath: c.kind === 'coming_soon' || c.kind === 'course' ? `/v1/public/ad-campaigns/${c.id}/leads` : null,
        totals: [...byCur.entries()].map(([cur, t]) => ({ currency: cur, budget: t.budget, spend: t.spend, leads: t.leads, costPerLead: t.leads ? Math.round(t.spend / t.leads) : null })),
        unattributedLeads: leadCounts.filter((x) => x.campaignId === c.id && !x.locationId).reduce((a, x) => a + x.n, 0),
        calls: callCounts.filter((x) => x.campaignId === c.id && (!visibleLocs || visibleLocs.includes(x.locationId))).reduce((a, x) => a + x.calls, 0),
        locations: locs,
      };
    });
  }

  /* ── public: coming-soon / course landing data and lead capture ── */

  app.get('/public/ad-campaigns/:id', {
    schema: { tags: ['public'], summary: 'Public landing data of a coming-soon or course campaign (lead form)', params: z.object({ id: z.uuid() }) },
  }, async (req) => {
    const [c] = await s.db.select().from(adCampaigns).where(eq(adCampaigns.id, req.params.id));
    if (!c || !['coming_soon', 'course'].includes(c.kind) || !['scheduled', 'active'].includes(c.status)) throw notFound('Campaign');
    const locs = await s.db.select({ id: locations.id, name: locations.name, city: sql<string>`${locations.address}->>'city'`, country: locations.country }).from(adCampaignLocations).innerJoin(locations, eq(locations.id, adCampaignLocations.locationId)).where(eq(adCampaignLocations.campaignId, c.id)).orderBy(asc(locations.name));
    return { id: c.id, kind: c.kind, name: c.name, creative: c.creative, comingSoon: c.comingSoon, locations: locs };
  });

  app.post('/public/ad-campaigns/:id/leads', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['public'], summary: 'Lead form submission: the lead is attributed to the campaign and location, consent is recorded, routing rules apply',
      params: z.object({ id: z.uuid() }),
      body: z.object({ locationId: z.uuid().optional(), name: z.string().trim().min(1).max(120), email: z.email().optional(), phone: z.string().trim().max(40).optional(), postalCode: z.string().max(12).optional(), marketingConsent: z.boolean().default(false), message: z.string().max(1000).optional() })
        .refine((b) => !!b.email || !!b.phone, { message: 'Leave an email or a phone number', path: ['email'] }),
    },
  }, async (req, reply) => {
    const [c] = await s.db.select().from(adCampaigns).where(eq(adCampaigns.id, req.params.id));
    if (!c || !['scheduled', 'active'].includes(c.status)) throw notFound('Campaign');
    const members = await s.db.select({ locationId: adCampaignLocations.locationId, country: locations.country }).from(adCampaignLocations).innerJoin(locations, eq(locations.id, adCampaignLocations.locationId)).where(eq(adCampaignLocations.campaignId, c.id));
    const b = req.body;
    const loc = b.locationId ? members.find((m) => m.locationId === b.locationId) : members.length === 1 ? members[0] : undefined;
    if (b.locationId && !loc) throw validationError('This campaign doesn’t run at that location', { locationId: 'Not in this campaign' });
    const lead = await s.db.transaction(async (tx) => {
      const l = await createRoutedLead(tx, {
        organizationId: c.organizationId, locationId: loc?.locationId ?? null, adCampaignId: c.id, kind: c.kind === 'course' ? 'course' : 'customer', source: c.kind === 'course' ? 'course_campaign' : c.kind === 'coming_soon' ? 'coming_soon' : 'ad_campaign',
        name: b.name, email: b.email ?? null, phone: b.phone ?? null, postalCode: b.postalCode ?? null, country: loc?.country ?? null, message: b.message ?? null,
      });
      await tx.insert(consentRecords).values({ organizationId: c.organizationId, email: b.email ?? null, purpose: 'marketing_email', version: `campaign:${c.id}`, granted: b.marketingConsent, source: 'lead_form', ip: req.ip });
      return l;
    });
    return reply.code(201).send({ received: true, leadId: lead.id });
  });

  /* ── authenticated ── */

  await app.register(async (priv) => {
    priv.addHook('preHandler', authenticate);
    const r = priv.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();

    const loadCampaign = async (orgId: string, id: string) => {
      const [c] = await s.db.select().from(adCampaigns).where(and(eq(adCampaigns.id, id), eq(adCampaigns.organizationId, orgId)));
      if (!c) throw notFound('Campaign');
      return syncApproval(c);
    };
    /** HQ campaigns need Network campaigns; a location's own campaigns need Ads at that location. */
    const campaignLocs = async (id: string) => (await s.db.select({ locationId: adCampaignLocations.locationId }).from(adCampaignLocations).where(eq(adCampaignLocations.campaignId, id))).map((x) => x.locationId);
    const requireCampaign = async (req: Parameters<typeof requireAt>[0], c: CampaignRow, act: 'view' | 'edit' | 'publish') => {
      if (await hasAt(req, s.db, c.organizationId, null, NC, act)) return;
      if (c.kind === 'local') {
        const [loc] = await campaignLocs(c.id);
        return requireAt(req, s.db, c.organizationId, loc, ADS, act);
      }
      if (act === 'view') {
        const sc = await scopeFor(req, s.db, c.organizationId, ADS);
        const locs = await campaignLocs(c.id);
        if (sc.all || locs.some((l) => sc.locationIds!.includes(l))) return;
      }
      throw forbidden('You don’t have access to this campaign');
    };

    r.get('/orgs/:orgId/ad-campaigns', {
      schema: { tags: ['marketing'], security: secured, params: orgParams, summary: 'Campaigns you can see with budget, spend, results and attributed leads per location', querystring: z.object({ kind: z.enum(['network', 'coming_soon', 'local', 'course', 'all']).default('all') }) },
    }, async (req) => {
      const { orgId } = req.params;
      const hq = await hasAt(req, s.db, orgId, null, NC, 'view');
      const ads = await scopeFor(req, s.db, orgId, ADS);
      const conds: SQL[] = [eq(adCampaigns.organizationId, orgId)];
      if (req.query.kind !== 'all') conds.push(eq(adCampaigns.kind, req.query.kind));
      // Brand switcher: campaigns of the chosen brand (campaigns without a brand are network-wide and always listed).
      const byBrand = await brandSharedCond(req, s.db, orgId, adCampaigns.brandId);
      if (byBrand) conds.push(byBrand);
      let rows = await s.db.select().from(adCampaigns).where(and(...conds)).orderBy(desc(adCampaigns.createdAt)).limit(200);
      let visible: string[] | null = null;
      if (!hq && !ads.all) {
        visible = ads.locationIds!;
        const ids = rows.length && visible.length ? new Set((await s.db.select({ id: adCampaignLocations.campaignId }).from(adCampaignLocations).where(and(inArray(adCampaignLocations.campaignId, rows.map((x) => x.id)), inArray(adCampaignLocations.locationId, visible)))).map((x) => x.id)) : new Set<string>();
        rows = rows.filter((x) => ids.has(x.id));
      }
      rows = await Promise.all(rows.map(syncApproval));
      return { items: await details(orgId, rows, visible), canCreateNetwork: await hasAt(req, s.db, orgId, null, NC, 'edit') };
    });

    r.get('/orgs/:orgId/ad-campaigns/:id', { schema: { tags: ['marketing'], security: secured, params: idParams } }, async (req) => {
      const c = await loadCampaign(req.params.orgId, req.params.id);
      await requireCampaign(req, c, 'view');
      const hq = await hasAt(req, s.db, c.organizationId, null, NC, 'view');
      const ads = await scopeFor(req, s.db, c.organizationId, ADS);
      return (await details(c.organizationId, [c], hq || ads.all ? null : ads.locationIds))[0]!;
    });

    r.get('/orgs/:orgId/ad-campaigns/coming-soon-locations', { schema: { tags: ['marketing'], security: secured, params: orgParams, summary: 'Locations in onboarding (draft, onboarding, opening soon) a coming-soon campaign can promote' } }, async (req) => {
      await requireAt(req, s.db, req.params.orgId, null, NC, 'view');
      const rows = await s.db.select({ id: locations.id, name: locations.name, status: locations.status, currency: locations.currency, city: sql<string>`${locations.address}->>'city'`, openingDate: sql<string | null>`${locations.settings}->>'openingDate'` })
        .from(locations).where(and(eq(locations.organizationId, req.params.orgId), inArray(locations.status, ONBOARDING), isNull(locations.archivedAt))).orderBy(asc(locations.name));
      return { items: rows };
    });

    r.post('/orgs/:orgId/ad-campaigns', {
      schema: {
        tags: ['marketing'], security: secured, params: orgParams,
        summary: 'HQ creates a network, coming-soon or course campaign. Budget totals are per currency and split evenly over the chosen locations in that currency (or set per location).',
        body: z.object({
          kind: z.enum(['network', 'coming_soon', 'course']), name: z.string().trim().min(1).max(160), objective: z.enum(['leads', 'awareness', 'traffic', 'bookings']).default('leads'),
          platforms: z.array(z.enum(AD_PLATFORMS)).min(1).max(3), startsOn: day, endsOn: day.optional(), creative, comingSoon: comingSoon.optional(),
          locationIds: z.array(z.uuid()).max(500).optional(), allLocations: z.boolean().default(false), radiusKm: z.number().int().min(1).max(100).default(8),
          budget: z.discriminatedUnion('mode', [
            z.object({ mode: z.literal('split'), totals: z.partialRecord(currency, z.number().int().min(0)) }),
            z.object({ mode: z.literal('per_location'), amounts: z.record(z.uuid(), z.number().int().min(0)) }),
          ]),
        }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      await requireAt(req, s.db, orgId, null, NC, 'edit');
      if (b.endsOn && b.endsOn < b.startsOn) throw validationError('The campaign ends before it starts', { endsOn: 'Before the start date' });
      if (b.kind === 'coming_soon' && !b.comingSoon) throw validationError('Add the opening date and pre-sale offer', { comingSoon: 'Required for coming-soon campaigns' });
      const all = await s.db.select().from(locations).where(and(eq(locations.organizationId, orgId), isNull(locations.archivedAt))).orderBy(asc(locations.name));
      let chosen = b.allLocations
        ? all.filter((l) => (b.kind === 'coming_soon' ? ONBOARDING.includes(l.status) : l.status !== 'closed'))
        : all.filter((l) => (b.locationIds ?? (b.budget.mode === 'per_location' ? Object.keys(b.budget.amounts) : [])).includes(l.id));
      if (!b.allLocations && b.locationIds && chosen.length !== new Set(b.locationIds).size) throw validationError('Unknown location', { locationIds: 'Not in this business' });
      if (!chosen.length) throw validationError('Choose at least one location', { locationIds: 'Required' });
      if (b.kind === 'coming_soon') {
        const operating = chosen.filter((l) => !ONBOARDING.includes(l.status));
        if (operating.length) throw validationError(`Coming-soon campaigns are for locations in onboarding (${operating.map((l) => l.name).join(', ')} already open)`, { locationIds: 'Only locations in onboarding' });
      }
      let split: Map<string, { budgetMinor: number; currency: string }>;
      let totals: Record<string, number>;
      if (b.budget.mode === 'split') {
        const needed = [...new Set(chosen.map((l) => l.currency))];
        const missing = needed.filter((c) => !(c in (b.budget as { totals: Record<string, number> }).totals));
        const extra = Object.keys(b.budget.totals).filter((c) => !needed.includes(c));
        if (missing.length) throw validationError(`Add a budget in ${missing.join(', ')}`, { budget: `Missing ${missing.join(', ')}` });
        if (extra.length) throw validationError(`No chosen location is budgeted in ${extra.join(', ')}`, { budget: `Remove ${extra.join(', ')}` });
        totals = b.budget.totals;
        split = splitBudget(chosen, totals);
      } else {
        const amounts = b.budget.amounts;
        chosen = chosen.filter((l) => l.id in amounts);
        split = new Map(chosen.map((l) => [l.id, { budgetMinor: amounts[l.id]!, currency: l.currency }]));
        totals = {};
        for (const v of split.values()) totals[v.currency] = (totals[v.currency] ?? 0) + v.budgetMinor;
      }
      const c = await s.db.transaction(async (tx) => {
        // A campaign whose locations are all in one brand is that brand's campaign.
        const chosenBrands = [...new Set(chosen.map((l) => l.brandId ?? null))];
        const [row] = await tx.insert(adCampaigns).values({ organizationId: orgId, brandId: chosenBrands.length === 1 ? chosenBrands[0] : null, kind: b.kind, name: b.name, objective: b.objective, platforms: b.platforms, status: 'draft', startsOn: b.startsOn, endsOn: b.endsOn ?? null, creative: b.creative, comingSoon: b.comingSoon ?? null, budgetTotals: totals, createdBy: req.user!.id }).returning();
        await tx.insert(adCampaignLocations).values(chosen.map((l) => ({ organizationId: orgId, campaignId: row!.id, locationId: l.id, budgetMinor: split.get(l.id)!.budgetMinor, currency: split.get(l.id)!.currency, radiusKm: b.radiusKm, geo: l.geo ?? null })));
        if (b.kind === 'coming_soon') {
          for (const l of chosen) await tx.update(locations).set({ settings: sql`${locations.settings} || ${JSON.stringify({ openingDate: b.comingSoon!.openingDate })}::jsonb`, updatedAt: new Date() }).where(eq(locations.id, l.id));
        }
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'ad_campaign.created', scopeKind: 'organization', scopeId: orgId, targetType: 'ad_campaign', targetId: row!.id, metadata: { kind: b.kind, locations: chosen.length, totals } });
        return row!;
      });
      return reply.code(201).send((await details(orgId, [c], null))[0]!);
    });

    r.post('/orgs/:orgId/ad-campaigns/local', {
      schema: {
        tags: ['marketing'], security: secured, params: orgParams, summary: 'A location’s own ad campaign. Its budget goes to the approvals inbox (local ad spend) unless HQ creates it.',
        body: z.object({ locationId: z.uuid(), name: z.string().trim().min(1).max(160), platforms: z.array(z.enum(AD_PLATFORMS)).min(1).max(3), budgetMinor: z.number().int().positive(), currency, startsOn: day, durationDays: z.number().int().min(1).max(90), creative, radiusKm: z.number().int().min(1).max(100).default(8), note: z.string().max(1000).optional() }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const me = requireUser(req);
      const b = req.body;
      const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, b.locationId), eq(locations.organizationId, orgId)));
      if (!loc) throw notFound('Location');
      await requireAt(req, s.db, orgId, loc.id, ADS, 'edit');
      if (b.currency !== loc.currency) throw validationError(`Ad spend at ${loc.name} is budgeted in ${loc.currency}`, { currency: `Must be ${loc.currency}` });
      const hqApproves = await hasAt(req, s.db, orgId, null, ADS, 'publish');
      const endsOn = new Date(new Date(`${b.startsOn}T00:00:00Z`).getTime() + (b.durationDays - 1) * 86400_000).toISOString().slice(0, 10);
      const out = await s.db.transaction(async (tx) => {
        const [row] = await tx.insert(adCampaigns).values({ organizationId: orgId, kind: 'local', name: b.name, platforms: b.platforms, status: hqApproves ? 'scheduled' : 'pending_approval', startsOn: b.startsOn, endsOn, creative: b.creative, budgetTotals: { [loc.currency]: b.budgetMinor }, createdBy: me.id }).returning();
        await tx.insert(adCampaignLocations).values({ organizationId: orgId, campaignId: row!.id, locationId: loc.id, budgetMinor: b.budgetMinor, currency: loc.currency, radiusKm: b.radiusKm, geo: loc.geo ?? null });
        if (hqApproves) return { row: row!, approval: null };
        // The approvals inbox decides `ad_spend` on a campaigns row; approval schedules it and this campaign follows.
        const [legacy] = await tx.insert(campaigns).values({ organizationId: orgId, scopeKind: 'location', scopeId: loc.id, name: b.name, channel: b.platforms.includes('google') ? 'google_ads' : 'meta_ads', status: 'pending_approval', content: { adSpend: { durationDays: b.durationDays, startsOn: b.startsOn, description: b.note ?? null }, adCampaignId: row!.id }, budgetMinor: b.budgetMinor, currency: loc.currency, createdBy: me.id }).returning();
        const ap = await insertApproval(tx, { organizationId: orgId, locationId: loc.id, kind: 'ad_spend', targetId: legacy!.id, title: b.name, payload: { campaignId: legacy!.id, adCampaignId: row!.id, channel: legacy!.channel, durationDays: b.durationDays, startsOn: b.startsOn, description: b.note ?? null }, amountMinor: b.budgetMinor, currency: loc.currency, requestedBy: me.id, comment: b.note ?? null }, req.ip);
        const [u] = await tx.update(adCampaigns).set({ approvalCampaignId: legacy!.id, approvalId: ap.id }).where(eq(adCampaigns.id, row!.id)).returning();
        return { row: u!, approval: ap };
      });
      if (out.approval) await notifyApprovers(s, out.approval);
      return reply.code(201).send((await details(orgId, [out.row], null))[0]!);
    });

    r.patch('/orgs/:orgId/ad-campaigns/:id', {
      schema: { tags: ['marketing'], security: secured, params: idParams, summary: 'Launch (schedule / activate), pause, complete or archive a campaign', body: z.object({ status: z.enum(['scheduled', 'active', 'paused', 'completed', 'archived']).optional(), name: z.string().trim().min(1).max(160).optional(), endsOn: day.nullable().optional() }) },
    }, async (req) => {
      const { orgId, id } = req.params;
      const c = await loadCampaign(orgId, id);
      await requireCampaign(req, c, req.body.status ? 'publish' : 'edit');
      if (req.body.status && c.status === 'pending_approval') throw conflict('awaiting_approval', 'This campaign is waiting for budget approval');
      if (req.body.status && ['rejected', 'archived'].includes(c.status)) throw conflict('campaign_closed', `This campaign is ${c.status}`);
      const [u] = await s.db.update(adCampaigns).set({ ...req.body, updatedAt: new Date() }).where(eq(adCampaigns.id, id)).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'ad_campaign.updated', scopeKind: 'organization', scopeId: orgId, targetType: 'ad_campaign', targetId: id, metadata: req.body });
      return (await details(orgId, [u!], null))[0]!;
    });

    r.post('/orgs/:orgId/ad-campaigns/:id/results', {
      schema: {
        tags: ['marketing'], security: secured, params: idParams, summary: 'Enter a day’s spend and results for one location (replaces that day’s manual entry). Funded spend is sent to the marketing fund.',
        body: z.object({ locationId: z.uuid(), day, spendMinor: z.number().int().min(0), currency, impressions: z.number().int().min(0).default(0), clicks: z.number().int().min(0).default(0), platformLeads: z.number().int().min(0).default(0) }),
      },
    }, async (req, reply) => {
      const { orgId, id } = req.params;
      const c = await loadCampaign(orgId, id);
      const b = req.body;
      if (['draft', 'pending_approval', 'rejected'].includes(c.status)) throw conflict('campaign_not_running', 'Results can be entered once the campaign is launched');
      const [cl] = await s.db.select().from(adCampaignLocations).where(and(eq(adCampaignLocations.campaignId, id), eq(adCampaignLocations.locationId, b.locationId)));
      if (!cl) throw validationError('This campaign doesn’t run at that location', { locationId: 'Not in this campaign' });
      await requireAnyAt(req, s.db, orgId, b.locationId, [[ADS, 'edit'], [NC, 'edit']]);
      if (b.currency !== cl.currency) throw validationError(`Spend at this location is in ${cl.currency}`, { currency: `Must be ${cl.currency}` });
      const out = await s.db.transaction(async (tx) => {
        const [prev] = await tx.select().from(adCampaignResults).where(and(eq(adCampaignResults.campaignId, id), eq(adCampaignResults.locationId, b.locationId), eq(adCampaignResults.day, b.day), eq(adCampaignResults.source, 'manual'))).for('update');
        const values = { spendMinor: b.spendMinor, impressions: b.impressions, clicks: b.clicks, platformLeads: b.platformLeads, enteredBy: req.user!.id };
        const [row] = prev
          ? await tx.update(adCampaignResults).set(values).where(eq(adCampaignResults.id, prev.id)).returning()
          : await tx.insert(adCampaignResults).values({ organizationId: orgId, campaignId: id, locationId: b.locationId, day: b.day, currency: cl.currency, source: 'manual', ...values }).returning();
        const delta = b.spendMinor - (prev?.spendMinor ?? 0);
        const fund = FUNDED_KINDS.has(c.kind) ? await recordFundSpend(tx, { organizationId: orgId, campaignId: id, locationId: b.locationId, resultId: row!.id, amountMinor: delta, currency: cl.currency, occurredOn: b.day, source: 'manual' }) : null;
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'ad_campaign.results_entered', scopeKind: 'location', scopeId: b.locationId, targetType: 'ad_campaign', targetId: id, metadata: { day: b.day, spendMinor: b.spendMinor, currency: cl.currency, fundDelta: fund?.amountMinor ?? 0 } });
        return { row: row!, fund };
      });
      return reply.code(201).send({ id: out.row.id, day: out.row.day, spend: { amount: out.row.spendMinor, currency: out.row.currency }, impressions: out.row.impressions, clicks: out.row.clicks, platformLeads: out.row.platformLeads, fundEvent: out.fund });
    });

    r.post('/orgs/:orgId/ad-campaigns/:id/sync', { schema: { tags: ['marketing'], security: secured, params: idParams, summary: 'Import results from the ads platforms (sandbox: nothing is imported)' } }, async (req) => {
      const c = await loadCampaign(req.params.orgId, req.params.id);
      await requireCampaign(req, c, 'edit');
      const out = await Promise.all(c.platforms.map((p) => fetchInsights(s.cfg, p as (typeof AD_PLATFORMS)[number])));
      return { platforms: c.platforms.map((p, i) => ({ platform: p, ...out[i]! })) };
    });

    r.get('/orgs/:orgId/ad-campaigns/oauth/:platform/start', {
      schema: { tags: ['marketing'], security: secured, params: z.object({ orgId: z.uuid(), platform: z.enum(AD_PLATFORMS) }), summary: 'Consent URL to connect an ads account (scaffolding; 503 until the platform app is configured)' },
    }, async (req) => {
      await requireAt(req, s.db, req.params.orgId, null, NC, 'publish');
      const url = adsOauthUrl(s.cfg, req.params.platform, signState(s.cfg.ENCRYPTION_KEY, { orgId: req.params.orgId, userId: req.user!.id, platform: req.params.platform }));
      if (!url) throw unavailable('oauth_not_configured', 'Connecting ads accounts needs the platform app credentials. Enter results by hand meanwhile.');
      return { url, note: 'Results import is not automated yet; spend is entered by hand.' };
    });

    /* ── marketing fund interface ── */

    r.get('/orgs/:orgId/ad-campaigns/fund-events', { schema: { tags: ['marketing'], security: secured, params: orgParams, querystring: z.object({ pending: z.coerce.boolean().default(false) }), summary: 'Campaign spend events for the marketing fund ledger' } }, async (req) => {
      const { orgId } = req.params;
      await requireAnyAt(req, s.db, orgId, null, [[NC, 'view'], ['finance.royalties', 'view']]);
      const rows = await s.db.select().from(marketingFundSpendEvents).where(and(eq(marketingFundSpendEvents.organizationId, orgId), req.query.pending ? isNull(marketingFundSpendEvents.consumedAt) : undefined)).orderBy(asc(marketingFundSpendEvents.createdAt)).limit(1000);
      return { items: rows.map((e) => ({ id: e.id, campaignId: e.campaignId, locationId: e.locationId, amountMinor: e.amountMinor, currency: e.currency, occurredOn: e.occurredOn, source: e.source, consumedAt: e.consumedAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString() })) };
    });

    r.post('/orgs/:orgId/ad-campaigns/fund-events/consume', { schema: { tags: ['marketing'], security: secured, params: orgParams, body: z.object({ ids: z.array(z.uuid()).min(1).max(1000) }) } }, async (req) => {
      await requireAnyAt(req, s.db, req.params.orgId, null, [['finance.royalties', 'edit'], [NC, 'publish']]);
      return { consumed: await markConsumed(s.db, req.params.orgId, req.body.ids) };
    });

  });
};
