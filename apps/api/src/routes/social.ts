import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SOCIAL_NETWORKS, localPostNeedsApproval, socialPostIssues, type SocialNetworkKey } from '@bh/shared';
import { locations, socialAccountGrants, socialAccounts, socialPosts, users } from '../db/schema/index.ts';
import { exchangeMetaCode, oauthStartUrl, readState, signState } from '../integrations/social.ts';
import { encrypt } from '../lib/crypto.ts';
import { AppError, conflict, forbidden, notFound, unavailable, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { hasAt, requireAt, scopeFor } from '../services/comms-scope.ts';
import { locationMayPost, locationRow, postableAccounts, publishDuePosts, publishPost, revokeLocationSocialAccess, tierOf, type SocialAccountRow, type SocialPostRow } from '../services/social.ts';
import { idParams, orgParams, secured } from './_common.ts';

const M = 'marketing.social';
const network = z.enum(SOCIAL_NETWORKS);

/**
 * Social: HQ-owned and location-owned accounts, access handover (HQ grants locations posting rights and revokes
 * them on termination), a composer with per-network validation, scheduling, approval of local posts by tier, a
 * content calendar and publishing through the network adapters (sandbox unless connected through OAuth).
 */
export const socialRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  // Background: publish due posts every minute (not in tests; the claim makes it safe on several instances).
  if (s.cfg.NODE_ENV !== 'test') {
    let timer: NodeJS.Timeout | null = null;
    app.addHook('onReady', async () => {
      timer = setInterval(() => void publishDuePosts(s).catch((err) => s.log.warn({ err }, 'social publish sweep failed')), 60_000);
      timer.unref?.();
    });
    app.addHook('onClose', async () => { if (timer) clearInterval(timer); });
  }

  // OAuth callback (unauthenticated: the signed state carries who started it).
  app.get('/oauth/social/:provider/callback', {
    schema: { tags: ['social'], summary: 'OAuth callback for social accounts (Meta pages and Instagram business accounts)', params: z.object({ provider: z.enum(['meta', 'linkedin', 'google']) }), querystring: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }) },
  }, async (req, reply) => {
    const back = (q: string) => reply.redirect(`${s.cfg.APP_URL.replace(/\/$/, '')}/marketing/social?${q}`);
    const st = req.query.state ? readState<{ orgId: string; userId: string; ownerKind: 'hq' | 'location'; locationId: string | null }>(s.cfg.ENCRYPTION_KEY, req.query.state) : null;
    if (!st || !req.query.code || req.query.error) return back('oauth=failed');
    if (req.params.provider !== 'meta' || !s.cfg.META_APP_ID || !s.cfg.META_APP_SECRET) return back('oauth=unavailable');
    try {
      const pages = await exchangeMetaCode(s.cfg, req.query.code);
      let n = 0;
      for (const p of pages) {
        const rows: Array<typeof socialAccounts.$inferInsert> = [{ organizationId: st.orgId, ownerKind: st.ownerKind, locationId: st.locationId, network: 'facebook', handle: p.name, externalId: p.id, mode: 'live', credentialsEncrypted: encrypt(p.access_token, s.cfg.ENCRYPTION_KEY), connectedBy: st.userId }];
        if (p.instagram_business_account) rows.push({ ...rows[0]!, network: 'instagram', handle: p.instagram_business_account.username ?? p.name, externalId: p.instagram_business_account.id });
        await s.db.insert(socialAccounts).values(rows);
        n += rows.length;
      }
      await audit(s.db, { organizationId: st.orgId, actorUserId: st.userId, action: 'social.accounts_connected', scopeKind: st.locationId ? 'location' : 'organization', scopeId: st.locationId ?? st.orgId, metadata: { provider: 'meta', accounts: n } });
      return back(`oauth=connected&count=${n}`);
    } catch (err) {
      s.log.warn({ err }, 'meta oauth exchange failed');
      return back('oauth=failed');
    }
  });

  await app.register(async (priv) => {
    priv.addHook('preHandler', authenticate);
    const r = priv.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();

    const loadAccount = async (orgId: string, id: string) => {
      const [a] = await s.db.select().from(socialAccounts).where(and(eq(socialAccounts.id, id), eq(socialAccounts.organizationId, orgId)));
      if (!a) throw notFound('Social account');
      return a;
    };
    const loadPost = async (orgId: string, id: string) => {
      const [p] = await s.db.select().from(socialPosts).where(and(eq(socialPosts.id, id), eq(socialPosts.organizationId, orgId)));
      if (!p) throw notFound('Post');
      return p;
    };
    const serializeAccount = (a: SocialAccountRow, grants: Array<typeof socialAccountGrants.$inferSelect> = []) => ({
      id: a.id, ownerKind: a.ownerKind, locationId: a.locationId, network: a.network, handle: a.handle, mode: a.mode, status: a.status, createdAt: a.createdAt.toISOString(),
      grants: grants.filter((g) => g.accountId === a.id).map((g) => ({ id: g.id, locationId: g.locationId, access: g.access, grantedAt: g.grantedAt.toISOString(), revokedAt: g.revokedAt?.toISOString() ?? null, revokeReason: g.revokeReason })),
    });
    const serializePost = async (rows: SocialPostRow[]) => {
      const ids = [...new Set(rows.flatMap((p) => [p.authorUserId, p.decidedBy]).filter((x): x is string => !!x))];
      const people = ids.length ? await s.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
      const nm = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? null : null);
      return rows.map((p) => ({
        id: p.id, locationId: p.locationId, body: p.body, media: p.media, link: p.link, accountIds: p.accountIds, scheduledAt: p.scheduledAt?.toISOString() ?? null, status: p.status, needsApproval: p.needsApproval,
        author: { id: p.authorUserId, name: nm(p.authorUserId) }, decidedBy: p.decidedBy ? { id: p.decidedBy, name: nm(p.decidedBy) } : null, decisionComment: p.decisionComment, decidedAt: p.decidedAt?.toISOString() ?? null,
        results: p.results, publishedAt: p.publishedAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString(),
      }));
    };

    /* ── accounts & handover ── */

    r.get('/orgs/:orgId/social/accounts', { schema: { tags: ['social'], security: secured, params: orgParams, summary: 'Accounts you can see: HQ sees every account; a location sees its own accounts and HQ accounts handed over to it' } }, async (req) => {
      const { orgId } = req.params;
      const scope = await scopeFor(req, s.db, orgId, M);
      const all = await s.db.select().from(socialAccounts).where(eq(socialAccounts.organizationId, orgId)).orderBy(asc(socialAccounts.network), asc(socialAccounts.handle));
      const grants = all.length ? await s.db.select().from(socialAccountGrants).where(inArray(socialAccountGrants.accountId, all.map((a) => a.id))).orderBy(desc(socialAccountGrants.grantedAt)) : [];
      if (scope.all) return { items: all.map((a) => serializeAccount(a, grants)), hq: true };
      const mine = new Set(scope.locationIds);
      const visible = all.filter((a) => (a.ownerKind === 'location' && a.locationId && mine.has(a.locationId)) || grants.some((g) => g.accountId === a.id && !g.revokedAt && mine.has(g.locationId)));
      return { items: visible.map((a) => serializeAccount(a, grants.filter((g) => mine.has(g.locationId)))), hq: false };
    });

    r.post('/orgs/:orgId/social/accounts', {
      schema: {
        tags: ['social'], security: secured, params: orgParams, summary: 'Add an account in sandbox (posts are simulated). Connect through OAuth to publish live.',
        body: z.object({ network, handle: z.string().trim().min(1).max(120), ownerKind: z.enum(['hq', 'location']).default('hq'), locationId: z.uuid().nullable().default(null) }).refine((b) => b.ownerKind === 'hq' || !!b.locationId, { message: 'Choose the location that owns it', path: ['locationId'] }),
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      if (b.locationId && !(await locationRow(s.db, orgId, b.locationId))) throw notFound('Location');
      await requireAt(req, s.db, orgId, b.ownerKind === 'hq' ? null : b.locationId, M, 'publish');
      const [a] = await s.db.insert(socialAccounts).values({ organizationId: orgId, ownerKind: b.ownerKind, locationId: b.locationId, network: b.network, handle: b.handle, mode: 'sandbox', connectedBy: req.user!.id }).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'social.account_added', scopeKind: b.ownerKind === 'hq' ? 'organization' : 'location', scopeId: b.ownerKind === 'hq' ? orgId : b.locationId, targetType: 'social_account', targetId: a!.id, metadata: { network: b.network, mode: 'sandbox' } });
      return reply.code(201).send(serializeAccount(a!));
    });

    r.get('/orgs/:orgId/social/oauth/:provider/start', {
      schema: { tags: ['social'], security: secured, params: z.object({ orgId: z.uuid(), provider: z.enum(['meta', 'linkedin', 'google']) }), querystring: z.object({ ownerKind: z.enum(['hq', 'location']).default('hq'), locationId: z.uuid().optional() }), summary: 'Consent URL to connect accounts (503 when the platform app is not configured)' },
    }, async (req) => {
      const { orgId, provider } = req.params;
      const locationId = req.query.ownerKind === 'location' ? req.query.locationId ?? null : null;
      await requireAt(req, s.db, orgId, locationId, M, 'publish');
      const url = oauthStartUrl(s.cfg, provider, signState(s.cfg.ENCRYPTION_KEY, { orgId, userId: req.user!.id, ownerKind: req.query.ownerKind, locationId }));
      if (!url) throw unavailable('oauth_not_configured', `Connecting ${provider} accounts needs the platform app credentials. Accounts can be added in sandbox meanwhile.`);
      if (provider !== 'meta') return { url, note: 'Publishing to this network runs in sandbox until its adapter is enabled.' };
      return { url };
    });

    r.patch('/orgs/:orgId/social/accounts/:id', { schema: { tags: ['social'], security: secured, params: idParams, body: z.object({ status: z.enum(['connected', 'disconnected']) }) } }, async (req) => {
      const { orgId, id } = req.params;
      const a = await loadAccount(orgId, id);
      await requireAt(req, s.db, orgId, a.ownerKind === 'hq' ? null : a.locationId, M, 'publish');
      const [u] = await s.db.update(socialAccounts).set({ status: req.body.status }).where(eq(socialAccounts.id, id)).returning();
      return serializeAccount(u!);
    });

    r.post('/orgs/:orgId/social/accounts/:id/grants', {
      schema: { tags: ['social'], security: secured, params: idParams, summary: 'Hand over posting rights on an HQ-owned account to a location (HQ keeps ownership)', body: z.object({ locationId: z.uuid(), access: z.enum(['post', 'post_insights', 'view']).default('post') }) },
    }, async (req, reply) => {
      const { orgId, id } = req.params;
      const a = await loadAccount(orgId, id);
      if (a.ownerKind !== 'hq') throw conflict('not_hq_account', 'Only HQ-owned accounts are handed over');
      await requireAt(req, s.db, orgId, null, M, 'publish');
      if (!(await locationRow(s.db, orgId, req.body.locationId))) throw notFound('Location');
      const [existing] = await s.db.select().from(socialAccountGrants).where(and(eq(socialAccountGrants.accountId, id), eq(socialAccountGrants.locationId, req.body.locationId), isNull(socialAccountGrants.revokedAt)));
      const [g] = existing
        ? await s.db.update(socialAccountGrants).set({ access: req.body.access }).where(eq(socialAccountGrants.id, existing.id)).returning()
        : await s.db.insert(socialAccountGrants).values({ organizationId: orgId, accountId: id, locationId: req.body.locationId, access: req.body.access, grantedBy: req.user!.id }).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'social.access_granted', scopeKind: 'location', scopeId: req.body.locationId, targetType: 'social_account', targetId: id, metadata: { access: req.body.access } });
      return reply.code(existing ? 200 : 201).send(serializeAccount(a, [g!]));
    });

    r.post('/orgs/:orgId/social/accounts/:id/grants/:grantId/revoke', {
      schema: { tags: ['social'], security: secured, params: z.object({ orgId: z.uuid(), id: z.uuid(), grantId: z.uuid() }), body: z.object({ reason: z.string().trim().min(1).max(200).default('revoked') }) },
    }, async (req) => {
      const { orgId, id, grantId } = req.params;
      await requireAt(req, s.db, orgId, null, M, 'publish');
      const [g] = await s.db.update(socialAccountGrants).set({ revokedAt: new Date(), revokedBy: req.user!.id, revokeReason: req.body.reason })
        .where(and(eq(socialAccountGrants.id, grantId), eq(socialAccountGrants.accountId, id), eq(socialAccountGrants.organizationId, orgId), isNull(socialAccountGrants.revokedAt))).returning();
      if (!g) throw notFound('Active grant');
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'social.access_revoked', scopeKind: 'location', scopeId: g.locationId, targetType: 'social_account', targetId: id, metadata: { reason: req.body.reason } });
      return { id: g.id, revokedAt: g.revokedAt!.toISOString() };
    });

    r.post('/orgs/:orgId/social/handover/revoke-location', {
      schema: { tags: ['social'], security: secured, params: orgParams, summary: 'Termination / exit: revoke all of a location’s rights on HQ accounts and take its posts off them', body: z.object({ locationId: z.uuid(), reason: z.string().trim().min(1).max(200).default('termination') }) },
    }, async (req) => {
      const { orgId } = req.params;
      await requireAt(req, s.db, orgId, null, M, 'publish');
      if (!(await locationRow(s.db, orgId, req.body.locationId))) throw notFound('Location');
      return revokeLocationSocialAccess(s.db, orgId, req.body.locationId, req.user!.id, req.body.reason);
    });

    /* ── posts ── */

    r.get('/orgs/:orgId/social/posts', {
      schema: { tags: ['social'], security: secured, params: orgParams, summary: 'Content calendar: posts in a date range (and unscheduled drafts / approvals)', querystring: z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(), status: z.string().max(40).optional(), locationId: z.uuid().optional() }) },
    }, async (req) => {
      const { orgId } = req.params;
      const scope = await scopeFor(req, s.db, orgId, M);
      const conds: SQL[] = [eq(socialPosts.organizationId, orgId)];
      if (!scope.all) conds.push(scope.locationIds!.length ? inArray(socialPosts.locationId, scope.locationIds!) : sql`false`);
      if (req.query.locationId) conds.push(eq(socialPosts.locationId, req.query.locationId));
      if (req.query.status) conds.push(inArray(socialPosts.status, req.query.status.split(',')));
      if (req.query.from) conds.push(or(isNull(socialPosts.scheduledAt), gte(socialPosts.scheduledAt, new Date(req.query.from)))!);
      if (req.query.to) conds.push(or(isNull(socialPosts.scheduledAt), lte(socialPosts.scheduledAt, new Date(req.query.to)))!);
      const rows = await s.db.select().from(socialPosts).where(and(...conds)).orderBy(asc(socialPosts.scheduledAt), desc(socialPosts.createdAt)).limit(500);
      return { items: await serializePost(rows), canApprove: await hasAt(req, s.db, orgId, null, M, 'publish') };
    });

    const postBody = z.object({
      locationId: z.uuid().nullable().default(null), body: z.string().max(63206).default(''), media: z.array(z.object({ url: z.url().max(2000), alt: z.string().max(300).optional() })).max(10).default([]),
      link: z.url().max(2000).nullable().optional(), accountIds: z.array(z.uuid()).min(1).max(20), scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(), submit: z.boolean().default(true),
    });

    r.post('/orgs/:orgId/social/posts', {
      schema: { tags: ['social'], security: secured, params: orgParams, summary: 'Compose a post for one or more accounts. Local posts may need HQ approval (location tier); submit=false saves a draft.', body: postBody },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const me = requireUser(req);
      const b = req.body;
      const loc = b.locationId ? await locationRow(s.db, orgId, b.locationId) : null;
      if (b.locationId && !loc) throw notFound('Location');
      await requireAt(req, s.db, orgId, b.locationId, M, 'edit');
      const accounts = await s.db.select().from(socialAccounts).where(and(eq(socialAccounts.organizationId, orgId), inArray(socialAccounts.id, b.accountIds)));
      if (accounts.length !== new Set(b.accountIds).size) throw validationError('Unknown account', { accountIds: 'Not in this business' });
      for (const a of accounts) {
        if (a.status === 'disconnected') throw conflict('account_disconnected', `${a.handle} is disconnected`);
        if (loc && !(await locationMayPost(s.db, a, loc.id))) throw forbidden(`${loc.name} has no posting rights on ${a.handle}`);
        if (!loc && a.ownerKind !== 'hq') throw forbidden('HQ posts go on HQ-owned accounts');
        const issues = socialPostIssues(a.network as SocialNetworkKey, { body: b.body, media: b.media, link: b.link });
        if (issues.length) throw new AppError(400, 'validation_failed', `This post doesn’t fit ${a.network}`, { body: issues.join(',') }, { network: a.network, issues });
      }
      const when = b.scheduledAt ? new Date(b.scheduledAt) : null;
      if (when && when.getTime() < Date.now() - 60_000) throw validationError('Choose a time in the future', { scheduledAt: 'In the past' });
      const hqPublisher = await hasAt(req, s.db, orgId, null, M, 'publish');
      const needsApproval = !hqPublisher && (loc ? localPostNeedsApproval(tierOf(loc), accounts.some((a) => a.ownerKind === 'hq')) : true);
      const status = !b.submit ? 'draft' : needsApproval ? 'pending_approval' : 'scheduled';
      const [p] = await s.db.insert(socialPosts).values({ organizationId: orgId, locationId: b.locationId, body: b.body, media: b.media, link: b.link ?? null, accountIds: [...new Set(b.accountIds)], scheduledAt: when ?? (status === 'scheduled' ? new Date() : null), status, needsApproval, authorUserId: me.id }).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'social.post_created', scopeKind: b.locationId ? 'location' : 'organization', scopeId: b.locationId ?? orgId, targetType: 'social_post', targetId: p!.id, metadata: { status, needsApproval } });
      let out = p!;
      if (status === 'scheduled' && (!when || when <= new Date())) {
        const [claimed] = await s.db.update(socialPosts).set({ status: 'publishing' }).where(and(eq(socialPosts.id, out.id), eq(socialPosts.status, 'scheduled'))).returning();
        if (claimed) out = await publishPost(s, claimed);
      }
      return reply.code(201).send((await serializePost([out]))[0]!);
    });

    r.post('/orgs/:orgId/social/posts/:id/submit', { schema: { tags: ['social'], security: secured, params: idParams, summary: 'Submit a draft (or a rejected post after changes)' } }, async (req) => {
      const { orgId, id } = req.params;
      const p = await loadPost(orgId, id);
      if (p.authorUserId !== req.user!.id) throw forbidden('Only the author can submit this post');
      if (!['draft', 'rejected'].includes(p.status)) throw conflict('not_draft', `This post is ${p.status}`);
      await requireAt(req, s.db, orgId, p.locationId, M, 'edit');
      const [u] = await s.db.update(socialPosts).set({ status: p.needsApproval ? 'pending_approval' : 'scheduled', scheduledAt: p.scheduledAt ?? (p.needsApproval ? null : new Date()), updatedAt: new Date() }).where(eq(socialPosts.id, id)).returning();
      return (await serializePost([u!]))[0]!;
    });

    r.post('/orgs/:orgId/social/posts/:id/decision', {
      schema: { tags: ['social'], security: secured, params: idParams, summary: 'HQ approves (schedules, or publishes now when the time has passed) or rejects a post. No self-approval.', body: z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(1000).optional() }) },
    }, async (req) => {
      const { orgId, id } = req.params;
      await requireAt(req, s.db, orgId, null, M, 'publish');
      const p = await loadPost(orgId, id);
      if (p.authorUserId === req.user!.id) throw forbidden('You cannot approve your own post');
      if (req.body.decision === 'reject' && !req.body.comment?.trim()) throw validationError('Say what needs to change', { comment: 'Required when rejecting' });
      const approve = req.body.decision === 'approve';
      const [u] = await s.db.update(socialPosts).set({ status: approve ? 'scheduled' : 'rejected', scheduledAt: approve ? p.scheduledAt ?? new Date() : p.scheduledAt, decidedBy: req.user!.id, decidedAt: new Date(), decisionComment: req.body.comment ?? null, updatedAt: new Date() })
        .where(and(eq(socialPosts.id, id), eq(socialPosts.status, 'pending_approval'))).returning();
      if (!u) throw conflict('already_decided', `This post is ${p.status}`);
      await audit(s.db, { organizationId: orgId, ...actor(req), action: approve ? 'social.post_approved' : 'social.post_rejected', scopeKind: p.locationId ? 'location' : 'organization', scopeId: p.locationId ?? orgId, targetType: 'social_post', targetId: id, metadata: { comment: req.body.comment ?? null } });
      let out = u;
      if (approve && u.scheduledAt && u.scheduledAt <= new Date()) {
        const [claimed] = await s.db.update(socialPosts).set({ status: 'publishing' }).where(and(eq(socialPosts.id, id), eq(socialPosts.status, 'scheduled'))).returning();
        if (claimed) out = await publishPost(s, claimed);
      }
      return (await serializePost([out]))[0]!;
    });

    r.post('/orgs/:orgId/social/posts/:id/publish-now', { schema: { tags: ['social'], security: secured, params: idParams } }, async (req) => {
      const { orgId, id } = req.params;
      const p = await loadPost(orgId, id);
      await requireAt(req, s.db, orgId, p.locationId, M, 'edit');
      const [claimed] = await s.db.update(socialPosts).set({ status: 'publishing' }).where(and(eq(socialPosts.id, id), eq(socialPosts.status, 'scheduled'))).returning();
      if (!claimed) throw conflict('not_scheduled', p.status === 'pending_approval' ? 'This post is waiting for approval' : `This post is ${p.status}`);
      return (await serializePost([await publishPost(s, claimed)]))[0]!;
    });

    r.post('/orgs/:orgId/social/posts/:id/cancel', { schema: { tags: ['social'], security: secured, params: idParams } }, async (req) => {
      const { orgId, id } = req.params;
      const p = await loadPost(orgId, id);
      await requireAt(req, s.db, orgId, p.locationId, M, 'edit');
      const [u] = await s.db.update(socialPosts).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(socialPosts.id, id), inArray(socialPosts.status, ['draft', 'pending_approval', 'scheduled', 'rejected']))).returning();
      if (!u) throw conflict('not_cancellable', `This post is ${p.status}`);
      return (await serializePost([u]))[0]!;
    });

    r.get('/orgs/:orgId/social/postable-accounts', { schema: { tags: ['social'], security: secured, params: orgParams, querystring: z.object({ locationId: z.uuid().optional() }), summary: 'Accounts the composer may target for HQ or a location' } }, async (req) => {
      const { orgId } = req.params;
      await requireAt(req, s.db, orgId, req.query.locationId ?? null, M, 'edit');
      const rows = req.query.locationId ? await postableAccounts(s.db, orgId, req.query.locationId) : await s.db.select().from(socialAccounts).where(and(eq(socialAccounts.organizationId, orgId), eq(socialAccounts.ownerKind, 'hq')));
      const loc = req.query.locationId ? await s.db.select({ settings: locations.settings }).from(locations).where(eq(locations.id, req.query.locationId)) : [];
      return { items: rows.filter((a) => a.status !== 'disconnected').map((a) => serializeAccount(a)), tier: loc[0] ? tierOf(loc[0]) : null, approvesOwnPosts: await hasAt(req, s.db, orgId, null, M, 'publish') };
    });
  });
};
