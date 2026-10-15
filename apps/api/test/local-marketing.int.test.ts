import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { commsMessages, leads, listingSyncs, locations, marketingFundEntries, reviewConnections, reviewListings, reviews, socialPosts, trackedCalls } from '../src/db/schema/index.ts';
import type { FetchLike } from '../src/integrations/partners/http.ts';
import { signVoicePayload, voiceWebhookUrl } from '../src/integrations/call-tracking.ts';
import { encrypt } from '../src/lib/crypto.ts';
import { onReviewReceived } from '../src/services/reviews.ts';
import { normaliseHours, openNow } from '../src/routes/sites.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Local marketing end to end: listings (field policy, approval, sandbox directories, drift accept / overwrite, Google
 * push and drift through a fake, bulk holiday hours, health), Google reviews as inbox conversations with SLA,
 * templates and replies through the reviews service (approval), the co-op fund (allowance, checklist, claim,
 * reimbursement in the fund ledger, burn-down), call tracking (recording rules, missed-call leads, signatures,
 * attribution, DNI) and the local social calendar — with franchisee isolation throughout.
 */

function googleFake() {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  let remote: Record<string, unknown> = { name: 'locations/222', title: 'Glow Toronto', storefrontAddress: { regionCode: 'CA', locality: 'Toronto', addressLines: ['1 Main St'] }, phoneNumbers: { primaryPhone: '+1 416 555 0100' } };
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body });
    if (url === 'https://oauth2.googleapis.com/token') return json(200, { access_token: 'at-g', expires_in: 3600 });
    if (init?.headers?.Authorization !== 'Bearer at-g') return json(401, { error: 'unauthenticated' });
    if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/locations/222?updateMask=') && init?.method === 'PATCH') {
      remote = { ...remote, ...JSON.parse(init.body ?? '{}') };
      return json(200, remote);
    }
    if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/locations/222?readMask=')) return json(200, remote);
    if (url.endsWith('/reply') && init?.method === 'PUT') return json(200, { comment: JSON.parse(init.body ?? '{}').comment });
    return json(404, { error: 'not found' });
  };
  return { fetch, calls, edit: (patch: Record<string, unknown>) => { remote = { ...remote, ...patch }; } };
}

describe.skipIf(!hasDb)('local marketing (DB)', () => {
  let app: FastifyInstance;
  const google = googleFake();
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let cmo: Awaited<ReturnType<typeof verifiedUser>>;
  let foA: Awaited<ReturnType<typeof verifiedUser>>;
  let foB: Awaited<ReturnType<typeof verifiedUser>>;
  let lmA: Awaited<ReturnType<typeof verifiedUser>>;
  let staff: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let orgSlug: string;
  let tor: { id: string; slug: string };
  let van: { id: string; slug: string };
  const o = (p: string) => `/v1/orgs/${orgId}${p}`;
  const pdf = { filename: 'invoice.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 invoice').toString('base64') };

  beforeAll(async () => {
    app = await makeApp({ partnerFetch: google.fetch }, { GOOGLE_OAUTH_CLIENT_ID: 'gid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret', SITES_BASE_URL: 'https://sites.test' });
    owner = await verifiedUser(app, 'Brand Owner');
    const org = await createOrg(app, owner.token, { name: `Glow Yoga ${uid()}` });
    orgId = org.id;
    orgSlug = org.slug;
    const gA = (await call(app, 'POST', o('/owner-groups'), { token: owner.token, body: { name: 'North Group' } })).body.id;
    const gB = (await call(app, 'POST', o('/owner-groups'), { token: owner.token, body: { name: 'West Group' } })).body.id;
    const t = await createLocation(app, owner.token, orgId, { name: 'Glow Toronto', ownerGroupId: gA, phone: '+1 416 555 0100' });
    const v = await createLocation(app, owner.token, orgId, { name: 'Glow Vancouver', ownerGroupId: gB, phone: '+1 604 555 0100', timeZone: 'America/Vancouver', address: { line1: '1 Main', city: 'Vancouver', region: 'BC', country: 'CA' } });
    tor = { id: t.id, slug: t.slug };
    van = { id: v.id, slug: v.slug };
    await call(app, 'PATCH', o(`/locations/${tor.id}`), { token: owner.token, body: { publiclyVisible: true } });
    cmo = await memberWithRole(app, owner.token, orgId, 'marketing_lead', { kind: 'organization', id: orgId }, 'HQ Marketing');
    foA = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: gA }, 'North Owner');
    foB = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: gB }, 'West Owner');
    lmA = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: tor.id }, 'Toronto Manager');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: tor.id }, 'Front Desk');
  });
  afterAll(async () => { await app?.close(); });

  /* ------------------------------ Listings ------------------------------ */

  it('applies the field policy: open fields save, locked fields are refused, approval fields wait for HQ', async () => {
    expect((await call(app, 'GET', o('/listings'), { token: staff.token })).body.error.code).toBe('module_not_available');
    const hours = [{ day: 1, opens: '07:00', closes: '21:00' }, { day: 2, opens: '07:00', closes: '21:00' }];
    const ok = await call(app, 'PATCH', o(`/listings/${tor.id}`), { token: foA.token, body: { hours } });
    expect(ok.status).toBe(200);
    expect(ok.body.applied).toEqual(['hours']);
    const [loc] = await app.ctx.db.select().from(locations).where(eq(locations.id, tor.id));
    expect((loc!.hours as { weekly: unknown }).weekly).toEqual(hours);
    expect((await call(app, 'PATCH', o(`/listings/${tor.id}`), { token: foA.token, body: { name: 'Cheap Yoga' } })).status).toBe(403);
    const desc = 'Heated vinyasa and yin classes in the heart of Toronto, with mats, towels and showers included for every member.';
    const pending = await call(app, 'PATCH', o(`/listings/${tor.id}`), { token: foA.token, body: { description: desc, note: 'New copy' } });
    expect(pending.body).toMatchObject({ applied: [], pendingApproval: ['description'] });
    // Another franchisee can neither read nor change this location's listing.
    expect((await call(app, 'GET', o(`/listings/${tor.id}`), { token: foB.token })).status).toBe(403);
    expect((await call(app, 'PATCH', o(`/listings/${tor.id}`), { token: foB.token, body: { hours } })).status).toBe(403);
    expect((await call(app, 'GET', o('/listings'), { token: foB.token })).body.items.map((x: any) => x.locationId)).toEqual([van.id]);
    // The franchisee cannot approve; HQ can.
    expect((await call(app, 'POST', o(`/listings/changes/${pending.body.requestId}/decision`), { token: foA.token, body: { decision: 'approve' } })).status).toBe(403);
    const ap = await call(app, 'POST', o(`/listings/changes/${pending.body.requestId}/decision`), { token: cmo.token, body: { decision: 'approve' } });
    expect(ap.body.status).toBe('approved');
    const detail = await call(app, 'GET', o(`/listings/${tor.id}`), { token: foA.token });
    expect(detail.body.listing.description).toBe(desc);
    expect(detail.body.canManage).toBe(false);
    expect(detail.body.policy.name).toBe('hq');
  });

  it('syncs sandbox directories, detects drift and resolves it by overwrite or accept', async () => {
    const conn = await call(app, 'POST', o('/listings/connections'), { token: cmo.token, body: { provider: 'apple' } });
    expect(conn.body.mode).toBe('sandbox');
    expect((await call(app, 'POST', o(`/listings/connections/${conn.body.id}/links`), { token: foA.token, body: { all: true } })).status).toBe(403);
    expect((await call(app, 'POST', o(`/listings/connections/${conn.body.id}/links`), { token: cmo.token, body: { all: true } })).body.linked).toBe(2);
    const push = await call(app, 'POST', o(`/listings/${tor.id}/push`), { token: lmA.token, body: {} });
    expect(push.body.results).toEqual([{ provider: 'apple', status: 'synced', mode: 'sandbox' }]);
    const [sync] = await app.ctx.db.select().from(listingSyncs).where(and(eq(listingSyncs.locationId, tor.id), eq(listingSyncs.provider, 'apple')));
    // Someone edits the phone and Monday hours on Apple Maps.
    const sim = await call(app, 'POST', o(`/listings/syncs/${sync!.id}/simulate-edit`), { token: lmA.token, body: { phone: '+1 416 555 9999', hours: [{ day: 1, opens: '09:00', closes: '17:00' }] } });
    expect(sim.body.drifted.sort()).toEqual(['hours', 'phone']);
    const ov = await call(app, 'GET', o('/listings'), { token: cmo.token });
    const torRow = ov.body.items.find((x: any) => x.locationId === tor.id);
    expect(torRow.openDrifts).toBe(2);
    expect(torRow.providers.find((p: any) => p.provider === 'apple').status).toBe('drift');
    expect(torRow.health.checks.find((c: any) => c.key === 'noDrift').ok).toBe(false);
    const drifts = (await call(app, 'GET', o('/listings/drifts'), { token: cmo.token })).body.items;
    const phone = drifts.find((d: any) => d.field === 'phone');
    const hrs = drifts.find((d: any) => d.field === 'hours');
    expect(phone.theirValue).toBe('+1 416 555 9999');
    expect((await call(app, 'POST', o(`/listings/drifts/${phone.id}/resolve`), { token: foA.token, body: { action: 'overwrite' } })).status).toBe(403);
    expect((await call(app, 'POST', o(`/listings/drifts/${phone.id}/resolve`), { token: cmo.token, body: { action: 'overwrite' } })).body.status).toBe('overwritten');
    const [after] = await app.ctx.db.select().from(listingSyncs).where(eq(listingSyncs.id, sync!.id));
    expect(after!.remoteSnapshot!.phone).toBe('+1 416 555 0100');
    // Accepting the directory's hours makes them BranchHarbor's (and the hosted site's).
    expect((await call(app, 'POST', o(`/listings/drifts/${hrs.id}/resolve`), { token: cmo.token, body: { action: 'accept' } })).body.status).toBe('accepted');
    const [loc] = await app.ctx.db.select().from(locations).where(eq(locations.id, tor.id));
    expect((loc!.hours as { weekly: unknown }).weekly).toEqual([{ day: 1, opens: '09:00', closes: '17:00' }]);
    expect((await call(app, 'GET', o(`/listings/${tor.id}`), { token: cmo.token })).body.providers.find((p: any) => p.provider === 'apple').status).toBe('synced');
  });

  it('pushes to Google Business Profile through the Reviews connection and reads drift back', async () => {
    const [conn] = await app.ctx.db.insert(reviewConnections).values({ organizationId: orgId, ownerKind: 'hq', accountName: 'accounts/111', mode: 'live', status: 'connected', credentialsEncrypted: encrypt('rt-google', app.ctx.cfg.ENCRYPTION_KEY) }).returning();
    await app.ctx.db.insert(reviewListings).values({ organizationId: orgId, connectionId: conn!.id, locationId: tor.id, externalLocationName: 'locations/222' });
    const push = await call(app, 'POST', o(`/listings/${tor.id}/push`), { token: cmo.token, body: { provider: 'google' } });
    expect(push.body.results).toEqual([{ provider: 'google', status: 'synced', mode: 'live' }]);
    const patch = google.calls.find((c) => c.method === 'PATCH')!;
    expect(decodeURIComponent(patch.url)).toContain('updateMask=title,storefrontAddress,phoneNumbers,regularHours,specialHours,profile.description,websiteUri');
    expect(JSON.parse(patch.body!).title).toBe('Glow Toronto');
    google.edit({ title: 'Glow Toronto — Best Yoga' });
    const check = await call(app, 'POST', o(`/listings/${tor.id}/check`), { token: lmA.token });
    expect(check.body.results.find((r: any) => r.provider === 'google').drifted).toEqual(['name']);
  });

  it('sets holiday hours across the network, keeping locations’ own hours unless overwritten', async () => {
    await call(app, 'PATCH', o(`/listings/${van.id}`), { token: foB.token, body: { specialHours: [{ date: '2099-12-25', closed: false, opens: '10:00', closes: '14:00' }] } });
    const entries = [{ date: '2099-12-25', closed: true, label: 'Christmas' }, { date: '2099-12-26', closed: false, opens: '10:00', closes: '16:00' }];
    expect((await call(app, 'POST', o('/listings/holiday-hours'), { token: foA.token, body: { name: 'Holidays', entries, locationIds: [tor.id] } })).status).toBe(403);
    const r = await call(app, 'POST', o('/listings/holiday-hours'), { token: cmo.token, body: { name: 'Holidays 2099', entries, locationIds: [tor.id, van.id] } });
    expect(r.status).toBe(201);
    expect(r.body.applied).toEqual([tor.id]);
    expect(r.body.skipped).toEqual([van.id]);
    const again = await call(app, 'POST', o('/listings/holiday-hours'), { token: cmo.token, body: { name: 'Holidays 2099 (all)', entries, locationIds: [van.id], overwrite: true } });
    expect(again.body.applied).toEqual([van.id]);
    const [loc] = await app.ctx.db.select().from(locations).where(eq(locations.id, tor.id));
    const h = normaliseHours(loc!.hours, '2099-01-01');
    expect(h.special.map((x) => x.date)).toEqual(['2099-12-25', '2099-12-26']);
    // The hosted site's open-now follows the special hours of the day.
    expect(openNow([{ day: 5, opens: '07:00', closes: '21:00' }], 'America/Toronto', new Date('2099-12-25T17:00:00Z'), h.special)).toEqual({ open: false, closesAt: null });
    expect(openNow(null, 'America/Toronto', new Date('2099-12-26T17:00:00Z'), h.special)).toEqual({ open: true, closesAt: '16:00' });
  });

  /* ------------------------------ Reviews in the inbox ------------------------------ */

  it('delivers Google reviews to the inbox with an SLA, and publishes inbox replies through the reviews service', async () => {
    await call(app, 'PUT', o('/reviews/settings'), { token: cmo.token, body: { locationId: null, settings: { replyApproval: 'negative' } } });
    await call(app, 'PUT', o('/local-marketing/settings'), { token: cmo.token, body: { reviewSla: { positiveHours: 48, negativeHours: 6 } } });
    expect((await call(app, 'PUT', o('/local-marketing/settings'), { token: foA.token, body: { reviewSla: { positiveHours: 1, negativeHours: 1 } } })).status).toBe(403);
    const tpl = await call(app, 'POST', o('/reviews/templates'), { token: cmo.token, body: { name: 'Sorry', minRating: 1, maxRating: 2, body: 'Hi {first_name}, we are sorry about your visit to {location}. Please contact us.' } });
    expect(tpl.status).toBe(201);
    const reviewedAt = new Date(Date.now() - 3_600_000);
    const [rev] = await app.ctx.db.insert(reviews).values({ organizationId: orgId, locationId: tor.id, source: 'google', externalId: 'accounts/111/locations/222/reviews/r1', authorName: 'Sam Patel', rating: 2, comment: 'Class was overbooked.', reviewedAt }).returning();
    await onReviewReceived(app.ctx, rev!);
    const list = await call(app, 'GET', o('/inbox/conversations?channel=review'), { token: lmA.token });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const conv = list.body.items[0];
    expect(conv.contactName).toBe('Sam Patel');
    expect(new Date(conv.replyDueAt).getTime()).toBe(reviewedAt.getTime() + 6 * 3_600_000);
    expect((await call(app, 'GET', o('/inbox/conversations?channel=review'), { token: foB.token })).body.items).toHaveLength(0);
    const detail = await call(app, 'GET', o(`/inbox/conversations/${conv.id}`), { token: lmA.token });
    expect(detail.body.review).toMatchObject({ rating: 2, needsApproval: true, canApprove: false });
    expect(detail.body.review.templates[0].body).toBe('Hi Sam, we are sorry about your visit to Glow Toronto. Please contact us.');
    expect(detail.body.policy.canReply).toBe(true);
    // The location manager replies from the inbox: negative reviews wait for HQ.
    const sent = await call(app, 'POST', o(`/inbox/conversations/${conv.id}/messages`), { token: lmA.token, body: { kind: 'reply', body: detail.body.review.templates[0].body } });
    expect(sent.status).toBe(201);
    expect(sent.body.status).toBe('pending_approval');
    expect(google.calls.some((c) => c.url.endsWith('/reply'))).toBe(false);
    // HQ approves in Reviews: posted to Google, and the inbox thread shows it sent and closed.
    const dec = await call(app, 'POST', o(`/reviews/${rev!.id}/reply/decision`), { token: cmo.token, body: { decision: 'approve' } });
    expect(dec.body.reply.status).toBe('published');
    expect(google.calls.filter((c) => c.url.endsWith('accounts/111/locations/222/reviews/r1/reply'))).toHaveLength(1);
    const msgs = await app.ctx.db.select().from(commsMessages).where(eq(commsMessages.conversationId, conv.id));
    expect(msgs.filter((m) => m.direction === 'outbound').map((m) => m.status)).toEqual(['sent']);
    const after = (await call(app, 'GET', o(`/inbox/conversations/${conv.id}`), { token: lmA.token })).body;
    expect(after.conversation).toMatchObject({ status: 'closed', replyDueAt: null });
    // Positive review: HQ replies straight from the inbox.
    const [good] = await app.ctx.db.insert(reviews).values({ organizationId: orgId, locationId: tor.id, source: 'google', externalId: 'accounts/111/locations/222/reviews/r2', authorName: 'Lee Wong', rating: 5, comment: 'Lovely.', reviewedAt: new Date() }).returning();
    await onReviewReceived(app.ctx, good!);
    const [g] = await app.ctx.db.select().from(reviews).where(eq(reviews.id, good!.id));
    const r2 = await call(app, 'POST', o(`/inbox/conversations/${g!.conversationId}/messages`), { token: cmo.token, body: { kind: 'reply', body: 'Thank you, Lee!' } });
    expect(r2.body.status).toBe('sent');
    expect((await call(app, 'POST', o(`/inbox/conversations/${g!.conversationId}/messages`), { token: staff.token, body: { kind: 'reply', body: 'x' } })).status).toBe(403);
  });

  /* ------------------------------ Co-op ------------------------------ */

  it('runs a co-op request → claim → reimbursement in the fund ledger, within the allowance', async () => {
    const noProgramme = await call(app, 'POST', o('/coop/requests'), { token: foA.token, body: { locationId: tor.id, kind: 'print', title: 'Flyers', startsOn: '2026-11-02', budgetMinor: 50000 } });
    expect(noProgramme.body.error.code).toBe('coop_not_set_up');
    expect((await call(app, 'PUT', o('/coop/allowances'), { token: foA.token, body: { period: 'quarter', basis: 'fixed', fixedMinor: 100000, matchRatioBps: 5000 } })).status).toBe(403);
    expect((await call(app, 'PUT', o('/coop/allowances'), { token: cmo.token, body: { period: 'quarter', basis: 'fixed', fixedMinor: 100000, matchRatioBps: 5000 } })).status).toBe(200);
    await app.ctx.db.insert(marketingFundEntries).values({ organizationId: orgId, kind: 'contribution', currency: 'CAD', amountMinor: 500000, occurredOn: '2026-10-01', description: 'Contributions', locationId: tor.id });
    const req1 = await call(app, 'POST', o('/coop/requests'), { token: foA.token, body: { locationId: tor.id, kind: 'print', title: 'Opening flyers', vendor: 'PrintCo', startsOn: '2026-11-02', budgetMinor: 80000, creative: [{ kind: 'link', url: 'https://example.com/flyer.pdf', name: 'Flyer' }] } });
    expect(req1.status).toBe(201);
    expect(req1.body).toMatchObject({ status: 'submitted', periodKey: '2026-Q4', currency: 'CAD' });
    expect((await call(app, 'GET', o(`/coop/requests/${req1.body.id}`), { token: foB.token })).status).toBe(404);
    expect((await call(app, 'POST', o(`/coop/requests/${req1.body.id}/decision`), { token: foA.token, body: { decision: 'approve' } })).status).toBe(403);
    const incomplete = await call(app, 'POST', o(`/coop/requests/${req1.body.id}/decision`), { token: cmo.token, body: { decision: 'approve', checklist: [{ key: 'logo', passed: true }] } });
    expect(incomplete.body.error.code).toBe('checklist_incomplete');
    const full = req1.body.checklist.map((c: any) => ({ key: c.key, passed: true }));
    const approved = await call(app, 'POST', o(`/coop/requests/${req1.body.id}/decision`), { token: cmo.token, body: { decision: 'approve', checklist: full } });
    expect(approved.body).toMatchObject({ status: 'approved', approvedMinor: 80000 });
    const sum1 = await call(app, 'GET', o(`/coop/locations/${tor.id}/summary?date=2026-11-02`), { token: foA.token });
    expect(sum1.body).toMatchObject({ allowanceMinor: 100000, committedMinor: 40000, remainingMinor: 60000 });
    // Claim: spent more than approved → capped at the approved budget, then the 50% match.
    const claim = await call(app, 'POST', o(`/coop/requests/${req1.body.id}/claim`), { token: foA.token, body: { spentMinor: 90000, invoice: pdf, proofs: [{ ...pdf, filename: 'photo.pdf' }], proofNotes: '5,000 flyers delivered', performance: { leads: 12 } } });
    expect(claim.status).toBe(201);
    expect(claim.body.status).toBe('claimed');
    const claimId = claim.body.claim.id;
    expect((await call(app, 'GET', o(`/coop/claims/${claimId}/documents/${claim.body.claim.invoiceDocumentId}`), { token: foA.token })).status).toBe(200);
    const dec = await call(app, 'POST', o(`/coop/claims/${claimId}/decision`), { token: cmo.token, body: { decision: 'approve' } });
    expect(dec.body.claim).toMatchObject({ status: 'approved', reimbursableMinor: 40000 });
    expect((await call(app, 'POST', o(`/coop/claims/${claimId}/pay`), { token: foA.token, body: { method: 'manual' } })).status).toBe(403);
    expect((await call(app, 'POST', o(`/coop/claims/${claimId}/pay`), { token: cmo.token, body: { method: 'bank_transfer' } })).status).toBe(400);
    const paid = await call(app, 'POST', o(`/coop/claims/${claimId}/pay`), { token: cmo.token, body: { method: 'bank_transfer', reference: 'TRF-2026-1102' } });
    expect(paid.body.claim).toMatchObject({ status: 'paid', payoutMethod: 'bank_transfer', payoutReference: 'TRF-2026-1102' });
    const [entry] = await app.ctx.db.select().from(marketingFundEntries).where(eq(marketingFundEntries.id, paid.body.claim.fundEntryId));
    expect(entry).toMatchObject({ kind: 'spend', amountMinor: -40000, currency: 'CAD', locationId: tor.id });
    expect(entry!.description).toContain('Co-op reimbursement: Opening flyers');
    // Burn-down: 1,000 allowance − 400 reimbursed. A request whose expected reimbursement exceeds what is left is refused.
    const ov = await call(app, 'GET', o('/coop/overview?date=2026-11-15'), { token: cmo.token });
    expect(ov.body.items.find((x: any) => x.locationId === tor.id)).toMatchObject({ allowanceMinor: 100000, claimedMinor: 40000, paidMinor: 40000, remainingMinor: 60000 });
    expect(ov.body.totals).toEqual([expect.objectContaining({ currency: 'CAD', allowanceMinor: 200000, paidMinor: 40000 })]);
    const req2 = await call(app, 'POST', o('/coop/requests'), { token: foA.token, body: { locationId: tor.id, kind: 'event', title: 'Studio open day', startsOn: '2026-12-05', budgetMinor: 200000 } });
    const tooMuch = await call(app, 'POST', o(`/coop/requests/${req2.body.id}/decision`), { token: cmo.token, body: { decision: 'approve', checklist: full } });
    expect(tooMuch.body.error.code).toBe('coop_allowance_exceeded');
    expect((await call(app, 'POST', o(`/coop/requests/${req2.body.id}/decision`), { token: cmo.token, body: { decision: 'approve', checklist: full, approvedMinor: 120000 } })).body.status).toBe('approved');
    // The west franchisee only sees their own (empty) co-op.
    expect((await call(app, 'GET', o('/coop/requests'), { token: foB.token })).body.items).toHaveLength(0);
  });

  it('lets locations customise only the open fields of approved brand templates', async () => {
    const t = await call(app, 'POST', o('/coop/asset-templates'), { token: cmo.token, body: { name: 'Open day poster', kind: 'poster', status: 'published', fields: [{ key: 'headline', label: 'Headline', locked: true, default: 'Find your calm' }, { key: 'offer', label: 'Offer', locked: false, default: 'First class free', maxLength: 40 }] } });
    expect(t.status).toBe(201);
    expect((await call(app, 'POST', o('/coop/asset-templates'), { token: foA.token, body: { name: 'Mine', kind: 'poster', fields: [{ key: 'a', label: 'A', locked: false }] } })).status).toBe(403);
    expect((await call(app, 'POST', o(`/coop/asset-templates/${t.body.id}/versions`), { token: foA.token, body: { locationId: tor.id, values: { headline: 'Cheap yoga' } } })).body.error.code).toBe('locked_or_too_long');
    const v = await call(app, 'POST', o(`/coop/asset-templates/${t.body.id}/versions`), { token: foA.token, body: { locationId: tor.id, values: { offer: 'Two weeks for $20' } } });
    expect(v.body.values).toEqual({ headline: 'Find your calm', offer: 'Two weeks for $20' });
    expect((await call(app, 'POST', o(`/coop/asset-templates/${t.body.id}/versions`), { token: foB.token, body: { locationId: tor.id, values: { offer: 'x' } } })).status).toBe(403);
  });

  /* ------------------------------ Call tracking ------------------------------ */

  it('tracks calls: recording rules, missed-call leads, signed webhooks, attribution and DNI', async () => {
    const camp = await call(app, 'POST', o('/ad-campaigns'), { token: cmo.token, body: { kind: 'network', name: 'Spring intro', objective: 'leads', platforms: ['google'], startsOn: '2026-11-01', creative: { headline: 'Spring', body: 'Try us' }, locationIds: [tor.id], budget: { mode: 'split', totals: { CAD: 10000 } } } });
    expect(camp.status).toBe(201);
    const campaignId = camp.body.id as string;
    const denied = await call(app, 'POST', o('/call-tracking/numbers'), { token: cmo.token, body: { locationId: tor.id, label: 'Google Ads', source: 'google_ads', campaignId, recordCalls: true } });
    expect(denied.body.error.code).toBe('recording_not_allowed');
    expect((await call(app, 'POST', o('/call-tracking/numbers'), { token: foA.token, body: { locationId: tor.id, label: 'Mine', source: 'website' } })).status).toBe(403);
    await call(app, 'PUT', o('/local-marketing/settings'), { token: cmo.token, body: { callRecording: { enabled: true, jurisdictions: { 'CA-ON': { message: 'This call may be recorded for quality and training.' } } } } });
    const n1 = await call(app, 'POST', o('/call-tracking/numbers'), { token: cmo.token, body: { locationId: tor.id, label: 'Google Ads', source: 'google_ads', campaignId, recordCalls: true, dniMatch: { utmSource: 'google' } } });
    expect(n1.status).toBe(201);
    expect(n1.body).toMatchObject({ mode: 'sandbox', forwardTo: '+14165550100', recordCalls: true });
    expect(n1.body.number).toMatch(/^\+141655501\d\d$/);
    const n2 = await call(app, 'POST', o('/call-tracking/numbers'), { token: cmo.token, body: { locationId: tor.id, label: 'Website', source: 'website', isDefault: true } });
    // Vancouver (BC) has no recording rule.
    expect((await call(app, 'POST', o('/call-tracking/numbers'), { token: cmo.token, body: { locationId: van.id, label: 'Print', source: 'print', recordCalls: true } })).body.error.code).toBe('recording_not_allowed');
    const answered = await call(app, 'POST', o(`/call-tracking/numbers/${n1.body.id}/simulate`), { token: lmA.token, body: { from: '+1 647 555 0123', outcome: 'answered', durationSeconds: 120 } });
    expect(answered.status).toBe(201);
    expect(answered.body.twiml).toContain('<Say language="en">This call may be recorded for quality and training.</Say>');
    expect(answered.body.twiml).toContain('record="record-from-answer-dual"');
    expect(answered.body.twiml).toContain('>+14165550100</Dial>');
    expect(answered.body.call).toMatchObject({ status: 'answered', durationSeconds: 120, source: 'google_ads', campaignId, recorded: true });
    const missed = await call(app, 'POST', o(`/call-tracking/numbers/${n2.body.id}/simulate`), { token: lmA.token, body: { from: '+1 647 555 0199', callerName: 'Jordan Lee', outcome: 'missed' } });
    expect(missed.body.call).toMatchObject({ status: 'missed', recorded: false });
    expect(missed.body.twiml).not.toContain('<Say');
    const [lead] = await app.ctx.db.select().from(leads).where(eq(leads.id, missed.body.call.leadId));
    expect(lead).toMatchObject({ source: 'phone_call', phone: '+16475550199', locationId: tor.id, name: 'Jordan Lee' });
    // Webhooks with a wrong signature are refused; a correctly signed one for an unknown number just hangs up.
    const params = { CallSid: 'CA123', To: n1.body.number, From: '+15555550100' };
    const bad = await app.inject({ method: 'POST', url: '/v1/webhooks/call-tracking/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' }, payload: new URLSearchParams(params).toString() });
    expect(bad.statusCode).toBe(401);
    const unknown = { CallSid: 'CA124', To: '+19999999999', From: '+15555550100' };
    const ok = await app.inject({ method: 'POST', url: '/v1/webhooks/call-tracking/twilio/voice', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signVoicePayload(app.ctx.cfg, voiceWebhookUrl(app.ctx.cfg), unknown) }, payload: new URLSearchParams(unknown).toString() });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('<Hangup/>');
    // Call log and report: scoped to the franchisee's locations.
    expect((await call(app, 'GET', o('/call-tracking/calls'), { token: foA.token })).body.items).toHaveLength(2);
    expect((await call(app, 'GET', o('/call-tracking/calls'), { token: foB.token })).body.items).toHaveLength(0);
    const rep = await call(app, 'GET', o('/call-tracking/report'), { token: cmo.token });
    expect(rep.body.totals).toMatchObject({ calls: 2, answered: 1, missed: 1, leads: 1 });
    expect(rep.body.bySource.map((x: any) => x.key).sort()).toEqual(['google_ads', 'website']);
    const c = await call(app, 'GET', o(`/ad-campaigns/${campaignId}`), { token: cmo.token });
    expect(c.body.calls).toBe(1);
    expect(c.body.locations[0]).toMatchObject({ calls: 1, answeredCalls: 1 });
    // DNI: Google visitors see the Google Ads number, everyone else the website default.
    const dni = (q: string) => call(app, 'GET', `/v1/public/call-tracking/${orgSlug}/${tor.slug}${q}`);
    expect((await dni('?utm_source=google')).body.number).toBe(n1.body.number);
    expect((await dni('')).body).toEqual({ number: n2.body.number, replaces: '+1 416 555 0100' });
    // Releasing stops forwarding.
    expect((await call(app, 'POST', o(`/call-tracking/numbers/${n1.body.id}/release`), { token: cmo.token })).body.status).toBe('released');
    expect((await dni('?utm_source=google')).body.number).toBe(n2.body.number);
    const calls = await app.ctx.db.select().from(trackedCalls).where(eq(trackedCalls.organizationId, orgId));
    expect(calls.every((c) => c.sandbox)).toBe(true);
  });

  /* ------------------------------ Local social ------------------------------ */

  it('lets locations localise HQ calendar posts and schedule them on their own accounts', async () => {
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const item = await call(app, 'POST', o('/social/calendar'), { token: cmo.token, body: { title: 'Spring classes', body: 'Spring is here at {location} in {city}! Book: {booking_link}', networks: ['facebook'], suggestedAt: when } });
    expect(item.status).toBe(201);
    expect((await call(app, 'POST', o('/social/calendar'), { token: foA.token, body: { title: 'Mine', body: 'My post', suggestedAt: when } })).status).toBe(403);
    // Drafts are HQ-only.
    const draftView = await call(app, 'GET', o('/social/calendar'), { token: foA.token });
    expect(draftView.body.items, JSON.stringify(draftView.body)).toHaveLength(0);
    await call(app, 'POST', o(`/social/calendar/${item.body.id}/status`), { token: cmo.token, body: { status: 'published' } });
    const prev = await call(app, 'GET', o(`/social/calendar/${item.body.id}/preview?locationId=${tor.id}`), { token: foA.token });
    expect(prev.body.body).toBe('Spring is here at Glow Toronto in Toronto! Book: {booking_link}');
    expect(prev.body.missing).toEqual(['booking_link']);
    expect((await call(app, 'POST', o(`/social/calendar/${item.body.id}/adopt`), { token: foA.token, body: { locationId: tor.id } })).body.error.code).toBe('missing_details');
    await call(app, 'PATCH', o(`/listings/${tor.id}`), { token: cmo.token, body: { bookingUrl: 'https://glow.example/toronto/book' } });
    expect((await call(app, 'POST', o(`/social/calendar/${item.body.id}/adopt`), { token: foA.token, body: { locationId: tor.id } })).body.error.code).toBe('no_accounts');
    const acct = await call(app, 'POST', o('/social/accounts'), { token: foA.token, body: { network: 'facebook', handle: 'Glow Toronto', ownerKind: 'location', locationId: tor.id } });
    expect(acct.status).toBe(201);
    expect((await call(app, 'POST', o(`/social/calendar/${item.body.id}/adopt`), { token: foA.token, body: { locationId: tor.id, body: 'My own words' } })).body.error.code).toBe('edits_not_allowed');
    expect((await call(app, 'POST', o(`/social/calendar/${item.body.id}/adopt`), { token: foB.token, body: { locationId: tor.id } })).status).toBe(403);
    const adopted = await call(app, 'POST', o(`/social/calendar/${item.body.id}/adopt`), { token: foA.token, body: { locationId: tor.id } });
    expect(adopted.status).toBe(201);
    expect(adopted.body).toMatchObject({ status: 'scheduled', body: 'Spring is here at Glow Toronto in Toronto! Book: https://glow.example/toronto/book', accountIds: [acct.body.id] });
    const [post] = await app.ctx.db.select().from(socialPosts).where(eq(socialPosts.id, adopted.body.postId));
    expect(post).toMatchObject({ locationId: tor.id, needsApproval: false });
    expect((await call(app, 'POST', o(`/social/calendar/${item.body.id}/adopt`), { token: foA.token, body: { locationId: tor.id } })).body.error.code).toBe('already_scheduled');
    const cal = await call(app, 'GET', o('/social/calendar'), { token: cmo.token });
    expect(cal.body.items[0].adoptions).toEqual([expect.objectContaining({ locationId: tor.id, status: 'scheduled', postStatus: 'scheduled' })]);
    expect((await call(app, 'GET', o('/social/calendar'), { token: foB.token })).body.items[0].adoptions).toEqual([]);
  });
});
