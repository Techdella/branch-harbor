import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hasDb, makeApp, uid } from './helpers.ts';
import type { Services } from '../src/context.ts';

const body = (extra: Record<string, unknown> = {}) => ({
  name: 'Ana Ruiz', email: `ana.${uid()}@example.com`, business: 'Casa Yoga', industry: 'studios', locationCount: 3, country: 'ES',
  primaryDifficulty: 'Different websites per studio', locale: 'es', ...extra,
});

const post = (app: FastifyInstance, payload: unknown, opts: { ip?: string; xff?: string } = {}) =>
  app.inject({
    method: 'POST', url: '/v1/public/demo-requests', payload: payload as Record<string, unknown>,
    remoteAddress: opts.ip ?? '127.0.0.1', headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
  });

describe.skipIf(!hasDb)('public demo requests', () => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => { await Promise.all(apps.map((a) => a.close())); });

  it('returns the next step in the requester language', async () => {
    const app = await makeApp(); apps.push(app);
    const res = await post(app, body(), { ip: '192.0.2.10' });
    expect(res.statusCode).toBe(201);
    expect(res.json().nextStep).toMatch(/Nuestro equipo/);
  });

  it('rejects a failed bot check with a field error when Turnstile is enabled', async () => {
    const botCheck = { enabled: true, verify: async (t?: string) => t === 'good-token' } as Services['botCheck'];
    const app = await makeApp({ botCheck }); apps.push(app);
    const bad = await post(app, body({ turnstileToken: 'forged' }), { ip: '192.0.2.11' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.turnstileToken).toBeTruthy();
    const ok = await post(app, body({ turnstileToken: 'good-token' }), { ip: '192.0.2.11' });
    expect(ok.statusCode).toBe(201);
  });

  it('ignores X-Forwarded-For from untrusted peers so the rate limit cannot be bypassed', async () => {
    const app = await makeApp(); apps.push(app);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await post(app, body(), { ip: '198.51.100.20', xff: `203.0.113.${i}` });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('trusts X-Forwarded-For from a loopback proxy such as the sites app', async () => {
    const app = await makeApp(); apps.push(app);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(app, body(), { ip: '127.0.0.1', xff: `203.0.113.${50 + i}` })).statusCode);
    expect(statuses.every((s) => s === 201)).toBe(true);
  });
});
