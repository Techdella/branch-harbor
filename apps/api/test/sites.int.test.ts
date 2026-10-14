import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DnsChecker } from '../src/integrations/domains.ts';
import { contrast, normaliseHours, openNow, themeFrom, siteSettingsSchema } from '../src/routes/sites.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe('sites helpers (pure)', () => {
  it('derives an accessible theme from any brand colour', () => {
    for (const c of ['#D6F26B', '#FFFF00', '#777777', '#2F6B3A', '#141414', '#FFFFFF']) {
      const t = themeFrom(siteSettingsSchema.parse({ primaryColor: c }));
      expect(contrast(t.primary, t.onPrimary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.primaryInk, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    }
    expect(siteSettingsSchema.parse({}).poweredBy).toBe(false);
    expect(siteSettingsSchema.safeParse({ font: 'comic-sans' }).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ logoUrl: 'http://insecure.example/logo.png' }).success).toBe(false);
  });

  it('computes open-now in the location timezone, including overnight hours, and never guesses from a summary', () => {
    const weekly = normaliseHours({ weekly: [{ day: 1, opens: '09:00', closes: '17:00' }, { day: 5, opens: '18:00', closes: '02:00' }, { day: 2, opens: 'bad', closes: '10:00' }] }).weekly;
    expect(weekly).toHaveLength(2);
    // Monday 2026-10-12 10:00 in Toronto = 14:00Z
    expect(openNow(weekly, 'America/Toronto', new Date('2026-10-12T14:00:00Z'))).toEqual({ open: true, closesAt: '17:00' });
    // Same instant is 07:00 in Seattle → closed
    expect(openNow(weekly, 'America/Los_Angeles', new Date('2026-10-12T14:00:00Z'))).toEqual({ open: false, closesAt: null });
    // Saturday 01:00 local after Friday-night opening
    expect(openNow(weekly, 'Europe/London', new Date('2026-10-17T00:00:00Z'))?.open).toBe(true);
    expect(openNow(normaliseHours({ summary: 'Daily 6am–8pm' }).weekly, 'Europe/London')).toBeNull();
  });
});

describe.skipIf(!hasDb)('public hosted sites API (DB)', () => {
  let app: FastifyInstance;
  const dns = { cnameOk: false, txtOk: false };
  const fakeDns: DnsChecker = { check: async () => ({ ...dns }) };
  let token: string;
  let org: Record<string, any>;
  let loc: Record<string, any>;
  let hidden: Record<string, any>;
  let pageId: string;
  let siteId: string;

  beforeAll(async () => {
    app = await makeApp({ dns: fakeDns });
    ({ token } = await verifiedUser(app));
    org = await createOrg(app, token, { name: `Sites ${uid()}` });
    loc = await createLocation(app, token, org.id, { name: 'Harbourfront' });
    await enablePublicAndPayments(app, token, org.id, loc.id);
    await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${loc.id}`, { token, body: { hours: { summary: 'Mon 9–5', weekly: [{ day: 1, opens: '09:00', closes: '17:00' }] } } });
    hidden = await createLocation(app, token, org.id, { name: 'Not yet open', status: 'opening_soon' });
    const tpl = await call(app, 'POST', `/v1/orgs/${org.id}/templates`, {
      token, body: { name: 'Home', fields: [
        { key: 'brand_tagline', label: 'Tagline', policy: 'locked', defaultValue: 'Breathe easy' },
        { key: 'hero_title', label: 'Hero', policy: 'editable', defaultValue: 'Welcome' },
      ] },
    });
    expect(tpl.status).toBe(201);
    const site = await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token, body: { locationId: loc.id, templateId: tpl.body.id } });
    expect(site.status).toBe(201);
    siteId = site.body.id;
    pageId = site.body.pages[0].id;
    await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token, body: { locationId: hidden.id, templateId: tpl.body.id } });
  });
  afterAll(async () => { await app?.close(); });

  it('serves brand data with only customer-visible locations and a default (non-BranchHarbor) theme', async () => {
    const r = await call(app, 'GET', `/v1/public/sites/${org.slug}`);
    expect(r.status).toBe(200);
    expect(r.body.brand).toMatchObject({ slug: org.slug, industry: 'studios', poweredBy: false });
    expect(r.body.locations.map((l: any) => l.slug)).toEqual([loc.slug]);
    expect(r.body.locations[0].hours.weekly).toHaveLength(1);
    expect(typeof r.body.locations[0].openNow.open).toBe('boolean');
    expect(r.body.site.includedAddress).toBe(`https://sites.branchharbor.com/${org.slug}`);
    expect((await call(app, 'GET', '/v1/public/sites/does-not-exist')).status).toBe(404);
  });

  it('never exposes drafts: nothing before publishing, then only the published snapshot', async () => {
    const before = await call(app, 'GET', `/v1/public/sites/${org.slug}/${loc.slug}`);
    expect(before.status).toBe(200);
    expect(before.body.pages).toEqual([]);
    expect(before.body.module).toMatchObject({ kind: 'studios', mode: 'native', paymentsEnabled: true });

    await call(app, 'PATCH', `/v1/orgs/${org.id}/pages/${pageId}/fields`, { token, body: { fields: { hero_title: 'Published hero' } } });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/pages/${pageId}/publish`, { token })).status).toBe(200);
    // A later edit puts the page back in draft — it must not show publicly.
    const edit = await call(app, 'PATCH', `/v1/orgs/${org.id}/pages/${pageId}/fields`, { token, body: { fields: { hero_title: 'DRAFT hero — not live' } } });
    expect(edit.status).toBe(200);
    expect(edit.body.page.status).toBe('draft');

    const after = await call(app, 'GET', `/v1/public/sites/${org.slug}/${loc.slug}`);
    expect(after.body.pages).toHaveLength(1);
    expect(after.body.pages[0]).toMatchObject({ slug: 'home', version: 1, content: { hero_title: 'Published hero', brand_tagline: 'Breathe easy' } });
    expect(JSON.stringify(after.body)).not.toContain('DRAFT hero');
    const brand = await call(app, 'GET', `/v1/public/sites/${org.slug}`);
    expect(brand.body.locations[0].pages).toEqual([expect.objectContaining({ slug: 'home' })]);
  });

  it('404s hidden (not-yet-public) and archived locations, including their products and hosts', async () => {
    expect((await call(app, 'GET', `/v1/public/sites/${org.slug}/${hidden.slug}`)).status).toBe(404);
    expect((await call(app, 'GET', `/v1/public/sites/${org.slug}/${hidden.slug}/products`)).status).toBe(404);
    expect((await call(app, 'GET', `/v1/public/sites/${org.slug}/nope`)).status).toBe(404);
  });

  it('resolve-host only resolves domains in state ready', async () => {
    const hostname = `www.harbour-${uid()}.example`;
    const add = await call(app, 'POST', `/v1/orgs/${org.id}/domains`, { token, body: { hostname, websiteId: siteId } });
    expect(add.status).toBe(201);
    const q = `/v1/public/sites/resolve-host?host=${hostname}`;
    expect((await call(app, 'GET', q)).status).toBe(404); // awaiting_dns
    dns.cnameOk = true; dns.txtOk = true;
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/verify`, { token })).body.state).toBe('certificate_pending');
    expect((await call(app, 'GET', q)).status).toBe(404);
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/verify`, { token })).body.state).toBe('ready');
    const ok = await call(app, 'GET', `/v1/public/sites/resolve-host?host=${hostname.toUpperCase()}:443`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ hostname, brandSlug: org.slug, locationSlug: loc.slug, isPrimary: false, primaryHost: null });
    await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/primary`, { token });
    expect((await call(app, 'GET', q)).body.primaryHost).toBe(hostname);
    expect((await call(app, 'GET', `/v1/public/sites/${org.slug}/${loc.slug}`)).body.site.primaryHost).toBe(hostname);

    // Hiding the location removes it from host resolution too.
    await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${loc.id}`, { token, body: { publiclyVisible: false } });
    expect((await call(app, 'GET', q)).status).toBe(404);
    expect((await call(app, 'GET', `/v1/public/sites/${org.slug}/${loc.slug}`)).status).toBe(404);
    await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${loc.id}`, { token, body: { publiclyVisible: true } });
  });

  it('stores a brand theme (safe fonts only, Powered by opt-in) and exposes it publicly', async () => {
    const bad = await call(app, 'PUT', `/v1/orgs/${org.id}/sites/settings`, { token, body: { font: 'papyrus' } });
    expect(bad.status).toBe(400);
    const put = await call(app, 'PUT', `/v1/orgs/${org.id}/sites/settings`, { token, body: { primaryColor: '#D6F26B', font: 'lora', enabledLocales: ['fr'], tagline: 'Calm, close to home' } });
    expect(put.status).toBe(200);
    expect(put.body.theme.onPrimary).toBe('#141414');
    const pub = await call(app, 'GET', `/v1/public/sites/${org.slug}`);
    expect(pub.body.brand).toMatchObject({ tagline: 'Calm, close to home', poweredBy: false, locales: ['en', 'fr'], theme: { primary: '#D6F26B', brandColor: '#D6F26B', font: 'lora' } });
    const outsider = await verifiedUser(app);
    expect((await call(app, 'PUT', `/v1/orgs/${org.id}/sites/settings`, { token: outsider.token, body: {} })).status).toBe(404);
  });

  it('class-booking manage view requires the manage token', async () => {
    const ct = await call(app, 'POST', `/v1/orgs/${org.id}/studios/class-types`, { token, body: { name: 'Flow', durationMinutes: 60, defaultCapacity: 1 } });
    const occ = await call(app, 'POST', `/v1/orgs/${org.id}/studios/occurrences`, { token, body: { locationId: loc.id, classTypeId: ct.body.id, startsAt: new Date(Date.now() + 2 * 86400_000).toISOString(), capacity: 1, priceMinor: 2500 } });
    expect(occ.status).toBe(201);
    const occId = (occ.body.items ?? [occ.body])[0].id;
    const b = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Ada', email: `ada-${uid()}@example.com` } } });
    expect(b.body.outcome).toBe('held');
    expect((await call(app, 'GET', `/v1/public/sites/manage/class-bookings/${b.body.bookingId}?token=wrong-token-123`)).status).toBe(404);
    const m = await call(app, 'GET', `/v1/public/sites/manage/class-bookings/${b.body.bookingId}?token=${b.body.manageToken}`);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ status: 'held', cancellable: true, price: { amount: 2500, currency: 'CAD' }, location: { timeZone: 'America/Toronto' } });
    await call(app, 'POST', `/v1/public/payments/${b.body.payment.id}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
    const m2 = await call(app, 'GET', `/v1/public/sites/manage/class-bookings/${b.body.bookingId}?token=${b.body.manageToken}`);
    expect(m2.body).toMatchObject({ status: 'confirmed', payment: { state: 'succeeded' } });

    // Class is now full → waitlist; the waitlist place is only visible with its own manage token.
    const w = await call(app, 'POST', `/v1/public/studios/occurrences/${occId}/bookings`, { body: { contact: { name: 'Bo', email: `bo-${uid()}@example.com` }, joinWaitlist: true } });
    expect(w.body).toMatchObject({ outcome: 'waitlisted', position: 1 });
    expect((await call(app, 'GET', `/v1/public/sites/manage/waitlist/${w.body.waitlistEntryId}?token=${b.body.manageToken}`)).status).toBe(404);
    const wm = await call(app, 'GET', `/v1/public/sites/manage/waitlist/${w.body.waitlistEntryId}?token=${w.body.manageToken}`);
    expect(wm.body).toMatchObject({ status: 'waiting', canLeave: true, class: { name: 'Flow' } });
  });
});
