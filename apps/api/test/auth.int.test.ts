import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { call, hasDb, makeApp, uid } from './helpers.ts';

describe.skipIf(!hasDb)('auth flow (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('signup → verify → login → refresh rotation → reuse detection → logout', async () => {
    const email = `auth-${uid()}@example.com`;
    const password = 'a-long-enough-password';
    const su = await call(app, 'POST', '/v1/auth/signup', { body: { name: 'Ada', email, password, acceptTerms: true }, headers: { 'x-bh-client': 'mobile' } });
    expect(su.status).toBe(201);
    expect(su.body.user.emailVerified).toBe(false);
    expect(su.body.refreshToken).toBeTruthy();
    expect(String(su.headers['set-cookie'])).toMatch(/bh_refresh=.*HttpOnly/i);

    // Unverified users cannot create an organisation.
    const blocked = await call(app, 'POST', '/v1/orgs', { token: su.body.accessToken, body: { name: 'X', industry: 'foods', model: 'independent', country: 'GB', defaultCurrency: 'GBP', defaultTimeZone: 'Europe/London', defaultLocale: 'en-GB', dataRegion: 'eu' } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_unverified');

    expect((await call(app, 'POST', '/v1/auth/signup', { body: { name: 'Ada', email: email.toUpperCase(), password, acceptTerms: true } })).status).toBe(409);
    expect((await call(app, 'POST', '/v1/auth/verify-email', { body: { token: 'bogus-token-123' } })).status).toBe(400);
    const v = await call(app, 'POST', '/v1/auth/verify-email', { body: { token: su.body.devVerificationToken } });
    expect(v.status).toBe(200);
    expect((await call(app, 'POST', '/v1/auth/verify-email', { body: { token: su.body.devVerificationToken } })).status).toBe(400);

    const bad = await call(app, 'POST', '/v1/auth/login', { body: { email, password: 'wrong-password' } });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('invalid_credentials');
    const login = await call(app, 'POST', '/v1/auth/login', { body: { email, password }, headers: { 'x-bh-client': 'mobile' } });
    expect(login.status).toBe(200);
    expect(login.body.user.emailVerified).toBe(true);

    const me = await call(app, 'GET', '/v1/auth/me', { token: login.body.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect((await call(app, 'GET', '/v1/auth/me')).status).toBe(401);

    const r1 = await call(app, 'POST', '/v1/auth/refresh', { body: { refreshToken: login.body.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    // Reusing the rotated token revokes the whole family.
    expect((await call(app, 'POST', '/v1/auth/refresh', { body: { refreshToken: login.body.refreshToken } })).status).toBe(401);
    expect((await call(app, 'POST', '/v1/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status).toBe(401);

    // Cookie-based refresh (web) and logout.
    const web = await call(app, 'POST', '/v1/auth/login', { body: { email, password } });
    expect(web.body.refreshToken).toBeUndefined();
    const cookie = String(web.headers['set-cookie']).split(';')[0]!;
    const r2 = await call(app, 'POST', '/v1/auth/refresh', { headers: { cookie } });
    expect(r2.status).toBe(200);
    const cookie2 = String(r2.headers['set-cookie']).split(';')[0]!;
    expect((await call(app, 'POST', '/v1/auth/logout', { headers: { cookie: cookie2 } })).status).toBe(204);
    expect((await call(app, 'POST', '/v1/auth/refresh', { headers: { cookie: cookie2 } })).status).toBe(401);
  });

  it('validation errors use the shared apiError shape with field messages', async () => {
    const r = await call(app, 'POST', '/v1/auth/signup', { body: { name: '', email: 'nope', password: 'short', acceptTerms: true } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_failed');
    expect(Object.keys(r.body.error.fields)).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });
});
