import { inject } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { Services } from '../src/context.ts';

export const dbUrl = inject('dbUrl');
export const hasDb = !!dbUrl;
export const WEBHOOK_SECRET = 'whsec_test_secret_for_branchharbor';

export async function makeApp(overrides: Partial<Services> = {}, env: Record<string, string> = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    config: {
      NODE_ENV: 'test', DATABASE_URL: dbUrl ?? 'postgres://invalid', LOG_LEVEL: 'silent', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      REQUIRE_EMAIL_VERIFICATION: 'true', DOMAINS_SANDBOX_AUTO_VERIFY: 'false', BOOKING_HOLD_MINUTES: '10',
      ANTHROPIC_API_KEY: '', STRIPE_SECRET_KEY: '', REDIS_URL: '', POSTMARK_SERVER_TOKEN: '', RESEND_API_KEY: '', CLOUDFLARE_API_TOKEN: '', ...env,
    },
    overrides,
    logger: process.env.TEST_LOG ? { level: 'error' } : false,
  });
  await app.ready();
  return app;
}

export const uid = () => Math.random().toString(36).slice(2, 10);

type Json = Record<string, any>;
export async function call(app: FastifyInstance, method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
    ...(opts.body !== undefined ? { payload: opts.body as Json } : {}),
  });
  let json: Json = {};
  try { json = res.json(); } catch { /* empty */ }
  return { status: res.statusCode, body: json, headers: res.headers, raw: res };
}

/** Sign up and verify a user; returns an access token with emailVerified=true. */
export async function verifiedUser(app: FastifyInstance, name = 'Test User') {
  const email = `user-${uid()}@example.com`;
  const password = 'correct horse battery staple';
  const su = await call(app, 'POST', '/v1/auth/signup', { body: { name, email, password, acceptTerms: true } });
  if (su.status !== 201) throw new Error(`signup failed ${su.status} ${JSON.stringify(su.body)}`);
  const v = await call(app, 'POST', '/v1/auth/verify-email', { body: { token: su.body.devVerificationToken } });
  if (v.status !== 200) throw new Error(`verify failed ${JSON.stringify(v.body)}`);
  return { token: v.body.accessToken as string, userId: su.body.user.id as string, email, password };
}

export async function createOrg(app: FastifyInstance, token: string, over: Json = {}) {
  const r = await call(app, 'POST', '/v1/orgs', {
    token,
    body: { name: `Org ${uid()}`, industry: 'studios', model: 'network', country: 'CA', defaultCurrency: 'CAD', defaultTimeZone: 'America/Toronto', defaultLocale: 'en', dataRegion: 'us', ...over },
  });
  if (r.status !== 201) throw new Error(`org failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

export async function createLocation(app: FastifyInstance, token: string, orgId: string, over: Json = {}) {
  const r = await call(app, 'POST', `/v1/orgs/${orgId}/locations`, {
    token,
    body: {
      name: `Loc ${uid()}`, code: `L${uid()}`.slice(0, 10).toUpperCase(),
      address: { line1: '1 Main St', city: 'Toronto', region: 'ON', postalCode: 'M5V 1A1', country: 'CA' },
      timeZone: 'America/Toronto', currency: 'CAD', status: 'operating', ...over,
    },
  });
  if (r.status !== 201) throw new Error(`location failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Json;
}

/** Make a location customer-visible and enable (sandbox) payments. */
export async function enablePublicAndPayments(app: FastifyInstance, token: string, orgId: string, locationId: string) {
  await call(app, 'PATCH', `/v1/orgs/${orgId}/locations/${locationId}`, { token, body: { publiclyVisible: true, status: 'operating' } });
  const r = await call(app, 'POST', `/v1/orgs/${orgId}/payments/connect/onboarding`, { token, body: { locationId } });
  if (r.status !== 200) throw new Error(`onboarding failed ${JSON.stringify(r.body)}`);
}

/** Create a verified user and give them `role` in `scope` via a real invitation. */
export async function memberWithRole(app: FastifyInstance, ownerToken: string, orgId: string, role: string, scope: { kind: string; id: string }, name = `Member ${uid()}`) {
  const u = await verifiedUser(app, name);
  const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token: ownerToken, body: { email: u.email, role, scope } });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const acc = await call(app, 'POST', '/v1/invitations/accept', { token: u.token, body: { token: inv.body.devInvitationToken } });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  return u;
}

/** Adds per-person grants (module actions) to a member's first role assignment, through the access API. */
export async function grantCaps(app: FastifyInstance, ownerToken: string, orgId: string, userId: string, caps: string[]) {
  const acc = await call(app, 'GET', `/v1/orgs/${orgId}/members/${userId}/access`, { token: ownerToken });
  if (acc.status !== 200) throw new Error(`access failed ${acc.status} ${JSON.stringify(acc.body)}`);
  const a = acc.body.assignments[0];
  const r = await call(app, 'PUT', `/v1/orgs/${orgId}/role-assignments/${a.id}/access`, { token: ownerToken, body: { role: a.role, customRoleId: a.customRoleId, grants: [...a.grants, ...caps], revokes: a.revokes } });
  if (r.status !== 200) throw new Error(`grant failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** ISO timestamp `minutes` from now. */
export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
