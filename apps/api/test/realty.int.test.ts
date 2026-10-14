import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { areaIn, findProtectedTargeting, formatAddressLines, formatArea, fromSqm, listingTransition, toSqm } from '@bh/shared';
import { realtyAiProposals, realtyAlertDeliveries, realtyEnquiries } from '../src/db/schema/index.ts';
import type { AiProvider } from '../src/integrations/ai.ts';
import { addDays, zonedToUtc } from '../src/lib/tz.ts';
import { guardFollowUps } from '../src/services/realty-ai.ts';
import { runSavedSearchAlerts, runViewingReminders } from '../src/services/realty-jobs.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '18:00' }));

describe('realty: pure rules', () => {
  it('listing transitions follow the lifecycle and close sales as sold, rentals as let', () => {
    expect(listingTransition('draft', 'active', 'sale').ok).toBe(true);
    expect(listingTransition('draft', 'sold', 'sale')).toEqual({ ok: false, reason: 'invalid_transition' });
    expect(listingTransition('under_offer', 'sold', 'sale').ok).toBe(true);
    expect(listingTransition('under_offer', 'let', 'sale')).toEqual({ ok: false, reason: 'sales_are_sold_not_let' });
    expect(listingTransition('active', 'let', 'rent').ok).toBe(true);
    expect(listingTransition('sold', 'active', 'sale').ok).toBe(false);
    expect(listingTransition('withdrawn', 'draft', 'sale').ok).toBe(true);
  });

  it('converts and displays areas in m² or sq ft without false precision', () => {
    expect(toSqm(1000, 'sqft')).toBeCloseTo(92.90304, 5);
    expect(fromSqm(92.90304, 'sqft')).toBeCloseTo(1000, 6);
    expect(areaIn(92.90304, 'sqft')).toBe(1000);
    expect(areaIn(92.90304, 'sqm')).toBe(93);
    expect(areaIn(null, 'sqm')).toBeNull();
    expect(formatArea(120, 'sqm', 'es')).toBe('120 m²');
    expect(formatArea(toSqm(1850, 'sqft'), 'sqft', 'en')).toBe('1,850 sq ft');
  });

  it('formats addresses per country and can hide the street', () => {
    expect(formatAddressLines({ line1: 'Calle de Serrano 41', city: 'Madrid', postalCode: '28001', region: 'Madrid', country: 'ES' })).toEqual(['Calle de Serrano 41', '28001 Madrid', 'Madrid']);
    expect(formatAddressLines({ line1: '12 Elm Row', city: 'London', postalCode: 'NW3 1AA', country: 'GB' })).toEqual(['12 Elm Row', 'London', 'NW3 1AA']);
    expect(formatAddressLines({ line1: '88 Harbour St', city: 'Toronto', region: 'ON', postalCode: 'M5J 0C3', country: 'CA' }, { hideStreet: true })).toEqual(['Toronto, ON']);
    expect(formatAddressLines({ line1: 'Villa 12, Street 4', city: 'Jumeirah', region: 'Dubai', country: 'AE' })).toEqual(['Villa 12, Street 4', 'Jumeirah', 'Dubai']);
  });

  it('detects protected-characteristic targeting but not property descriptions', () => {
    expect(findProtectedTargeting('Bright family room and no carpets')).toEqual([]);
    expect(findProtectedTargeting('Close to parks and the station')).toEqual([]);
    expect(findProtectedTargeting('Perfect for young professionals')[0]?.characteristic).toBe('age');
    expect(findProtectedTargeting('No kids please')[0]?.characteristic).toBe('familial_status');
    expect(findProtectedTargeting('Send it to Christians only')[0]?.characteristic).toBe('religion');
    expect(findProtectedTargeting('segment buyers by nationality')[0]?.characteristic).toBe('national_origin');
  });

  it('the follow-up tool refuses protected audience criteria, unknown records and steering text', () => {
    const known = new Set(['enquiry:e1']);
    const ok = { followUps: [{ refType: 'enquiry', refId: 'e1', channel: 'email', reason: 'Asked about price', draftMessage: 'Hi {{first_name}}, the price was updated.' }] };
    expect(guardFollowUps(ok, known).ok).toBe(true);
    expect(guardFollowUps({ ...ok, audience: { minBedrooms: 3, maxPrice: 900000_00, currency: 'CAD' } }, known).ok).toBe(true);
    expect(guardFollowUps({ ...ok, audience: { familyStatus: 'with children' } }, known)).toMatchObject({ ok: false, refusal: expect.stringContaining('protected') });
    expect(guardFollowUps({ ...ok, audience: { religion: 'any' } }, known).ok).toBe(false);
    expect(guardFollowUps({ ...ok, audience: { city: 'young families only' } }, known).ok).toBe(false);
    expect(guardFollowUps({ followUps: [{ ...ok.followUps[0], refId: 'invented' }] }, known).ok).toBe(false);
    expect(guardFollowUps({ followUps: [{ ...ok.followUps[0], draftMessage: 'Ideal for a young couple like you' }] }, known).ok).toBe(false);
  });
});

/** Scripted AI provider: returns the queued responses in order and records what it was asked. */
function scriptedAi(responses: Array<Record<string, unknown>>) {
  const calls: Array<{ system: string; messages: unknown[] }> = [];
  const ai: AiProvider = {
    enabled: true, model: 'fake-model',
    async createMessage(input) {
      calls.push({ system: input.system, messages: JSON.parse(JSON.stringify(input.messages)) });
      const r = responses.shift() ?? { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' };
      return { id: `msg_${uid()}`, type: 'message', role: 'assistant', model: 'fake-model', usage: { input_tokens: 1, output_tokens: 1 }, ...r } as never;
    },
  };
  return { ai, calls, push: (...r: Array<Record<string, unknown>>) => responses.push(...r) };
}
const toolUse = (name: string, input: unknown) => ({ content: [{ type: 'tool_use', id: `tu_${uid()}`, name, input }], stop_reason: 'tool_use' });

describe.skipIf(!hasDb)('realty: listings, approvals, routing, viewings, offers, reports, AI (DB)', () => {
  let app: FastifyInstance;
  const fake = scriptedAi([]);
  let owner: { token: string; userId: string };
  let orgId: string;
  let slug: string;
  let toronto: any, london: any, madrid: any;
  let hq: Awaited<ReturnType<typeof verifiedUser>>;
  let mgr: Awaited<ReturnType<typeof verifiedUser>>;
  let agentA: { user: Awaited<ReturnType<typeof verifiedUser>>; id: string };
  let agentB: { user: Awaited<ReturnType<typeof verifiedUser>>; id: string };
  let agentC: { user: Awaited<ReturnType<typeof verifiedUser>>; id: string };
  let agentL: { user: Awaited<ReturnType<typeof verifiedUser>>; id: string };
  const day = addDays(new Date().toISOString().slice(0, 10), 3);
  const at = (hhmm: string, tz = 'America/Toronto') => zonedToUtc(day, hhmm, tz).toISOString();

  const R = (path: string) => `/v1/orgs/${orgId}/realty${path}`;
  async function agent(locationId: string, name: string, extra: Record<string, unknown> = {}) {
    const user = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: locationId }, name);
    const r = await call(app, 'POST', R('/agents'), { token: owner.token, body: { locationId, name, userId: user.userId, email: user.email, availability: ALL_WEEK, ...extra } });
    expect(r.status).toBe(201);
    return { user, id: r.body.id as string };
  }
  async function listing(token: string, locationId: string, over: Record<string, unknown> = {}) {
    const r = await call(app, 'POST', R('/listings'), { token, body: {
      locationId, transaction: 'sale', propertyType: 'house', title: `House ${uid()}`, priceMinor: 125_000_000, bedrooms: 3, bathrooms: 2, area: { value: 1850, unit: 'sqft' },
      description: 'Three-bedroom detached house with a renovated kitchen, two bathrooms and a private garden.', photos: [{ url: 'https://images.example.com/1.jpg' }],
      address: { line1: '42 Birchmount Cres', city: 'Toronto', region: 'ON', postalCode: 'M1N 1A1' }, ...over,
    } });
    if (r.status !== 201) throw new Error(`listing failed ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  beforeAll(async () => {
    app = await makeApp({ ai: fake.ai });
    owner = await verifiedUser(app, 'Owner');
    slug = `keystone-${uid()}`;
    const org = await createOrg(app, owner.token, { name: `Keystone ${uid()}`, industry: 'realty', country: 'CA', defaultCurrency: 'CAD', defaultTimeZone: 'America/Toronto' });
    orgId = org.id;
    slug = org.slug;
    toronto = await createLocation(app, owner.token, orgId, { name: 'Toronto Midtown' });
    london = await createLocation(app, owner.token, orgId, { name: 'London Hampstead', currency: 'GBP', timeZone: 'Europe/London', address: { line1: '1 Heath St', city: 'London', postalCode: 'NW3 6TP', country: 'GB' } });
    madrid = await createLocation(app, owner.token, orgId, { name: 'Madrid Salamanca', currency: 'EUR', timeZone: 'Europe/Madrid', address: { line1: 'Calle de Serrano 41', city: 'Madrid', postalCode: '28001', country: 'ES' } });
    for (const l of [toronto, london, madrid]) await call(app, 'PATCH', `/v1/orgs/${orgId}/locations/${l.id}`, { token: owner.token, body: { publiclyVisible: true } });
    hq = await memberWithRole(app, owner.token, orgId, 'hq_admin', { kind: 'organization', id: orgId }, 'HQ Admin');
    mgr = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: toronto.id }, 'Toronto Manager');
    agentA = await agent(toronto.id, 'Nadia Hassan');
    agentB = await agent(toronto.id, 'Omar Diaz');
    agentC = await agent(toronto.id, 'Lena Fischer');
    agentL = await agent(london.id, 'Harriet Cole');
  });
  afterAll(async () => { await app?.close(); });

  it('office defaults: area unit from the country, standard tier', async () => {
    const r = await call(app, 'GET', R('/offices'), { token: owner.token });
    expect(r.status).toBe(200);
    const by = (id: string) => r.body.items.find((o: any) => o.locationId === id);
    expect(by(toronto.id)).toMatchObject({ areaUnit: 'sqft', tier: 'standard', currency: 'CAD' });
    expect(by(madrid.id)).toMatchObject({ areaUnit: 'sqm', currency: 'EUR' });
    expect(by(london.id).areaUnit).toBe('sqft');
    // Tier is HQ governance: a location manager cannot change it.
    expect((await call(app, 'PUT', R(`/offices/${toronto.id}`), { token: mgr.token, body: { tier: 'flexible' } })).status).toBe(403);
    expect((await call(app, 'PUT', R(`/offices/${toronto.id}`), { token: mgr.token, body: { viewingMinutes: 30 } })).status).toBe(200);
  });

  it('status transitions with HQ approval: no self-approval, publish only after approval, governed edits stay pending', async () => {
    const l = await listing(agentA.user.token, toronto.id);
    expect(l.status).toBe('draft');
    expect(l.agents).toEqual([expect.objectContaining({ id: agentA.id, role: 'lead' })]);
    expect(l.area).toMatchObject({ value: 1850, unit: 'sqft' });
    // Another agent at the office cannot edit or publish it.
    expect((await call(app, 'POST', R(`/listings/${l.id}/status`), { token: agentB.user.token, body: { to: 'active' } })).status).toBe(403);
    // Invalid transition.
    const bad = await call(app, 'POST', R(`/listings/${l.id}/status`), { token: agentA.user.token, body: { to: 'sold' } });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('invalid_transition');
    // Standard office → publish request goes to HQ.
    const req1 = await call(app, 'POST', R(`/listings/${l.id}/status`), { token: agentA.user.token, body: { to: 'active', note: 'Ready' } });
    expect(req1.status).toBe(202);
    expect(req1.body.result).toBe('pending_approval');
    expect(req1.body.listing.status).toBe('draft');
    expect(req1.body.listing.approval).toMatchObject({ status: 'pending', requestedStatus: 'active' });
    // Not visible to the public yet.
    expect((await call(app, 'GET', `/v1/public/realty/listings/${l.id}`)).status).toBe(404);
    // Agents/managers without website.approve cannot approve; HQ must comment to reject.
    expect((await call(app, 'POST', R(`/listings/${l.id}/approval`), { token: agentA.user.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', R(`/listings/${l.id}/approval`), { token: mgr.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', R(`/listings/${l.id}/approval`), { token: hq.token, body: { decision: 'reject' } })).status).toBe(400);
    const ok = await call(app, 'POST', R(`/listings/${l.id}/approval`), { token: hq.token, body: { decision: 'approve', comment: 'Meets advertising standards' } });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('active');
    expect(ok.body.approval.status).toBe('approved');
    expect(ok.body.firstActiveAt).toBeTruthy();
    const pub = await call(app, 'GET', `/v1/public/realty/listings/${l.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.listing.title).toBe(l.title);

    // Editing marketing content of a published listing: kept pending until HQ approves; live page unchanged.
    const edit = await call(app, 'PATCH', R(`/listings/${l.id}`), { token: agentA.user.token, body: { title: 'Renovated family-sized home', priceMinor: 119_900_000 } });
    expect(edit.status).toBe(200);
    expect(edit.body.result).toBe('pending_approval');
    expect((await call(app, 'GET', `/v1/public/realty/listings/${l.id}`)).body.listing.price.amount).toBe(125_000_000);
    // The requester cannot approve their own change even with approval rights (owner self-check is by requester).
    const ap = await call(app, 'POST', R(`/listings/${l.id}/approval`), { token: hq.token, body: { decision: 'approve' } });
    expect(ap.status).toBe(200);
    expect((await call(app, 'GET', `/v1/public/realty/listings/${l.id}`)).body.listing.price.amount).toBe(119_900_000);

    // Owner requesting and approving their own publish is refused (no self-approval) — the owner publishes directly instead.
    const l2 = await listing(owner.token, toronto.id, { leadAgentId: agentB.id });
    const direct = await call(app, 'POST', R(`/listings/${l2.id}/status`), { token: owner.token, body: { to: 'coming_soon' } });
    expect(direct.status).toBe(200);
    expect(direct.body.listing.status).toBe('coming_soon');

    // Flexible office: agents publish directly.
    await call(app, 'PUT', R(`/offices/${london.id}`), { token: owner.token, body: { tier: 'flexible' } });
    const l3 = await listing(agentL.user.token, london.id, { address: { line1: '12 Elm Row', city: 'London', postalCode: 'NW3 1AA' }, priceMinor: 250_000_000 });
    expect(l3.price.currency).toBe('GBP');
    const flex = await call(app, 'POST', R(`/listings/${l3.id}/status`), { token: agentL.user.token, body: { to: 'active' } });
    expect(flex.status).toBe(200);
    expect(flex.body.listing.approval.status).toBe('not_required');

    // Withdraw → relist as draft → audit trail in history.
    const w = await call(app, 'POST', R(`/listings/${l3.id}/status`), { token: agentL.user.token, body: { to: 'withdrawn' } });
    expect(w.body.listing.status).toBe('withdrawn');
    const d = await call(app, 'POST', R(`/listings/${l3.id}/status`), { token: agentL.user.token, body: { to: 'draft' } });
    expect(d.body.listing.history.map((h: any) => h.to)).toEqual(['draft', 'active', 'withdrawn', 'draft']);
  });

  it('lead routing: listing agent → co-listing agent → round-robin → office pool; agents see their own and the pool', async () => {
    const l = await listing(owner.token, toronto.id, { leadAgentId: agentA.id, coAgentIds: [agentB.id] });
    await call(app, 'POST', R(`/listings/${l.id}/status`), { token: owner.token, body: { to: 'active' } });
    const enquire = (body: Record<string, unknown>) => call(app, 'POST', `/v1/public/realty/${slug}/enquiries`, { body: { kind: 'buyer', contact: { name: `Buyer ${uid()}`, email: `b-${uid()}@example.com` }, message: 'Is it still available?', ...body } });
    const routed = async (id: string) => (await app.ctx.db.select().from(realtyEnquiries).where(eq(realtyEnquiries.id, id)))[0]!;

    const e1 = await enquire({ listingId: l.id });
    expect(e1.status).toBe(201);
    expect(await routed(e1.body.id)).toMatchObject({ assignedAgentId: agentA.id, routedBy: 'listing_agent' });

    await call(app, 'PATCH', R(`/agents/${agentA.id}`), { token: agentA.user.token, body: { acceptsLeads: false } });
    const e2 = await enquire({ listingId: l.id });
    expect(await routed(e2.body.id)).toMatchObject({ assignedAgentId: agentB.id, routedBy: 'co_listing_agent' });

    // No listing → round-robin among agents accepting leads (B, C) in a stable order.
    const rr = [];
    for (let i = 0; i < 4; i++) rr.push((await routed((await enquire({ officeSlug: toronto.slug })).body.id)).assignedAgentId);
    expect(new Set(rr)).toEqual(new Set([agentB.id, agentC.id]));
    expect(rr[0]).not.toBe(rr[1]);
    expect(rr[0]).toBe(rr[2]);
    await call(app, 'PATCH', R(`/agents/${agentA.id}`), { token: agentA.user.token, body: { acceptsLeads: true } });

    // Office pool mode leaves enquiries unassigned.
    await call(app, 'PUT', R(`/offices/${toronto.id}`), { token: mgr.token, body: { leadRouting: 'office_pool' } });
    const pool = await enquire({ officeSlug: toronto.slug, kind: 'valuation' });
    expect(await routed(pool.body.id)).toMatchObject({ assignedAgentId: null, routedBy: 'office_pool' });
    await call(app, 'PUT', R(`/offices/${toronto.id}`), { token: mgr.token, body: { leadRouting: 'listing_agent' } });

    // Visibility: agent A sees own + pool but not B's; manager sees all; HQ (no client access) is refused; London agent sees none of Toronto's.
    const aList = (await call(app, 'GET', R('/enquiries'), { token: agentA.user.token })).body.items.map((x: any) => x.id);
    expect(aList).toContain(e1.body.id);
    expect(aList).toContain(pool.body.id);
    expect(aList).not.toContain(e2.body.id);
    const mList = (await call(app, 'GET', R('/enquiries'), { token: mgr.token })).body.items.map((x: any) => x.id);
    expect(mList).toEqual(expect.arrayContaining([e1.body.id, e2.body.id, pool.body.id]));
    expect((await call(app, 'GET', R('/enquiries'), { token: hq.token })).status).toBe(403);
    expect((await call(app, 'GET', R('/enquiries'), { token: agentL.user.token })).body.items.map((x: any) => x.id)).not.toContain(pool.body.id);
    // Claiming from the pool is first-come; reassigning someone else's lead needs a manager.
    expect((await call(app, 'POST', R(`/enquiries/${pool.body.id}/assign`), { token: agentC.user.token, body: { agentId: agentC.id } })).status).toBe(200);
    expect((await call(app, 'POST', R(`/enquiries/${pool.body.id}/assign`), { token: agentA.user.token, body: { agentId: agentA.id } })).status).toBe(403);
    // Portal leads are idempotent on their external reference.
    const p1 = await call(app, 'POST', R('/enquiries'), { token: mgr.token, body: { locationId: toronto.id, listingId: l.id, source: 'portal_realtor_ca', name: 'Portal Lead', externalRef: 'rc-123' } });
    const p2 = await call(app, 'POST', R('/enquiries'), { token: mgr.token, body: { locationId: toronto.id, listingId: l.id, source: 'portal_realtor_ca', name: 'Portal Lead', externalRef: 'rc-123' } });
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(200);
    expect(p2.body.id).toBe(p1.body.id);
  });

  it('viewing slots: an agent can never hold overlapping viewings; co-listing agents take the overflow', async () => {
    const solo = await listing(owner.token, toronto.id, { leadAgentId: agentC.id });
    await call(app, 'POST', R(`/listings/${solo.id}/status`), { token: owner.token, body: { to: 'active' } });
    const book = (listingId: string, startsAt: string) => call(app, 'POST', `/v1/public/realty/listings/${listingId}/viewings`, { body: { startsAt, contact: { name: `Viewer ${uid()}`, email: `v-${uid()}@example.com` } } });

    const slots = await call(app, 'GET', `/v1/public/realty/listings/${solo.id}/viewing-slots?date=${day}`);
    expect(slots.status).toBe(200);
    expect(slots.body.slots.map((x: any) => x.startsAt)).toContain(at('10:00'));
    // Concurrent requests for the same agent and time: exactly one wins.
    const [r1, r2] = await Promise.all([book(solo.id, at('10:00')), book(solo.id, at('10:00'))]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const lost = r1.status === 409 ? r1 : r2;
    expect(lost.body.error.code).toBe('slot_unavailable');
    // 10:30 overlaps the 15-minute buffer after a 10:00–10:30 viewing; 10:45 does not.
    expect((await book(solo.id, at('10:30'))).status).toBe(409);
    expect((await book(solo.id, at('10:45'))).status).toBe(201);
    // Outside availability.
    expect((await book(solo.id, at('07:00'))).status).toBe(409);
    const after = await call(app, 'GET', `/v1/public/realty/listings/${solo.id}/viewing-slots?date=${day}`);
    expect(after.body.slots.map((x: any) => x.startsAt)).not.toContain(at('10:00'));

    // The same agent is busy across listings: another listing led by C cannot take 10:00 either.
    const other = await listing(owner.token, toronto.id, { leadAgentId: agentC.id, coAgentIds: [agentA.id] });
    await call(app, 'POST', R(`/listings/${other.id}/status`), { token: owner.token, body: { to: 'active' } });
    const overflow = await book(other.id, at('10:00'));
    expect(overflow.status).toBe(201);
    expect(overflow.body.viewing.agentId).toBe(agentA.id);

    // Staff booking for a specific agent at a clashing time is refused; confirm/feedback flow by the agent.
    expect((await call(app, 'POST', R('/viewings'), { token: mgr.token, body: { listingId: solo.id, startsAt: at('11:00'), agentId: agentC.id, contact: { name: 'Walk-in' } } })).status).toBe(409);
    const won = r1.status === 201 ? r1 : r2;
    expect((await call(app, 'POST', R(`/viewings/${won.body.viewing.id}/confirm`), { token: agentB.user.token })).status).toBe(403);
    const conf = await call(app, 'POST', R(`/viewings/${won.body.viewing.id}/confirm`), { token: agentC.user.token });
    expect(conf.body.status).toBe('confirmed');
    expect((await call(app, 'POST', R(`/viewings/${won.body.viewing.id}/feedback`), { token: agentC.user.token, body: { interestLevel: 'high' } })).status).toBe(409); // not started yet

    // Reminder job: runs once per confirmed viewing within 24h.
    const now = new Date(new Date(at('10:00')).getTime() - 3 * 3600_000);
    const first = await runViewingReminders(app.ctx, { organizationId: orgId, now });
    expect(first.sent).toBe(1);
    expect((await runViewingReminders(app.ctx, { organizationId: orgId, now })).sent).toBe(0);
    // Agents only see contact details for their own viewings.
    const listB = await call(app, 'GET', R(`/viewings?from=${encodeURIComponent(at('00:00'))}&to=${encodeURIComponent(at('23:59'))}`), { token: agentB.user.token });
    const seenByB = listB.body.items.find((v: any) => v.id === won.body.viewing.id);
    expect(seenByB.contact.email).toBeNull();
  });

  it('offers: only listing agents, the recording agent and managers can see them; accepting moves the listing under offer', async () => {
    const l = await listing(owner.token, toronto.id, { leadAgentId: agentA.id });
    await call(app, 'POST', R(`/listings/${l.id}/status`), { token: owner.token, body: { to: 'active' } });
    const wrongCurrency = await call(app, 'POST', R(`/listings/${l.id}/offers`), { token: agentB.user.token, body: { buyerName: 'Haddad family', amountMinor: 120_000_000, currency: 'USD' } });
    expect(wrongCurrency.status).toBe(400);
    const ob = await call(app, 'POST', R(`/listings/${l.id}/offers`), { token: agentB.user.token, body: { buyerName: 'Omar & Sara Haddad', amountMinor: 118_000_000, currency: 'CAD', conditions: ['Financing within 5 business days', 'Home inspection'] } });
    expect(ob.status).toBe(201);
    expect(ob.body.submittedByAgentId).toBe(agentB.id);
    const oc = await call(app, 'POST', R(`/listings/${l.id}/offers`), { token: agentC.user.token, body: { buyerName: 'Aaron Patel', amountMinor: 121_000_000, currency: 'CAD' } });
    expect(oc.status).toBe(201);

    const seen = async (token: string) => { const r = await call(app, 'GET', R(`/listings/${l.id}/offers`), { token }); return r.status === 200 ? r.body.items.map((o: any) => o.id).sort() : r.status; };
    expect(await seen(agentA.user.token)).toEqual([ob.body.id, oc.body.id].sort()); // listing agent
    expect(await seen(mgr.token)).toEqual([ob.body.id, oc.body.id].sort()); // office manager
    expect(await seen(agentB.user.token)).toEqual([ob.body.id]); // only the offer B recorded
    expect(await seen(agentL.user.token)).toBe(403); // agent at another office
    expect(await seen(hq.token)).toBe(403); // HQ report access ≠ offer access
    expect((await call(app, 'GET', R(`/offers/${oc.body.id}`), { token: agentB.user.token })).status).toBe(404);
    expect((await call(app, 'GET', R(`/offers/${oc.body.id}`), { token: hq.token })).status).toBe(404);
    const listedForB = (await call(app, 'GET', R('/offers'), { token: agentB.user.token })).body.items.map((o: any) => o.id);
    expect(listedForB).toContain(ob.body.id);
    expect(listedForB).not.toContain(oc.body.id);
    // Listings board hides offer counts from agents who may not see them.
    const board = (await call(app, 'GET', R('/listings'), { token: agentC.user.token })).body.items.find((x: any) => x.id === l.id);
    expect(board.counts.openOffers).toBeNull();

    // Negotiation: B cannot respond for the vendor; A counters; B revises; A accepts.
    expect((await call(app, 'POST', R(`/offers/${ob.body.id}/actions`), { token: agentB.user.token, body: { action: 'accept' } })).status).toBe(403);
    const counter = await call(app, 'POST', R(`/offers/${ob.body.id}/actions`), { token: agentA.user.token, body: { action: 'counter', amountMinor: 122_500_000, note: 'Vendor counter' } });
    expect(counter.body.status).toBe('countered');
    expect((await call(app, 'POST', R(`/offers/${ob.body.id}/actions`), { token: agentA.user.token, body: { action: 'revise', amountMinor: 1 } })).status).toBe(403);
    const revise = await call(app, 'POST', R(`/offers/${ob.body.id}/actions`), { token: agentB.user.token, body: { action: 'revise', amountMinor: 121_500_000 } });
    expect(revise.body.status).toBe('submitted');
    const accept = await call(app, 'POST', R(`/offers/${ob.body.id}/actions`), { token: agentA.user.token, body: { action: 'accept' } });
    expect(accept.status).toBe(200);
    expect(accept.body.events.map((e: any) => e.action)).toEqual(['submitted', 'countered', 'revised', 'accepted']);
    expect(accept.body.amount).toEqual({ amount: 121_500_000, currency: 'CAD' });
    expect((await call(app, 'GET', R(`/listings/${l.id}`), { token: agentA.user.token })).body.status).toBe('under_offer');
    const second = await call(app, 'POST', R(`/offers/${oc.body.id}/actions`), { token: agentA.user.token, body: { action: 'accept' } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('offer_already_accepted');
    // Close the sale at the accepted price.
    const sold = await call(app, 'POST', R(`/listings/${l.id}/status`), { token: agentA.user.token, body: { to: 'sold' } });
    expect(sold.body.listing.closedPrice).toEqual({ amount: 121_500_000, currency: 'CAD' });
  });

  it('search and reports never combine currencies; areas filter in the chosen unit', async () => {
    // GBP sale in London, EUR sale in Madrid (m²), plus the CAD sale from the previous test.
    const gb = await listing(agentL.user.token, london.id, { address: { line1: '3 Flask Walk', city: 'London', postalCode: 'NW3 1HE' }, priceMinor: 180_000_000, area: { value: 1200, unit: 'sqft' } });
    await call(app, 'POST', R(`/listings/${gb.id}/status`), { token: agentL.user.token, body: { to: 'active' } });
    const es = await listing(owner.token, madrid.id, { leadAgentId: (await agent(madrid.id, 'Lucía Romero')).id, address: { line1: 'Calle de Velázquez 10', city: 'Madrid', postalCode: '28001' }, priceMinor: 89_000_000, area: { value: 140, unit: 'sqm' } });
    expect(es.area).toMatchObject({ value: 140, unit: 'sqm' });
    await call(app, 'POST', R(`/listings/${es.id}/status`), { token: owner.token, body: { to: 'active' } });

    // Search: price range needs a currency and excludes other currencies (reported, not converted).
    expect((await call(app, 'GET', `/v1/public/realty/${slug}/listings?maxPrice=100000000`)).status).toBe(400);
    const eur = await call(app, 'GET', `/v1/public/realty/${slug}/listings?maxPrice=100000000&currency=EUR`);
    expect(eur.body.items.map((x: any) => x.id)).toEqual([es.id]);
    expect(eur.body.excluded.otherCurrency).toBeGreaterThan(0);
    // Area in the requested unit: 1,200 sq ft ≈ 111 m²; min 120 m² keeps Madrid (140 m²) and drops London.
    const sqm = await call(app, 'GET', `/v1/public/realty/${slug}/listings?minArea=120&areaUnit=sqm`);
    const ids = sqm.body.items.map((x: any) => x.id);
    expect(ids).toContain(es.id);
    expect(ids).not.toContain(gb.id);
    const gbInSqm = (await call(app, 'GET', `/v1/public/realty/listings/${gb.id}?areaUnit=sqm`)).body.listing;
    expect(gbInSqm.area).toMatchObject({ value: 111, unit: 'sqm' });
    expect(gbInSqm.areaAlt).toMatchObject({ value: 1200, unit: 'sqft' });

    // Close GBP and EUR sales.
    for (const [tok, id] of [[agentL.user.token, gb.id], [owner.token, es.id]] as const) {
      await call(app, 'POST', R(`/listings/${id}/status`), { token: tok, body: { to: 'under_offer' } });
      await call(app, 'POST', R(`/listings/${id}/status`), { token: tok, body: { to: 'sold', closedPriceMinor: id === gb.id ? 175_000_000 : 87_500_000 } });
    }
    const rep = await call(app, 'GET', R('/reports'), { token: hq.token });
    expect(rep.status).toBe(200);
    expect(rep.body.network.combinedVolume).toBeNull();
    const cur = rep.body.network.sold.map((v: any) => v.currency);
    expect(cur).toEqual(['CAD', 'EUR', 'GBP']);
    expect(rep.body.network.sold.find((v: any) => v.currency === 'GBP')).toEqual({ currency: 'GBP', count: 1, volumeMinor: 175_000_000 });
    expect(rep.body.network.sold.find((v: any) => v.currency === 'EUR').volumeMinor).toBe(87_500_000);
    const tor = rep.body.locations.find((x: any) => x.locationId === toronto.id);
    expect(tor.sold.every((v: any) => v.currency === 'CAD')).toBe(true);
    expect(tor.funnel.enquiries).toBeGreaterThan(0);
    expect(JSON.stringify(rep.body)).not.toMatch(/@example\.com/); // no client personal data
    // A location manager's report is limited to their office; agents (staff) have no report access.
    const mrep = await call(app, 'GET', R(`/reports?scopeKind=location&scopeId=${toronto.id}`), { token: mgr.token });
    expect(mrep.body.locations.map((x: any) => x.locationId)).toEqual([toronto.id]);
    expect((await call(app, 'GET', R('/reports'), { token: agentA.user.token })).status).toBe(403);
  });

  it('saved searches: strict criteria, alerts only with consent, never twice, unsubscribe stops them', async () => {
    const bad = await call(app, 'POST', `/v1/public/realty/${slug}/saved-searches`, { body: { email: 'x@example.com', criteria: { minBedrooms: 2, familyStatus: 'no kids' }, alertsConsent: true } });
    expect(bad.status).toBe(400);
    const noCur = await call(app, 'POST', `/v1/public/realty/${slug}/saved-searches`, { body: { email: 'x@example.com', criteria: { maxPrice: 100 }, alertsConsent: true } });
    expect(noCur.status).toBe(400);
    const yes = await call(app, 'POST', `/v1/public/realty/${slug}/saved-searches`, { body: { email: `alerts-${uid()}@example.com`, name: '3 bed Toronto', criteria: { transaction: 'sale', minBedrooms: 3, city: 'Toronto' }, frequency: 'instant', alertsConsent: true } });
    const no = await call(app, 'POST', `/v1/public/realty/${slug}/saved-searches`, { body: { email: `noalerts-${uid()}@example.com`, criteria: { transaction: 'sale' }, frequency: 'instant', alertsConsent: false } });
    expect(yes.status).toBe(201);
    expect(no.body.alerts).toBe('off');
    const l = await listing(owner.token, toronto.id, { leadAgentId: agentA.id, bedrooms: 4 });
    await call(app, 'POST', R(`/listings/${l.id}/status`), { token: owner.token, body: { to: 'active' } });
    const outbox = app.ctx.mailer.outbox;
    const before = outbox.length;
    const run1 = await runSavedSearchAlerts(app.ctx, { organizationId: orgId });
    expect(run1.emails).toBe(1);
    expect(outbox.slice(before).map((m) => m.to)).toEqual([expect.stringMatching(/^alerts-/)]);
    expect(outbox[outbox.length - 1]!.text).toMatch(/Unsubscribe/);
    expect((await runSavedSearchAlerts(app.ctx, { organizationId: orgId })).emails).toBe(0);
    const deliveries = await app.ctx.db.select().from(realtyAlertDeliveries).where(eq(realtyAlertDeliveries.savedSearchId, yes.body.id));
    expect(deliveries.map((d) => d.listingId)).toEqual([l.id]);
    // Each alert carries a fresh manage token (only a hash is stored); the original one no longer works.
    const alertToken = decodeURIComponent(outbox[outbox.length - 1]!.text.match(/token=([^\s]+)/)![1]!);
    expect((await call(app, 'POST', `/v1/public/realty/saved-searches/${yes.body.id}/unsubscribe`, { body: { manageToken: yes.body.manageToken } })).status).toBe(404);
    expect((await call(app, 'POST', `/v1/public/realty/saved-searches/${yes.body.id}/unsubscribe`, { body: { manageToken: alertToken } })).status).toBe(200);
    const l2 = await listing(owner.token, toronto.id, { leadAgentId: agentA.id, bedrooms: 5 });
    await call(app, 'POST', R(`/listings/${l2.id}/status`), { token: owner.token, body: { to: 'active' } });
    expect((await runSavedSearchAlerts(app.ctx, { organizationId: orgId })).emails).toBe(0);
  });

  it('AI refuses protected-characteristic targeting in instructions and tool calls; drafts are proposals only', async () => {
    const l = await listing(agentA.user.token, toronto.id);
    // 1) Instructions that target a protected group are refused before the model is called.
    const callsBefore = fake.calls.length;
    const refused = await call(app, 'POST', R('/ai/follow-ups'), { token: mgr.token, body: { instructions: 'Only follow up with young families, no retirees' } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('fair_housing_refused');
    expect(fake.calls.length).toBe(callsBefore);

    // 2) The model tries a protected audience → tool refuses; it retries with allowed criteria → stored proposal.
    const enq = (await app.ctx.db.select().from(realtyEnquiries).where(and(eq(realtyEnquiries.organizationId, orgId), eq(realtyEnquiries.locationId, toronto.id))))[0]!;
    await app.ctx.db.update(realtyEnquiries).set({ status: 'new' }).where(eq(realtyEnquiries.id, enq.id));
    fake.push(
      toolUse('propose_follow_ups', { followUps: [{ refType: 'enquiry', refId: enq.id, channel: 'email', reason: 'New enquiry', draftMessage: 'Hi {{first_name}}' }], audience: { familyStatus: 'with children', minBedrooms: 3 } }),
      toolUse('propose_follow_ups', { followUps: [{ refType: 'enquiry', refId: enq.id, channel: 'email', reason: 'Enquiry not answered yet', draftMessage: 'Hi {{first_name}}, would you like to book a viewing?' }], audience: { minBedrooms: 3 } }),
    );
    const fu = await call(app, 'POST', R('/ai/follow-ups'), { token: mgr.token, body: { locationId: toronto.id } });
    expect(fu.status).toBe(200);
    expect(fu.body.refusals[0]).toMatch(/protected characteristics \(familyStatus\)/);
    expect(fu.body.proposal.kind).toBe('follow_up');
    expect(fu.body.proposal.output.audience).toEqual({ minBedrooms: 3 });
    // The model never received client contact details.
    const lastCall = fake.calls[fake.calls.length - 1]!;
    expect(JSON.stringify(lastCall.messages)).not.toMatch(/@example\.com/);
    expect(lastCall.system).toMatch(/FAIR HOUSING/);

    // 3) Description draft that steers by age is refused; the corrected draft is stored but NOT applied.
    fake.push(
      toolUse('submit_listing_description', { headline: 'Perfect for young professionals', description: 'A great home for young professionals.', factsUsed: ['bedrooms'] }),
      toolUse('submit_listing_description', { headline: 'Three-bedroom detached house with garden', description: 'Three bedrooms, two bathrooms and 1,850 sq ft of living space with a private garden.', factsUsed: ['bedrooms', 'bathrooms', 'area'] }),
    );
    const draft = await call(app, 'POST', R(`/listings/${l.id}/ai/description`), { token: agentA.user.token, body: {} });
    expect(draft.status).toBe(200);
    expect(draft.body.refusals).toHaveLength(1);
    expect(draft.body.proposal.output.headline).toBe('Three-bedroom detached house with garden');
    expect((await call(app, 'GET', R(`/listings/${l.id}`), { token: agentA.user.token })).body.title).toBe(l.title);
    // Applying goes through the editor; the draft listing is not governed so it applies now.
    const applied = await call(app, 'POST', R(`/ai/proposals/${draft.body.proposal.id}/decision`), { token: agentA.user.token, body: { decision: 'apply' } });
    expect(applied.status).toBe(200);
    expect((await call(app, 'GET', R(`/listings/${l.id}`), { token: agentA.user.token })).body.title).toBe('Three-bedroom detached house with garden');
    const stored = await app.ctx.db.select().from(realtyAiProposals).where(eq(realtyAiProposals.organizationId, orgId));
    expect(stored.every((p) => !JSON.stringify(p.output).match(/young professionals|with children/))).toBe(true);
  });

  it('portal syndication is sandbox without office credentials, opt-in per listing, and validates required fields', async () => {
    const portals = await call(app, 'GET', R('/syndication/portals'), { token: owner.token });
    expect(portals.body.items.every((p: any) => p.live === false && p.mode === 'sandbox')).toBe(true);
    const l = await listing(owner.token, toronto.id, { leadAgentId: agentA.id });
    await call(app, 'POST', R(`/listings/${l.id}/status`), { token: owner.token, body: { to: 'active' } });
    expect((await call(app, 'PUT', R(`/listings/${l.id}/syndication/rightmove`), { token: owner.token, body: { optedIn: true } })).status).toBe(400); // UK feed, Canadian listing
    const opt = await call(app, 'PUT', R(`/listings/${l.id}/syndication/reso_xml`), { token: agentA.user.token, body: { optedIn: true } });
    expect(opt.status).toBe(200);
    expect(opt.body.issues).toContain('Brokerage name/licence disclosure is required');
    let feed = await call(app, 'GET', R('/syndication/reso_xml/feed'), { token: owner.token });
    expect(feed.body.excluded.map((x: any) => x.listingId)).toContain(l.id);
    await call(app, 'PUT', R(`/offices/${toronto.id}`), { token: owner.token, body: { brokerageLicence: 'Keystone Realty Inc., Brokerage' } });
    feed = await call(app, 'GET', R('/syndication/reso_xml/feed'), { token: owner.token });
    expect(feed.body.included.map((x: any) => x.listingId)).toContain(l.id);
    expect(feed.body.content).toContain('SANDBOX PREVIEW');
    expect(feed.body.content).toContain('<ProviderListingId>');
    const exp = await call(app, 'POST', R('/syndication/reso_xml/export'), { token: owner.token, body: {} });
    expect(exp.body).toMatchObject({ mode: 'sandbox', live: false, transmitted: false });
    expect(exp.body.results.find((r: any) => r.listingId === l.id).status).toBe('sandbox_exported');
  });
});
