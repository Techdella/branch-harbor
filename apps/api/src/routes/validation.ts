import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { VALIDATION_CALL_STATUSES, VALIDATION_SENTIMENTS, pickValidators } from '@bh/shared';
import { franchiseProspects, franchiseValidationCalls, franchiseValidationLinks, franchiseValidators, locations, organizations, ownerGroups, users } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { hasCapability, requireMember } from '../services/authz.ts';
import { addActivity, getProspect } from '../services/franchise.ts';
import { networkNotify } from '../services/network-notify.ts';
import { userNames } from '../services/network-access.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';

const tags = ['validation'];
const org = (organizationId: string) => ({ organizationId, kind: 'organization' as const, id: organizationId });
const DAY = 86_400_000;

/**
 * Candidate validation calls (`/v1/orgs/:orgId/validation`): franchisees opt in as validators (Surveys & validation,
 * view), HQ assigns validators to a prospect by rotation (franchise pipeline edit), the candidate gets a scheduling
 * link, and HQ or the validator records the outcome. Validators never see a candidate's financial details.
 */
export const validationRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const db = s.db;
  app.addHook('preHandler', authenticate);

  const pipeline = (req: Parameters<typeof hasCapability>[0], orgId: string, action: 'view' | 'edit') => hasCapability(req, db, 'sales.franchise_pipeline', action, org(orgId));
  const requirePipeline = async (req: Parameters<typeof hasCapability>[0], orgId: string, action: 'view' | 'edit') => {
    await requireMember(req, db, orgId);
    if (!(await pipeline(req, orgId, action))) throw forbidden(`Missing ${action} access to the franchise pipeline`);
  };

  async function pool(orgId: string, now = new Date()) {
    const vs = await db.select({ v: franchiseValidators, name: users.name, group: ownerGroups.name, loc: locations.name }).from(franchiseValidators).innerJoin(users, eq(users.id, franchiseValidators.userId))
      .leftJoin(ownerGroups, eq(ownerGroups.id, franchiseValidators.ownerGroupId)).leftJoin(locations, eq(locations.id, franchiseValidators.locationId))
      .where(eq(franchiseValidators.organizationId, orgId)).orderBy(asc(users.name));
    const calls = vs.length ? await db.select({ validatorId: franchiseValidationCalls.validatorId, createdAt: franchiseValidationCalls.createdAt, status: franchiseValidationCalls.status }).from(franchiseValidationCalls)
      .where(and(eq(franchiseValidationCalls.organizationId, orgId), gte(franchiseValidationCalls.createdAt, new Date(now.getTime() - 90 * DAY)))) : [];
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return vs.map(({ v, name, group, loc }) => {
      const mine = calls.filter((c) => c.validatorId === v.id && c.status !== 'cancelled');
      return {
        id: v.id, userId: v.userId, name, ownerGroupName: group, locationName: loc, country: v.country, region: v.region, active: v.active, maxCallsPerMonth: v.maxCallsPerMonth, bio: v.bio, schedulingUrl: v.schedulingUrl, phone: v.phone,
        callsLast90: mine.length, callsThisMonth: mine.filter((c) => c.createdAt >= monthStart).length, lastCallAt: mine.length ? iso(mine.map((c) => c.createdAt).sort((a, b) => b.getTime() - a.getTime())[0]) : null, optedInAt: v.optedInAt.toISOString(),
      };
    });
  }

  const callOut = (c: typeof franchiseValidationCalls.$inferSelect, extra: { validatorName?: string | null; prospectName?: string | null; prospectCity?: string | null } = {}) => ({
    id: c.id, prospectId: c.prospectId, validatorId: c.validatorId, status: c.status, scheduledAt: iso(c.scheduledAt), proposedTimes: c.proposedTimes, completedAt: iso(c.completedAt), sentiment: c.sentiment, outcome: c.outcome, createdAt: c.createdAt.toISOString(), ...extra,
  });

  /* ------------------------------ validators ------------------------------ */

  app.get('/orgs/:orgId/validation/validators', { schema: { tags, security: secured, params: orgParams, summary: 'Validators (franchisees who opted in) with their call load (franchise pipeline view)' } }, async (req) => {
    const { orgId } = req.params;
    await requirePipeline(req, orgId, 'view');
    return { items: await pool(orgId) };
  });

  app.patch('/orgs/:orgId/validation/validators/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ active: z.boolean().optional(), maxCallsPerMonth: z.number().int().min(0).max(30).optional() }) } }, async (req) => {
    const { orgId, id } = req.params;
    await requirePipeline(req, orgId, 'edit');
    const [v] = await db.update(franchiseValidators).set({ ...req.body, updatedAt: new Date() }).where(and(eq(franchiseValidators.id, id), eq(franchiseValidators.organizationId, orgId))).returning();
    if (!v) throw notFound('Validator');
    return { id: v.id, active: v.active, maxCallsPerMonth: v.maxCallsPerMonth };
  });

  app.get('/orgs/:orgId/validation/me', { schema: { tags, security: secured, params: orgParams, summary: 'Your validator profile and your calls (franchisees)' } }, async (req) => {
    const { orgId } = req.params;
    await requireMember(req, db, orgId);
    const [v] = await db.select().from(franchiseValidators).where(and(eq(franchiseValidators.organizationId, orgId), eq(franchiseValidators.userId, req.user!.id)));
    const calls = v ? await db.select({ c: franchiseValidationCalls, p: { name: franchiseProspects.name, city: franchiseProspects.city, country: franchiseProspects.country, email: franchiseProspects.email, phone: franchiseProspects.phone } }).from(franchiseValidationCalls)
      .innerJoin(franchiseProspects, eq(franchiseProspects.id, franchiseValidationCalls.prospectId)).where(eq(franchiseValidationCalls.validatorId, v.id)).orderBy(desc(franchiseValidationCalls.createdAt)).limit(50) : [];
    return {
      eligible: await canVolunteer(req, orgId), validator: v ? { id: v.id, active: v.active, bio: v.bio, schedulingUrl: v.schedulingUrl, phone: v.phone, maxCallsPerMonth: v.maxCallsPerMonth, optedInAt: v.optedInAt.toISOString() } : null,
      // Candidates' contact details only while a call is being arranged; never their finances.
      calls: calls.map(({ c, p }) => callOut(c, { prospectName: p.name, prospectCity: [p.city, p.country].filter(Boolean).join(', ') })),
    };
  });

  /** Franchise owners (owner-group scope) and location managers with Surveys & validation can volunteer. */
  async function canVolunteer(req: Parameters<typeof hasCapability>[0], orgId: string) {
    const mine = await requireMember(req, db, orgId);
    return mine.some((a) => (a.scopeKind === 'owner_group' || a.scopeKind === 'location') && a.capabilities?.has('community.surveys:view'));
  }

  app.put('/orgs/:orgId/validation/me', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ active: z.boolean(), bio: z.string().trim().max(1000).nullable().optional(), schedulingUrl: z.url().max(500).nullable().optional(), phone: z.string().max(40).nullable().optional(), maxCallsPerMonth: z.number().int().min(1).max(30).default(4) }), summary: 'Opt in (or out) as a validator for candidate calls' },
  }, async (req) => {
    const { orgId } = req.params;
    const mine = await requireMember(req, db, orgId);
    if (!(await canVolunteer(req, orgId))) throw forbidden('Only franchisees can be validators');
    const og = mine.find((a) => a.scopeKind === 'owner_group')?.scopeId ?? null;
    const locId = mine.find((a) => a.scopeKind === 'location')?.scopeId ?? null;
    const [loc] = locId ? await db.select().from(locations).where(eq(locations.id, locId)) : og ? await db.select().from(locations).where(and(eq(locations.organizationId, orgId), eq(locations.ownerGroupId, og))).limit(1) : [];
    const vals = { active: req.body.active, bio: req.body.bio ?? null, schedulingUrl: req.body.schedulingUrl ?? null, phone: req.body.phone ?? null, maxCallsPerMonth: req.body.maxCallsPerMonth, ownerGroupId: og ?? loc?.ownerGroupId ?? null, locationId: loc?.id ?? null, country: loc?.country ?? null, region: loc?.address.region ?? null, updatedAt: new Date() };
    const [v] = await db.insert(franchiseValidators).values({ organizationId: orgId, userId: req.user!.id, ...vals }).onConflictDoUpdate({ target: [franchiseValidators.organizationId, franchiseValidators.userId], set: vals }).returning();
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: req.body.active ? 'validation.opted_in' : 'validation.opted_out', targetType: 'franchise_validator', targetId: v!.id, ip: req.ip });
    return { id: v!.id, active: v!.active };
  });

  /* -------------------------------- calls -------------------------------- */

  app.get('/orgs/:orgId/validation/calls', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ prospectId: z.uuid().optional(), status: z.enum(VALIDATION_CALL_STATUSES).optional() }), summary: 'Validation calls (franchise pipeline view)' } }, async (req) => {
    const { orgId } = req.params;
    await requirePipeline(req, orgId, 'view');
    const conds = [eq(franchiseValidationCalls.organizationId, orgId)];
    if (req.query.prospectId) conds.push(eq(franchiseValidationCalls.prospectId, req.query.prospectId));
    if (req.query.status) conds.push(eq(franchiseValidationCalls.status, req.query.status));
    const rows = await db.select({ c: franchiseValidationCalls, p: { name: franchiseProspects.name, city: franchiseProspects.city, stage: franchiseProspects.stage }, v: { userId: franchiseValidators.userId } }).from(franchiseValidationCalls)
      .innerJoin(franchiseProspects, eq(franchiseProspects.id, franchiseValidationCalls.prospectId)).innerJoin(franchiseValidators, eq(franchiseValidators.id, franchiseValidationCalls.validatorId))
      .where(and(...conds)).orderBy(desc(franchiseValidationCalls.createdAt)).limit(300);
    const names = await userNames(db, rows.map((r) => r.v.userId));
    // Candidates in the pipeline who could use validation calls (from discovery call up to signing) and have none yet.
    const prospects = await db.select({ id: franchiseProspects.id, name: franchiseProspects.name, stage: franchiseProspects.stage, city: franchiseProspects.city, country: franchiseProspects.country }).from(franchiseProspects)
      .where(and(eq(franchiseProspects.organizationId, orgId), inArray(franchiseProspects.stage, ['discovery_call', 'disclosure_sent', 'disclosure_receipt_signed', 'waiting_period', 'agreement_sent'])));
    return {
      items: rows.map((r) => ({ ...callOut(r.c, { validatorName: names.get(r.v.userId) ?? null, prospectName: r.p.name, prospectCity: r.p.city }), prospectStage: r.p.stage })),
      candidates: prospects.map((p) => ({ ...p, calls: rows.filter((r) => r.c.prospectId === p.id).length })),
      can: { edit: await pipeline(req, orgId, 'edit') },
    };
  });

  app.post('/orgs/:orgId/validation/prospects/:id/assign', {
    schema: { tags, security: secured, params: idParams, body: z.object({ count: z.number().int().min(1).max(6).default(3), validatorIds: z.array(z.uuid()).max(6).optional(), sendLink: z.boolean().default(true) }).default({ count: 3, sendLink: true }), summary: 'Assign validators to a candidate (rotation: same region, fewest recent calls, under monthly limits) and send the scheduling link' },
  }, async (req, reply) => {
    const { orgId, id } = req.params;
    await requirePipeline(req, orgId, 'edit');
    const p = await getProspect(db, orgId, id);
    if (p.stage === 'lost' || p.stage === 'opened') throw conflict('invalid_stage', 'This candidate is not in the pipeline');
    const all = (await pool(orgId)).filter((v) => v.active);
    const existing = await db.select({ validatorId: franchiseValidationCalls.validatorId }).from(franchiseValidationCalls).where(eq(franchiseValidationCalls.prospectId, id));
    const picked = req.body.validatorIds?.length ? all.filter((v) => req.body.validatorIds!.includes(v.id) && !existing.some((e) => e.validatorId === v.id)) : pickValidators(all, { country: p.country, region: p.region }, req.body.count, existing.map((e) => e.validatorId));
    if (!picked.length) throw conflict('no_validators', 'No validator is available. Ask franchisees to opt in, or raise their monthly limits.');
    const calls = await db.insert(franchiseValidationCalls).values(picked.map((v) => ({ organizationId: orgId, prospectId: id, validatorId: v.id, createdBy: req.user!.id }))).returning();
    await addActivity(db, p, 'note', `Validation calls: ${picked.map((v) => v.name).join(', ')}`, req.user!.id, { validation: calls.map((c) => c.id) });
    const token = randomToken();
    await db.delete(franchiseValidationLinks).where(eq(franchiseValidationLinks.prospectId, id));
    await db.insert(franchiseValidationLinks).values({ organizationId: orgId, prospectId: id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * DAY) });
    const [o] = await db.select({ slug: organizations.slug, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const link = `${s.cfg.SITES_BASE_URL}/${o!.slug}/franchise/validation?token=${encodeURIComponent(token)}`;
    if (req.body.sendLink) {
      await s.jobs.enqueue('email.send', { to: p.email, subject: `${o!.name}: talk to our franchisees`, text: `Hi ${p.name.split(/\s+/)[0]},\n\nThese franchise owners have offered to tell you what owning a ${o!.name} franchise is really like. Book a time with each of them here:\n${link}\n\nThe calls are between you and them; we don't listen in.\n\n${o!.name}`, tag: 'franchise_validation' });
    }
    await networkNotify(s, { organizationId: orgId, userIds: picked.map((v) => v.userId), kind: 'validation_call', title: `Validation call with ${p.name.split(/\s+/)[0]}`, body: 'A prospective franchisee would like to hear about your experience. They will propose times.', link: '/franchise/validation' });
    await audit(db, { organizationId: orgId, actorUserId: req.user!.id, action: 'validation.assigned', targetType: 'franchise_prospect', targetId: id, metadata: { validators: picked.map((v) => v.id) }, ip: req.ip });
    return reply.code(201).send({ calls: calls.map((c) => callOut(c, { validatorName: picked.find((v) => v.id === c.validatorId)?.name ?? null })), link, devToken: s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS ? token : undefined });
  });

  app.patch('/orgs/:orgId/validation/calls/:id', {
    schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(VALIDATION_CALL_STATUSES).optional(), scheduledAt: z.iso.datetime({ offset: true }).nullable().optional(), sentiment: z.enum(VALIDATION_SENTIMENTS).nullable().optional(), outcome: z.string().max(4000).nullable().optional() }), summary: 'Schedule a call or record its outcome (pipeline edit, or the validator on their own call)' },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requireMember(req, db, orgId);
    const [c] = await db.select({ c: franchiseValidationCalls, userId: franchiseValidators.userId }).from(franchiseValidationCalls).innerJoin(franchiseValidators, eq(franchiseValidators.id, franchiseValidationCalls.validatorId))
      .where(and(eq(franchiseValidationCalls.id, id), eq(franchiseValidationCalls.organizationId, orgId)));
    if (!c) throw notFound('Call');
    if (c.userId !== req.user!.id && !(await pipeline(req, orgId, 'edit'))) throw notFound('Call');
    const b = req.body;
    if (b.status === 'completed' && !b.sentiment && !c.c.sentiment) throw validationError('Record how the call went', { sentiment: 'Required' });
    const [row] = await db.update(franchiseValidationCalls).set({
      ...(b.status ? { status: b.status } : {}), ...(b.scheduledAt !== undefined ? { scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null, ...(b.scheduledAt && !b.status && c.c.status === 'requested' ? { status: 'scheduled' } : {}) } : {}),
      ...(b.sentiment !== undefined ? { sentiment: b.sentiment } : {}), ...(b.outcome !== undefined ? { outcome: b.outcome } : {}), ...(b.status === 'completed' ? { completedAt: new Date() } : {}), updatedAt: new Date(),
    }).where(eq(franchiseValidationCalls.id, id)).returning();
    if (b.status === 'completed') {
      const p = await getProspect(db, orgId, row!.prospectId);
      await addActivity(db, p, 'call', `Validation call completed (${row!.sentiment})`, req.user!.id, { validationCallId: id });
    }
    return callOut(row!);
  });
};

/** Public scheduling page for the candidate: their validators (first name, location, intro, booking link) and calls. */
export const validationPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const tokenParams = z.object({ token: z.string().min(20).max(200) });

  async function byToken(token: string) {
    const [l] = await s.db.select().from(franchiseValidationLinks).where(eq(franchiseValidationLinks.tokenHash, sha256(token)));
    if (!l || l.expiresAt < new Date()) throw notFound('Link');
    const [p] = await s.db.select().from(franchiseProspects).where(eq(franchiseProspects.id, l.prospectId));
    const [o] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, l.organizationId));
    return { l, p: p!, brand: o! };
  }

  app.get('/public/franchise/validation/:token', { schema: { tags: ['public', 'franchise'], params: tokenParams, summary: 'Validation calls for a candidate (scheduling page)' } }, async (req) => {
    const { l, p, brand } = await byToken(req.params.token);
    if (!l.openedAt) await s.db.update(franchiseValidationLinks).set({ openedAt: new Date() }).where(eq(franchiseValidationLinks.id, l.id));
    const rows = await s.db.select({ c: franchiseValidationCalls, v: franchiseValidators, name: users.name, loc: locations.name, city: locations.address }).from(franchiseValidationCalls)
      .innerJoin(franchiseValidators, eq(franchiseValidators.id, franchiseValidationCalls.validatorId)).innerJoin(users, eq(users.id, franchiseValidators.userId)).leftJoin(locations, eq(locations.id, franchiseValidators.locationId))
      .where(and(eq(franchiseValidationCalls.prospectId, p.id), inArray(franchiseValidationCalls.status, ['requested', 'scheduled', 'completed']))).orderBy(asc(franchiseValidationCalls.createdAt));
    return {
      brand: { name: brand.name }, candidateFirstName: p.name.split(/\s+/)[0],
      calls: rows.map((r) => ({ id: r.c.id, status: r.c.status, scheduledAt: iso(r.c.scheduledAt), proposedTimes: r.c.proposedTimes, validator: { firstName: r.name.split(/\s+/)[0], location: r.loc, city: r.city?.city ?? null, bio: r.v.bio, schedulingUrl: r.v.schedulingUrl } })),
    };
  });

  app.post('/public/franchise/validation/:token/calls/:callId', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { tags: ['public', 'franchise'], params: tokenParams.extend({ callId: z.uuid() }), body: z.object({ proposedTimes: z.string().trim().min(3).max(1000) }), summary: 'The candidate proposes times for a call; the validator is notified' },
  }, async (req) => {
    const { p } = await byToken(req.params.token);
    const [c] = await s.db.select({ c: franchiseValidationCalls, userId: franchiseValidators.userId }).from(franchiseValidationCalls).innerJoin(franchiseValidators, eq(franchiseValidators.id, franchiseValidationCalls.validatorId))
      .where(and(eq(franchiseValidationCalls.id, req.params.callId), eq(franchiseValidationCalls.prospectId, p.id)));
    if (!c || !['requested', 'scheduled'].includes(c.c.status)) throw notFound('Call');
    await s.db.update(franchiseValidationCalls).set({ proposedTimes: req.body.proposedTimes, updatedAt: new Date() }).where(eq(franchiseValidationCalls.id, c.c.id));
    await networkNotify(s, { organizationId: p.organizationId, userIds: [c.userId], kind: 'validation_call', title: `${p.name.split(/\s+/)[0]} proposed times for your call`, body: req.body.proposedTimes.slice(0, 180), link: '/franchise/validation' });
    return { status: 'received' as const };
  });
};
