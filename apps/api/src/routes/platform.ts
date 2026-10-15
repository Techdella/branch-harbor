import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { INDUSTRIES, INDUSTRY_META, ROLE_TEMPLATES, TEAM_ROLE_ORDER, canonicalRole, type Role } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { brands, customRoles, locations, organizations, ownerGroups, portfolios, regions, roleAssignments, territories, users } from '../db/schema/index.ts';
import { AppError, forbidden, notFound } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { issueTokens, serializeUser, setRefreshCookie, wantsBodyToken } from '../services/auth.ts';
import { orgParams, secured } from './_common.ts';

/**
 * BranchHarbor platform administration. Only users with `platform_role = 'admin'` (set by `pnpm db:seed` from
 * PLATFORM_ADMIN_EMAIL, never through the API) may call these. Every change is audited on the organisation.
 */
export const platformRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const requirePlatformAdmin = async (req: FastifyRequest) => {
    const me = requireUser(req);
    const [u] = await s.db.select({ role: users.platformRole }).from(users).where(eq(users.id, me.id));
    if (u?.role !== 'admin') throw forbidden('BranchHarbor platform administrators only');
  };

  app.put('/platform/orgs/:orgId/industry', {
    schema: {
      tags: ['platform'], security: secured, params: orgParams,
      body: z.object({ industry: z.enum(INDUSTRIES), reason: z.string().trim().min(5).max(500) }),
      summary: 'Change a business account’s industry (platform admins only, audited). Normal API calls cannot change it.',
    },
  }, async (req) => {
    await requirePlatformAdmin(req);
    const { orgId } = req.params;
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw notFound('Organisation');
    if (org.industry === req.body.industry) throw new AppError(409, 'industry_unchanged', `This business account is already ${INDUSTRY_META[req.body.industry].name}.`);
    const [updated] = await s.db.transaction(async (tx) => {
      const r = await tx.update(organizations).set({ industry: req.body.industry, updatedAt: new Date() }).where(eq(organizations.id, orgId)).returning();
      await audit(tx, {
        organizationId: orgId, ...actor(req), action: 'platform.org_industry_changed', scopeKind: 'organization', scopeId: orgId, targetType: 'organization', targetId: orgId,
        metadata: { from: org.industry, to: req.body.industry, reason: req.body.reason },
      });
      return r;
    });
    return { id: updated!.id, industry: updated!.industry, previousIndustry: org.industry };
  });
};

const DEMO_DOMAIN = 'demo.branchharbor.com';
const DEMO_OWNER = 'demo@branchharbor.com';
/** Demo accounts: demo@branchharbor.com and anything at (a subdomain of) demo.branchharbor.com. */
const isDemoEmail = (email: string) => /[@.]demo\.branchharbor\.com$/i.test(email) || email.toLowerCase() === DEMO_OWNER;

/**
 * Demo site only (`DEMO_MODE=true`, a database seeded with `pnpm db:seed:demo`): the demo-account picker. Returns
 * 404 everywhere else, so the production product never exposes it.
 */
export const demoRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const requireDemo = () => {
    if (!s.cfg.DEMO_MODE) throw notFound('Route');
  };

  app.get('/demo/accounts', {
    schema: { tags: ['demo'], summary: 'Demo site only: demo accounts per business and role, for the demo sign-in picker' },
  }, async () => {
    requireDemo();
    const rows = await s.db
      .select({ u: { id: users.id, name: users.name, email: users.email }, a: roleAssignments, o: { id: organizations.id, name: organizations.name, industry: organizations.industry, model: organizations.model } })
      .from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).innerJoin(organizations, eq(organizations.id, roleAssignments.organizationId))
      .where(and(or(like(sql`lower(${users.email})`, `%@${DEMO_DOMAIN}`), like(sql`lower(${users.email})`, `%.${DEMO_DOMAIN}`), eq(sql`lower(${users.email})`, DEMO_OWNER)), sql`${users.deletedAt} is null`));
    const scopeIds = [...new Set(rows.map((r) => r.a.scopeId))];
    const names = new Map<string, string>();
    if (scopeIds.length) {
      for (const t of [regions, ownerGroups, locations, territories, portfolios, brands] as const) for (const x of await s.db.select({ id: t.id, name: t.name }).from(t).where(inArray(t.id, scopeIds))) names.set(x.id, x.name);
    }
    const customIds = rows.map((r) => r.a.customRoleId).filter((x): x is string => !!x);
    const custom = customIds.length ? await s.db.select({ id: customRoles.id, name: customRoles.name }).from(customRoles).where(inArray(customRoles.id, customIds)) : [];
    const byOrg = new Map<string, { id: string; name: string; industry: string; model: string; accounts: Map<string, { email: string; name: string; roles: { role: string; roleName: string; scope: string | null }[] }> }>();
    for (const r of rows) {
      const o = byOrg.get(r.o.id) ?? { ...r.o, accounts: new Map() };
      const acc = o.accounts.get(r.u.id) ?? { email: r.u.email, name: r.u.name, roles: [] };
      acc.roles.push({
        role: canonicalRole(r.a.role),
        roleName: r.a.role === 'custom' ? (custom.find((c) => c.id === r.a.customRoleId)?.name ?? 'Custom role') : (ROLE_TEMPLATES[canonicalRole(r.a.role) as Role]?.name ?? r.a.role),
        scope: r.a.scopeKind === 'organization' ? null : (names.get(r.a.scopeId) ?? null),
      });
      o.accounts.set(r.u.id, acc);
      byOrg.set(r.o.id, o);
    }
    const rank = (role: string) => { const i = TEAM_ROLE_ORDER.indexOf(role as Role); return i < 0 ? 99 : i; };
    const orgs = [...byOrg.values()]
      .map((o) => ({ ...o, accounts: [...o.accounts.values()].sort((a, b) => Math.min(...a.roles.map((r) => rank(r.role))) - Math.min(...b.roles.map((r) => rank(r.role))) || a.name.localeCompare(b.name)) }))
      .sort((a, b) => b.accounts.length - a.accounts.length || a.name.localeCompare(b.name));
    return { demoMode: true, organizations: orgs };
  });

  app.post('/demo/login', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['demo'], summary: 'Demo site only: sign in as a demo account without a password', body: z.object({ email: z.email() }) },
  }, async (req, reply) => {
    requireDemo();
    if (!isDemoEmail(req.body.email)) throw forbidden('Only demo accounts can sign in this way');
    const [u] = await s.db.select().from(users).where(eq(sql`lower(${users.email})`, req.body.email.toLowerCase()));
    if (!u || u.deletedAt) throw notFound('Demo account');
    const tokens = await issueTokens(s, { id: u.id, email: u.email, emailVerified: !!u.emailVerifiedAt }, req);
    setRefreshCookie(s, reply, tokens.refreshToken, tokens.refreshTokenExpiresAt);
    await audit(s.db, { organizationId: null, ...actor(req), actorUserId: u.id, action: 'user.demo_login', targetType: 'user', targetId: u.id, ip: req.ip });
    return { user: serializeUser(u), accessToken: tokens.accessToken, accessTokenExpiresIn: tokens.accessTokenExpiresIn, ...(wantsBodyToken(req) ? { refreshToken: tokens.refreshToken } : {}) };
  });
};
