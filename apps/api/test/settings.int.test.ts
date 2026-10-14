import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { organizations, subscriptions } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('organisation policies and per-location billing (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let orgId: string;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app);
    orgId = (await createOrg(app, owner.token)).id;
  });
  afterAll(async () => { await app?.close(); });

  it('defaults to no cross-location customer sharing and AI training opt-out, persists changes and keeps other settings', async () => {
    const org = await call(app, 'GET', `/v1/orgs/${orgId}`, { token: owner.token });
    expect(org.body.policies).toEqual({ customerDataSharing: 'off', aiTrainingOptOut: true, refundApprovalThresholds: {} });
    await app.ctx.db.update(organizations).set({ settings: { site: { primaryColor: '#123456' } } }).where(eq(organizations.id, orgId));
    const p = await call(app, 'PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { customerDataSharing: 'totals_only', aiTrainingOptOut: false } });
    expect(p.body.policies).toMatchObject({ customerDataSharing: 'totals_only', aiTrainingOptOut: false });
    const [row] = await app.ctx.db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(row!.settings).toMatchObject({ site: { primaryColor: '#123456' }, customerDataSharing: 'totals_only', aiTrainingOptOut: false });
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}`, { token: owner.token, body: { customerDataSharing: 'everyone' } })).status).toBe(400);
    const loc = await createLocation(app, owner.token, orgId);
    const mgr = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: loc.id });
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}`, { token: mgr.token, body: { aiTrainingOptOut: true } })).status).toBe(403);
  });

  it('shows the per-location plan price from the subscription and which locations are billed', async () => {
    await createLocation(app, owner.token, orgId, { name: 'Draft spot', status: 'draft' });
    await app.ctx.db.update(subscriptions).set({ plan: 'network', status: 'active', pricePerLocationMinor: 7900, billedLocationCount: 1 }).where(eq(subscriptions.organizationId, orgId));
    const sub = await call(app, 'GET', `/v1/orgs/${orgId}/subscription`, { token: owner.token });
    expect(sub.body).toMatchObject({ pricePerLocation: { amount: 7900, currency: 'CAD', interval: 'month' }, estimatedTotal: { amount: 7900, currency: 'CAD' } });
    expect(sub.body.locations.find((l: any) => l.name === 'Draft spot')).toMatchObject({ billed: false, price: null });
    expect(sub.body.locations.find((l: any) => l.billed).price).toEqual({ amount: 7900, currency: 'CAD', interval: 'month' });
  });
});
