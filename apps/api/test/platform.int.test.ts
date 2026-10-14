import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AiProvider } from '../src/integrations/ai.ts';
import { paymentReferences } from '../src/db/schema/index.ts';
import { call, createLocation, createOrg, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('websites governance and group publishing (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('respects field origins, routes protected changes to approval, and reports partial publish failures honestly', async () => {
    const owner = await verifiedUser(app);
    const org = await createOrg(app, owner.token);
    const tpl = await call(app, 'POST', `/v1/orgs/${org.id}/templates`, {
      token: owner.token,
      body: { name: 'Studio home', fields: [
        { key: 'brand_tagline', label: 'Tagline', policy: 'locked', defaultValue: 'Yoga for every body' },
        { key: 'hero_title', label: 'Hero title', policy: 'editable', defaultValue: 'Welcome' },
        { key: 'intro_offer', label: 'Intro offer', policy: 'approval', defaultValue: 'First class free' },
      ] },
    });
    const [l1, l2, l3] = [await createLocation(app, owner.token, org.id), await createLocation(app, owner.token, org.id), await createLocation(app, owner.token, org.id)];
    const s1 = await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token: owner.token, body: { locationId: l1.id, templateId: tpl.body.id } });
    await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token: owner.token, body: { locationId: l2.id, templateId: tpl.body.id } });
    // l3 has no website → its publish result must fail.
    const pageId = s1.body.pages[0].id;

    const mgr = await verifiedUser(app);
    const inv = await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: owner.token, body: { email: mgr.email, role: 'location_manager', scope: { kind: 'location', id: l1.id } } });
    await call(app, 'POST', '/v1/invitations/accept', { token: mgr.token, body: { token: inv.body.devInvitationToken } });

    const locked = await call(app, 'PATCH', `/v1/orgs/${org.id}/pages/${pageId}/fields`, { token: mgr.token, body: { fields: { brand_tagline: 'Hacked' } } });
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('fields_locked');
    const edit = await call(app, 'PATCH', `/v1/orgs/${org.id}/pages/${pageId}/fields`, { token: mgr.token, body: { fields: { hero_title: 'Welcome to Queen West', intro_offer: '2 weeks unlimited' } } });
    expect(edit.body.results).toEqual([{ key: 'hero_title', result: 'applied' }, expect.objectContaining({ key: 'intro_offer', result: 'pending_approval' })]);
    const field = (key: string) => edit.body.page.fields.find((f: any) => f.key === key);
    expect(field('hero_title')).toMatchObject({ origin: 'local', isOverridden: true, hqValue: 'Welcome' });
    expect(field('intro_offer')).toMatchObject({ value: 'First class free', pendingValue: '2 weeks unlimited' });

    // HQ changes the template default: inherited fields update, local override is kept.
    const upd = await call(app, 'PATCH', `/v1/orgs/${org.id}/templates/${tpl.body.id}`, { token: owner.token, body: { defaults: { hero_title: 'Hello', brand_tagline: 'Breathe' } } });
    expect(upd.body.affected).toEqual({ inheritedFields: 3, localOverridesKept: 1 });

    const approvalId = edit.body.results[1].approvalId;
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/approvals/${approvalId}/decision`, { token: mgr.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/approvals/${approvalId}/decision`, { token: owner.token, body: { decision: 'reject' } })).status).toBe(400);
    const ok = await call(app, 'POST', `/v1/orgs/${org.id}/approvals/${approvalId}/decision`, { token: owner.token, body: { decision: 'approve', comment: 'Looks good' } });
    expect(ok.body.status).toBe('approved');
    const page = await call(app, 'GET', `/v1/orgs/${org.id}/pages/${pageId}`, { token: mgr.token });
    expect(page.body.fields.find((f: any) => f.key === 'intro_offer').value).toBe('2 weeks unlimited');
    expect(page.body.fields.find((f: any) => f.key === 'brand_tagline').value).toBe('Breathe');

    const reset = await call(app, 'POST', `/v1/orgs/${org.id}/pages/${pageId}/fields/hero_title/reset`, { token: mgr.token });
    expect(reset.body.fields.find((f: any) => f.key === 'hero_title')).toMatchObject({ value: 'Hello', origin: 'hq' });

    const job = await call(app, 'POST', `/v1/orgs/${org.id}/publish-jobs`, { token: owner.token, body: { pageSlug: 'home', locationIds: [l1.id, l2.id, l3.id] } });
    expect(job.status).toBe(201);
    expect(job.body.status).toBe('partial');
    expect(job.body.summary).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    expect(job.body.results.find((r: any) => r.locationId === l3.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/no website/) });

    // Fix the failing location and retry only the failures.
    await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token: owner.token, body: { locationId: l3.id, templateId: tpl.body.id } });
    const retry = await call(app, 'POST', `/v1/orgs/${org.id}/publish-jobs/${job.body.id}/retry`, { token: owner.token });
    expect(retry.body.status).toBe('completed');
    expect(retry.body.results.find((r: any) => r.locationId === l3.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(retry.body.results.find((r: any) => r.locationId === l1.id).attempts).toBe(1);

    // Location manager cannot publish to locations outside their scope.
    const denied = await call(app, 'POST', `/v1/orgs/${org.id}/publish-jobs`, { token: mgr.token, body: { pageSlug: 'home', locationIds: [l1.id, l2.id] } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.deniedLocationIds).toEqual([l2.id]);
  });
});

describe.skipIf(!hasDb)('reports never combine currencies (DB)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); });
  afterAll(async () => { await app?.close(); });

  it('reports revenue per currency, null when unavailable', async () => {
    const { token } = await verifiedUser(app);
    const org = await createOrg(app, token);
    const ca = await createLocation(app, token, org.id);
    const us = await createLocation(app, token, org.id, { currency: 'USD', timeZone: 'America/Los_Angeles', address: { line1: 'x', city: 'Seattle', country: 'US' } });
    const empty = await call(app, 'GET', `/v1/orgs/${org.id}/reports/overview`, { token });
    expect(empty.body.metrics.revenue.value).toBeNull();
    expect(empty.body.metrics.revenue.unavailableReason).toMatch(/No payment account/);
    expect(empty.body.metrics.classBookings.value).toBeNull();
    expect(empty.body.metrics.leads.value).toBe(0);

    const ins = (locationId: string, amountMinor: number, currency: string, state = 'succeeded', refundedMinor = 0) => ({ organizationId: org.id, locationId, provider: 'stripe', externalId: `pi_${uid()}`, amountMinor, currency, state, refundedMinor });
    await app.ctx.db.insert(paymentReferences).values([ins(ca.id, 2800, 'CAD'), ins(ca.id, 2400, 'CAD', 'succeeded', 400), ins(us.id, 3000, 'USD'), ins(us.id, 5000, 'USD', 'failed')]);
    const r = await call(app, 'GET', `/v1/orgs/${org.id}/reports/overview`, { token });
    expect(r.body.metrics.revenue.value).toEqual([
      { currency: 'CAD', grossMinor: 5200, refundedMinor: 400, netMinor: 4800, paymentCount: 2 },
      { currency: 'USD', grossMinor: 3000, refundedMinor: 0, netMinor: 3000, paymentCount: 1 },
    ]);
    expect(r.body.metrics.combinedRevenue.value).toBeNull();
    expect(r.body.metrics.revenue.freshness.source).toMatch(/Stripe/);
    const scoped = await call(app, 'GET', `/v1/orgs/${org.id}/reports/overview?scopeKind=location&scopeId=${us.id}`, { token });
    expect(scoped.body.metrics.revenue.value.map((x: any) => x.currency)).toEqual(['USD']);
  });
});

describe.skipIf(!hasDb)('BranchHarbor AI (DB)', () => {
  it('returns 503 ai_unavailable without a key while everything else works', async () => {
    const app = await makeApp();
    const { token } = await verifiedUser(app);
    const org = await createOrg(app, token);
    const conv = await call(app, 'POST', `/v1/orgs/${org.id}/ai/conversations`, { token, body: { scope: { kind: 'organization', id: org.id } } });
    expect(conv.status).toBe(201);
    const r = await call(app, 'POST', `/v1/orgs/${org.id}/ai/conversations/${conv.body.id}/messages`, { token, body: { content: 'Hello' } });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('ai_unavailable');
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/ai/status`, { token })).body.available).toBe(false);
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/locations`, { token })).status).toBe(200);
    await app.close();
  });

  it('only reads scoped data and proposes actions that need explicit approval', async () => {
    const calls: any[] = [];
    let step = 0;
    const fake: AiProvider = {
      enabled: true,
      model: 'claude-sonnet-5-5',
      async createMessage(input) {
        calls.push(input);
        step++;
        const usage = { input_tokens: 10, output_tokens: 10 } as any;
        if (step === 1) return { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu1', name: 'list_locations', input: {} }] } as any;
        if (step === 2) return { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu2', name: 'propose_action', input: { kind: 'draft_campaign', summary: 'Draft autumn email for Queen West', payload: { name: 'Autumn intro offer', channel: 'email', subject: 'Try us', body: 'Two weeks unlimited.' } } }] } as any;
        return { id: 'm3', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'I drafted a campaign for your review.' }] } as any;
      },
    };
    const app = await makeApp({ ai: fake });
    const owner = await verifiedUser(app);
    const org = await createOrg(app, owner.token);
    const l1 = await createLocation(app, owner.token, org.id, { name: 'Queen West' });
    await createLocation(app, owner.token, org.id, { name: 'Leslieville' });
    const mgr = await verifiedUser(app);
    const inv = await call(app, 'POST', `/v1/orgs/${org.id}/invitations`, { token: owner.token, body: { email: mgr.email, role: 'location_manager', scope: { kind: 'location', id: l1.id } } });
    await call(app, 'POST', '/v1/invitations/accept', { token: mgr.token, body: { token: inv.body.devInvitationToken } });

    // A location manager cannot open an org-wide conversation.
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/ai/conversations`, { token: mgr.token, body: { scope: { kind: 'organization', id: org.id } } })).status).toBe(403);
    const conv = await call(app, 'POST', `/v1/orgs/${org.id}/ai/conversations`, { token: mgr.token, body: { scope: { kind: 'location', id: l1.id } } });
    const r = await call(app, 'POST', `/v1/orgs/${org.id}/ai/conversations/${conv.body.id}/messages`, { token: mgr.token, body: { content: 'Draft an autumn campaign' } });
    expect(r.status).toBe(200);
    expect(r.body.reply).toMatch(/drafted/);
    expect(r.body.scope.label).toBe('Location "Queen West"');
    expect(r.body.proposedActions).toHaveLength(1);
    expect(r.body.proposedActions[0].status).toBe('proposed');
    expect(calls[0].system).toMatch(/untrusted data/);
    // The tool result passed back to the model only includes the authorised location.
    const trMsg = calls[1].messages.find((m: any) => Array.isArray(m.content) && m.content[0]?.tool_use_id === 'tu1');
    const toolResult = JSON.parse(trMsg.content[0].content);
    expect(toolResult.untrustedData.items.map((i: any) => i.name)).toEqual(['Queen West']);

    const decided = await call(app, 'POST', `/v1/orgs/${org.id}/ai/proposed-actions/${r.body.proposedActions[0].id}/decision`, { token: mgr.token, body: { decision: 'approve' } });
    expect(decided.body.status).toBe('executed');
    const campaigns = await call(app, 'GET', `/v1/orgs/${org.id}/campaigns`, { token: owner.token });
    expect(campaigns.body.items[0]).toMatchObject({ name: 'Autumn intro offer', status: 'draft', scopeKind: 'location', scopeId: l1.id });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/ai/proposed-actions/${r.body.proposedActions[0].id}/decision`, { token: mgr.token, body: { decision: 'approve' } })).status).toBe(409);
    await app.close();
  });
});

describe.skipIf(!hasDb)('privacy: export, consent and account deletion (DB)', () => {
  it('exports personal data and deletes the account, revoking all sessions', async () => {
    const app = await makeApp();
    const u = await verifiedUser(app);
    expect((await call(app, 'POST', '/v1/me/consents', { token: u.token, body: { purpose: 'marketing_sms', granted: true } })).status).toBe(201);
    const consents = await call(app, 'GET', '/v1/me/consents', { token: u.token });
    expect(consents.body.current.map((c: any) => c.purpose).sort()).toEqual(['marketing_email', 'marketing_sms', 'terms']);
    const exp = await call(app, 'GET', '/v1/me/export', { token: u.token });
    expect(exp.status).toBe(200);
    expect(exp.body.user.email).toBe(u.email);
    expect(JSON.stringify(exp.body)).not.toMatch(/password_?hash|tokenHash/i);
    const login = await call(app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password }, headers: { 'x-bh-client': 'mobile' } });
    expect((await call(app, 'DELETE', '/v1/me', { token: u.token, body: { password: 'wrong', confirm: 'DELETE' } })).status).toBe(403);
    expect((await call(app, 'DELETE', '/v1/me', { token: u.token, body: { password: u.password, confirm: 'DELETE' } })).status).toBe(202);
    expect((await call(app, 'POST', '/v1/auth/refresh', { body: { refreshToken: login.body.refreshToken } })).status).toBe(401);
    expect((await call(app, 'POST', '/v1/auth/login', { body: { email: u.email, password: u.password } })).status).toBe(401);
    await app.close();
  });
});

describe.skipIf(!hasDb)('connections and mapping errors (DB)', () => {
  it('syncs in sandbox mode, surfaces mapping errors and resolves them', async () => {
    const app = await makeApp();
    const { token } = await verifiedUser(app);
    const org = await createOrg(app, token);
    const loc = await createLocation(app, token, org.id, { name: 'Queen West' });
    const c = await call(app, 'POST', `/v1/orgs/${org.id}/connections`, { token, body: { provider: 'mindbody', direction: 'import', authoritative: 'external', config: { siteId: '-99' }, credentials: { apiKey: 'secret-key' } } });
    expect(c.status).toBe(201);
    expect(c.body.hasCredentials).toBe(true);
    expect(JSON.stringify(c.body)).not.toContain('secret-key');
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/connections`, { token, body: { provider: 'meta', direction: 'export', authoritative: 'branchharbor' } })).body.error.code).toBe('connector_planned');
    const test = await call(app, 'POST', `/v1/orgs/${org.id}/connections/${c.body.id}/test`, { token });
    expect(test.body.result.sandbox).toBe(false); // credentials present → live probe attempted
    // Force sandbox state for the sync (no network in tests).
    const c2 = await call(app, 'POST', `/v1/orgs/${org.id}/connections`, { token, body: { provider: 'mindbody', direction: 'import', authoritative: 'external' } });
    const t2 = await call(app, 'POST', `/v1/orgs/${org.id}/connections/${c2.body.id}/test`, { token });
    expect(t2.body.result.sandbox).toBe(true);
    expect(t2.body.connection.state).toBe('initial_sync');
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/connections/${c2.body.id}/sync`, { token })).status).toBe(202);
    await app.ctx.jobs.drain();
    const status = await call(app, 'GET', `/v1/orgs/${org.id}/connections/${c2.body.id}/status`, { token });
    expect(status.body.connection.state).toBe('degraded');
    expect(status.body.mappings).toMatchObject({ mapped: 1, error: 1 });
    expect(status.body.connection.lastSuccessAt).toBeTruthy();
    const errs = await call(app, 'GET', `/v1/orgs/${org.id}/connections/${c2.body.id}/mappings?status=error`, { token });
    const res = await call(app, 'POST', `/v1/orgs/${org.id}/connections/${c2.body.id}/mappings/${errs.body.items[0].id}/resolve`, { token, body: { action: 'ignore' } });
    expect(res.body.remainingErrors).toBe(0);
    expect((await call(app, 'GET', `/v1/orgs/${org.id}/connections/${c2.body.id}/status`, { token })).body.connection.state).toBe('connected');
    expect(loc.id).toBeTruthy();
    await app.close();
  });
});
