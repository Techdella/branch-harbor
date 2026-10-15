import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { splitBudget } from '@bh/shared';
import { locations, socialPosts } from '../src/db/schema/index.ts';
import { onMarketingFundSpend, type MarketingFundSpendEvent } from '../src/services/marketing-fund.ts';
import { publishDuePosts } from '../src/services/social.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, verifiedUser } from './helpers.ts';

describe('budget split per currency (unit)', () => {
  it('splits each currency over its locations and keeps the exact total', () => {
    const m = splitBudget([{ id: 'a', currency: 'CAD' }, { id: 'b', currency: 'CAD' }, { id: 'c', currency: 'CAD' }, { id: 'd', currency: 'GBP' }], { CAD: 1000, GBP: 777 });
    expect([m.get('a')!.budgetMinor, m.get('b')!.budgetMinor, m.get('c')!.budgetMinor]).toEqual([334, 333, 333]);
    expect(m.get('d')).toEqual({ budgetMinor: 777, currency: 'GBP' });
  });
});

describe.skipIf(!hasDb)('lead routing, social approval + handover, network and coming-soon campaigns (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let orgId: string;
  let tor: any; let van: any; let sea: any; let dub: any;
  let rep1: { token: string; userId: string }; let rep2: { token: string; userId: string };
  let trainer1: { token: string; userId: string }; let trainer2: { token: string; userId: string };
  let mgrTor: { token: string; userId: string };
  let marketer: { token: string; userId: string };

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Elena Owner');
    orgId = (await createOrg(app, owner.token)).id;
    tor = await createLocation(app, owner.token, orgId, { name: 'Toronto Annex', currency: 'CAD' });
    van = await createLocation(app, owner.token, orgId, { name: 'Vancouver Main', currency: 'CAD', address: { line1: '1 Main', city: 'Vancouver', region: 'BC', postalCode: 'V5V 3M6', country: 'CA' }, timeZone: 'America/Vancouver' });
    sea = await createLocation(app, owner.token, orgId, { name: 'Seattle Pike', currency: 'USD', address: { line1: '1 Pike', city: 'Seattle', region: 'WA', postalCode: '98101', country: 'US' }, timeZone: 'America/Los_Angeles' });
    dub = await createLocation(app, owner.token, orgId, { name: 'Dublin Portobello', currency: 'EUR', status: 'onboarding', address: { line1: '14 Richmond St', city: 'Dublin', postalCode: 'D02', country: 'IE' }, timeZone: 'Europe/Dublin' });
    rep1 = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: tor.id }, 'Rae Rep');
    rep2 = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: tor.id }, 'Ravi Rep');
    mgrTor = rep1;
    trainer1 = await memberWithRole(app, owner.token, orgId, 'instructor_trainer', { kind: 'organization', id: orgId }, 'Sofia Trainer');
    trainer2 = await memberWithRole(app, owner.token, orgId, 'instructor_trainer', { kind: 'organization', id: orgId }, 'Marcus Trainer');
    marketer = await memberWithRole(app, owner.token, orgId, 'digital_marketer', { kind: 'organization', id: orgId }, 'Priyanka Marketer');
  });
  afterAll(async () => { await app?.close(); });

  const lead = (token: string, body: Record<string, unknown>) => call(app, 'POST', `/v1/orgs/${orgId}/sales/leads`, { token, body });

  it('routing rules: first match wins — territory round robin, source to a location, dry-run test', async () => {
    const r1 = await call(app, 'POST', `/v1/orgs/${orgId}/sales/routing-rules`, { token: owner.token, body: { name: 'Downtown Toronto', conditions: { postalPrefixes: ['M5'] }, action: { type: 'users', userIds: [rep1.userId, rep2.userId] } } });
    expect(r1.status).toBe(201);
    const r2 = await call(app, 'POST', `/v1/orgs/${orgId}/sales/routing-rules`, { token: owner.token, body: { name: 'Instagram → Vancouver', conditions: { sources: ['instagram'] }, action: { type: 'location', locationId: van.id } } });
    expect(r2.body.position).toBe(1);
    // Location managers can't change routing (publish on the pipeline is HQ).
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/sales/routing-rules`, { token: rep1.token, body: { name: 'x', action: { type: 'location', locationId: tor.id } } })).status).toBe(403);

    const dry = await call(app, 'POST', `/v1/orgs/${orgId}/sales/routing-rules/test`, { token: owner.token, body: { postalCode: 'M5V 1A1' } });
    expect(dry.body).toMatchObject({ ruleName: 'Downtown Toronto', assignedUserId: rep1.userId, reason: 'rule' });
    const dry2 = await call(app, 'POST', `/v1/orgs/${orgId}/sales/routing-rules/test`, { token: owner.token, body: { postalCode: 'M5V 1A1' } });
    expect(dry2.body.assignedUserId).toBe(rep1.userId); // dry runs don't advance the round robin

    const a = await lead(owner.token, { name: 'A', email: 'a@example.com', postalCode: 'M5V 1A1', locationId: tor.id });
    const b = await lead(owner.token, { name: 'B', email: 'b@example.com', postalCode: 'm5t 2b2', locationId: tor.id });
    const c = await lead(owner.token, { name: 'C', email: 'c@example.com', postalCode: 'M5A', locationId: tor.id });
    expect([a.body.assignedUser.id, b.body.assignedUser.id, c.body.assignedUser.id]).toEqual([rep1.userId, rep2.userId, rep1.userId]);
    const ig = await lead(owner.token, { name: 'D', email: 'd@example.com', source: 'instagram', postalCode: 'M5V' });
    // First match wins: the postal rule comes before the source rule.
    expect(ig.body).toMatchObject({ routingRuleId: r1.body.id, assignedUser: { id: rep2.userId } });
    const ig2 = await lead(owner.token, { name: 'E', email: 'e@example.com', source: 'instagram', postalCode: 'V6K' });
    expect(ig2.body).toMatchObject({ locationId: van.id, assignedUser: null });
    // Scope: a Toronto manager sees Toronto leads only.
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/sales/leads`, { token: rep1.token });
    expect(list.body.items.length).toBeGreaterThan(0);
    expect(list.body.items.every((l: any) => l.locationId === tor.id)).toBe(true);
  });

  it('course leads go to instructors (least loaded) and only they and HQ see them', async () => {
    const x = await lead(owner.token, { kind: 'course', name: 'Teacher hopeful 1', email: 't1@example.com', source: 'course_campaign' });
    const y = await lead(owner.token, { kind: 'course', name: 'Teacher hopeful 2', email: 't2@example.com', source: 'course_campaign' });
    const assignees = [x.body.assignedUser.id, y.body.assignedUser.id].sort();
    expect(assignees).toEqual([trainer1.userId, trainer2.userId].sort());
    const mine = await call(app, 'GET', `/v1/orgs/${orgId}/sales/leads?kind=course&assigned=me`, { token: trainer1.token });
    expect(mine.body.items).toHaveLength(1);
    // A location manager has no course leads module.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/sales/leads?kind=course`, { token: rep1.token })).body.items).toEqual([]);
    // Instructors can't see customer leads.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/sales/leads?kind=customer`, { token: trainer1.token })).body.items).toEqual([]);
  });

  it('pipeline: convert a lead to a deal, move stages (won closes it), tasks', async () => {
    const l = await lead(owner.token, { name: 'Deal Person', email: 'deal@example.com', locationId: tor.id });
    const conv = await call(app, 'POST', `/v1/orgs/${orgId}/sales/leads/${l.body.id}/convert`, { token: mgrTor.token, body: { valueMinor: 19900 } });
    expect(conv.status).toBe(201);
    const deals = await call(app, 'GET', `/v1/orgs/${orgId}/sales/deals`, { token: mgrTor.token });
    const d = deals.body.items.find((x: any) => x.id === conv.body.dealId);
    expect(d).toMatchObject({ value: { amount: 19900, currency: 'CAD' }, stageId: deals.body.stages[0].id, customerName: 'Deal Person' });
    const won = deals.body.stages.find((st: any) => st.outcome === 'won');
    const task = await call(app, 'POST', `/v1/orgs/${orgId}/sales/deals/${d.id}/activities`, { token: mgrTor.token, body: { type: 'task', body: 'Call back about membership', dueAt: new Date(Date.now() + 86400_000).toISOString() } });
    expect(task.body).toMatchObject({ type: 'task', doneAt: null });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/sales/tasks`, { token: mgrTor.token })).body.items.some((t: any) => t.id === task.body.id)).toBe(true);
    const moved = await call(app, 'PATCH', `/v1/orgs/${orgId}/sales/deals/${d.id}`, { token: mgrTor.token, body: { stageId: won.id } });
    expect(moved.body.closedAt).toBeTruthy();
    const acts = await call(app, 'GET', `/v1/orgs/${orgId}/sales/deals/${d.id}/activities`, { token: mgrTor.token });
    expect(acts.body.items.some((a: any) => a.type === 'stage_change')).toBe(true);
    // Another location's manager can't see the deal.
    const vanMgr = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: van.id });
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}/sales/deals/${d.id}`, { token: vanMgr.token, body: { title: 'x' } })).status).toBe(403);
  });

  it('social: local post on an HQ account needs approval (standard tier); HQ approves; publishing is sandboxed', async () => {
    const acct = await call(app, 'POST', `/v1/orgs/${orgId}/social/accounts`, { token: marketer.token, body: { network: 'instagram', handle: '@northlight' } });
    expect(acct.status).toBe(201);
    // Without a handover the location can't post on it.
    const noRights = await call(app, 'POST', `/v1/orgs/${orgId}/social/posts`, { token: mgrTor.token, body: { locationId: tor.id, body: 'Hello Annex', media: [{ url: 'https://img.example.com/a.jpg' }], accountIds: [acct.body.id] } });
    expect(noRights.status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/social/accounts/${acct.body.id}/grants`, { token: mgrTor.token, body: { locationId: tor.id } })).status).toBe(403);
    const grant = await call(app, 'POST', `/v1/orgs/${orgId}/social/accounts/${acct.body.id}/grants`, { token: marketer.token, body: { locationId: tor.id, access: 'post' } });
    expect(grant.status).toBe(201);
    // Per-network validation: Instagram needs an image.
    const noImg = await call(app, 'POST', `/v1/orgs/${orgId}/social/posts`, { token: mgrTor.token, body: { locationId: tor.id, body: 'No image', accountIds: [acct.body.id] } });
    expect(noImg.status).toBe(400);
    expect(noImg.body.error.details.issues).toContain('media_required');
    const post = await call(app, 'POST', `/v1/orgs/${orgId}/social/posts`, { token: mgrTor.token, body: { locationId: tor.id, body: 'New 6am class at the Annex!', media: [{ url: 'https://img.example.com/a.jpg' }], accountIds: [acct.body.id] } });
    expect(post.status).toBe(201);
    expect(post.body).toMatchObject({ status: 'pending_approval', needsApproval: true });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/social/posts/${post.body.id}/decision`, { token: mgrTor.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/social/posts/${post.body.id}/decision`, { token: marketer.token, body: { decision: 'reject' } })).status).toBe(400);
    const ok = await call(app, 'POST', `/v1/orgs/${orgId}/social/posts/${post.body.id}/decision`, { token: marketer.token, body: { decision: 'approve' } });
    expect(ok.body.status).toBe('sandboxed'); // published in sandbox: never claimed live
    expect(ok.body.results[0]).toMatchObject({ accountId: acct.body.id, status: 'sandboxed' });
  });

  it('social: flexible tier posts to its own account without approval; scheduled posts publish when due', async () => {
    await app.ctx.db.update(locations).set({ settings: { marketingTier: 'flexible' } }).where(eq(locations.id, tor.id));
    const own = await call(app, 'POST', `/v1/orgs/${orgId}/social/accounts`, { token: owner.token, body: { network: 'facebook', handle: 'Northlight Annex', ownerKind: 'location', locationId: tor.id } });
    const when = new Date(Date.now() + 3600_000).toISOString();
    const p = await call(app, 'POST', `/v1/orgs/${orgId}/social/posts`, { token: mgrTor.token, body: { locationId: tor.id, body: 'Community class Sunday', accountIds: [own.body.id], scheduledAt: when } });
    expect(p.body).toMatchObject({ status: 'scheduled', needsApproval: false });
    await app.ctx.db.update(socialPosts).set({ scheduledAt: new Date(Date.now() - 1000) }).where(eq(socialPosts.id, p.body.id));
    expect(await publishDuePosts(app.ctx)).toBeGreaterThanOrEqual(1);
    const [row] = await app.ctx.db.select().from(socialPosts).where(eq(socialPosts.id, p.body.id));
    expect(row!.status).toBe('sandboxed');
    await app.ctx.db.update(locations).set({ settings: {} }).where(eq(locations.id, tor.id));
  });

  it('social handover revoke (termination): grants revoked, scheduled posts on HQ accounts cancelled, posting refused', async () => {
    const acct = await call(app, 'POST', `/v1/orgs/${orgId}/social/accounts`, { token: owner.token, body: { network: 'facebook', handle: 'Northlight Yoga' } });
    await call(app, 'POST', `/v1/orgs/${orgId}/social/accounts/${acct.body.id}/grants`, { token: owner.token, body: { locationId: tor.id } });
    const p = await call(app, 'POST', `/v1/orgs/${orgId}/social/posts`, { token: mgrTor.token, body: { locationId: tor.id, body: 'Summer schedule', accountIds: [acct.body.id], scheduledAt: new Date(Date.now() + 86400_000).toISOString() } });
    expect(p.body.status).toBe('pending_approval');
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/social/handover/revoke-location`, { token: owner.token, body: { locationId: tor.id, reason: 'termination' } });
    expect(r.body.grantsRevoked).toBeGreaterThanOrEqual(2);
    expect(r.body.postsCancelled).toBeGreaterThanOrEqual(1);
    const [row] = await app.ctx.db.select().from(socialPosts).where(eq(socialPosts.id, p.body.id));
    expect(row!.status).toBe('cancelled');
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/social/posts`, { token: mgrTor.token, body: { locationId: tor.id, body: 'Again', accountIds: [acct.body.id] } })).status).toBe(403);
    const accts = await call(app, 'GET', `/v1/orgs/${orgId}/social/accounts`, { token: mgrTor.token });
    expect(accts.body.items.some((a: any) => a.id === acct.body.id)).toBe(false);
  });

  it('network campaign: budget split per currency, validation of currencies, results feed the marketing fund', async () => {
    const events: MarketingFundSpendEvent[] = [];
    const off = onMarketingFundSpend((e) => void events.push(e));
    const base = { kind: 'network', name: 'Summer intro month', platforms: ['meta', 'google'], startsOn: '2026-11-01', creative: { headline: 'Intro month', body: '30 days unlimited' }, locationIds: [tor.id, van.id, sea.id] };
    const missing = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns`, { token: marketer.token, body: { ...base, budget: { mode: 'split', totals: { CAD: 100001 } } } });
    expect(missing.status).toBe(400);
    expect(missing.body.error, JSON.stringify(missing.body)).toMatchObject({ fields: { budget: expect.stringMatching(/USD/) } });
    const extra = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns`, { token: marketer.token, body: { ...base, budget: { mode: 'split', totals: { CAD: 100001, USD: 50000, GBP: 1 } } } });
    expect(extra.status).toBe(400);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns`, { token: mgrTor.token, body: { ...base, budget: { mode: 'split', totals: { CAD: 100001, USD: 50000 } } } })).status).toBe(403);
    const c = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns`, { token: marketer.token, body: { ...base, budget: { mode: 'split', totals: { CAD: 100001, USD: 50000 } } } });
    expect(c.status).toBe(201);
    const by = Object.fromEntries(c.body.locations.map((l: any) => [l.locationId, l.budget]));
    expect(by[tor.id].amount + by[van.id].amount).toBe(100001);
    expect([by[tor.id].amount, by[van.id].amount].sort()).toEqual([50000, 50001]);
    expect(by[sea.id]).toEqual({ amount: 50000, currency: 'USD' });
    expect(c.body.totals).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'CAD', budget: 100001 }), expect.objectContaining({ currency: 'USD', budget: 50000 })]));
    // Results only once launched.
    const early = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}/results`, { token: marketer.token, body: { locationId: sea.id, day: '2026-11-01', spendMinor: 1000, currency: 'USD' } });
    expect(early.body.error.code).toBe('campaign_not_running');
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}`, { token: marketer.token, body: { status: 'active' } })).body.status).toBe('active');
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}/results`, { token: marketer.token, body: { locationId: sea.id, day: '2026-11-01', spendMinor: 1000, currency: 'CAD' } })).status).toBe(400);
    const r1 = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}/results`, { token: marketer.token, body: { locationId: sea.id, day: '2026-11-01', spendMinor: 2500, currency: 'USD', impressions: 4000, clicks: 80 } });
    expect(r1.body.fundEvent).toMatchObject({ amountMinor: 2500, currency: 'USD' });
    const r2 = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}/results`, { token: marketer.token, body: { locationId: sea.id, day: '2026-11-01', spendMinor: 2000, currency: 'USD', impressions: 4000, clicks: 80 } });
    expect(r2.body.fundEvent).toMatchObject({ amountMinor: -500 });
    expect(events.map((e) => e.amountMinor)).toEqual([2500, -500]);
    const pending = await call(app, 'GET', `/v1/orgs/${orgId}/ad-campaigns/fund-events?pending=true`, { token: owner.token });
    expect(pending.body.items.reduce((a: number, e: any) => a + e.amountMinor, 0)).toBe(2000);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/fund-events/consume`, { token: owner.token, body: { ids: pending.body.items.map((e: any) => e.id) } })).body.consumed).toBe(2);
    const sync = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}/sync`, { token: marketer.token });
    expect(sync.body.platforms.every((p: any) => p.mode === 'sandbox' && p.imported === 0)).toBe(true);
    off();
  });

  it('coming-soon campaign: only locations in onboarding; public lead form attributes leads to campaign and location', async () => {
    const cs = { kind: 'coming_soon', name: 'Dublin opening', platforms: ['meta'], startsOn: '2026-11-01', creative: { headline: 'Opening soon in Portobello', body: 'Founding memberships' }, comingSoon: { openingDate: '2027-01-15', presaleOffer: 'Founding member: 3 months for €99', formFields: ['name', 'email'] }, budget: { mode: 'split', totals: { EUR: 150000 } } };
    const wrong = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns`, { token: marketer.token, body: { ...cs, locationIds: [dub.id, tor.id], budget: { mode: 'split', totals: { EUR: 150000, CAD: 1 } } } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toMatch(/onboarding/);
    const c = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns`, { token: marketer.token, body: { ...cs, locationIds: [dub.id] } });
    expect(c.status).toBe(201);
    expect(c.body.locations[0]).toMatchObject({ locationId: dub.id, budget: { amount: 150000, currency: 'EUR' } });
    expect((await call(app, 'GET', `/v1/public/ad-campaigns/${c.body.id}`)).status).toBe(404); // not live yet
    await call(app, 'PATCH', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}`, { token: marketer.token, body: { status: 'active' } });
    const pub = await call(app, 'GET', `/v1/public/ad-campaigns/${c.body.id}`);
    expect(pub.body).toMatchObject({ comingSoon: { openingDate: '2027-01-15' }, locations: [{ id: dub.id }] });
    const sub = await call(app, 'POST', `/v1/public/ad-campaigns/${c.body.id}/leads`, { body: { name: 'Aoife', email: 'aoife@example.com', marketingConsent: true } });
    expect(sub.status).toBe(201);
    const wrongLoc = await call(app, 'POST', `/v1/public/ad-campaigns/${c.body.id}/leads`, { body: { locationId: tor.id, name: 'X', email: 'x@example.com' } });
    expect(wrongLoc.status).toBe(400);
    const detail = await call(app, 'GET', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}`, { token: marketer.token });
    expect(detail.body.locations[0].leads).toBe(1);
    const leads = await call(app, 'GET', `/v1/orgs/${orgId}/sales/leads?adCampaignId=${c.body.id}`, { token: owner.token });
    expect(leads.body.items[0]).toMatchObject({ source: 'coming_soon', locationId: dub.id, adCampaignId: c.body.id });
    const [loc] = await app.ctx.db.select().from(locations).where(eq(locations.id, dub.id));
    expect(loc!.settings).toMatchObject({ openingDate: '2027-01-15' });
  });

  it('local campaign: budget request goes through the approvals inbox; approval schedules the campaign', async () => {
    const l = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/local`, { token: mgrTor.token, body: { locationId: tor.id, name: 'Annex local boost', platforms: ['meta'], budgetMinor: 30000, currency: 'CAD', startsOn: '2026-11-10', durationDays: 14, creative: { headline: 'Annex', body: 'Try a class' } } });
    // Location managers have no Ads module by default.
    expect(l.status).toBe(403);
    const fo = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'location', id: tor.id }, 'Liam Franchisee');
    const wrongCur = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/local`, { token: fo.token, body: { locationId: tor.id, name: 'Annex local boost', platforms: ['meta'], budgetMinor: 30000, currency: 'USD', startsOn: '2026-11-10', durationDays: 14, creative: { headline: 'Annex', body: 'Try a class' } } });
    expect(wrongCur.status).toBe(400);
    const c = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/local`, { token: fo.token, body: { locationId: tor.id, name: 'Annex local boost', platforms: ['meta'], budgetMinor: 30000, currency: 'CAD', startsOn: '2026-11-10', durationDays: 14, creative: { headline: 'Annex', body: 'Try a class' } } });
    expect(c.status).toBe(201);
    expect(c.body.status).toBe('pending_approval');
    const inbox = await call(app, 'GET', `/v1/orgs/${orgId}/approvals?kind=ad_spend`, { token: owner.token });
    const ap = inbox.body.items.find((a: any) => a.id === c.body.approvalId);
    expect(ap).toMatchObject({ kind: 'ad_spend', amount: { amount: 30000, currency: 'CAD' }, canDecide: true });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/approvals/${ap.id}/decision`, { token: owner.token, body: { decision: 'approve' } })).status).toBe(200);
    const after = await call(app, 'GET', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}`, { token: fo.token });
    expect(after.body.status).toBe('scheduled');
    // The franchisee sees their location's row only on network campaigns that include them.
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/ad-campaigns`, { token: fo.token });
    for (const camp of list.body.items) expect(camp.locations.every((x: any) => x.locationId === tor.id)).toBe(true);
    // Local spend is the location's own money, not the marketing fund.
    await call(app, 'PATCH', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}`, { token: owner.token, body: { status: 'active' } });
    const res = await call(app, 'POST', `/v1/orgs/${orgId}/ad-campaigns/${c.body.id}/results`, { token: fo.token, body: { locationId: tor.id, day: '2026-11-10', spendMinor: 2000, currency: 'CAD' } });
    expect(res.body.fundEvent).toBeNull();
  });
});
