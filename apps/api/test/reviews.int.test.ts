import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  automations, classBookings, classOccurrences, classTypes, commsConversations, commsMessages, consentRecords, customers, marketingTasks, reviewRequests, reviewSettings, reviews,
} from '../src/db/schema/index.ts';
import type { FetchLike } from '../src/integrations/partners/http.ts';
import { emitMarketingEvent } from '../src/services/marketing.ts';
import { getLocationRatingSummary, quietHoursEnd } from '../src/services/reviews.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Marketing → Reviews end to end: request settings, requests after completed class visits (consent, frequency cap,
 * quiet hours, opt-out), the hosted review page without rating gating, private feedback in the inbox, negative-review
 * alerts, automations (review received / send review request), Google Business Profile through a Google fake (OAuth,
 * locations, review sync, replies with AI suggestion and HQ approval), sandbox connections that never invent reviews,
 * the dashboard and the league-table summary — with franchisee scope isolation.
 */

/** Google fake: OAuth token endpoint, accounts, locations, reviews and the reply endpoint. */
function googleFake() {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const reviewsPage = {
    reviews: [
      { name: 'accounts/111/locations/222/reviews/r-bad', reviewer: { displayName: 'Sam Patel' }, starRating: 'ONE', comment: 'Class was overbooked and cold.', createTime: new Date(Date.now() - 3_600_000).toISOString(), updateTime: new Date().toISOString() },
      { name: 'accounts/111/locations/222/reviews/r-good', reviewer: { displayName: 'Lee Wong' }, starRating: 'FIVE', comment: 'Lovely teachers.', createTime: new Date(Date.now() - 7_200_000).toISOString(), updateTime: new Date().toISOString(), reviewReply: { comment: 'Thanks Lee!', updateTime: new Date().toISOString() } },
    ],
    averageRating: 3, totalReviewCount: 2,
  };
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body });
    if (url === 'https://oauth2.googleapis.com/token') {
      const p = new URLSearchParams(init?.body ?? '');
      if (p.get('grant_type') === 'authorization_code') return json(200, { access_token: 'at-1', refresh_token: 'rt-google-1', expires_in: 3600, id_token: `x.${Buffer.from(JSON.stringify({ email: 'hq@brand.example' })).toString('base64url')}.y` });
      return json(200, { access_token: 'at-2', expires_in: 3600 });
    }
    if (init?.headers?.Authorization !== 'Bearer at-2') return json(401, { error: 'unauthenticated' });
    if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) return json(200, { accounts: [{ name: 'accounts/111' }] });
    if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations')) return json(200, { locations: [{ name: 'locations/222', title: 'Brand Toronto', metadata: { newReviewUri: 'https://search.google.com/local/writereview?placeid=abc' } }] });
    if (url.startsWith('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews?')) return json(200, reviewsPage);
    if (url.endsWith('/reply') && init?.method === 'PUT') return json(200, { comment: JSON.parse(init.body ?? '{}').comment });
    return json(404, { error: 'not found' });
  };
  return { fetch, calls };
}

describe.skipIf(!hasDb)('reviews (DB)', () => {
  let app: FastifyInstance;
  const google = googleFake();
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let cmo: Awaited<ReturnType<typeof verifiedUser>>;
  let lm: Awaited<ReturnType<typeof verifiedUser>>;
  let fo2: Awaited<ReturnType<typeof verifiedUser>>;
  let staff: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let orgSlug: string;
  let tor: { id: string; slug: string };
  let van: { id: string; slug: string };
  let classTypeId: string;
  const base = () => `/v1/orgs/${orgId}/reviews`;
  const aiCalls: string[] = [];

  const customer = async (name: string, opts: { email?: string | null; phone?: string | null; consent?: Array<'marketing_email' | 'marketing_sms'>; locationId?: string } = {}) => {
    const [c] = await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: opts.locationId ?? tor.id, name, email: opts.email === undefined ? `${name.split(' ')[0]!.toLowerCase()}-${uid()}@example.com` : opts.email, phone: opts.phone ?? null }).returning();
    for (const purpose of opts.consent ?? []) await app.ctx.db.insert(consentRecords).values({ organizationId: orgId, customerId: c!.id, purpose, version: 'v1', granted: true, source: 'test' });
    return c!;
  };
  const attendedClass = async (customerIds: string[], endedMinutesAgo: number, locationId = tor.id) => {
    const ends = new Date(Date.now() - endedMinutesAgo * 60_000);
    const [occ] = await app.ctx.db.insert(classOccurrences).values({ organizationId: orgId, locationId, classTypeId, startsAt: new Date(ends.getTime() - 3_600_000), endsAt: ends, capacity: 20, currency: 'CAD' }).returning();
    for (const id of customerIds) await app.ctx.db.insert(classBookings).values({ organizationId: orgId, locationId, occurrenceId: occ!.id, customerId: id, status: 'attended', checkedInAt: ends });
    return occ!;
  };
  const outboxTo = (email: string) => app.ctx.mailer.outbox.filter((m) => m.to === email);
  const tokenFrom = (text: string) => /review\?t=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;

  beforeAll(async () => {
    app = await makeApp({ partnerFetch: google.fetch }, { GOOGLE_OAUTH_CLIENT_ID: 'gid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret', SITES_BASE_URL: 'https://sites.test' });
    app.ctx.ai = { enabled: true, model: 'fake-model', createMessage: async (input) => { aiCalls.push(JSON.stringify(input.messages)); return { content: [{ type: 'text', text: 'Thank you for telling us, Sam. We are sorry the class felt crowded and cold; please contact the studio so we can make it right.' }] } as never; } };
    owner = await verifiedUser(app, 'Brand Owner');
    const org = await createOrg(app, owner.token, { name: `Glow Yoga ${uid()}` });
    orgId = org.id;
    orgSlug = org.slug;
    const g1 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'North Group' } })).body.id;
    const g2 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'West Group' } })).body.id;
    const t = await createLocation(app, owner.token, orgId, { name: 'Toronto Queen', ownerGroupId: g1 });
    const v = await createLocation(app, owner.token, orgId, { name: 'Vancouver Main', ownerGroupId: g2, timeZone: 'America/Vancouver', address: { line1: '1 Main', city: 'Vancouver', country: 'CA' } });
    tor = { id: t.id, slug: t.slug };
    van = { id: v.id, slug: v.slug };
    cmo = await memberWithRole(app, owner.token, orgId, 'cmo', { kind: 'organization', id: orgId }, 'HQ Marketing');
    lm = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: tor.id }, 'Toronto Manager');
    fo2 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g2 }, 'West Owner');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: tor.id }, 'Front Desk');
    const [ct] = await app.ctx.db.insert(classTypes).values({ organizationId: orgId, name: 'Hot Flow', durationMinutes: 60, defaultCapacity: 20 }).returning();
    classTypeId = ct!.id;
  });
  afterAll(async () => { await app?.close(); });

  it('gates the module and the settings by access', async () => {
    expect((await call(app, 'GET', base(), { token: staff.token })).body.error.code).toBe('module_not_available');
    const hqSettings = { enabled: true, sources: ['class_visit'], delayMinutes: 60, channel: 'email', frequencyCapDays: 90, links: [{ kind: 'facebook', label: 'Facebook', url: 'https://facebook.com/glow/reviews' }], replyApproval: 'negative' };
    expect((await call(app, 'PUT', `${base()}/settings`, { token: lm.token, body: { locationId: null, settings: hqSettings } })).status).toBe(403);
    expect((await call(app, 'PUT', `${base()}/settings`, { token: lm.token, body: { locationId: tor.id, settings: { delayMinutes: 30 } } })).status).toBe(403);
    const put = await call(app, 'PUT', `${base()}/settings`, { token: cmo.token, body: { locationId: null, settings: hqSettings } });
    expect(put.status).toBe(200);
    expect(put.body.effective).toMatchObject({ enabled: true, delayMinutes: 60, consentMode: 'marketing', replyApproval: 'negative' });
    // The West franchise owner configures their own location (publish in their scope) but cannot touch HQ policy.
    const west = await call(app, 'PUT', `${base()}/settings`, { token: fo2.token, body: { locationId: van.id, settings: { channel: 'sms', quietHours: { start: '00:00', end: '23:59' }, replyApproval: 'none' } } });
    expect(west.status).toBe(200);
    expect(west.body.effective).toMatchObject({ channel: 'sms', replyApproval: 'negative', delayMinutes: 60 });
    expect((await call(app, 'GET', `${base()}/settings?locationId=${tor.id}`, { token: fo2.token })).status).toBe(403);
  });

  it('sends one request per completed class after the delay, with consent and the frequency cap', async () => {
    // Requests were switched on yesterday (classes that ended before that never get one).
    await app.ctx.db.update(reviewSettings).set({ enabledAt: new Date(Date.now() - 86_400_000) }).where(eq(reviewSettings.organizationId, orgId));
    const ana = await customer('Ana Lopez', { consent: ['marketing_email'] });
    const ben = await customer('Ben Shah');
    await attendedClass([ana.id, ben.id], 90);
    await attendedClass([ana.id], 10); // still inside the 60-minute delay
    const run = await call(app, 'POST', `${base()}/requests/run`, { token: cmo.token });
    expect(run.status).toBe(200);
    expect(run.body.queued).toBe(3);
    expect(run.body.sent).toMatchObject({ sandboxed: 1, skipped: 1 });
    const mail = outboxTo(ana.email!);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe('How was your visit to Toronto Queen?');
    expect(mail[0]!.text).toContain(`https://sites.test/${orgSlug}/${tor.slug}/review?t=`);
    expect(outboxTo(ben.email!)).toHaveLength(0);
    const reqs = (await call(app, 'GET', `${base()}/requests`, { token: lm.token })).body.items;
    expect(reqs.find((r: any) => r.customerId === ben.id).skipReason).toBe('no_consent');
    // Idempotent: running again creates nothing new.
    expect((await call(app, 'POST', `${base()}/requests/run`, { token: cmo.token })).body.queued).toBe(0);
    // Later, the second class ends: Ana was asked recently, so the 90-day cap skips it.
    const [second] = await app.ctx.db.select().from(reviewRequests).where(and(eq(reviewRequests.customerId, ana.id), eq(reviewRequests.status, 'scheduled')));
    await app.ctx.db.update(reviewRequests).set({ sendAt: new Date() }).where(eq(reviewRequests.id, second!.id));
    await call(app, 'POST', `${base()}/requests/run`, { token: cmo.token });
    expect((await app.ctx.db.select().from(reviewRequests).where(eq(reviewRequests.id, second!.id)))[0]!.skipReason).toBe('frequency_cap');
    // Franchisees only see their own locations' requests.
    expect((await call(app, 'GET', `${base()}/requests`, { token: fo2.token })).body.items).toHaveLength(0);
  });

  it('defers texts in quiet hours and honours opt-outs from the review page', async () => {
    const cleo = await customer('Cleo Martin', { phone: '+16045550111', consent: ['marketing_sms'], locationId: van.id });
    const sent = await call(app, 'POST', `${base()}/requests`, { token: fo2.token, body: { locationId: van.id, customerId: cleo.id } });
    expect(sent.status).toBe(201);
    expect(sent.body.outcome).toEqual({ status: 'deferred', reason: 'quiet_hours' });
    expect(sent.body.request.channel).toBe('sms');
    expect(quietHoursEnd(new Date('2026-10-15T12:00:00Z'), 'UTC', { start: '21:00', end: '09:00' })).toBeNull();
    expect(quietHoursEnd(new Date('2026-10-15T22:00:00Z'), 'UTC', { start: '21:00', end: '09:00' })!.toISOString()).toBe('2026-10-16T09:00:00.000Z');
    // The location manager cannot send for another location.
    expect((await call(app, 'POST', `${base()}/requests`, { token: lm.token, body: { locationId: van.id, customerId: cleo.id } })).status).toBe(403);

    const dee = await customer('Dee Okafor', { consent: ['marketing_email'] });
    const r = await call(app, 'POST', `${base()}/requests`, { token: lm.token, body: { locationId: tor.id, customerId: dee.id } });
    expect(r.body.outcome.status).toBe('sandboxed');
    const token = tokenFrom(outboxTo(dee.email!)[0]!.text)!;
    expect((await call(app, 'POST', `/v1/public/reviews/${orgSlug}/${tor.slug}/opt-out`, { body: { t: token } })).status).toBe(200);
    const again = await call(app, 'POST', `${base()}/requests`, { token: owner.token, body: { locationId: tor.id, customerId: dee.id } });
    expect(again.body.outcome).toEqual({ status: 'skipped', reason: 'opted_out' });
  });

  it('offers the public review links to every rating and sends private feedback to the inbox', async () => {
    await call(app, 'PUT', `${base()}/settings`, { token: cmo.token, body: { locationId: null, settings: { frequencyCapDays: 1 } } });
    const eve = await customer('Eve Grant', { consent: ['marketing_email'] });
    const fay = await customer('Fay Adams', { consent: ['marketing_email'] });
    const tokens: string[] = [];
    for (const c of [eve, fay]) {
      await call(app, 'POST', `${base()}/requests`, { token: lm.token, body: { locationId: tor.id, customerId: c.id } });
      tokens.push(tokenFrom(outboxTo(c.email!)[0]!.text)!);
    }
    const page = await call(app, 'GET', `/v1/public/reviews/${orgSlug}/${tor.slug}?t=${tokens[0]}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ location: { name: 'Toronto Queen' }, firstName: 'Eve', submitted: null });
    expect((await call(app, 'GET', `/v1/public/reviews/${orgSlug}/${van.slug}?t=${tokens[0]}`)).status).toBe(404);
    expect((await call(app, 'GET', `/v1/public/reviews/${orgSlug}/${tor.slug}?t=${'x'.repeat(32)}`)).status).toBe(404);

    const low = await call(app, 'POST', `/v1/public/reviews/${orgSlug}/${tor.slug}`, { body: { t: tokens[0], rating: 2, comment: 'Showers were cold.' } });
    const high = await call(app, 'POST', `/v1/public/reviews/${orgSlug}/${tor.slug}`, { body: { t: tokens[1], rating: 5, comment: 'Wonderful.' } });
    expect(low.status).toBe(201);
    expect(high.status).toBe(201);
    // No review gating: a 2★ customer is offered exactly the same public links as a 5★ customer.
    expect(low.body.links).toEqual(high.body.links);
    expect(low.body.links.map((l: any) => l.kind)).toEqual(['facebook']);
    expect((await call(app, 'POST', `/v1/public/reviews/${orgSlug}/${tor.slug}`, { body: { t: tokens[0], rating: 5 } })).body.error.code).toBe('already_reviewed');

    const [rv] = await app.ctx.db.select().from(reviews).where(eq(reviews.customerId, eve.id));
    expect(rv).toMatchObject({ source: 'branchharbor', rating: 2, locationId: tor.id });
    const [conv] = await app.ctx.db.select().from(commsConversations).where(eq(commsConversations.id, rv!.conversationId!));
    expect(conv).toMatchObject({ locationId: tor.id, channel: 'email', handle: eve.email, status: 'open' });
    const [msg] = await app.ctx.db.select().from(commsMessages).where(eq(commsMessages.conversationId, conv!.id));
    expect(msg!.body).toContain('★★☆☆☆');
    expect(msg!.body).toContain('Showers were cold.');
    // Negative (≤ 2★): the location manager and HQ marketing are alerted.
    expect(outboxTo(lm.email).some((m) => m.subject.startsWith('2★ review at Toronto Queen'))).toBe(true);
    expect(outboxTo(cmo.email).some((m) => m.subject.startsWith('2★ review at Toronto Queen'))).toBe(true);
    expect(outboxTo(fo2.email).some((m) => m.subject.includes('review at'))).toBe(false);
    expect((await call(app, 'POST', `/v1/public/reviews/${orgSlug}/${tor.slug}/link`, { body: { t: tokens[0], kind: 'facebook' } })).status).toBe(200);
  });

  it('runs automations on review received (rating condition) and the send review request action', async () => {
    const graph = (action: Record<string, unknown>, trigger: string, cond?: Record<string, unknown>) => ({
      nodes: [{ id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: { event: trigger } }, ...(cond ? [{ id: 'c', type: 'condition', position: { x: 0, y: 100 }, config: cond }] : []), { id: 'a', type: 'action', position: { x: 0, y: 200 }, config: action }],
      edges: cond ? [{ id: 'e1', source: 't', target: 'c' }, { id: 'e2', source: 'c', target: 'a', sourceHandle: 'yes' }] : [{ id: 'e1', source: 't', target: 'a' }],
    });
    await app.ctx.db.insert(automations).values([
      { organizationId: orgId, scopeId: orgId, name: 'Low rating follow-up', status: 'active', triggerEvent: 'review.received', activatedAt: new Date(), graph: graph({ action: 'create_task', title: 'Call back about a low rating', dueInDays: 1 }, 'review.received', { kind: 'field', field: 'event.rating', op: 'lt', value: '3' }) as never },
      { organizationId: orgId, scopeId: orgId, name: 'Ask after booking', status: 'active', triggerEvent: 'booking.created', activatedAt: new Date(), graph: graph({ action: 'send_review_request', channel: 'default' }, 'booking.created') as never },
    ]);
    const gus = await customer('Gus Hill', { consent: ['marketing_email'] });
    const hal = await customer('Hal Ito', { consent: ['marketing_email'] });
    for (const c of [gus, hal]) await call(app, 'POST', `${base()}/requests`, { token: lm.token, body: { locationId: tor.id, customerId: c.id } });
    await call(app, 'POST', `/v1/public/reviews/${orgSlug}/${tor.slug}`, { body: { t: tokenFrom(outboxTo(gus.email!)[0]!.text), rating: 1 } });
    await call(app, 'POST', `/v1/public/reviews/${orgSlug}/${tor.slug}`, { body: { t: tokenFrom(outboxTo(hal.email!)[0]!.text), rating: 4 } });
    await app.ctx.jobs.drain();
    const tasks = await app.ctx.db.select().from(marketingTasks).where(eq(marketingTasks.organizationId, orgId));
    expect(tasks.map((x) => x.customerId)).toEqual([gus.id]);

    const ivy = await customer('Ivy Moss', { consent: ['marketing_email'] });
    await emitMarketingEvent(app.ctx, { organizationId: orgId, type: 'booking.created', key: `booking:${uid()}`, customerId: ivy.id, locationId: tor.id });
    await app.ctx.jobs.drain();
    const [req] = await app.ctx.db.select().from(reviewRequests).where(eq(reviewRequests.customerId, ivy.id));
    expect(req).toMatchObject({ source: 'automation', status: 'sandboxed', channel: 'email' });
  });

  it('connects Google Business Profile, syncs reviews, and replies with AI suggestion and HQ approval', async () => {
    expect((await call(app, 'GET', `${base()}/connections/google/start?ownerKind=hq`, { token: lm.token })).status).toBe(403);
    const start = await call(app, 'GET', `${base()}/connections/google/start?ownerKind=hq`, { token: cmo.token });
    expect(start.body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(start.body.url).toContain(encodeURIComponent('https://www.googleapis.com/auth/business.manage'));
    const state = new URL(start.body.url).searchParams.get('state')!;
    const cb = await call(app, 'GET', `/v1/oauth/reviews/google/callback?code=code-1&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain('google=connected');
    const conns = await call(app, 'GET', `${base()}/connections`, { token: cmo.token });
    const live = conns.body.items.find((c: any) => c.mode === 'live');
    expect(live).toMatchObject({ ownerKind: 'hq', accountEmail: 'hq@brand.example', status: 'connected' });
    expect(JSON.stringify(conns.body)).not.toContain('rt-google-1');
    const glocs = await call(app, 'GET', `${base()}/connections/${live.id}/google-locations`, { token: cmo.token });
    expect(glocs.body.items).toEqual([{ accountName: 'accounts/111', name: 'locations/222', title: 'Brand Toronto', reviewUrl: 'https://search.google.com/local/writereview?placeid=abc' }]);
    const link = await call(app, 'POST', `${base()}/connections/${live.id}/listings`, { token: cmo.token, body: { locationId: tor.id, externalLocationName: 'locations/222', accountName: 'accounts/111', title: 'Brand Toronto', reviewUrl: 'https://search.google.com/local/writereview?placeid=abc' } });
    expect(link.status).toBe(201);
    const sync = await call(app, 'POST', `${base()}/listings/${link.body.id}/sync`, { token: lm.token });
    expect(sync.body).toMatchObject({ fetched: 2, created: 2, sandbox: false });
    expect((await call(app, 'POST', `${base()}/listings/${link.body.id}/sync`, { token: lm.token })).body.created).toBe(0);
    const list = await call(app, 'GET', `${base()}?source=google`, { token: lm.token });
    const bad = list.body.items.find((r: any) => r.rating === 1);
    const good = list.body.items.find((r: any) => r.rating === 5);
    expect(good.reply).toMatchObject({ status: 'published', external: true, text: 'Thanks Lee!' });
    expect(outboxTo(lm.email).some((m) => m.subject.startsWith('1★ review at Toronto Queen'))).toBe(true);
    // The Google review link now shows on the hosted page too (first), with the configured links.
    expect((await call(app, 'GET', `${base()}?source=google`, { token: fo2.token })).body.items).toHaveLength(0);

    const sug = await call(app, 'POST', `${base()}/${bad.id}/suggest-reply`, { token: lm.token, body: {} });
    expect(sug.status).toBe(200);
    expect(sug.body.suggestion).toContain('sorry');
    expect(aiCalls[0]).toContain('untrustedReview');
    // HQ policy: replies to negative reviews by location staff wait for HQ approval.
    const sub = await call(app, 'PUT', `${base()}/${bad.id}/reply`, { token: lm.token, body: { text: sug.body.suggestion, aiSuggested: true } });
    expect(sub.body.reply).toMatchObject({ status: 'pending_approval', aiSuggested: true });
    expect(google.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect((await call(app, 'POST', `${base()}/${bad.id}/reply/decision`, { token: lm.token, body: { decision: 'approve' } })).status).toBe(403);
    const ok = await call(app, 'POST', `${base()}/${bad.id}/reply/decision`, { token: cmo.token, body: { decision: 'approve' } });
    expect(ok.body.reply).toMatchObject({ status: 'published', decidedBy: { name: 'HQ Marketing' } });
    const put = google.calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews/r-bad/reply');
    expect(JSON.parse(put.body!).comment).toBe(sug.body.suggestion);
    // Private feedback is answered from the inbox, not as a public reply.
    const priv = (await call(app, 'GET', `${base()}?source=branchharbor`, { token: lm.token })).body.items[0];
    expect((await call(app, 'PUT', `${base()}/${priv.id}/reply`, { token: lm.token, body: { text: 'Thanks' } })).body.error.code).toBe('reply_in_inbox');
    // AI unavailable: a clear 503, nothing else breaks.
    const ai = app.ctx.ai;
    app.ctx.ai = { ...ai, enabled: false };
    expect((await call(app, 'POST', `${base()}/${bad.id}/suggest-reply`, { token: lm.token, body: {} })).body.error.code).toBe('ai_unavailable');
    app.ctx.ai = ai;
  });

  it('keeps sandbox connections honest: nothing fetched, nothing invented', async () => {
    const c = await call(app, 'POST', `${base()}/connections/sandbox`, { token: fo2.token, body: { ownerKind: 'location', locationId: van.id } });
    expect(c.status).toBe(201);
    const l = await call(app, 'POST', `${base()}/connections/${c.body.id}/listings`, { token: fo2.token, body: { locationId: van.id, externalLocationName: 'locations/999' } });
    expect(l.status).toBe(201);
    const before = await app.ctx.db.select().from(reviews).where(eq(reviews.locationId, van.id));
    expect((await call(app, 'POST', `${base()}/listings/${l.body.id}/sync`, { token: fo2.token })).body).toMatchObject({ fetched: 0, created: 0, sandbox: true });
    expect(await app.ctx.db.select().from(reviews).where(eq(reviews.locationId, van.id))).toHaveLength(before.length);
    expect((await call(app, 'POST', `${base()}/connections/${c.body.id}/listings`, { token: fo2.token, body: { locationId: tor.id, externalLocationName: 'locations/998' } })).status).toBe(403);
  });

  it('reports ratings per location and network-wide, scoped, plus the league-table summary', async () => {
    const hq = await call(app, 'GET', `${base()}/dashboard?bucket=month`, { token: cmo.token });
    expect(hq.status).toBe(200);
    const torRow = hq.body.byLocation.find((x: any) => x.locationId === tor.id);
    expect(torRow.reviews).toBe(6);
    expect(torRow.distribution).toEqual([2, 1, 0, 1, 2]);
    expect(torRow.averageRating).toBe(3);
    expect(hq.body.totals.reviews).toBe(6);
    expect(hq.body.requests.completed).toBe(4);
    expect(hq.body.series.length).toBeGreaterThan(0);
    // Google: 2 of 2 answered; private feedback: none answered in the inbox yet.
    expect(torRow.responseRate).toBeCloseTo(2 / 6, 3);
    const west = await call(app, 'GET', `${base()}/dashboard`, { token: fo2.token });
    expect(west.body.byLocation.map((x: any) => x.locationId)).toEqual([van.id]);
    expect(west.body.totals.reviews).toBe(0);
    expect((await call(app, 'GET', `${base()}/dashboard?locationId=${tor.id}`, { token: fo2.token })).status).toBe(404);
    const summary = await getLocationRatingSummary(app.ctx.db, orgId, [tor.id, van.id], { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) });
    expect(summary).toEqual([
      expect.objectContaining({ locationId: tor.id, reviews: 6, averageRating: 3, publicReviews: 2 }),
      { locationId: van.id, reviews: 0, averageRating: null, distribution: [0, 0, 0, 0, 0], publicReviews: 0, responseRate: null, avgResponseHours: null },
    ]);
  });
});
