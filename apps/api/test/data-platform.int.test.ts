import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import {
  benchmarkContributions, consentRecords, customers, dailySales, invitations, locations, organizations, pages, salesConnections, salesSyncRuns,
} from '../src/db/schema/index.ts';
import type { FetchLike } from '../src/integrations/partners/http.ts';
import { recomputeBenchmarks, lastFullMonth } from '../src/services/benchmarks.ts';
import { writeXlsx } from '../src/lib/xlsx.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

const fx = (name: string) => readFileSync(new URL(`./fixtures/sales/${name}`, import.meta.url), 'utf8');
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

/** Live-mode partner HTTP for the second app: Square OAuth + locations + orders, with a switch to expire the token. */
const live = { expired: false, calls: [] as string[] };
const squareFetch: FetchLike = async (url, init) => {
  live.calls.push(`${init?.method ?? 'GET'} ${url}`);
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (/oauth2\/token/.test(url)) return json(200, { access_token: 'EAAA-live', refresh_token: 'R', expires_at: '2027-01-01T00:00:00Z', merchant_id: 'MLR' });
  if (live.expired) return json(401, { errors: [{ code: 'UNAUTHORIZED', detail: 'expired' }] });
  if (/v2\/locations/.test(url)) return json(200, { locations: [{ id: 'L1W8Q7A3', name: 'Queen West', currency: 'CAD', timezone: 'America/Toronto' }, { id: 'L2', name: 'Other', currency: 'CAD' }] });
  if (/orders\/search/.test(url)) return json(200, fx('square-orders-search.json'));
  return json(599, { message: `no mock for ${url}` });
};

/**
 * Network data platform: POS / booking sales connectors (sandbox and live OAuth, sync idempotency, expired tokens),
 * gross-sales sources feeding royalty statements, self-reported variance, reconciliation; the import wizard (vendor
 * templates, consent, dry run, run, undo, role mapping, XLSX); bulk launch; opt-in benchmarks with k-anonymity; and
 * scope isolation throughout.
 */
describe.skipIf(!hasDb)('network data platform (DB)', () => {
  let app: FastifyInstance;
  let liveApp: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let hq: Awaited<ReturnType<typeof verifiedUser>>;
  let fin: Awaited<ReturnType<typeof verifiedUser>>;
  let fo1: Awaited<ReturnType<typeof verifiedUser>>;
  let fo2: Awaited<ReturnType<typeof verifiedUser>>;
  let staff: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let g1: string;
  let tor: string;
  let van: string;
  let lon: string;
  let torConn: string;
  let vanConn: string;
  const SC = () => `/v1/orgs/${orgId}/sales-connectors`;
  const IM = () => `/v1/orgs/${orgId}/imports`;
  const callbackPath = (url: string) => { const u = new URL(url); return `${u.pathname}${u.search}`; };

  beforeAll(async () => {
    app = await makeApp();
    liveApp = await makeApp({ partnerFetch: squareFetch }, { SQUARE_APPLICATION_ID: 'sq0idp-test', SQUARE_APPLICATION_SECRET: 'sq0csp-test' });
    owner = await verifiedUser(app, 'Franchisor CEO');
    orgId = (await createOrg(app, owner.token, { name: `Northlight ${uid()}` })).id;
    g1 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Pacific Heat' } })).body.id;
    const g2 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Thames Hot Yoga' } })).body.id;
    tor = (await createLocation(app, owner.token, orgId, { name: 'Toronto Annex', code: 'TOR-1', ownerGroupId: g1 })).id;
    van = (await createLocation(app, owner.token, orgId, { name: 'Vancouver Main', code: 'VAN-1', ownerGroupId: g1, timeZone: 'America/Vancouver', address: { line1: '1 Main', city: 'Vancouver', country: 'CA' } })).id;
    lon = (await createLocation(app, owner.token, orgId, { name: 'London Hackney', code: 'LON-1', ownerGroupId: g2, timeZone: 'Europe/London', currency: 'GBP', address: { line1: '1 Mare St', city: 'London', country: 'GB' } })).id;
    hq = await memberWithRole(app, owner.token, orgId, 'hq_admin', { kind: 'organization', id: orgId }, 'HQ Admin');
    fin = await memberWithRole(app, owner.token, orgId, 'finance_lead', { kind: 'organization', id: orgId }, 'Finance');
    fo1 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g1 }, 'Owner Pacific');
    fo2 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g2 }, 'Owner Thames');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: tor }, 'Staff Toronto');
  });
  afterAll(async () => { await app?.close(); await liveApp?.close(); });

  /* ------------------------------ connectors ------------------------------ */

  it('keeps sales connectors away from staff and scopes franchise owners to their own locations', async () => {
    expect((await call(app, 'GET', SC(), { token: staff.token })).body.error.code).toBe('module_not_available');
    const mine = await call(app, 'GET', SC(), { token: fo1.token });
    expect(mine.status).toBe(200);
    expect(mine.body.locations.map((l: any) => l.name).sort()).toEqual(['Toronto Annex', 'Vancouver Main']);
    expect(mine.body.can).toEqual({ edit: true, publish: false, export: true });
    expect(mine.body.catalog.map((c: any) => c.provider)).toEqual(['square', 'toast', 'mindbody', 'shopify', 'lightspeed', 'clover']);
    expect(mine.body.catalog.every((c: any) => c.mode === 'sandbox')).toBe(true);
    expect((await call(app, 'POST', SC(), { token: fo2.token, body: { locationId: tor, provider: 'square' } })).status).toBe(403);
  });

  it('connects Square in sandbox through the OAuth callback (single-use state) and syncs 35 days', async () => {
    const r = await call(app, 'POST', SC(), { token: fo1.token, body: { locationId: tor, provider: 'square' } });
    expect(r.status).toBe(201);
    torConn = r.body.connection.id;
    expect(r.body.connection.status).toBe('pending_authorisation');
    expect(r.body.authorizeUrl).toContain('/v1/sales-connectors/oauth/callback?state=');
    const cb = await call(app, 'GET', callbackPath(r.body.authorizeUrl));
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toContain(`/sales-connectors?connected=${torConn}`);
    const again = await call(app, 'GET', callbackPath(r.body.authorizeUrl));
    expect(again.headers.location).toContain('error=invalid_state');
    await app.ctx.jobs.drain();
    const rows = await app.ctx.db.select().from(dailySales).where(eq(dailySales.connectionId, torConn));
    expect(rows.length).toBeGreaterThanOrEqual(35 * 2);
    expect(rows.every((x) => x.sandbox && x.currency === 'CAD' && x.netMinor === x.grossMinor - x.refundsMinor - x.taxMinor - x.tipsMinor)).toBe(true);
    const detail = await call(app, 'GET', `${SC()}/${torConn}`, { token: fo1.token });
    expect(detail.body.connection.status).toBe('connected');
    expect(detail.body.connection.mode).toBe('sandbox');
    expect(detail.body.runs[0]).toMatchObject({ trigger: 'initial', status: 'succeeded', sandbox: true });
    expect((await call(app, 'POST', SC(), { token: fo1.token, body: { locationId: tor, provider: 'square' } })).body.error.code).toBe('connection_exists');
  });

  it('resyncs idempotently (unchanged days are counted, not rewritten) and limits the window', async () => {
    const before = await app.ctx.db.select().from(dailySales).where(eq(dailySales.connectionId, torConn));
    const r = await call(app, 'POST', `${SC()}/${torConn}/sync`, { token: fo1.token, body: { from: '2026-09-01', to: '2026-09-30' } });
    expect(r.status).toBe(202);
    await app.ctx.jobs.drain();
    const again = await call(app, 'POST', `${SC()}/${torConn}/sync`, { token: fo1.token, body: { from: '2026-09-01', to: '2026-09-30' } });
    await app.ctx.jobs.drain();
    const [run] = await app.ctx.db.select().from(salesSyncRuns).where(eq(salesSyncRuns.id, again.body.id));
    expect(run).toMatchObject({ status: 'succeeded', daysWritten: 0, daysUnchanged: 60 });
    const after = await app.ctx.db.select().from(dailySales).where(eq(dailySales.connectionId, torConn));
    expect(after.length).toBe(new Set(after.map((x) => `${x.businessDate}|${x.channel}|${x.currency}`)).size);
    expect(after.length).toBeGreaterThan(before.length);
    expect((await call(app, 'POST', `${SC()}/${torConn}/sync`, { token: fo1.token, body: { from: '2026-01-01', to: '2026-09-30' } })).status).toBe(400);
    expect((await call(app, 'POST', `${SC()}/${torConn}/sync`, { token: fo2.token, body: {} })).status).toBe(403);
  });

  it('live Square: vendor OAuth, choosing the Square location, sync of real order shapes, and an expired token', async () => {
    const r = await call(liveApp, 'POST', SC(), { token: owner.token, body: { locationId: lon, provider: 'square' } });
    expect(r.status).toBe(201);
    const auth = new URL(r.body.authorizeUrl);
    expect(auth.host).toBe('connect.squareupsandbox.com');
    const state = auth.searchParams.get('state')!;
    const cb = await call(liveApp, 'GET', `/v1/sales-connectors/oauth/callback?state=${encodeURIComponent(state)}&code=sq-code`);
    expect(cb.headers.location).toContain('connected=');
    const id = r.body.connection.id;
    const [row] = await liveApp.ctx.db.select().from(salesConnections).where(eq(salesConnections.id, id));
    expect(row!.mode).toBe('live');
    expect(row!.credentialsEncrypted).toBeTruthy();
    expect(row!.credentialsEncrypted).not.toContain('EAAA-live');
    // Several Square locations: no sync until one is chosen.
    expect(await liveApp.ctx.db.select().from(salesSyncRuns).where(eq(salesSyncRuns.connectionId, id))).toHaveLength(0);
    const ext = await call(liveApp, 'GET', `${SC()}/${id}/external-locations`, { token: owner.token });
    expect(ext.body.items.map((x: any) => x.id)).toEqual(['L1W8Q7A3', 'L2']);
    expect((await call(liveApp, 'PATCH', `${SC()}/${id}`, { token: owner.token, body: { config: { externalLocationId: 'L1W8Q7A3' } } })).body.config.externalLocationId).toBe('L1W8Q7A3');
    await liveApp.ctx.jobs.drain();
    await call(liveApp, 'POST', `${SC()}/${id}/sync`, { token: owner.token, body: { from: '2026-10-12', to: '2026-10-13' } });
    await liveApp.ctx.jobs.drain();
    const rows = await liveApp.ctx.db.select().from(dailySales).where(and(eq(dailySales.connectionId, id), eq(dailySales.businessDate, '2026-10-12')));
    // London is Europe/London: 17:02 UTC on the 12th is the 12th; CAD orders at a GBP location are kept in CAD, never converted.
    expect(rows.find((x) => x.currency === 'CAD' && x.channel === 'in_store')).toMatchObject({ grossMinor: 2376, taxMinor: 276, tipsMinor: 300, sandbox: false });
    expect(rows.every((x) => x.currency === 'CAD')).toBe(true);
    live.expired = true;
    await call(liveApp, 'POST', `${SC()}/${id}/sync`, { token: owner.token, body: {} });
    await liveApp.ctx.jobs.drain();
    const after = await call(liveApp, 'GET', `${SC()}/${id}`, { token: owner.token });
    expect(after.body.connection.status).toBe('authorization_expired');
    expect(after.body.runs[0].status).toBe('failed');
    live.expired = false;
    const re = await call(liveApp, 'POST', `${SC()}/${id}/reconnect`, { token: owner.token });
    expect(re.body.authorizeUrl).toContain('squareupsandbox');
    expect((await call(liveApp, 'DELETE', `${SC()}/${id}`, { token: owner.token })).body.status).toBe('disconnected');
  });

  /* ---------------------------- sources & royalties ---------------------------- */

  it('feeds royalties from the location’s one gross-sales source and flags self-reported variance', async () => {
    const F = `/v1/orgs/${orgId}/finance`;
    const basis = { streams: ['bookings', 'memberships', 'retail', 'food', 'other'], netOfRefunds: true, excludeTax: true, excludeTips: true, includeExternalSales: true };
    expect((await call(app, 'POST', `${F}/terms`, { token: fin.token, body: { currency: 'CAD', effectiveFrom: '2026-01-01', royaltyBps: 600, basis } })).status).toBe(201);
    // Toronto: the Square connector is the source (franchise owners cannot choose it).
    expect((await call(app, 'PUT', `${SC()}/sources/${tor}`, { token: fo1.token, body: { source: 'connector', connectionId: torConn } })).status).toBe(403);
    const set = await call(app, 'PUT', `${SC()}/sources/${tor}`, { token: fin.token, body: { source: 'connector', connectionId: torConn } });
    expect(set.body).toMatchObject({ source: 'connector', connectionId: torConn, explicit: true });
    // Vancouver: self-reported, with a Mindbody (sandbox) connection that shows different sales.
    const mb = await call(app, 'POST', SC(), { token: fo1.token, body: { locationId: van, provider: 'mindbody', config: { siteId: '-99' } } });
    expect(mb.body.connection.status).toBe('connected'); // sandbox: no activation link needed
    vanConn = mb.body.connection.id;
    await app.ctx.jobs.drain();
    await call(app, 'POST', `${SC()}/${vanConn}/sync`, { token: fo1.token, body: { from: '2026-09-01', to: '2026-09-30' } });
    await app.ctx.jobs.drain();
    expect((await call(app, 'PUT', `${SC()}/sources/${van}`, { token: fin.token, body: { source: 'self_reported', varianceThresholdBps: 500 } })).body.source).toBe('self_reported');
    const rep = await call(app, 'POST', `${F}/external-sales`, { token: fo1.token, body: { locationId: van, periodStart: '2026-09-01', grossMinor: 1_000_000, refundsMinor: 0, taxMinor: 0, evidence: { filename: 'z.pdf', contentType: 'application/pdf', dataBase64: b64('%PDF-1.4') } } });
    expect(rep.status).toBe(201);
    await call(app, 'POST', `${F}/external-sales/${rep.body.id}/review`, { token: fin.token, body: { decision: 'accepted' } });

    const close = await call(app, 'POST', `${F}/periods/close`, { token: fin.token, body: { startDate: '2026-09-01' } });
    expect(close.status).toBe(200);
    const list = (await call(app, 'GET', `${F}/statements`, { token: fin.token })).body.items;
    const torSt = (await call(app, 'GET', `${F}/statements/${list.find((x: any) => x.location.id === tor).id}`, { token: fin.token })).body;
    const sept = await app.ctx.db.select().from(dailySales).where(eq(dailySales.connectionId, torConn));
    const expected = sept.filter((x) => x.businessDate >= '2026-09-01' && x.businessDate <= '2026-09-30').reduce((a, x) => a + x.grossMinor - x.refundsMinor - x.taxMinor - x.tipsMinor, 0);
    expect(torSt.externalSalesMinor).toBe(expected);
    expect(torSt.basisMinor).toBe(expected);
    expect(torSt.warnings).toEqual(expect.arrayContaining(['sales_source:connector', 'connector_sandbox_data']));
    const vanSt = (await call(app, 'GET', `${F}/statements/${list.find((x: any) => x.location.id === van).id}`, { token: fin.token })).body;
    expect(vanSt.externalSalesMinor).toBe(1_000_000);
    expect(vanSt.warnings.some((w: string) => w.startsWith('self_reported_variance:'))).toBe(true);
  });

  it('reconciles BranchHarbor payments, connectors and self-reported periods per location, in scope', async () => {
    const r = await call(app, 'GET', `${SC()}/reconciliation?from=2026-09-01&to=2026-09-30`, { token: fin.token });
    expect(r.status).toBe(200);
    const vanRow = r.body.rows.find((x: any) => x.location.id === van);
    expect(vanRow.source.source).toBe('self_reported');
    expect(vanRow.flags).toContain('variance');
    expect(vanRow.selfReported[0].comparison).toMatchObject({ provider: 'mindbody', variance: { flagged: true } });
    const torRow = r.body.rows.find((x: any) => x.location.id === tor);
    expect(torRow.connectors[0]).toMatchObject({ provider: 'square', missingDays: 0, sandbox: true });
    expect(torRow.flags).toContain('sandbox');
    const fo = await call(app, 'GET', `${SC()}/reconciliation?from=2026-09-01&to=2026-09-30`, { token: fo1.token });
    expect(fo.body.rows.map((x: any) => x.location.id).sort()).toEqual([tor, van].sort());
    const csv = await call(app, 'GET', `${SC()}/reconciliation/export?from=2026-09-01&to=2026-09-30`, { token: fin.token });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.raw.body).toContain('self_reported 2026-09-01');
    const daily = await call(app, 'GET', `${SC()}/daily?locationId=${tor}&from=2026-09-01&to=2026-09-02`, { token: fo1.token });
    expect(daily.body.items.length).toBe(4);
    expect((await call(app, 'GET', `${SC()}/daily?locationId=${lon}`, { token: fo1.token })).status).toBe(403);
  });

  /* ---------------------------------- import ---------------------------------- */

  it('imports customers from a Square export: template detection, consent only when stated, dry run, run and undo', async () => {
    const [existing] = await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: tor, name: 'Old Name', email: 'ana@example.com', phone: null }).returning();
    const csv = [
      'Reference ID,First Name,Surname,Email Address,Phone Number,Square Customer ID,Email Subscription Status,Birthday',
      'r1,Ana,Lima,ana@example.com,+14165550101,SQ1,subscribed,1990-03-04',
      'r2,Ben,Okafor,ben@example.com,,SQ2,unsubscribed,',
      'r3,Cleo,Ng,cleo@example.com,,SQ3,,',
      'r4,Bad,Email,not-an-email,,SQ4,subscribed,',
    ].join('\n');
    const up = await call(app, 'POST', IM(), { token: owner.token, body: { entity: 'customers', filename: 'square-customers.csv', dataBase64: b64(csv) } });
    expect(up.status).toBe(201);
    expect(up.body.templateKey).toBe('square_customers');
    expect(up.body.mapping).toMatchObject({ first_name: 1, last_name: 2, email: 3, phone: 4, marketing_email: 6, date_of_birth: 7 });
    const v = await call(app, 'PUT', `${IM()}/${up.body.id}/mapping`, { token: owner.token, body: { mapping: up.body.mapping, options: { locationId: tor } } });
    expect(v.body.counts).toMatchObject({ total: 4, valid: 3, invalid: 1, create: 2, update: 1 });
    expect(v.body.preview.find((p: any) => p.row === 5).errors[0]).toMatchObject({ field: 'email', code: 'invalid_email' });
    const dry = await call(app, 'POST', `${IM()}/${up.body.id}/run`, { token: owner.token, body: { dryRun: true } });
    expect(dry.status).toBe(202);
    await app.ctx.jobs.drain();
    const afterDry = (await call(app, 'GET', `${IM()}/${up.body.id}`, { token: owner.token })).body;
    expect(afterDry).toMatchObject({ status: 'completed', dryRun: true, createdCount: 2, updatedCount: 1, canUndo: false });
    expect(await app.ctx.db.select().from(customers).where(eq(customers.email, 'ben@example.com'))).toHaveLength(0);
    await call(app, 'POST', `${IM()}/${up.body.id}/run`, { token: owner.token, body: { dryRun: false } });
    await app.ctx.jobs.drain();
    const done = (await call(app, 'GET', `${IM()}/${up.body.id}`, { token: owner.token })).body;
    expect(done).toMatchObject({ status: 'completed', createdCount: 2, updatedCount: 1, errorRows: 1, progressPct: 100, canUndo: true });
    const ana = (await app.ctx.db.select().from(customers).where(eq(customers.id, existing!.id)))[0]!;
    expect(ana).toMatchObject({ name: 'Ana Lima', phone: '+14165550101', dateOfBirth: '1990-03-04' });
    const consents = await app.ctx.db.select().from(consentRecords).where(eq(consentRecords.organizationId, orgId));
    expect(consents.map((c) => `${c.email}:${c.purpose}:${c.granted}`).sort()).toEqual(['ana@example.com:marketing_email:true', 'ben@example.com:marketing_email:false']);
    // Cleo had no consent value: nothing recorded (consent is never assumed).
    const undo = await call(app, 'POST', `${IM()}/${up.body.id}/rollback`, { token: owner.token });
    expect(undo.body.status).toBe('rolled_back');
    expect(await app.ctx.db.select().from(customers).where(eq(customers.email, 'ben@example.com'))).toHaveLength(0);
    expect((await app.ctx.db.select().from(customers).where(eq(customers.id, existing!.id)))[0]).toMatchObject({ name: 'Old Name', phone: null });
    expect(await app.ctx.db.select().from(consentRecords).where(eq(consentRecords.organizationId, orgId))).toHaveLength(0);
    expect((await call(app, 'POST', `${IM()}/${up.body.id}/rollback`, { token: owner.token })).body.error.code).toBe('import_not_undoable');
  });

  it('imports staff from an XLSX with role mapping and location codes; undo revokes the invitations', async () => {
    const xlsx = writeXlsx([
      ['Employee Name', 'Work Email', 'Job Title', 'Home Location'],
      ['Maya Rao', 'maya@example.com', 'Studio Manager', 'TOR-1'],
      ['Liam Chen', 'liam@example.com', 'Instructor', 'VAN-1'],
      ['Nobody', 'nobody@example.com', 'Instructor', 'NOPE'],
    ]);
    const up = await call(app, 'POST', IM(), { token: owner.token, body: { entity: 'staff', filename: 'staff.xlsx', dataBase64: xlsx.toString('base64') } });
    expect(up.body.format).toBe('xlsx');
    expect(up.body.mapping).toMatchObject({ name: 0, email: 1, role: 2, location_code: 3 });
    const v = await call(app, 'PUT', `${IM()}/${up.body.id}/mapping`, { token: owner.token, body: { mapping: up.body.mapping, options: { roleMapping: { Instructor: 'staff' } } } });
    expect(v.body.roles).toEqual(expect.arrayContaining([{ title: 'Studio Manager', role: 'location_manager' }, { title: 'Instructor', role: 'staff' }]));
    expect(v.body.counts).toMatchObject({ valid: 2, invalid: 1 });
    expect(v.body.preview[2].errors[0].code).toBe('unknown_location');
    await call(app, 'POST', `${IM()}/${up.body.id}/run`, { token: owner.token, body: {} });
    await app.ctx.jobs.drain();
    const inv = await app.ctx.db.select().from(invitations).where(and(eq(invitations.organizationId, orgId), eq(invitations.email, 'maya@example.com')));
    expect(inv[0]).toMatchObject({ role: 'location_manager', scopeKind: 'location', scopeId: tor, status: 'pending' });
    await call(app, 'POST', `${IM()}/${up.body.id}/rollback`, { token: owner.token });
    expect((await app.ctx.db.select().from(invitations).where(eq(invitations.id, inv[0]!.id)))[0]!.status).toBe('revoked');
  });

  it('checks every row against the importer’s scope and validates locations before writing', async () => {
    const csv = 'Name,Email,Location\nOne,one@example.com,TOR-1\nTwo,two@example.com,LON-1\n';
    const up = await call(app, 'POST', IM(), { token: fo1.token, body: { entity: 'customers', filename: 'c.csv', dataBase64: b64(csv) } });
    const v = await call(app, 'PUT', `${IM()}/${up.body.id}/mapping`, { token: fo1.token, body: { mapping: { ...up.body.mapping, location_code: 2 } } });
    expect(v.body.counts).toMatchObject({ valid: 1, invalid: 1 });
    expect(v.body.preview[1].errors[0].code).toBe('not_allowed');
    // Another franchise owner cannot see or run this import.
    expect((await call(app, 'GET', `${IM()}/${up.body.id}`, { token: fo2.token })).status).toBe(403);
    expect((await call(app, 'POST', IM(), { token: fo1.token, body: { entity: 'locations', filename: 'l.csv', dataBase64: b64('name\nx\n') } })).status).toBe(201);
    const locs = 'Store Name,Store Code,Street Address,Town,Country,Timezone,Currency\nOttawa Glebe,OTT-1,1 Bank St,Ottawa,CA,America/Toronto,CAD\nDup,TOR-1,1 X,Toronto,CA,America/Toronto,CAD\nBad tz,BAD-1,1 Y,Nowhere,CA,Mars/Base,CAD\n';
    const lu = await call(app, 'POST', IM(), { token: hq.token, body: { entity: 'locations', filename: 'locations.csv', dataBase64: b64(locs) } });
    const lv = await call(app, 'PUT', `${IM()}/${lu.body.id}/mapping`, { token: hq.token, body: { mapping: lu.body.mapping } });
    expect(lv.body.counts).toMatchObject({ valid: 1, invalid: 2 });
    expect(lv.body.batch.errors.map((e: any) => e.code).sort()).toEqual(['duplicate_code', 'invalid_time_zone']);
    expect((await call(app, 'PUT', `${IM()}/${lu.body.id}/mapping`, { token: fo1.token, body: { mapping: lu.body.mapping } })).status).toBe(403);
    const cat = await call(app, 'GET', `${IM()}/catalog`, { token: hq.token });
    expect(cat.body.entities.map((e: any) => e.key)).toEqual(['locations', 'staff', 'customers', 'memberships', 'leads']);
    expect(cat.body.templates.some((t: any) => t.key === 'glofox_members')).toBe(true);
    expect((await call(app, 'POST', IM(), { token: staff.token, body: { entity: 'customers', filename: 'c.csv', dataBase64: b64(csv) } })).status).toBe(403);
  });

  /* -------------------------------- bulk launch -------------------------------- */

  it('launches several locations at once with sites, listings data and staff invitations on a progress board', async () => {
    const L = `/v1/orgs/${orgId}/launches`;
    expect((await call(app, 'GET', L, { token: fo1.token })).status).toBe(403);
    const sheet = [
      'name,code,address_line1,city,country,time_zone,currency,manager_email,staff_emails,listing_categories,listing_description',
      'Calgary Beltline,CAL-1,1 17 Ave SW,Calgary,CA,America/Edmonton,CAD,mgr.cal@example.com,a@example.com;b@example.com,Yoga studio;Gym,Hot yoga in the Beltline',
      'Halifax North,HAL-1,1 Agricola St,Halifax,CA,America/Halifax,CAD,,,Yoga studio,',
      'Clash,TOR-1,1 X,Toronto,CA,America/Toronto,CAD,,,,',
    ].join('\n');
    const parsed = await call(app, 'POST', `${L}/parse`, { token: hq.token, body: { filename: 'launch.csv', dataBase64: b64(sheet) } });
    expect(parsed.body.valid).toBe(2);
    expect(parsed.body.errors[0]).toMatchObject({ row: 3 });
    expect((await call(app, 'POST', L, { token: hq.token, body: { name: 'Autumn wave', siteMode: 'publish', rows: parsed.body.rows } })).status).toBe(400);
    const r = await call(app, 'POST', L, { token: hq.token, body: { name: 'Autumn wave', siteMode: 'publish', rows: parsed.body.rows.slice(0, 2) } });
    expect(r.status).toBe(202);
    await app.ctx.jobs.drain();
    const board = (await call(app, 'GET', `${L}/${r.body.id}`, { token: hq.token })).body;
    expect(board).toMatchObject({ status: 'completed', total: 2, done: 2, failed: 0, progressPct: 100 });
    expect(board.items[0].steps).toMatchObject({ location: { status: 'done' }, website: { status: 'done', detail: 'published' }, listing: { status: 'done' }, staff: { status: 'done', detail: '3' } });
    expect(board.items[1].steps.staff.status).toBe('skipped');
    const [cal] = await app.ctx.db.select().from(locations).where(eq(locations.id, board.items[0].locationId));
    expect(cal).toMatchObject({ status: 'opening_soon', publiclyVisible: true, timeZone: 'America/Edmonton' });
    expect((cal!.settings as any).listing).toMatchObject({ categories: ['Yoga studio', 'Gym'], description: 'Hot yoga in the Beltline', status: 'ready' });
    const [page] = await app.ctx.db.select().from(pages).where(eq(pages.id, board.items[0].pageId));
    expect(page!.status).toBe('published');
    const invs = await app.ctx.db.select().from(invitations).where(eq(invitations.scopeId, cal!.id));
    expect(invs.map((i) => `${i.email}:${i.role}`).sort()).toEqual(['a@example.com:staff', 'b@example.com:staff', 'mgr.cal@example.com:location_manager']);
    expect((await call(app, 'GET', L, { token: hq.token })).body.items[0].id).toBe(r.body.id);
  });

  /* -------------------------------- benchmarks -------------------------------- */

  it('benchmarks are off by default, HQ-only, and publish nothing below 10 organisations', async () => {
    const B = `/v1/orgs/${orgId}/benchmarks`;
    expect((await call(app, 'GET', B, { token: fo1.token })).status).toBe(403);
    const off = await call(app, 'GET', B, { token: hq.token });
    expect(off.body).toMatchObject({ optedIn: false, metrics: [], minCohort: 10, can: { manage: true } });
    expect((await call(app, 'PUT', `${B}/settings`, { token: fin.token, body: { optIn: true } })).status).toBe(403);
    expect((await call(app, 'PUT', `${B}/settings`, { token: hq.token, body: { optIn: true } })).body.optIn).toBe(true);
    await app.ctx.jobs.drain();
    const on = await call(app, 'GET', B, { token: hq.token });
    expect(on.body.optedIn).toBe(true);
    expect(on.body.metrics.find((m: any) => m.metric === 'bookings_per_location')).toMatchObject({ status: 'cohort_too_small', cohort: null });
  });

  it('publishes noised percentiles once 10+ similar networks take part; opting out deletes contributions', async () => {
    // Ten more studio networks in North America, opted in, with one operating location each.
    for (let i = 0; i < 10; i++) {
      const o = await createOrg(app, owner.token, { name: `Peer ${i} ${uid()}` });
      await createLocation(app, owner.token, o.id, { name: `Peer ${i} studio` });
      await app.ctx.db.update(organizations).set({ settings: { benchmarks: { optIn: true, optedInAt: new Date().toISOString() } } }).where(eq(organizations.id, o.id));
    }
    const period = lastFullMonth();
    const r = await recomputeBenchmarks(app.ctx, period);
    expect(r.published).toBeGreaterThan(0);
    const b = await call(app, 'GET', `/v1/orgs/${orgId}/benchmarks?period=${period}`, { token: hq.token });
    const bookings = b.body.metrics.find((m: any) => m.metric === 'bookings_per_location');
    expect(bookings.status).toBe('ok');
    expect(bookings.cohort.scope).toBe('region');
    expect(bookings.cohort.size).toBe(10); // 11 organisations, published in bands of 5
    expect(typeof bookings.percentile).toBe('number');
    const revenue = b.body.metrics.filter((m: any) => m.metric === 'revenue_per_location');
    expect(revenue.map((m: any) => m.currency).sort()).toEqual(['CAD', 'GBP']);
    expect(revenue.find((m: any) => m.currency === 'GBP').status).toBe('cohort_too_small'); // only one GBP network
    expect(JSON.stringify(b.body)).not.toMatch(/Peer \d/);
    await call(app, 'PUT', `/v1/orgs/${orgId}/benchmarks/settings`, { token: hq.token, body: { optIn: false } });
    expect(await app.ctx.db.select().from(benchmarkContributions).where(eq(benchmarkContributions.organizationId, orgId))).toHaveLength(0);
  });
});
