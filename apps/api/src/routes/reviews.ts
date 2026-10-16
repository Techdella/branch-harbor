import { and, desc, eq, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { REVIEW_CHANNELS, REVIEW_LINK_KINDS, reviewSettingsPatchSchema, reviewSettingsSchema } from '@bh/shared';
import { customers, locations, reviewConnections, reviewListings, reviewRequests, reviewSettings, reviews, users } from '../db/schema/index.ts';
import { readState, signState } from '../integrations/social.ts';
import { encrypt } from '../lib/crypto.ts';
import { conflict, forbidden, notFound, unavailable, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasAt, requireAt, scopeFor } from '../services/comms-scope.ts';
import {
  connectionToken, deliverRequest, effectiveSettings, emitReviewEvent, googleBusiness, locationSettingsRow, optOutOfRequests, orgSettingsRow, publicReviewPage, publishReply, queueReviewRequest,
  recordLinkOpened, replyNeedsApproval, reviewDashboard, reviewsTick, saveSettings, serializeRequest, serializeReview, submitPublicReview, suggestReply, syncListing,
} from '../services/reviews.ts';
import { idParams, orgParams, secured } from './_common.ts';

const M = 'marketing.reviews';
const tags = ['reviews'];
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const token = z.string().min(16).max(64);

/**
 * Marketing → Reviews API (`/v1/orgs/:orgId/reviews/...`) plus the hosted review page (`/v1/public/reviews/...`) and the
 * Google OAuth callback. Access: `marketing.reviews` — view (dashboard, reviews, requests), edit (reply, send a
 * request), publish (request settings, review links, Google connections, approve replies). Everything is filtered to
 * the locations in the person's scope; HQ-level settings and approvals need organisation-wide access.
 */
export const reviewRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;

  // Background: schedule and send review requests every minute; fetch Google reviews every 30 minutes.
  if (s.cfg.NODE_ENV !== 'test') {
    let timer: NodeJS.Timeout | null = null;
    let lastGoogle = 0;
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        const google = Date.now() - lastGoogle > 30 * 60_000;
        if (google) lastGoogle = Date.now();
        void reviewsTick(s, new Date(), { google }).catch((err) => s.log.warn({ err }, 'reviews tick failed'));
      }, 60_000);
      timer.unref?.();
    });
    app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
  }

  /* ---------------- Google OAuth callback (signed state carries who started it) ---------------- */

  app.get('/oauth/reviews/google/callback', {
    schema: { tags, summary: 'Google Business Profile OAuth callback', querystring: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }), hide: true },
  }, async (req, reply) => {
    const back = (q: string) => reply.redirect(`${s.cfg.APP_URL.replace(/\/$/, '')}/marketing/reviews?tab=connections&${q}`);
    const st = req.query.state ? readState<{ orgId: string; userId: string; ownerKind: 'hq' | 'location'; locationId: string | null }>(s.cfg.ENCRYPTION_KEY, req.query.state) : null;
    if (!st || !req.query.code || req.query.error) return back('google=failed');
    const g = googleBusiness(s);
    if (!g.configured) return back('google=unavailable');
    try {
      const { refreshToken, email } = await g.exchangeCode(req.query.code);
      const [c] = await db.insert(reviewConnections).values({
        organizationId: st.orgId, ownerKind: st.ownerKind, locationId: st.locationId, accountEmail: email, mode: 'live', status: 'connected', credentialsEncrypted: encrypt(refreshToken, s.cfg.ENCRYPTION_KEY), connectedBy: st.userId,
      }).returning();
      await audit(db, { organizationId: st.orgId, actorUserId: st.userId, action: 'reviews.google_connected', scopeKind: st.locationId ? 'location' : 'organization', scopeId: st.locationId ?? st.orgId, targetType: 'review_connection', targetId: c!.id });
      return back(`google=connected&connection=${c!.id}`);
    } catch (err) {
      s.log.warn({ err }, 'google business oauth exchange failed');
      return back('google=failed');
    }
  });

  /* ---------------- Hosted review page (public, token-gated) ---------------- */

  const pageParams = z.object({ brand: z.string().min(1).max(80), location: z.string().min(1).max(80) });

  app.get('/public/reviews/:brand/:location', { schema: { tags, params: pageParams, querystring: z.object({ t: token }), summary: 'Hosted review page: location, first name and the public review links (offered to everyone)' }, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) =>
    publicReviewPage(s, req.params.brand, req.params.location, req.query.t));

  app.post('/public/reviews/:brand/:location', {
    schema: { tags, params: pageParams, body: z.object({ t: token, rating: z.number().int().min(1).max(5), comment: z.string().max(4000).nullable().optional() }), summary: 'Leave a rating and comment (private feedback to the location); returns the public review links for every rating' },
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => reply.code(201).send(await submitPublicReview(s, req.params.brand, req.params.location, req.body.t, { rating: req.body.rating, comment: req.body.comment ?? null })));

  app.post('/public/reviews/:brand/:location/link', { schema: { tags, params: pageParams, body: z.object({ t: token, kind: z.enum(REVIEW_LINK_KINDS) }), hide: true }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) =>
    recordLinkOpened(s, req.body.t, req.body.kind));

  app.post('/public/reviews/:brand/:location/opt-out', { schema: { tags, params: pageParams, body: z.object({ t: token }), summary: 'Stop review requests to this contact' }, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) =>
    optOutOfRequests(s, req.body.t));

  /* ---------------- Authenticated ---------------- */

  await app.register(async (priv) => {
    priv.addHook('preHandler', authenticate);
    const r = priv.withTypeProvider<ZodTypeProvider>();

    const directory = async (orgId: string, userIds: string[] = []) => {
      const locs = await db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, orgId));
      const ppl = userIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(userIds)])) : [];
      return { locations: new Map(locs.map((l) => [l.id, l.name])), users: new Map(ppl.map((p) => [p.id, p.name])) };
    };
    const scopeIds = async (req: FastifyRequest, orgId: string, locationId?: string) => {
      const scope = await scopeFor(req, db, orgId, M);
      if (locationId) {
        if (!scope.all && !scope.locationIds!.includes(locationId)) throw notFound('Location');
        return [locationId];
      }
      return scope.all ? ('all' as const) : scope.locationIds!;
    };
    const loadReview = async (req: FastifyRequest, orgId: string, id: string) => {
      const [row] = await db.select().from(reviews).where(and(eq(reviews.id, id), eq(reviews.organizationId, orgId)));
      if (!row) throw notFound('Review');
      if (!(await hasAt(req, db, orgId, row.locationId, M, 'view'))) throw notFound('Review');
      return row;
    };
    const one = async (orgId: string, row: typeof reviews.$inferSelect) => serializeReview(row, await directory(orgId, [row.replyBy, row.replyDecidedBy].filter((x): x is string => !!x)));
    const isHqApprover = (req: FastifyRequest, orgId: string) => hasAt(req, db, orgId, null, M, 'publish');

    /* ── dashboard ── */

    r.get('/orgs/:orgId/reviews/dashboard', {
      schema: { tags, security: secured, params: orgParams, querystring: z.object({ from: ymd.optional(), to: ymd.optional(), bucket: z.enum(['week', 'month']).default('month'), locationId: z.uuid().optional() }), summary: 'Rating over time, volume, response rate and time, requests funnel — per location and in total (scope-filtered)' },
    }, async (req) => {
      const { orgId } = req.params;
      const ids = await scopeIds(req, orgId, req.query.locationId);
      const to = req.query.to ? new Date(`${req.query.to}T00:00:00Z`) : new Date();
      const from = req.query.from ? new Date(`${req.query.from}T00:00:00Z`) : new Date(to.getTime() - 365 * 86_400_000);
      if (from >= to) throw validationError('The start must be before the end', { from: 'Invalid' });
      return reviewDashboard(db, orgId, ids, { from, to: req.query.to ? new Date(to.getTime() + 86_400_000) : to }, req.query.bucket);
    });

    /* ── reviews ── */

    r.get('/orgs/:orgId/reviews', {
      schema: {
        tags, security: secured, params: orgParams, summary: 'Reviews for the locations in scope (newest first)',
        querystring: z.object({ locationId: z.uuid().optional(), source: z.enum(['google', 'branchharbor']).optional(), rating: z.coerce.number().int().min(1).max(5).optional(), maxRating: z.coerce.number().int().min(1).max(5).optional(), reply: z.enum(['none', 'draft', 'pending_approval', 'published', 'rejected', 'failed', 'unanswered']).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
      },
    }, async (req) => {
      const { orgId } = req.params;
      const ids = await scopeIds(req, orgId, req.query.locationId);
      const q = req.query;
      const where: SQL[] = [eq(reviews.organizationId, orgId)];
      if (ids !== 'all') where.push(ids.length ? inArray(reviews.locationId, ids) : sql`false`);
      if (q.source) where.push(eq(reviews.source, q.source));
      if (q.rating) where.push(eq(reviews.rating, q.rating));
      if (q.maxRating) where.push(lte(reviews.rating, q.maxRating));
      if (q.reply === 'unanswered') where.push(and(eq(reviews.source, 'google'), inArray(reviews.replyStatus, ['none', 'draft', 'rejected', 'failed']))!);
      else if (q.reply) where.push(eq(reviews.replyStatus, q.reply));
      if (q.q) where.push(or(ilike(reviews.comment, `%${q.q}%`), ilike(reviews.authorName, `%${q.q}%`))!);
      const rows = await db.select().from(reviews).where(and(...where)).orderBy(desc(reviews.reviewedAt)).limit(q.limit);
      const dir = await directory(orgId, rows.flatMap((x) => [x.replyBy, x.replyDecidedBy]).filter((x): x is string => !!x));
      return { items: rows.map((x) => serializeReview(x, dir)), canApprove: await isHqApprover(req, orgId) };
    });

    r.get('/orgs/:orgId/reviews/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const row = await loadReview(req, req.params.orgId, req.params.id);
      const st = await effectiveSettings(db, req.params.orgId, row.locationId);
      return { ...(await one(req.params.orgId, row)), needsApproval: replyNeedsApproval(st.replyApproval, row.rating) && !(await isHqApprover(req, req.params.orgId)), canReply: row.source === 'google' && (await hasAt(req, db, req.params.orgId, row.locationId, M, 'edit')), canApprove: await isHqApprover(req, req.params.orgId), aiEnabled: s.ai.enabled };
    });

    r.post('/orgs/:orgId/reviews/:id/suggest-reply', {
      schema: { tags, security: secured, params: idParams, body: z.object({ tone: z.enum(['warm, professional', 'concise', 'apologetic']).optional(), locale: z.string().max(10).nullable().optional() }).default({}), summary: 'AI-suggested reply (draft only; nothing is saved or posted)' },
    }, async (req) => {
      const row = await loadReview(req, req.params.orgId, req.params.id);
      await requireAt(req, db, req.params.orgId, row.locationId, M, 'edit');
      return suggestReply(s, row, { tone: req.body.tone, locale: req.body.locale ?? row.language });
    });

    r.put('/orgs/:orgId/reviews/:id/reply', {
      schema: { tags, security: secured, params: idParams, body: z.object({ text: z.string().trim().min(2).max(4000), aiSuggested: z.boolean().default(false), publish: z.boolean().default(true) }), summary: 'Save a reply draft, or publish it (or send it for HQ approval when the policy requires it)' },
    }, async (req) => {
      const { orgId } = req.params;
      const row = await loadReview(req, orgId, req.params.id);
      await requireAt(req, db, orgId, row.locationId, M, 'edit');
      if (row.source !== 'google') throw conflict('reply_in_inbox', 'Private feedback is answered from the inbox conversation');
      if (row.replyStatus === 'pending_approval' && !(await isHqApprover(req, orgId))) throw conflict('awaiting_approval', 'This reply is waiting for HQ approval');
      const now = new Date();
      const base = { replyText: req.body.text, replyAiSuggested: req.body.aiSuggested, replyBy: req.user!.id, replyError: null, updatedAt: now };
      if (!req.body.publish) {
        const [u] = await db.update(reviews).set({ ...base, replyStatus: 'draft' }).where(eq(reviews.id, row.id)).returning();
        return one(orgId, u!);
      }
      const st = await effectiveSettings(db, orgId, row.locationId);
      if (replyNeedsApproval(st.replyApproval, row.rating) && !(await isHqApprover(req, orgId))) {
        const [u] = await db.update(reviews).set({ ...base, replyStatus: 'pending_approval', replySubmittedAt: now, replyDecidedBy: null, replyDecisionNote: null }).where(eq(reviews.id, row.id)).returning();
        await audit(db, { organizationId: orgId, ...actor(req), action: 'reviews.reply_submitted', scopeKind: 'location', scopeId: row.locationId, targetType: 'review', targetId: row.id, metadata: { aiSuggested: req.body.aiSuggested } });
        await emitReviewEvent(s, { type: 'reply_changed', review: u! });
        return one(orgId, u!);
      }
      const [u] = await db.update(reviews).set({ ...base, replySubmittedAt: now }).where(eq(reviews.id, row.id)).returning();
      return one(orgId, await publishReply(s, u!, req.user!.id));
    });

    r.post('/orgs/:orgId/reviews/:id/reply/decision', {
      schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional(), text: z.string().trim().min(2).max(4000).optional() }), summary: 'HQ approves (and publishes) or rejects a reply waiting for approval' },
    }, async (req) => {
      const { orgId } = req.params;
      const row = await loadReview(req, orgId, req.params.id);
      if (!(await isHqApprover(req, orgId))) throw forbidden('Only HQ with Reviews publish access approves replies');
      if (row.replyStatus !== 'pending_approval') throw conflict('not_pending', 'This reply is not waiting for approval');
      const [u] = await db.update(reviews).set({ replyStatus: req.body.decision === 'approve' ? 'pending_approval' : 'rejected', replyText: req.body.text ?? row.replyText, replyDecidedBy: req.user!.id, replyDecisionNote: req.body.note ?? null, updatedAt: new Date() }).where(eq(reviews.id, row.id)).returning();
      await audit(db, { organizationId: orgId, ...actor(req), action: `reviews.reply_${req.body.decision === 'approve' ? 'approved' : 'rejected'}`, scopeKind: 'location', scopeId: row.locationId, targetType: 'review', targetId: row.id });
      if (req.body.decision === 'reject') await emitReviewEvent(s, { type: 'reply_changed', review: u! });
      return one(orgId, req.body.decision === 'approve' ? await publishReply(s, u!, req.user!.id) : u!);
    });

    /* ── requests ── */

    r.get('/orgs/:orgId/reviews/requests', {
      schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional(), status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), summary: 'Review requests (scheduled, sent, skipped with the reason, completed)' },
    }, async (req) => {
      const { orgId } = req.params;
      const ids = await scopeIds(req, orgId, req.query.locationId);
      const where: SQL[] = [eq(reviewRequests.organizationId, orgId)];
      if (ids !== 'all') where.push(ids.length ? inArray(reviewRequests.locationId, ids) : sql`false`);
      if (req.query.status) where.push(eq(reviewRequests.status, req.query.status));
      const rows = await db.select().from(reviewRequests).where(and(...where)).orderBy(desc(reviewRequests.createdAt)).limit(req.query.limit);
      const dir = await directory(orgId);
      return { items: rows.map((x) => serializeRequest(x, dir.locations)) };
    });

    r.post('/orgs/:orgId/reviews/requests', {
      schema: {
        tags, security: secured, params: orgParams, summary: 'Send a review request now to a customer (frequency cap, opt-outs, consent and quiet hours still apply)',
        body: z.object({ locationId: z.uuid(), customerId: z.uuid(), channel: z.enum(REVIEW_CHANNELS).optional() }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      await requireAt(req, db, orgId, req.body.locationId, M, 'edit');
      const [c] = await db.select().from(customers).where(and(eq(customers.id, req.body.customerId), eq(customers.organizationId, orgId), isNull(customers.erasedAt)));
      if (!c) throw notFound('Customer');
      const row = await queueReviewRequest(s, { organizationId: orgId, locationId: req.body.locationId, customerId: c.id, source: 'manual', triggerKey: `manual:${req.user!.id}:${Date.now()}`, sendAt: new Date(), channel: req.body.channel ?? null, createdBy: req.user!.id });
      const outcome = await deliverRequest(s, row!.id);
      const [fresh] = await db.select().from(reviewRequests).where(eq(reviewRequests.id, row!.id));
      await audit(db, { organizationId: orgId, ...actor(req), action: 'reviews.request_sent', scopeKind: 'location', scopeId: req.body.locationId, targetType: 'review_request', targetId: row!.id, metadata: { outcome: outcome.status, reason: outcome.reason ?? null } });
      return reply.code(201).send({ request: serializeRequest(fresh!), outcome });
    });

    r.post('/orgs/:orgId/reviews/requests/run', { schema: { tags, security: secured, params: orgParams, summary: 'Run the review-request scheduler for this organisation now (also runs every minute)' } }, async (req) => {
      await requireAt(req, db, req.params.orgId, null, M, 'publish');
      return reviewsTick(s, new Date(), { organizationId: req.params.orgId });
    });

    /* ── settings ── */

    r.get('/orgs/:orgId/reviews/settings', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }) } }, async (req) => {
      const { orgId } = req.params;
      const locationId = req.query.locationId ?? null;
      await requireAt(req, db, orgId, locationId, M, 'view');
      const org = await orgSettingsRow(db, orgId);
      const loc = locationId ? await locationSettingsRow(db, locationId) : null;
      return {
        locationId, organization: reviewSettingsSchema.parse(org?.settings ?? {}), overrides: loc?.settings ?? null, effective: await effectiveSettings(db, orgId, locationId),
        canEdit: await hasAt(req, db, orgId, locationId, M, 'publish'), canEditHq: await isHqApprover(req, orgId), enabledAt: (loc ?? org)?.enabledAt?.toISOString() ?? null,
      };
    });

    r.put('/orgs/:orgId/reviews/settings', {
      schema: { tags, security: secured, params: orgParams, body: z.object({ locationId: z.uuid().nullable().default(null), settings: reviewSettingsPatchSchema, clear: z.array(z.string()).max(20).optional() }), summary: 'Save HQ defaults (locationId null) or a location’s overrides (only the keys sent override; `clear` removes overrides)' },
    }, async (req) => {
      const { orgId } = req.params;
      const { locationId } = req.body;
      if (locationId) {
        const [l] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, orgId)));
        if (!l) throw notFound('Location');
      }
      await requireAt(req, db, orgId, locationId, M, 'publish');
      const patch = { ...req.body.settings } as Record<string, unknown>;
      if (locationId && req.body.clear?.length) {
        const row = await locationSettingsRow(db, locationId);
        if (row) {
          const kept = Object.fromEntries(Object.entries(row.settings).filter(([k]) => !req.body.clear!.includes(k)));
          await db.update(reviewSettings).set({ settings: kept }).where(eq(reviewSettings.id, row.id));
        }
      }
      await saveSettings(db, orgId, locationId, patch, req.user!.id);
      return { effective: await effectiveSettings(db, orgId, locationId) };
    });

    /* ── Google Business Profile connections ── */

    r.get('/orgs/:orgId/reviews/connections', { schema: { tags, security: secured, params: orgParams, summary: 'Google Business Profile connections and linked locations in scope' } }, async (req) => {
      const { orgId } = req.params;
      const scope = await scopeFor(req, db, orgId, M);
      const conns = await db.select().from(reviewConnections).where(eq(reviewConnections.organizationId, orgId)).orderBy(desc(reviewConnections.createdAt));
      const listings = await db.select().from(reviewListings).where(eq(reviewListings.organizationId, orgId));
      const visible = (locId: string | null) => scope.all || (!!locId && scope.locationIds!.includes(locId));
      return {
        googleConfigured: googleBusiness(s).configured,
        items: conns.filter((c) => (c.ownerKind === 'hq' ? scope.all : visible(c.locationId)) || listings.some((l) => l.connectionId === c.id && visible(l.locationId))).map((c) => ({
          id: c.id, ownerKind: c.ownerKind, locationId: c.locationId, accountEmail: c.accountEmail, mode: c.mode, status: c.status, lastSyncAt: c.lastSyncAt?.toISOString() ?? null, lastError: c.lastError, createdAt: c.createdAt.toISOString(),
          listings: listings.filter((l) => l.connectionId === c.id && visible(l.locationId)).map((l) => ({ id: l.id, locationId: l.locationId, externalLocationName: l.externalLocationName, title: l.title, reviewUrl: l.reviewUrl, lastFetchedAt: l.lastFetchedAt?.toISOString() ?? null })),
        })),
      };
    });

    r.get('/orgs/:orgId/reviews/connections/google/start', {
      schema: { tags, security: secured, params: orgParams, querystring: z.object({ ownerKind: z.enum(['hq', 'location']).default('hq'), locationId: z.uuid().optional() }), summary: 'Google consent URL (503 when the Google OAuth client is not configured)' },
    }, async (req) => {
      const { orgId } = req.params;
      const locationId = req.query.ownerKind === 'location' ? req.query.locationId ?? null : null;
      if (req.query.ownerKind === 'location' && !locationId) throw validationError('Choose the location', { locationId: 'Required' });
      await requireAt(req, db, orgId, locationId, M, 'publish');
      const url = googleBusiness(s).authUrl(signState(s.cfg.ENCRYPTION_KEY, { orgId, userId: req.user!.id, ownerKind: req.query.ownerKind, locationId }));
      if (!url) throw unavailable('google_not_configured', 'Connecting Google Business Profile needs the platform Google OAuth client. A sandbox connection can be added meanwhile (it fetches no reviews).');
      return { url };
    });

    r.post('/orgs/:orgId/reviews/connections/sandbox', {
      schema: { tags, security: secured, params: orgParams, body: z.object({ ownerKind: z.enum(['hq', 'location']).default('hq'), locationId: z.uuid().nullable().default(null) }), summary: 'Add a sandbox connection (no Google credentials: nothing is fetched, replies are kept in BranchHarbor)' },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const locationId = req.body.ownerKind === 'location' ? req.body.locationId : null;
      await requireAt(req, db, orgId, locationId, M, 'publish');
      const [c] = await db.insert(reviewConnections).values({ organizationId: orgId, ownerKind: req.body.ownerKind, locationId, mode: 'sandbox', status: 'connected', connectedBy: req.user!.id }).returning();
      await audit(db, { organizationId: orgId, ...actor(req), action: 'reviews.sandbox_connection_added', scopeKind: locationId ? 'location' : 'organization', scopeId: locationId ?? orgId, targetType: 'review_connection', targetId: c!.id });
      return reply.code(201).send({ id: c!.id, mode: c!.mode });
    });

    const loadConnection = async (req: FastifyRequest, orgId: string, id: string) => {
      const [c] = await db.select().from(reviewConnections).where(and(eq(reviewConnections.id, id), eq(reviewConnections.organizationId, orgId)));
      if (!c) throw notFound('Connection');
      await requireAt(req, db, orgId, c.ownerKind === 'hq' ? null : c.locationId, M, 'publish');
      return c;
    };

    r.get('/orgs/:orgId/reviews/connections/:id/google-locations', { schema: { tags, security: secured, params: idParams, summary: 'Locations of the connected Google account (live connections only)' } }, async (req) => {
      const c = await loadConnection(req, req.params.orgId, req.params.id);
      const t = connectionToken(s, c);
      if (!t || !googleBusiness(s).configured) return { items: [], sandbox: true };
      const items = await googleBusiness(s).listLocations(t);
      if (!c.accountName && items[0]) await db.update(reviewConnections).set({ accountName: items[0].accountName }).where(eq(reviewConnections.id, c.id));
      return { items, sandbox: false };
    });

    r.post('/orgs/:orgId/reviews/connections/:id/listings', {
      schema: { tags, security: secured, params: idParams, body: z.object({ locationId: z.uuid(), externalLocationName: z.string().min(3).max(200).regex(/^(accounts\/[^/]+\/)?locations\/[A-Za-z0-9_-]+$/, 'locations/…'), accountName: z.string().max(200).optional(), title: z.string().max(200).optional(), reviewUrl: z.url().optional() }), summary: 'Link a Google location to a BranchHarbor location' },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const c = await loadConnection(req, orgId, req.params.id);
      await requireAt(req, db, orgId, req.body.locationId, M, 'publish');
      if (c.ownerKind === 'location' && c.locationId !== req.body.locationId) throw forbidden('A location connection can only feed its own location');
      const name = req.body.externalLocationName.replace(/^accounts\/[^/]+\//, '');
      const acct = req.body.accountName ?? req.body.externalLocationName.match(/^(accounts\/[^/]+)\//)?.[1];
      if (acct && !c.accountName) await db.update(reviewConnections).set({ accountName: acct }).where(eq(reviewConnections.id, c.id));
      const [l] = await db.insert(reviewListings).values({ organizationId: orgId, connectionId: c.id, locationId: req.body.locationId, externalLocationName: name, title: req.body.title ?? null, reviewUrl: req.body.reviewUrl ?? null })
        .onConflictDoUpdate({ target: [reviewListings.locationId, reviewListings.provider], set: { connectionId: c.id, externalLocationName: name, title: req.body.title ?? null, reviewUrl: req.body.reviewUrl ?? null } }).returning();
      await audit(db, { organizationId: orgId, ...actor(req), action: 'reviews.listing_linked', scopeKind: 'location', scopeId: req.body.locationId, targetType: 'review_listing', targetId: l!.id, metadata: { externalLocationName: name } });
      return reply.code(201).send({ id: l!.id });
    });

    r.post('/orgs/:orgId/reviews/listings/:id/sync', { schema: { tags, security: secured, params: idParams, summary: 'Fetch Google reviews now for one linked location (sandbox: fetches nothing)' } }, async (req) => {
      const [l] = await db.select().from(reviewListings).where(and(eq(reviewListings.id, req.params.id), eq(reviewListings.organizationId, req.params.orgId)));
      if (!l) throw notFound('Listing');
      await requireAt(req, db, req.params.orgId, l.locationId, M, 'edit');
      return syncListing(s, l.id);
    });

    r.delete('/orgs/:orgId/reviews/listings/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const [l] = await db.select().from(reviewListings).where(and(eq(reviewListings.id, req.params.id), eq(reviewListings.organizationId, req.params.orgId)));
      if (!l) throw notFound('Listing');
      await requireAt(req, db, req.params.orgId, l.locationId, M, 'publish');
      await db.delete(reviewListings).where(eq(reviewListings.id, l.id));
      return { ok: true };
    });

    r.post('/orgs/:orgId/reviews/connections/:id/disconnect', { schema: { tags, security: secured, params: idParams } }, async (req) => {
      const c = await loadConnection(req, req.params.orgId, req.params.id);
      await db.update(reviewConnections).set({ status: 'disconnected', credentialsEncrypted: null }).where(eq(reviewConnections.id, c.id));
      await audit(db, { organizationId: req.params.orgId, ...actor(req), action: 'reviews.connection_disconnected', scopeKind: c.locationId ? 'location' : 'organization', scopeId: c.locationId ?? req.params.orgId, targetType: 'review_connection', targetId: c.id });
      return { ok: true };
    });
  });
};
