import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DnsChecker } from '../src/integrations/domains.ts';
import { call, createLocation, createOrg, hasDb, makeApp, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('custom domains state machine via API (DB, sandbox provider)', () => {
  let app: FastifyInstance;
  const dnsState = { cnameOk: false, txtOk: false };
  const fakeDns: DnsChecker = { check: async () => ({ ...dnsState }) };
  beforeAll(async () => { app = await makeApp({ dns: fakeDns }); });
  afterAll(async () => { await app?.close(); });

  it('returns exact DNS records and advances awaiting_dns → verifying/certificate_pending → ready', async () => {
    const { token } = await verifiedUser(app);
    const org = await createOrg(app, token);
    const loc = await createLocation(app, token, org.id);
    const site = await call(app, 'POST', `/v1/orgs/${org.id}/websites`, { token, body: { locationId: loc.id } });
    expect(site.status).toBe(201);
    expect(site.body.includedAddress).toMatch(/^https:\/\/sites\.branchharbor\.com\//);
    const hostname = `www.stillwater-${uid()}.ca`;
    const add = await call(app, 'POST', `/v1/orgs/${org.id}/domains`, { token, body: { hostname: `https://${hostname.toUpperCase()}/`, websiteId: site.body.id } });
    expect(add.status).toBe(201);
    expect(add.body.state).toBe('awaiting_dns');
    expect(add.body.hostname).toBe(hostname);
    const cname = add.body.dnsRecords.find((r: any) => r.type === 'CNAME');
    const txt = add.body.dnsRecords.find((r: any) => r.type === 'TXT');
    expect(cname).toMatchObject({ name: hostname, value: 'edge.branchharbor.com' });
    expect(txt.name).toBe(`_bh-verify.${hostname}`);
    expect(txt.value).toMatch(/^bh-verify=/);
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/domains`, { token, body: { hostname, websiteId: site.body.id } })).body.error.code).toBe('hostname_taken');

    const v1 = await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/verify`, { token });
    expect(v1.body.state).toBe('awaiting_dns');
    expect(v1.body.checks.reason).toMatch(/CNAME and TXT/);
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/primary`, { token })).body.error.code).toBe('domain_not_ready');

    dnsState.cnameOk = true;
    dnsState.txtOk = true;
    const v2 = await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/verify`, { token });
    expect(v2.body.state).toBe('certificate_pending');
    const v3 = await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/verify`, { token });
    expect(v3.body.state).toBe('ready');
    expect(v3.body.transition).toEqual({ from: 'certificate_pending', to: 'ready', reason: null });
    expect((await call(app, 'POST', `/v1/orgs/${org.id}/domains/${add.body.id}/primary`, { token })).body.isPrimary).toBe(true);

    expect((await call(app, 'POST', `/v1/orgs/${org.id}/domains`, { token, body: { hostname: 'nope', websiteId: site.body.id } })).status).toBe(400);
  });
});
