import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { LISTING_FIELD_POLICIES, LISTING_FIELDS, SOCIAL_NETWORKS } from '@bh/shared';
import { reviewReplyTemplates, socialCalendarItems } from '../db/schema/index.ts';
import { forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasAt, requireAt, scopeFor } from '../services/comms-scope.ts';
import { getLocalMarketingSettings, saveLocalMarketingSettings } from '../services/local-marketing.ts';
import { adoptItem, calendar, itemVisibleTo, loadItem, localise, serializeItem, skipItem } from '../services/local-social.ts';
import { backfillReviewConversations } from '../services/review-inbox.ts';
import { idParams, orgParams, secured } from './_common.ts';

const SOCIAL = 'marketing.social';
const REVIEWS = 'marketing.reviews';
const iso = z.iso.datetime({ offset: true });

/**
 * Local marketing settings (`/local-marketing/settings`), review reply templates (`/reviews/templates`) and the local
 * social content calendar (`/social/calendar`). Each section checks its own module.
 */
export const localMarketingRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);
  const org = (req: FastifyRequest, orgId: string, module: string, action: 'view' | 'edit' | 'publish') => hasAt(req, db, orgId, null, module, action);

  /* ── settings ── */

  app.get('/orgs/:orgId/local-marketing/settings', { schema: { tags: ['marketing'], security: secured, params: orgParams, summary: 'Listing field policy, review reply SLA, co-op checklist and call recording rules, with what this person may change' } }, async (req) => {
    const { orgId } = req.params;
    return {
      settings: await getLocalMarketingSettings(db, orgId),
      canEdit: {
        listings: await org(req, orgId, 'marketing.listings', 'publish'), reviews: await org(req, orgId, REVIEWS, 'publish'),
        coop: await org(req, orgId, 'marketing.coop', 'publish'), calls: await org(req, orgId, 'marketing.call_tracking', 'publish'),
      },
    };
  });

  app.put('/orgs/:orgId/local-marketing/settings', {
    schema: {
      tags: ['marketing'], security: secured, params: orgParams, summary: 'Change settings (each section needs organisation-wide publish on its module)',
      body: z.object({
        listingPolicy: z.partialRecord(z.enum(LISTING_FIELDS), z.enum(LISTING_FIELD_POLICIES)).optional(),
        autoPush: z.boolean().optional(),
        reviewSla: z.object({ positiveHours: z.number().int().min(1).max(336), negativeHours: z.number().int().min(1).max(168) }).optional(),
        coopChecklist: z.array(z.object({ key: z.string().regex(/^[a-z0-9_]{2,40}$/), label: z.string().trim().max(120).nullable().default(null) })).max(20).optional(),
        callRecording: z.object({ enabled: z.boolean(), jurisdictions: z.record(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/), z.object({ message: z.string().trim().min(10).max(300) })) }).optional(),
        missedCallLeads: z.boolean().optional(),
      }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    const b = req.body;
    const need: Array<[boolean, string]> = [
      [b.listingPolicy !== undefined || b.autoPush !== undefined, 'marketing.listings'], [b.reviewSla !== undefined, REVIEWS],
      [b.coopChecklist !== undefined, 'marketing.coop'], [b.callRecording !== undefined || b.missedCallLeads !== undefined, 'marketing.call_tracking'],
    ];
    for (const [touched, module] of need) if (touched && !(await org(req, orgId, module, 'publish'))) throw forbidden(`Changing this needs organisation-wide ${module} publish`);
    const patch = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) throw validationError('Nothing to change');
    const settings = await saveLocalMarketingSettings(db, orgId, patch, req.user!.id);
    await audit(db, { organizationId: orgId, ...actor(req), action: 'local_marketing.settings_changed', scopeKind: 'organization', scopeId: orgId, metadata: { keys: Object.keys(patch), recording: b.callRecording ? { enabled: b.callRecording.enabled, jurisdictions: Object.keys(b.callRecording.jurisdictions) } : undefined } });
    return { settings };
  });

  /* ── review reply templates ── */

  app.get('/orgs/:orgId/reviews/templates', { schema: { tags: ['reviews'], security: secured, params: orgParams, summary: 'Review reply templates: HQ templates and the location templates in scope' } }, async (req) => {
    const { orgId } = req.params;
    const sc = await scopeFor(req, db, orgId, REVIEWS);
    const rows = await db.select().from(reviewReplyTemplates).where(and(eq(reviewReplyTemplates.organizationId, orgId), sc.all ? undefined : or(isNull(reviewReplyTemplates.locationId), sc.locationIds!.length ? inArray(reviewReplyTemplates.locationId, sc.locationIds!) : sql`false`)))
      .orderBy(asc(reviewReplyTemplates.minRating), asc(reviewReplyTemplates.name));
    return { items: rows.map((t) => ({ id: t.id, locationId: t.locationId, name: t.name, minRating: t.minRating, maxRating: t.maxRating, locale: t.locale, body: t.body })), canManageHq: await org(req, orgId, REVIEWS, 'publish') };
  });

  app.post('/orgs/:orgId/reviews/templates', {
    schema: {
      tags: ['reviews'], security: secured, params: orgParams, summary: 'Add a reply template ({first_name}, {location}, {business}); HQ templates need organisation-wide Reviews publish',
      body: z.object({ locationId: z.uuid().nullable().default(null), name: z.string().trim().min(2).max(80), minRating: z.number().int().min(1).max(5).default(1), maxRating: z.number().int().min(1).max(5).default(5), locale: z.string().max(10).nullable().default(null), body: z.string().trim().min(5).max(1500) })
        .refine((b) => b.minRating <= b.maxRating, { message: 'Minimum above maximum', path: ['minRating'] }),
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    if (req.body.locationId) await requireAt(req, db, orgId, req.body.locationId, REVIEWS, 'edit');
    else if (!(await org(req, orgId, REVIEWS, 'publish'))) throw forbidden('HQ templates need organisation-wide Reviews publish');
    const [t] = await db.insert(reviewReplyTemplates).values({ organizationId: orgId, ...req.body, createdBy: req.user!.id }).returning();
    return reply.code(201).send({ id: t!.id });
  });

  app.delete('/orgs/:orgId/reviews/templates/:id', { schema: { tags: ['reviews'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const [t] = await db.select().from(reviewReplyTemplates).where(and(eq(reviewReplyTemplates.id, id), eq(reviewReplyTemplates.organizationId, orgId)));
    if (!t) throw notFound('Template');
    if (t.locationId) await requireAt(req, db, orgId, t.locationId, REVIEWS, 'edit');
    else if (!(await org(req, orgId, REVIEWS, 'publish'))) throw forbidden('HQ templates need organisation-wide Reviews publish');
    await db.delete(reviewReplyTemplates).where(eq(reviewReplyTemplates.id, id));
    return { ok: true };
  });

  app.post('/orgs/:orgId/reviews/inbox-backfill', { schema: { tags: ['reviews'], security: secured, params: orgParams, summary: 'Create inbox conversations for Google reviews stored before reviews appeared in the inbox' } }, async (req) => {
    if (!(await org(req, req.params.orgId, REVIEWS, 'publish'))) throw forbidden();
    return { created: await backfillReviewConversations(s, req.params.orgId) };
  });

  /* ── local social content calendar ── */

  const itemBody = z.object({
    title: z.string().trim().min(2).max(120), body: z.string().trim().min(1).max(3000), media: z.array(z.object({ url: z.url().max(2000), alt: z.string().max(200).optional() })).max(10).default([]),
    link: z.url().max(2000).nullable().default(null), networks: z.array(z.enum(SOCIAL_NETWORKS)).max(4).default([]), suggestedAt: iso, allowEdits: z.boolean().default(false),
    audience: z.enum(['all', 'selected']).default('all'), locationIds: z.array(z.uuid()).max(2000).default([]),
  });

  app.get('/orgs/:orgId/social/calendar', {
    schema: { tags: ['social'], security: secured, params: orgParams, querystring: z.object({ from: iso.optional(), to: iso.optional(), locationId: z.uuid().optional() }), summary: 'HQ content calendar: posts locations can localise and schedule, with who adopted each' },
  }, async (req) => {
    const { orgId } = req.params;
    const sc = await scopeFor(req, db, orgId, SOCIAL);
    const isHq = await org(req, orgId, SOCIAL, 'publish');
    if (req.query.locationId && !sc.all && !sc.locationIds!.includes(req.query.locationId)) throw notFound('Location');
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = req.query.to ? new Date(req.query.to) : new Date(from.getTime() + 42 * 86_400_000);
    const locationIds = req.query.locationId ? [req.query.locationId] : sc.all ? ('all' as const) : sc.locationIds!;
    return { items: await calendar(db, orgId, { from, to, includeDrafts: isHq, locationIds }), canManage: isHq };
  });

  app.post('/orgs/:orgId/social/calendar', { schema: { tags: ['social'], security: secured, params: orgParams, body: itemBody, summary: 'HQ: add a calendar post (draft until published to the network)' } }, async (req, reply) => {
    const { orgId } = req.params;
    if (!(await org(req, orgId, SOCIAL, 'publish'))) throw forbidden('Only HQ with Social publish access manages the content calendar');
    const [i] = await db.insert(socialCalendarItems).values({ organizationId: orgId, ...req.body, suggestedAt: new Date(req.body.suggestedAt), createdBy: req.user!.id }).returning();
    return reply.code(201).send(serializeItem(i!));
  });

  app.put('/orgs/:orgId/social/calendar/:id', { schema: { tags: ['social'], security: secured, params: idParams, body: itemBody } }, async (req) => {
    const { orgId, id } = req.params;
    if (!(await org(req, orgId, SOCIAL, 'publish'))) throw forbidden('Only HQ with Social publish access manages the content calendar');
    await loadItem(db, orgId, id);
    const [i] = await db.update(socialCalendarItems).set({ ...req.body, suggestedAt: new Date(req.body.suggestedAt), updatedAt: new Date() }).where(eq(socialCalendarItems.id, id)).returning();
    return serializeItem(i!);
  });

  app.post('/orgs/:orgId/social/calendar/:id/status', { schema: { tags: ['social'], security: secured, params: idParams, body: z.object({ status: z.enum(['draft', 'published', 'archived']) }), summary: 'HQ: publish a post to the network calendar (or withdraw / archive it)' } }, async (req) => {
    const { orgId, id } = req.params;
    if (!(await org(req, orgId, SOCIAL, 'publish'))) throw forbidden('Only HQ with Social publish access manages the content calendar');
    const item = await loadItem(db, orgId, id);
    const [i] = await db.update(socialCalendarItems).set({ status: req.body.status, publishedAt: req.body.status === 'published' ? item.publishedAt ?? new Date() : item.publishedAt, updatedAt: new Date() }).where(eq(socialCalendarItems.id, id)).returning();
    await audit(db, { organizationId: orgId, ...actor(req), action: `social.calendar_${req.body.status}`, scopeKind: 'organization', scopeId: orgId, targetType: 'social_calendar_item', targetId: id });
    return serializeItem(i!);
  });

  app.get('/orgs/:orgId/social/calendar/:id/preview', { schema: { tags: ['social'], security: secured, params: idParams, querystring: z.object({ locationId: z.uuid() }), summary: 'The post localised for a location: text, missing details and the accounts it would go to' } }, async (req) => {
    const { orgId, id } = req.params;
    await requireAt(req, db, orgId, req.query.locationId, SOCIAL, 'view');
    const item = await loadItem(db, orgId, id);
    if (!itemVisibleTo(item, req.query.locationId) || (item.status !== 'published' && !(await org(req, orgId, SOCIAL, 'publish')))) throw notFound('Calendar post');
    return localise(s, item, req.query.locationId);
  });

  app.post('/orgs/:orgId/social/calendar/:id/adopt', {
    schema: { tags: ['social'], security: secured, params: idParams, body: z.object({ locationId: z.uuid(), accountIds: z.array(z.uuid()).max(10).optional(), scheduledAt: iso.nullable().optional(), body: z.string().max(3000).nullable().optional() }), summary: 'Localise and schedule on the location’s own accounts (one click)' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requireAt(req, db, orgId, req.body.locationId, SOCIAL, 'edit');
    const post = await adoptItem(s, await loadItem(db, orgId, id), { locationId: req.body.locationId, accountIds: req.body.accountIds, scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : null, body: req.body.body ?? null }, req.user!.id);
    return reply.code(201).send({ postId: post.id, status: post.status, scheduledAt: post.scheduledAt?.toISOString() ?? null, body: post.body, accountIds: post.accountIds });
  });

  app.post('/orgs/:orgId/social/calendar/:id/skip', { schema: { tags: ['social'], security: secured, params: idParams, body: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const { orgId, id } = req.params;
    await requireAt(req, db, orgId, req.body.locationId, SOCIAL, 'edit');
    return skipItem(s, await loadItem(db, orgId, id), req.body.locationId, req.user!.id);
  });
};

