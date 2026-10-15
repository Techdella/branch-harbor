import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalRole, signUpSchema, apiError } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { consentRecords, customRoles, emailVerificationTokens, locations, roleAssignments, organizations, users } from '../db/schema/index.ts';
import { loadRoleLabels, roleName } from '../services/access.ts';
import { sha256 } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, unauthorized } from '../lib/errors.ts';
import { authenticate, requireUser, signAccessToken } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { businessModeView } from '../services/businessMode.ts';
import { accessSummaryFor, withEffectiveAccess } from '../services/authz.ts';
import {
  REFRESH_COOKIE, clearRefreshCookie, createVerificationToken, findUserByEmail, hashPassword, issueTokens, revokeRefreshToken,
  rotateRefreshToken, sendVerificationEmail, serializeUser, setRefreshCookie, verifyPassword, wantsBodyToken,
} from '../services/auth.ts';
import { secured } from './_common.ts';

const signupBody = signUpSchema.extend({
  acceptTerms: z.literal(true, { error: 'You must accept the terms to create an account' }),
  termsVersion: z.string().default('2026-10'),
  marketingConsent: z.boolean().default(false),
});

const sessionResponse = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), locale: z.string(), timeZone: z.string().nullable(), emailVerified: z.boolean(), createdAt: z.string(), deletionRequestedAt: z.string().nullable() }),
  accessToken: z.string(),
  accessTokenExpiresIn: z.number(),
  refreshToken: z.string().optional().describe('Only returned when the X-BH-Client: mobile header is sent; web clients use the httpOnly cookie.'),
  devVerificationToken: z.string().optional().describe('Non-production only, when email delivery is disabled.'),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  app.post('/auth/signup', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], summary: 'Create an account (email + password)', body: signupBody, response: { 201: sessionResponse, 400: apiError, 409: apiError } },
  }, async (req, reply) => {
    const b = req.body;
    if (await findUserByEmail(s.db, b.email)) throw conflict('email_taken', 'An account with this email already exists');
    const passwordHash = await hashPassword(b.password);
    const { user, token } = await s.db.transaction(async (tx) => {
      const [user] = await tx.insert(users).values({ email: b.email.trim(), name: b.name.trim(), passwordHash, locale: b.locale }).returning();
      await tx.insert(consentRecords).values([
        { userId: user!.id, email: user!.email, purpose: 'terms', version: b.termsVersion, granted: true, source: 'signup', ip: req.ip },
        { userId: user!.id, email: user!.email, purpose: 'marketing_email', version: b.termsVersion, granted: b.marketingConsent, source: 'signup', ip: req.ip },
      ]);
      await audit(tx, { organizationId: null, actorUserId: user!.id, action: 'user.signup', targetType: 'user', targetId: user!.id, ip: req.ip });
      return { user: user!, token: await createVerificationToken(tx, user!.id) };
    });
    await sendVerificationEmail(s, user.email, user.name, token);
    const tokens = await issueTokens(s, { id: user.id, email: user.email, emailVerified: false }, req);
    setRefreshCookie(s, reply, tokens.refreshToken, tokens.refreshTokenExpiresAt);
    return reply.code(201).send({
      user: serializeUser(user),
      accessToken: tokens.accessToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      ...(wantsBodyToken(req) ? { refreshToken: tokens.refreshToken } : {}),
      ...(s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS && s.mailer.mode === 'log' ? { devVerificationToken: token } : {}),
    });
  });

  app.post('/auth/verify-email', {
    schema: { tags: ['auth'], summary: 'Confirm an email verification token', body: z.object({ token: z.string().min(10) }), response: { 200: z.object({ verified: z.literal(true), accessToken: z.string() }), 400: apiError } },
  }, async (req) => {
    const result = await s.db.transaction(async (tx) => {
      const [row] = await tx.select().from(emailVerificationTokens)
        .where(and(eq(emailVerificationTokens.tokenHash, sha256(req.body.token)), isNull(emailVerificationTokens.usedAt), gt(emailVerificationTokens.expiresAt, new Date())));
      if (!row) throw badRequest('This verification link is invalid or has expired');
      await tx.update(emailVerificationTokens).set({ usedAt: new Date() }).where(eq(emailVerificationTokens.id, row.id));
      const [u] = await tx.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, row.userId)).returning();
      await audit(tx, { organizationId: null, actorUserId: row.userId, action: 'user.email_verified', targetType: 'user', targetId: row.userId });
      return u!;
    });
    return { verified: true as const, accessToken: await signAccessToken(s.cfg, { id: result.id, email: result.email, emailVerified: true }) };
  });

  app.post('/auth/resend-verification', {
    preHandler: authenticate,
    config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
    schema: { tags: ['auth'], security: secured, summary: 'Send a new verification email', response: { 202: z.object({ sent: z.boolean(), devVerificationToken: z.string().optional() }) } },
  }, async (req, reply) => {
    const me = requireUser(req);
    const [u] = await s.db.select().from(users).where(eq(users.id, me.id));
    if (!u) throw unauthorized();
    if (u.emailVerifiedAt) return reply.code(202).send({ sent: false });
    const token = await createVerificationToken(s.db, u.id);
    await sendVerificationEmail(s, u.email, u.name, token);
    return reply.code(202).send({ sent: true, ...(s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS && s.mailer.mode === 'log' ? { devVerificationToken: token } : {}) });
  });

  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], summary: 'Sign in with email + password', body: z.object({ email: z.email(), password: z.string().min(1) }), response: { 200: sessionResponse, 401: apiError } },
  }, async (req, reply) => {
    const u = await findUserByEmail(s.db, req.body.email);
    const ok = await verifyPassword(u?.passwordHash ?? null, req.body.password);
    if (!u || !ok || u.deletedAt) throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect');
    const tokens = await issueTokens(s, { id: u.id, email: u.email, emailVerified: !!u.emailVerifiedAt }, req);
    setRefreshCookie(s, reply, tokens.refreshToken, tokens.refreshTokenExpiresAt);
    await audit(s.db, { organizationId: null, actorUserId: u.id, action: 'user.login', targetType: 'user', targetId: u.id, ip: req.ip });
    return { user: serializeUser(u), accessToken: tokens.accessToken, accessTokenExpiresIn: tokens.accessTokenExpiresIn, ...(wantsBodyToken(req) ? { refreshToken: tokens.refreshToken } : {}) };
  });

  app.post('/auth/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], summary: 'Rotate the refresh token (cookie or body) and get a new access token', body: z.object({ refreshToken: z.string().optional() }).optional(), response: { 200: sessionResponse, 401: apiError } },
  }, async (req, reply) => {
    const presented = req.body?.refreshToken ?? req.cookies[REFRESH_COOKIE];
    if (!presented) throw unauthorized('No session');
    try {
      const { user, tokens } = await rotateRefreshToken(s, presented, req);
      setRefreshCookie(s, reply, tokens.refreshToken, tokens.refreshTokenExpiresAt);
      return {
        user: serializeUser(user),
        accessToken: tokens.accessToken,
        accessTokenExpiresIn: tokens.accessTokenExpiresIn,
        ...(wantsBodyToken(req) || req.body?.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      };
    } catch (err) {
      clearRefreshCookie(s, reply);
      throw err;
    }
  });

  app.post('/auth/logout', {
    schema: { tags: ['auth'], summary: 'Revoke the current refresh token', body: z.object({ refreshToken: z.string().optional() }).optional(), response: { 204: z.null() } },
  }, async (req, reply) => {
    const presented = req.body?.refreshToken ?? req.cookies[REFRESH_COOKIE];
    if (presented) await revokeRefreshToken(s, presented);
    clearRefreshCookie(s, reply);
    return reply.code(204).send(null);
  });

  app.get('/auth/me', {
    preHandler: authenticate,
    schema: { tags: ['auth'], security: secured, summary: 'Current user with organisation memberships and role assignments' },
  }, async (req) => {
    const me = requireUser(req);
    const [u] = await s.db.select().from(users).where(eq(users.id, me.id));
    if (!u || u.deletedAt) throw unauthorized();
    const rows = await s.db
      .select({ assignment: roleAssignments, org: { id: organizations.id, name: organizations.name, slug: organizations.slug, industry: organizations.industry, model: organizations.model, settings: organizations.settings } })
      .from(roleAssignments)
      .innerJoin(organizations, eq(organizations.id, roleAssignments.organizationId))
      .where(eq(roleAssignments.userId, u.id));
    // Business mode per organisation: independent businesses have one (primary) location and no network concepts.
    const indepIds = [...new Set(rows.filter((r) => r.org.model === 'independent').map((r) => r.org.id))];
    const primary = new Map<string, string>();
    if (indepIds.length) {
      const locs = await s.db.select({ id: locations.id, organizationId: locations.organizationId }).from(locations)
        .where(and(inArray(locations.organizationId, indepIds), isNull(locations.archivedAt))).orderBy(asc(locations.createdAt));
      for (const l of locs) if (!primary.has(l.organizationId)) primary.set(l.organizationId, l.id);
    }
    const customIds = [...new Set(rows.map((r) => r.assignment.customRoleId).filter((x): x is string => !!x))];
    const custom = customIds.length ? await s.db.select({ id: customRoles.id, name: customRoles.name }).from(customRoles).where(inArray(customRoles.id, customIds)) : [];
    type MeOrg = { id: string; name: string; slug: string; industry: string; roles: Array<{ id: string; role: string; customRoleId: string | null; name: string; label: string | null; scope: { kind: string; id: string } }> } & ReturnType<typeof businessModeView>;
    const orgs = new Map<string, MeOrg>();
    const labels = new Map<string, Map<string, string>>();
    for (const r of rows) {
      const { settings, model: _model, ...base } = r.org;
      const o = orgs.get(r.org.id) ?? { ...base, ...businessModeView({ model: r.org.model, settings }, primary.get(r.org.id) ?? null), roles: [] };
      if (!labels.has(r.org.id)) labels.set(r.org.id, await loadRoleLabels(s.db, r.org.id));
      o.roles.push({ id: r.assignment.id, role: canonicalRole(r.assignment.role), customRoleId: r.assignment.customRoleId, name: roleName(r.assignment.role, custom.find((c) => c.id === r.assignment.customRoleId), labels.get(r.org.id)), label: labels.get(r.org.id)?.get(canonicalRole(r.assignment.role)) ?? null, scope: { kind: r.assignment.scopeKind, id: r.assignment.scopeId } });
      orgs.set(r.org.id, o);
    }
    // What each organisation shows this person (workspaces, settings, landing workspace) — for navigation only;
    // every endpoint still checks module + action + scope.
    const out = [];
    for (const o of orgs.values()) {
      const assignments = await withEffectiveAccess(s.db, o.id, rows.filter((r) => r.org.id === o.id && (!r.assignment.expiresAt || r.assignment.expiresAt > new Date())).map((r) => r.assignment), o.industry);
      out.push({ ...o, access: await accessSummaryFor(s.db, assignments, o.industry) });
    }
    return { user: { ...serializeUser(u), platformAdmin: u.platformRole === 'admin' }, organizations: out, demoMode: s.cfg.DEMO_MODE };
  });
};
