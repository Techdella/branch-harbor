import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { pushNotifications, pushTokens } from '../src/db/schema/index.ts';
import { loadConfig } from '../src/config.ts';
import { createPushProvider, type PushMessage, type PushProvider } from '../src/integrations/push.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;

describe('Expo push adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a logging sandbox without EXPO_ACCESS_TOKEN / ENABLE_EXPO_PUSH and never calls the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = createPushProvider(loadConfig({ NODE_ENV: 'test' }), silentLog);
    expect(p.mode).toBe('sandbox');
    const r = await p.send([{ to: 'ExponentPushToken[abc]', title: 'Hi', body: 'There' }]);
    expect(r.tickets).toEqual([{ status: 'ok', id: 'sandbox' }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts to the Expo Push API with the access token when configured', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [{ status: 'ok', id: 'tkt-1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const p = createPushProvider(loadConfig({ NODE_ENV: 'test', EXPO_ACCESS_TOKEN: 'expo-secret' }), silentLog);
    expect(p.mode).toBe('live');
    const r = await p.send([{ to: 'ExponentPushToken[abc]', title: 'Order ready', body: 'Collect at Ballard' }]);
    expect(r.tickets[0]).toEqual({ status: 'ok', id: 'tkt-1' });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer expo-secret');
    expect(JSON.parse(init.body as string)[0]).toMatchObject({ to: 'ExponentPushToken[abc]', title: 'Order ready', sound: 'default' });
    expect(createPushProvider(loadConfig({ NODE_ENV: 'test', ENABLE_EXPO_PUSH: 'true' }), silentLog).mode).toBe('live');
  });
});

describe.skipIf(!hasDb)('push notifications: triggers, preferences and sandbox logging (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string; email: string };
  let customer: { token: string; userId: string; email: string };
  let orgId: string;
  let loc: any;
  let itemId: string;
  const sent: PushMessage[] = [];
  const goneToken = `ExponentPushToken[gone-${uid()}]`;
  /** A "live" provider that records messages; one token is reported as uninstalled. */
  const fakeExpo: PushProvider = {
    mode: 'live',
    async send(messages) {
      sent.push(...messages);
      return { tickets: messages.map((m) => (m.to === goneToken ? { status: 'error' as const, message: 'not registered', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' as const, id: 'x' })) };
    },
  };
  const rows = (userId: string) => app.ctx.db.select().from(pushNotifications).where(eq(pushNotifications.userId, userId));

  beforeAll(async () => {
    app = await makeApp({ push: fakeExpo });
    owner = await verifiedUser(app, 'Owner');
    customer = await verifiedUser(app, 'Casey Customer');
    orgId = (await createOrg(app, owner.token, { industry: 'foods', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Los_Angeles' })).id;
    loc = await createLocation(app, owner.token, orgId, { name: 'Ballard', currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: '5410 22nd Ave NW', city: 'Seattle', region: 'WA', country: 'US' } });
    await enablePublicAndPayments(app, owner.token, orgId, loc.id);
    const menu = await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus`, { token: owner.token, body: { name: 'Main' } });
    itemId = (await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu.body.id}/items`, { token: owner.token, body: { category: 'Bowls', name: 'Bowl', prices: { USD: 1600 } } })).body.id;
    await call(app, 'POST', `/v1/orgs/${orgId}/foods/menus/${menu.body.id}/publish`, { token: owner.token });
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    await call(app, 'POST', `/v1/orgs/${orgId}/foods/locations/${loc.id}/pickup-slots`, { token: owner.token, body: { date: tomorrow, open: '11:00', close: '13:00', intervalMinutes: 30, capacity: 5 } });
    await call(app, 'POST', '/v1/me/push-tokens', { token: customer.token, body: { token: `ExponentPushToken[cust-${uid()}]`, platform: 'ios' } });
    await call(app, 'POST', '/v1/me/push-tokens', { token: customer.token, body: { token: goneToken, platform: 'android' } });
  });
  afterAll(async () => { await app?.close(); });

  const placePaidOrder = async () => {
    const slots = (await call(app, 'GET', `/v1/public/foods/${loc.id}/pickup-slots?from=${encodeURIComponent(new Date().toISOString())}`)).body.items;
    const o = await call(app, 'POST', `/v1/public/foods/${loc.id}/orders`, { body: { pickupSlotId: slots[0].id, lines: [{ menuItemId: itemId, quantity: 1 }], contact: { name: 'Casey Customer', email: customer.email } } });
    await call(app, 'POST', `/v1/public/payments/${o.body.payment.id}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
    return o.body.order.id as string;
  };
  const transition = (id: string, to: string) => call(app, 'POST', `/v1/orgs/${orgId}/foods/orders/${id}/transition`, { token: owner.token, body: { to } });

  it('notifies the customer when their order is accepted and ready; uninstalled devices are pruned', async () => {
    const id = await placePaidOrder();
    await transition(id, 'accepted');
    await app.ctx.jobs.drain();
    expect(sent.filter((m) => m.title.includes('accepted'))).toHaveLength(2);
    let log = await rows(customer.userId);
    expect(log[0]).toMatchObject({ category: 'order_status', status: 'sent', tokenCount: 2, organizationId: orgId });
    expect(await app.ctx.db.select().from(pushTokens).where(eq(pushTokens.token, goneToken))).toHaveLength(0);

    await transition(id, 'preparing');
    await transition(id, 'ready');
    await app.ctx.jobs.drain();
    log = await rows(customer.userId);
    expect(log.map((r) => r.title)).toEqual(expect.arrayContaining([expect.stringMatching(/is ready$/)]));
    expect(log).toHaveLength(2); // preparing is not notified
  });

  it('respects a withdrawn preference (push_updates) and logs the skip', async () => {
    expect((await call(app, 'POST', '/v1/me/consents', { token: customer.token, body: { purpose: 'push_updates', granted: false } })).status).toBe(201);
    const before = sent.length;
    const id = await placePaidOrder();
    await transition(id, 'accepted');
    await app.ctx.jobs.drain();
    expect(sent.length).toBe(before);
    const skipped = await app.ctx.db.select().from(pushNotifications).where(and(eq(pushNotifications.userId, customer.userId), eq(pushNotifications.status, 'skipped_preference')));
    expect(skipped).toHaveLength(1);
    await call(app, 'POST', '/v1/me/consents', { token: customer.token, body: { purpose: 'push_updates', granted: true } });
  });

  it('notifies approvers (not the requester) about new approval requests; users without devices are logged as skipped', async () => {
    await call(app, 'POST', '/v1/me/push-tokens', { token: owner.token, body: { token: `ExponentPushToken[own-${uid()}]`, platform: 'ios' } });
    const mgr = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: loc.id });
    await call(app, 'POST', '/v1/me/push-tokens', { token: mgr.token, body: { token: `ExponentPushToken[mgr-${uid()}]`, platform: 'ios' } });
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/ad-spend-requests`, { token: mgr.token, body: { locationId: loc.id, amountMinor: 30000, currency: 'USD', channel: 'google_ads', durationDays: 7, title: 'Lunch rush' } });
    expect(r.status).toBe(201);
    await app.ctx.jobs.drain();
    const ownerLog = await rows(owner.userId);
    expect(ownerLog.find((x) => x.category === 'approval_request')).toMatchObject({ status: 'sent', title: 'Local ad spend needs approval', data: { approvalId: r.body.id, kind: 'ad_spend' } });
    expect((await rows(mgr.userId)).filter((x) => x.category === 'approval_request')).toHaveLength(0);
  });

  it('cover requests reach eligible staff at the location (sandbox mode logs, does not send)', async () => {
    const sandboxApp = await makeApp();
    try {
      const o = await verifiedUser(sandboxApp, 'Studio Owner');
      const sorg = (await createOrg(sandboxApp, o.token)).id;
      const sloc = await createLocation(sandboxApp, o.token, sorg);
      const instructor = await memberWithRole(sandboxApp, o.token, sorg, 'staff', { kind: 'location', id: sloc.id }, 'Ana Instructor');
      const noDevice = await memberWithRole(sandboxApp, o.token, sorg, 'staff', { kind: 'location', id: sloc.id }, 'No Device');
      await call(sandboxApp, 'POST', '/v1/me/push-tokens', { token: instructor.token, body: { token: `ExponentPushToken[ins-${uid()}]`, platform: 'android' } });
      const ct = (await call(sandboxApp, 'POST', `/v1/orgs/${sorg}/studios/class-types`, { token: o.token, body: { locationId: sloc.id, name: 'Slow Flow', durationMinutes: 60, defaultCapacity: 10 } })).body.id;
      const occ = (await call(sandboxApp, 'POST', `/v1/orgs/${sorg}/studios/occurrences`, { token: o.token, body: { locationId: sloc.id, classTypeId: ct, startsAt: new Date(Date.now() + 2 * 86400_000).toISOString() } })).body.items[0];
      expect((await call(sandboxApp, 'POST', `/v1/orgs/${sorg}/studios/occurrences/${occ.id}/cover-requests`, { token: o.token, body: { reason: 'Travel' } })).status).toBe(201);
      await sandboxApp.ctx.jobs.drain();
      const log = await sandboxApp.ctx.db.select().from(pushNotifications).where(eq(pushNotifications.category, 'cover_request'));
      const byUser = Object.fromEntries(log.map((l) => [l.userId, l.status]));
      expect(byUser[instructor.userId]).toBe('sandbox');
      expect(byUser[noDevice.userId]).toBe('skipped_no_token');
      expect(byUser[o.userId]).toBeUndefined(); // the requester is not notified
      expect(log.find((l) => l.userId === instructor.userId)!.body).toMatch(/^Slow Flow · /);
    } finally {
      await sandboxApp.close();
    }
  });
});
