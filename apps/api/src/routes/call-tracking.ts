import { and, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { ALL_PARTY_CONSENT_US_STATES, recordingJurisdiction, recordingRule } from '@bh/shared';
import { adCampaigns, locations, trackedCalls, trackingNumbers } from '../db/schema/index.ts';
import { callTrackingLive } from '../integrations/call-tracking.ts';
import { notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasAt, requireAt, scopeFor } from '../services/comms-scope.ts';
import {
  CALLS, addTrackingNumber, callReport, dniNumber, handleStatusWebhook, handleVoiceWebhook, leadStatuses, releaseTrackingNumber, serializeCall, serializeNumber, simulateCall,
} from '../services/call-tracking.ts';
import { getLocalMarketingSettings } from '../services/local-marketing.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['call-tracking'];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SOURCES = ['website', 'google_ads', 'meta_ads', 'google_business', 'print', 'radio', 'tv', 'outdoor', 'directory', 'email', 'other'] as const;
const dniMatch = z.object({ utmSource: z.string().trim().max(80).nullable().optional(), utmMedium: z.string().trim().max(80).nullable().optional(), utmCampaign: z.string().trim().max(120).nullable().optional(), referrerHost: z.string().trim().max(120).nullable().optional() }).default({});

/** Twilio voice webhooks (form-encoded, X-Twilio-Signature) and the public DNI lookup. */
export const callTrackingWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));
  const sig = (req: FastifyRequest) => { const v = req.headers['x-twilio-signature']; return Array.isArray(v) ? v[0] : v; };

  app.post('/webhooks/call-tracking/twilio/voice', { config: { rateLimit: false }, schema: { tags: ['webhooks'], summary: 'Twilio voice: incoming call to a tracking number (TwiML: disclosure when recording, then forward)', hide: true } }, async (req, reply) =>
    reply.type('text/xml').send(await handleVoiceWebhook(s, (req.body ?? {}) as Record<string, string>, sig(req))));
  app.post('/webhooks/call-tracking/twilio/status', { config: { rateLimit: false }, schema: { tags: ['webhooks'], summary: 'Twilio <Dial action>: call outcome (missed calls alert the location and create a lead)', hide: true } }, async (req, reply) =>
    reply.type('text/xml').send(await handleStatusWebhook(s, (req.body ?? {}) as Record<string, string>, sig(req))));

  app.get('/public/call-tracking/:brand/:location', {
    schema: {
      tags: ['public'], summary: 'Dynamic number insertion: the tracking number for this visitor (UTM / referrer), or null to keep the location’s number',
      params: z.object({ brand: z.string().min(1).max(80), location: z.string().min(1).max(80) }),
      querystring: z.object({ utm_source: z.string().max(80).optional(), utm_medium: z.string().max(80).optional(), utm_campaign: z.string().max(120).optional(), ref: z.string().max(200).optional() }),
    },
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    let host: string | null = null;
    try { host = req.query.ref ? new URL(req.query.ref).hostname : null; } catch { host = null; }
    const r = await dniNumber(s.db, req.params.brand, req.params.location, { utmSource: req.query.utm_source, utmMedium: req.query.utm_medium, utmCampaign: req.query.utm_campaign, referrerHost: host });
    if (!r) throw notFound('Location');
    return reply.header('Cache-Control', 'public, max-age=300').send(r);
  });
};

/**
 * Marketing → Call tracking (`/v1/orgs/:orgId/call-tracking/...`). Access: `marketing.call_tracking` — view (call log,
 * report), edit (follow up, notes), publish (numbers, forwarding, recording), export (CSV). Recording requires HQ's
 * jurisdiction rule (settings) and is off by default.
 */
export const callTrackingRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);
  const scopeIds = async (req: FastifyRequest, orgId: string, action: 'view' | 'export' = 'view') => {
    const sc = await scopeFor(req, db, orgId, CALLS, action);
    return sc.all ? ('all' as const) : sc.locationIds!;
  };
  const loadNumber = async (orgId: string, id: string) => {
    const [n] = await db.select().from(trackingNumbers).where(and(eq(trackingNumbers.id, id), eq(trackingNumbers.organizationId, orgId)));
    if (!n) throw notFound('Tracking number');
    return n;
  };
  const inScopeCond = (ids: string[] | 'all', col: typeof trackedCalls.locationId | typeof trackingNumbers.locationId): SQL | undefined => (ids === 'all' ? undefined : ids.length ? inArray(col, ids) : sql`false`);

  app.get('/orgs/:orgId/call-tracking/numbers', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ includeReleased: z.coerce.boolean().default(false) }), summary: 'Tracking numbers of the locations in scope' } }, async (req) => {
    const { orgId } = req.params;
    const ids = await scopeIds(req, orgId);
    const rows = await db.select().from(trackingNumbers).where(and(eq(trackingNumbers.organizationId, orgId), inScopeCond(ids, trackingNumbers.locationId), req.query.includeReleased ? undefined : eq(trackingNumbers.status, 'active'))).orderBy(desc(trackingNumbers.createdAt));
    return { items: rows.map(serializeNumber), live: callTrackingLive(s.cfg), canManage: await hasAt(req, db, orgId, null, CALLS, 'publish') || (ids !== 'all' && (await Promise.all(ids.map((l) => hasAt(req, db, orgId, l, CALLS, 'publish')))).some(Boolean)) };
  });

  app.post('/orgs/:orgId/call-tracking/numbers', {
    schema: {
      tags, security: secured, params: orgParams, summary: 'Add a tracking number for a location (and campaign). Forwards to the location phone unless another number is given.',
      body: z.object({ locationId: z.uuid(), label: z.string().trim().min(2).max(120), source: z.enum(SOURCES), campaignId: z.uuid().nullable().optional(), forwardTo: z.string().trim().min(6).max(30).nullable().optional(), recordCalls: z.boolean().default(false), dniMatch, isDefault: z.boolean().default(false), areaCode: z.string().regex(/^\d{3}$/).nullable().optional() }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requireAt(req, db, orgId, req.body.locationId, CALLS, 'publish');
    if (req.body.campaignId) {
      const [c] = await db.select({ id: adCampaigns.id }).from(adCampaigns).where(and(eq(adCampaigns.id, req.body.campaignId), eq(adCampaigns.organizationId, orgId)));
      if (!c) throw validationError('Unknown campaign', { campaignId: 'Not found' });
    }
    const n = await addTrackingNumber(s, orgId, req.body, req.user!.id);
    return reply.code(201).send(serializeNumber(n));
  });

  app.patch('/orgs/:orgId/call-tracking/numbers/:id', {
    schema: { tags, security: secured, params: idParams, body: z.object({ label: z.string().trim().min(2).max(120).optional(), forwardTo: z.string().trim().min(6).max(30).optional(), recordCalls: z.boolean().optional(), dniMatch: dniMatch.optional(), isDefault: z.boolean().optional(), campaignId: z.uuid().nullable().optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const n = await loadNumber(orgId, id);
    await requireAt(req, db, orgId, n.locationId, CALLS, 'publish');
    if (req.body.recordCalls) {
      const [l] = await db.select().from(locations).where(eq(locations.id, n.locationId));
      if (!recordingRule((await getLocalMarketingSettings(db, orgId)).callRecording, l!.country, l!.address.region)) throw validationError('Call recording is not switched on for this location’s jurisdiction', { recordCalls: 'Not allowed here' });
    }
    if (req.body.isDefault) await db.update(trackingNumbers).set({ isDefault: false }).where(and(eq(trackingNumbers.locationId, n.locationId), eq(trackingNumbers.status, 'active')));
    const { forwardTo, ...rest } = req.body;
    const [u] = await db.update(trackingNumbers).set({ ...rest, ...(forwardTo ? { forwardTo: forwardTo.replace(/[^0-9+]/g, '') } : {}) }).where(eq(trackingNumbers.id, n.id)).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: 'calls.number_updated', scopeKind: 'location', scopeId: n.locationId, targetType: 'tracking_number', targetId: n.id, metadata: req.body });
    return serializeNumber(u!);
  });

  app.post('/orgs/:orgId/call-tracking/numbers/:id/release', { schema: { tags, security: secured, params: idParams, summary: 'Release the number (calls to it stop being forwarded)' } }, async (req) => {
    const n = await loadNumber(req.params.orgId, req.params.id);
    await requireAt(req, db, req.params.orgId, n.locationId, CALLS, 'publish');
    return serializeNumber(await releaseTrackingNumber(s, n, req.user!.id));
  });

  app.post('/orgs/:orgId/call-tracking/numbers/:id/simulate', {
    schema: { tags, security: secured, params: idParams, body: z.object({ from: z.string().trim().min(6).max(30), callerName: z.string().trim().max(120).nullable().optional(), outcome: z.enum(['answered', 'missed', 'busy']).default('answered'), durationSeconds: z.number().int().min(0).max(36_000).default(95) }), summary: 'Sandbox only: simulate a call through the same signed webhooks Twilio sends' },
  }, async (req, reply) => {
    const n = await loadNumber(req.params.orgId, req.params.id);
    await requireAt(req, db, req.params.orgId, n.locationId, CALLS, 'edit');
    const r = await simulateCall(s, n, req.body);
    return reply.code(201).send({ call: serializeCall(r.call), twiml: r.twiml });
  });

  /* ── call log ── */

  const callFilters = z.object({ locationId: z.uuid().optional(), campaignId: z.uuid().optional(), status: z.enum(['answered', 'missed', 'busy', 'failed', 'ringing', 'voicemail', 'unanswered']).optional(), from: ymd.optional(), to: ymd.optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) });
  const callConds = (orgId: string, ids: string[] | 'all', q: z.infer<typeof callFilters>) => {
    const conds: SQL[] = [eq(trackedCalls.organizationId, orgId)];
    const sc = inScopeCond(ids, trackedCalls.locationId);
    if (sc) conds.push(sc);
    if (q.locationId) conds.push(eq(trackedCalls.locationId, q.locationId));
    if (q.campaignId) conds.push(eq(trackedCalls.campaignId, q.campaignId));
    if (q.status === 'unanswered') conds.push(inArray(trackedCalls.status, ['missed', 'busy', 'voicemail']));
    else if (q.status) conds.push(eq(trackedCalls.status, q.status));
    if (q.from) conds.push(gte(trackedCalls.startedAt, new Date(`${q.from}T00:00:00Z`)));
    if (q.to) conds.push(lt(trackedCalls.startedAt, new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000)));
    return conds;
  };

  app.get('/orgs/:orgId/call-tracking/calls', { schema: { tags, security: secured, params: orgParams, querystring: callFilters, summary: 'Call log with source and campaign attribution (newest first)' } }, async (req) => {
    const { orgId } = req.params;
    const rows = await db.select().from(trackedCalls).where(and(...callConds(orgId, await scopeIds(req, orgId), req.query))).orderBy(desc(trackedCalls.startedAt)).limit(req.query.limit);
    const st = await leadStatuses(db, rows.map((r) => r.leadId));
    return { items: rows.map((c) => serializeCall(c, c.leadId ? st.get(c.leadId) : null)) };
  });

  app.get('/orgs/:orgId/call-tracking/calls.csv', { schema: { tags, security: secured, params: orgParams, querystring: callFilters, summary: 'Call log (CSV)' } }, async (req, reply) => {
    const { orgId } = req.params;
    const rows = await db.select().from(trackedCalls).where(and(...callConds(orgId, await scopeIds(req, orgId, 'export'), req.query))).orderBy(desc(trackedCalls.startedAt)).limit(req.query.limit);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [['started_at', 'location_id', 'source', 'campaign_id', 'caller', 'status', 'duration_seconds', 'first_time', 'lead_id'].join(','), ...rows.map((c) => [c.startedAt.toISOString(), c.locationId, c.source, c.campaignId, c.callerNumber, c.status, c.durationSeconds, c.firstTimeCaller, c.leadId].map(esc).join(','))].join('\n');
    await audit(db, { organizationId: orgId, ...actor(req), action: 'calls.exported', scopeKind: 'organization', scopeId: orgId, metadata: { rows: rows.length } });
    return reply.header('Content-Disposition', 'attachment; filename="calls.csv"').type('text/csv; charset=utf-8').send(csv);
  });

  app.patch('/orgs/:orgId/call-tracking/calls/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ notes: z.string().max(2000).nullable().optional(), followedUp: z.boolean().optional() }), summary: 'Notes and follow-up' } }, async (req) => {
    const { orgId, id } = req.params;
    const [c] = await db.select().from(trackedCalls).where(and(eq(trackedCalls.id, id), eq(trackedCalls.organizationId, orgId)));
    if (!c) throw notFound('Call');
    await requireAt(req, db, orgId, c.locationId, CALLS, 'edit');
    const [u] = await db.update(trackedCalls).set({ ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}), ...(req.body.followedUp !== undefined ? { followedUpAt: req.body.followedUp ? new Date() : null, followedUpBy: req.body.followedUp ? req.user!.id : null } : {}) }).where(eq(trackedCalls.id, c.id)).returning();
    return serializeCall(u!);
  });

  app.get('/orgs/:orgId/call-tracking/report', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional() }), summary: 'Calls by source, campaign and location: answered, missed, first-time callers and leads' } }, async (req) => {
    const { orgId } = req.params;
    const to = req.query.to ? new Date(new Date(`${req.query.to}T00:00:00Z`).getTime() + 86_400_000) : new Date(Date.now() + 60_000);
    const from = req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw validationError('The start must be before the end', { from: 'Invalid' });
    return { from: from.toISOString(), to: to.toISOString(), ...(await callReport(db, orgId, await scopeIds(req, orgId), { from, to })) };
  });

  /** Recording rules and the consent guidance shown with them. */
  app.get('/orgs/:orgId/call-tracking/recording', { schema: { tags, security: secured, params: orgParams, summary: 'Call recording rules per jurisdiction (off by default) and which location jurisdictions are covered' } }, async (req) => {
    const { orgId } = req.params;
    const ids = await scopeIds(req, orgId);
    const settings = await getLocalMarketingSettings(db, orgId);
    const locs = await db.select({ id: locations.id, name: locations.name, country: locations.country, address: locations.address }).from(locations).where(and(eq(locations.organizationId, orgId), ids === 'all' ? undefined : ids.length ? inArray(locations.id, ids) : sql`false`));
    return {
      ...settings.callRecording, allPartyConsentUsStates: ALL_PARTY_CONSENT_US_STATES,
      locations: locs.map((l) => ({ id: l.id, name: l.name, jurisdiction: recordingJurisdiction(l.country, l.address.region), allowed: !!recordingRule(settings.callRecording, l.country, l.address.region) })),
    };
  });
};
