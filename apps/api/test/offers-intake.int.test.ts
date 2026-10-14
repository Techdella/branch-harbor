import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { classBookings, customers, intakeResponses } from '../src/db/schema/index.ts';
import { zonedToUtc } from '../src/lib/tz.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('studio introductory offers with eligibility rules (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let orgId: string;
  let tor: any;
  let lon: any;
  let offer: any;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'HQ Owner');
    orgId = (await createOrg(app, owner.token)).id;
    tor = await createLocation(app, owner.token, orgId, { name: 'Queen West' });
    lon = await createLocation(app, owner.token, orgId, { name: 'Shoreditch', currency: 'GBP', timeZone: 'Europe/London', address: { line1: '1 Rivington St', city: 'London', country: 'GB' } });
    for (const l of [tor, lon]) await call(app, 'PATCH', `/v1/orgs/${orgId}/locations/${l.id}`, { token: owner.token, body: { publiclyVisible: true, status: 'operating' } });
  });
  afterAll(async () => { await app?.close(); });

  it('HQ creates a network offer priced per currency; locations without a price do not show it', async () => {
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/studios/offers`, { token: owner.token, body: { name: 'Intro week', kind: 'intro_pass', prices: { CAD: 2500 }, credits: 3, validDays: 7, status: 'active', eligibility: { newCustomersOnly: true, maxPerCustomer: 1, minAge: 16 } } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ scope: 'network', rules: ['New customers only', 'Once per customer', 'Ages 16+'] });
    offer = r.body;
    const pubTor = await call(app, 'GET', `/v1/public/studios/${tor.id}/offers`);
    expect(pubTor.body.items[0]).toMatchObject({ name: 'Intro week', price: { amount: 2500, currency: 'CAD' } });
    expect((await call(app, 'GET', `/v1/public/studios/${lon.id}/offers`)).body.items).toEqual([]);
    // A location manager can't create network offers; staff can't create any.
    const mgr = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: tor.id });
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/studios/offers`, { token: mgr.token, body: { name: 'x', prices: { CAD: 1 } } })).status).toBe(403);
    // PATCH only changes what is sent (status stays active).
    const p = await call(app, 'PATCH', `/v1/orgs/${orgId}/studios/offers/${offer.id}`, { token: owner.token, body: { prices: { CAD: 2500, GBP: 1500 } } });
    expect(p.body).toMatchObject({ status: 'active', kind: 'intro_pass', validDays: 7 });
    expect((await call(app, 'GET', `/v1/public/studios/${lon.id}/offers`)).body.items[0].price).toEqual({ amount: 1500, currency: 'GBP' });
  });

  it('reports every failed rule and enforces them on redemption', async () => {
    const [young] = await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: tor.id, name: 'Young One', dateOfBirth: '2015-04-01' }).returning();
    const [nodob] = await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: tor.id, name: 'No Dob' }).returning();
    const [adult] = await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: tor.id, name: 'New Adult', dateOfBirth: '1990-01-01' }).returning();
    const check = (customerId: string) => call(app, 'POST', `/v1/orgs/${orgId}/studios/offers/${offer.id}/eligibility`, { token: owner.token, body: { locationId: tor.id, customerId } });
    expect((await check(young!.id)).body.reasons.map((r: any) => r.code)).toEqual(['under_age']);
    expect((await check(nodob!.id)).body.reasons.map((r: any) => r.code)).toEqual(['age_unknown']);
    expect((await check(adult!.id)).body).toMatchObject({ eligible: true, price: { amount: 2500, currency: 'CAD' } });

    const redeem = () => call(app, 'POST', `/v1/orgs/${orgId}/studios/offers/${offer.id}/redemptions`, { token: owner.token, body: { locationId: tor.id, customerId: adult!.id } });
    expect((await redeem()).status).toBe(201);
    const second = await redeem();
    expect(second.status).toBe(409);
    expect(second.body.error.details.reasons.map((r: any) => r.code)).toEqual(['not_new_customer', 'redemption_limit']);

    // A returning customer (has a past booking) is not a new customer.
    const [ret] = await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: tor.id, name: 'Returning', dateOfBirth: '1985-01-01' }).returning();
    const ct = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/class-types`, { token: owner.token, body: { locationId: tor.id, name: 'Flow', durationMinutes: 60, defaultCapacity: 5 } })).body.id;
    const occ = (await call(app, 'POST', `/v1/orgs/${orgId}/studios/occurrences`, { token: owner.token, body: { locationId: tor.id, classTypeId: ct, startsAt: new Date(Date.now() + 86400_000).toISOString() } })).body.items[0];
    await app.ctx.db.insert(classBookings).values({ organizationId: orgId, locationId: tor.id, occurrenceId: occ.id, customerId: ret!.id, status: 'attended' });
    expect((await check(ret!.id)).body.reasons.map((r: any) => r.code)).toEqual(['not_new_customer']);

    // Paused offers are not eligible for anyone.
    await call(app, 'PATCH', `/v1/orgs/${orgId}/studios/offers/${offer.id}`, { token: owner.token, body: { status: 'paused' } });
    expect((await check(adult!.id)).body.reasons.map((r: any) => r.code)).toContain('offer_not_active');
    const list = await call(app, 'GET', `/v1/orgs/${orgId}/studios/offers`, { token: owner.token });
    expect(list.body.items[0]).toMatchObject({ redemptions: 1, status: 'paused' });
  });
});

describe.skipIf(!hasDb)('wellness intake forms: versioned questions + consent, responses excluded from AI (DB)', () => {
  let app: FastifyInstance;
  let token: string;
  let orgId: string;
  let loc: any;
  let svc: any;
  let form: any;
  const day = new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await makeApp();
    ({ token } = await verifiedUser(app));
    orgId = (await createOrg(app, token, { industry: 'wellness', country: 'IE', defaultCurrency: 'EUR', defaultTimeZone: 'Europe/Dublin', dataRegion: 'eu' })).id;
    loc = await createLocation(app, token, orgId, { name: 'Dublin', currency: 'EUR', timeZone: 'Europe/Dublin', address: { line1: '1 Grafton St', city: 'Dublin', country: 'IE' } });
    await call(app, 'PATCH', `/v1/orgs/${orgId}/locations/${loc.id}`, { token, body: { publiclyVisible: true } });
    svc = (await call(app, 'POST', `/v1/orgs/${orgId}/wellness/services`, { token, body: { locationId: loc.id, name: 'Restorative massage', durationMinutes: 60, priceMinor: 0 } })).body;
    await call(app, 'POST', `/v1/orgs/${orgId}/wellness/practitioners`, { token, body: { locationId: loc.id, name: 'Niamh Byrne', serviceIds: [svc.id], availability: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) } });
  });
  afterAll(async () => { await app?.close(); });

  it('creates a form, validates answers and consent version, and never marks responses for AI context', async () => {
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/wellness/intake-forms`, {
      token, body: {
        name: 'New client intake', serviceIds: [svc.id], status: 'active', consentVersion: '2026-10', consentText: 'I agree that Harbourline may store these answers to prepare my visit.',
        questions: [
          { id: 'goals', label: 'What would you like from your visit?', type: 'longtext', required: true },
          { id: 'pressure', label: 'Preferred pressure', type: 'choice', required: true, options: ['Light', 'Medium', 'Firm'] },
          { id: 'reminders', label: 'Text reminders?', type: 'yes_no', required: false },
        ],
      },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ version: 1, aiContext: 'excluded' });
    form = r.body;
    const pub = await call(app, 'GET', `/v1/public/wellness/${loc.id}/intake-forms?serviceId=${svc.id}`);
    expect(pub.body.items[0]).toMatchObject({ id: form.id, consent: { version: '2026-10' } });

    const appt = await call(app, 'POST', `/v1/public/wellness/${loc.id}/appointments`, { body: { serviceId: svc.id, startsAt: zonedToUtc(day, '10:00', 'Europe/Dublin').toISOString(), contact: { name: 'Clara Client', email: `c-${uid()}@example.com` } } });
    expect(appt.status).toBe(201);
    const submit = (body: any) => call(app, 'POST', `/v1/public/wellness/intake-forms/${form.id}/responses`, { body: { appointmentId: appt.body.appointment.id, manageToken: appt.body.manageToken, ...body } });

    const bad = await submit({ answers: { pressure: 'Extreme', extra: 'x' }, consent: { accepted: true, version: '2026-10' } });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.error.fields)).toEqual(expect.arrayContaining(['answers.goals', 'answers.pressure', 'answers.extra']));
    expect((await submit({ answers: { goals: 'Relax', pressure: 'Medium' }, consent: { accepted: false, version: '2026-10' } })).status).toBe(400);
    expect((await submit({ answers: { goals: 'Relax', pressure: 'Medium' }, consent: { accepted: true, version: '2025-01' } })).body.error.code).toBe('consent_version_changed');
    expect((await call(app, 'POST', `/v1/public/wellness/intake-forms/${form.id}/responses`, { body: { appointmentId: appt.body.appointment.id, manageToken: 'wrong-token-123', answers: {}, consent: { accepted: true, version: '2026-10' } } })).status).toBe(404);

    const ok = await submit({ answers: { goals: 'Ease shoulder tension', pressure: 'Medium', reminders: true }, consent: { accepted: true, version: '2026-10' } });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ formVersion: 1, consentVersion: '2026-10' });
    const [row] = await app.ctx.db.select().from(intakeResponses).where(eq(intakeResponses.id, ok.body.id));
    expect(row!.aiContextExcluded).toBe(true);

    // Changing the consent text requires a new version; responses keep the version they answered.
    expect((await call(app, 'PATCH', `/v1/orgs/${orgId}/wellness/intake-forms/${form.id}`, { token, body: { consentText: 'Updated statement about storing answers.' } })).status).toBe(400);
    const v2 = await call(app, 'PATCH', `/v1/orgs/${orgId}/wellness/intake-forms/${form.id}`, { token, body: { consentText: 'Updated statement about storing answers.', consentVersion: '2026-11' } });
    expect(v2.body).toMatchObject({ version: 2, status: 'active' });
    const responses = await call(app, 'GET', `/v1/orgs/${orgId}/wellness/intake-forms/${form.id}/responses`, { token });
    expect(responses.body.items[0]).toMatchObject({ formVersion: 1, consentVersion: '2026-10', aiContextExcluded: true, customer: { name: 'Clara Client' } });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/wellness/intake-forms`, { token })).body.items[0].responses).toBe(1);
  });

  it('staff without customer access cannot read responses', async () => {
    const staff = await memberWithRole(app, token, orgId, 'staff', { kind: 'location', id: loc.id });
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/wellness/intake-forms/${form.id}/responses`, { token: staff.token })).body.items).toEqual([]);
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/wellness/intake-forms`, { token: staff.token, body: { name: 'x', questions: [{ id: 'a', label: 'a', type: 'text' }], consentVersion: '1', consentText: 'xxxxxxxxxxxx' } })).status).toBe(403);
  });
});
