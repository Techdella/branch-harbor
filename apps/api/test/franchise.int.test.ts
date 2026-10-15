import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { franchiseDeliveries, franchiseTasks, invitations, locations } from '../src/db/schema/index.ts';
import { runFranchiseJobs } from '../src/services/franchise.ts';
import { call, createLocation, createOrg, enablePublicAndPayments, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

const DAY = 86_400_000;
const pdf = Buffer.from('%PDF-1.4\n% BranchHarbor test document\n').toString('base64');

describe.skipIf(!hasDb)('franchise development, new-location flow and legal (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string; email: string };
  let hq: { token: string; userId: string };
  let org: Record<string, any>;
  let O: string;
  let fddUS: string, fddCA: string, fddAU: string, agreementDoc: string;
  let hqLocationId: string;

  const backdateReceipt = async (prospectId: string, days: number) => {
    await app.ctx.db.update(franchiseDeliveries).set({ receiptSignedAt: new Date(Date.now() - days * DAY), deliveredAt: new Date(Date.now() - days * DAY) })
      .where(and(eq(franchiseDeliveries.prospectId, prospectId), eq(franchiseDeliveries.kind, 'disclosure')));
  };
  const upload = async (kind: string, title: string, jurisdictions: string[], token = owner.token) => {
    const r = await call(app, 'POST', `/v1/orgs/${O}/franchise/documents`, { token, body: { kind, title, version: '2026', jurisdictions, fileName: `${uid()}.pdf`, contentType: 'application/pdf', contentBase64: pdf } });
    return r;
  };
  const newProspect = async (over: Record<string, unknown>) => {
    const r = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects`, { token: owner.token, body: { name: `Prospect ${uid()}`, email: `p-${uid()}@example.com`, source: 'referral', ...over } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as string;
  };
  /** Disclose + sign receipt through the public e-receipt, then backdate the receipt by `daysAgo`. */
  const discloseAndReceipt = async (prospectId: string, documentId: string, daysAgo: number) => {
    const d = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${prospectId}/disclosures`, { token: owner.token, body: { documentId } });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const view = await call(app, 'GET', `/v1/public/franchise/disclosures/${d.body.devToken}`);
    expect(view.status).toBe(200);
    const rc = await call(app, 'POST', `/v1/public/franchise/disclosures/${d.body.devToken}/receipt`, { body: { name: 'Pat Prospect', acknowledge: true }, headers: { 'user-agent': 'vitest' } });
    expect(rc.status, JSON.stringify(rc.body)).toBe(200);
    if (daysAgo) await backdateReceipt(prospectId, daysAgo);
  };
  const sendAgreement = (prospectId: string, terms: Record<string, unknown> = {}) =>
    call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${prospectId}/agreement`, { token: owner.token, body: { documentId: agreementDoc, terms: { termYears: 10, royaltyBps: 600, marketingFundBps: 200, renewalOption: 'One 10-year renewal', ...terms } } });

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Franchisor Owner');
    org = await createOrg(app, owner.token, { name: `Harbour Fitness ${uid()}`, industry: 'studios', country: 'US', defaultCurrency: 'USD', defaultTimeZone: 'America/Denver' });
    O = org.id;
    // Franchise sales without Legal: a custom role with the franchise pipeline and location management (go-live approvals).
    const desk = await call(app, 'POST', `/v1/orgs/${O}/roles`, { token: owner.token, body: { name: `Franchise sales ${uid()}`, capabilities: ['sales.franchise_pipeline:edit', 'network.locations:edit', 'network.approvals:publish'] } });
    expect(desk.status, JSON.stringify(desk.body)).toBe(201);
    hq = await verifiedUser(app, 'Franchise Sales');
    const inv = await call(app, 'POST', `/v1/orgs/${O}/invitations`, { token: owner.token, body: { email: (hq as any).email, role: 'custom', customRoleId: desk.body.id, scope: { kind: 'organization', id: O } } });
    expect((await call(app, 'POST', '/v1/invitations/accept', { token: hq.token, body: { token: inv.body.devInvitationToken } })).status).toBe(200);
    const hqLoc = await createLocation(app, owner.token, O, { name: 'HQ Denver', address: { line1: '1 Main', city: 'Denver', region: 'CO', country: 'US' }, timeZone: 'America/Denver', currency: 'USD' });
    hqLocationId = hqLoc.id;
    await enablePublicAndPayments(app, owner.token, O, hqLocationId);
    const set = await call(app, 'PUT', `/v1/orgs/${O}/franchise/settings`, { token: owner.token, body: { enquiryFormEnabled: true, homeRegion: 'CO', collectLocationId: hqLocationId } });
    expect(set.status).toBe(200);
    fddUS = (await upload('disclosure', 'Franchise Disclosure Document', ['US'])).body.id;
    fddCA = (await upload('disclosure', 'Canadian disclosure document', ['CA'])).body.id;
    fddAU = (await upload('disclosure', 'Australian disclosure document', ['AU'])).body.id;
    agreementDoc = (await upload('agreement_template', 'Franchise agreement', ['US', 'CA', 'AU'])).body.id;
  });
  afterAll(async () => { await app?.close(); });

  it('lists the shipped rules as unreviewed and lets legal record counsel review (org copy)', async () => {
    const r = await call(app, 'GET', `/v1/orgs/${O}/franchise/rules`, { token: owner.token });
    expect(r.status).toBe(200);
    expect(r.body.disclaimer).toMatch(/not legal advice/i);
    expect(r.body.items.length).toBeGreaterThan(40);
    expect(r.body.items.every((x: any) => x.reviewedByCounsel === false && x.needsCounselReview === true)).toBe(true);
    const fr = r.body.items.find((x: any) => x.code === 'FR');
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/rules/${fr.id}/review`, { token: hq.token, body: { reviewed: true } })).status).toBe(403);
    const rev = await call(app, 'POST', `/v1/orgs/${O}/franchise/rules/${fr.id}/review`, { token: owner.token, body: { reviewed: true, note: 'Checked by counsel' } });
    expect(rev.status).toBe(200);
    const again = await call(app, 'GET', `/v1/orgs/${O}/franchise/rules`, { token: hq.token });
    expect(again.body.items.find((x: any) => x.code === 'FR')).toMatchObject({ reviewedByCounsel: true, origin: 'organization' });
    const ev = await call(app, 'GET', `/v1/orgs/${O}/franchise/rules/evaluate?country=US&region=CA`, { token: hq.token });
    expect(ev.body.applicable.map((a: any) => a.code)).toEqual(['US', 'US-CA']);
    expect(ev.body.signingBlockers.map((b: any) => b.code)).toContain('registration_required');
  });

  it('brand-site enquiry lands in the pipeline with cadence tasks; stage changes regenerate them; due emails go out', async () => {
    const terr = await call(app, 'POST', `/v1/orgs/${O}/franchise/territories`, { token: owner.token, body: { name: 'Phoenix East', country: 'US', region: 'AZ' } });
    expect(terr.status).toBe(201);
    const cfg = await call(app, 'GET', `/v1/public/franchise/${org.slug}`);
    expect(cfg.body).toMatchObject({ enabled: true, territories: [expect.objectContaining({ name: 'Phoenix East' })] });
    const email = `enq-${uid()}@example.com`;
    const enq = await call(app, 'POST', `/v1/public/franchise/${org.slug}/enquiries`, { body: { name: 'Sofia Marquez', email, country: 'US', region: 'AZ', city: 'Phoenix', territoryId: terr.body.id, liquidCapital: 250000, netWorth: 900000, currency: 'USD', consent: true, utm: { source: 'meta', medium: 'paid_social', campaign: 'fall' } } });
    expect(enq.status, JSON.stringify(enq.body)).toBe(201);
    const list = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects`, { token: owner.token });
    const p = list.body.items.find((x: any) => x.email === email);
    expect(p).toMatchObject({ stage: 'enquiry', source: 'ads', territoryName: 'Phoenix East', liquidCapital: { amount: 25_000_000, currency: 'USD' }, selfDeclared: true, openTasks: 3 });
    const tasks = await app.ctx.db.select().from(franchiseTasks).where(eq(franchiseTasks.prospectId, p.id));
    expect(tasks.map((t) => [t.kind, Math.round((t.dueAt!.getTime() - new Date(p.stageEnteredAt).getTime()) / DAY)]).sort()).toEqual([['call', 1], ['email', 0], ['email', 4]]);

    const jobs = await runFranchiseJobs(app.ctx, new Date(), O);
    expect(jobs.emails).toBe(1);
    const detail = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${p.id}`, { token: owner.token });
    expect(detail.body.activities.map((a: any) => a.kind)).toEqual(expect.arrayContaining(['enquiry', 'email']));

    const mv = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${p.id}/stage`, { token: owner.token, body: { to: 'qualified' } });
    expect(mv.status).toBe(200);
    const after = await app.ctx.db.select().from(franchiseTasks).where(eq(franchiseTasks.prospectId, p.id));
    expect(after.filter((t) => t.status === 'skipped').length).toBe(2);
    expect(after.filter((t) => t.status === 'open').map((t) => t.title).sort()).toEqual(['Check territory availability', 'Invite to discovery call']);
    // Later stages need the action, not a drag.
    const jump = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${p.id}/stage`, { token: owner.token, body: { to: 'signed' } });
    expect(jump.status).toBe(409);
    expect(jump.body.error.code).toBe('stage_requires_action');
  });

  for (const [label, where, doc] of [
    ['US (Arizona)', { country: 'US', region: 'AZ', city: 'Tucson' }, () => fddUS],
    ['Canada (Ontario)', { country: 'CA', region: 'ON', city: 'Ottawa', currency: 'CAD' }, () => fddCA],
    ['Australia (NSW)', { country: 'AU', region: 'NSW', city: 'Sydney', currency: 'AUD' }, () => fddAU],
  ] as const) {
    it(`${label}: signing and fee payment are blocked before day 14 and allowed after`, async () => {
      const id = await newProspect(where);
      await discloseAndReceipt(id, doc(), 0);
      let p = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${id}`, { token: owner.token });
      expect(p.body.stage).toBe('waiting_period');
      expect(p.body.deliveries[0]).toMatchObject({ receiptName: 'Pat Prospect', receiptIp: expect.any(String) });
      const sent = await sendAgreement(id);
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      await backdateReceipt(id, 13);
      const view = await call(app, 'GET', `/v1/public/franchise/agreements/${sent.body.devToken}`);
      expect(view.body).toMatchObject({ canSign: false, waitingUntil: expect.any(String) });
      const early = await call(app, 'POST', `/v1/public/franchise/agreements/${sent.body.devToken}/sign`, { body: { name: 'Pat Prospect', accept: true } });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('franchise_blocked');
      expect(early.body.error.message).toMatch(/can be signed from/);
      const fee = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${id}/fee-invoices`, { token: owner.token, body: { amountMinor: 4_000_000, currency: 'USD', description: 'Initial franchise fee' } });
      expect(fee.status).toBe(409);
      expect(fee.body.error.details.blockers[0].code).toBe('waiting_period');
      p = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${id}`, { token: owner.token });
      expect(p.body.activities.some((a: any) => a.kind === 'blocked')).toBe(true);

      await backdateReceipt(id, 15);
      const ok = await call(app, 'POST', `/v1/public/franchise/agreements/${sent.body.devToken}/sign`, { body: { name: 'Pat Prospect', accept: true } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      if (where.country === 'AU') expect(ok.body.coolingOffEndsAt).toEqual(expect.any(String));
      p = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${id}`, { token: owner.token });
      expect(p.body.stage).toBe('onboarding');
      expect(p.body.project).toMatchObject({ status: 'active' });
      const fee2 = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${id}/fee-invoices`, { token: owner.token, body: { amountMinor: 4_000_000, currency: 'USD', description: 'Initial franchise fee' } });
      expect(fee2.status, JSON.stringify(fee2.body)).toBe(201);
      const paid = await call(app, 'POST', `/v1/public/payments/${fee2.body.paymentId}/sandbox-confirm`, { body: { outcome: 'succeeded' } });
      expect(paid.status).toBe(200);
      p = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${id}`, { token: owner.token });
      expect(p.body.invoices[0]).toMatchObject({ status: 'paid' });
    });
  }

  it('registration states: the agreement cannot be sent or signed until the registration is in effect', async () => {
    const id = await newProspect({ country: 'US', region: 'CA', city: 'San Diego' });
    await discloseAndReceipt(id, fddUS, 20);
    const blocked = await sendAgreement(id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.blockers.map((b: any) => [b.code, b.ruleCode])).toEqual([['registration_required', 'US-CA']]);
    // HQ admin has no legal permission: cannot record registrations.
    expect((await call(app, 'PUT', `/v1/orgs/${O}/franchise/registrations/US-CA`, { token: hq.token, body: { status: 'registered' } })).status).toBe(403);
    const reg = await call(app, 'PUT', `/v1/orgs/${O}/franchise/registrations/US-CA`, { token: owner.token, body: { status: 'registered', fileNumber: 'DFPI-1234', expiresAt: new Date(Date.now() + 300 * DAY).toISOString() } });
    expect(reg.status).toBe(200);
    const sent = await sendAgreement(id);
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const ok = await call(app, 'POST', `/v1/public/franchise/agreements/${sent.body.devToken}/sign`, { body: { name: 'Cal Prospect', accept: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('go-live: provision from template, pre-opening checklist, HQ approval opens the location and the owner is invited to their owner group', async () => {
    const franchisee = await verifiedUser(app, 'Ben Okafor');
    const id = await newProspect({ country: 'US', region: 'TX', city: 'Austin', email: franchisee.email, name: 'Ben Okafor' });
    await call(app, 'PUT', `/v1/orgs/${O}/franchise/registrations/US-TX`, { token: owner.token, body: { status: 'exempt' } });
    await discloseAndReceipt(id, fddUS, 15);
    const sent = await sendAgreement(id, { territory: 'Austin North' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const signed = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${id}/agreement/record-signature`, { token: owner.token, body: { signatureId: sent.body.signatureId, signerName: 'Ben Okafor' } });
    expect(signed.status, JSON.stringify(signed.body)).toBe(200);
    const projectId = signed.body.projectId as string;

    let proj = await call(app, 'GET', `/v1/orgs/${O}/franchise/projects/${projectId}`, { token: owner.token });
    expect(proj.body.tasks.length).toBeGreaterThan(15);
    expect(proj.body.tasks.map((t: any) => t.section)).toEqual(expect.arrayContaining(['training', 'site_selection', 'lease', 'fit_out', 'suppliers', 'marketing', 'systems', 'pre_opening']));
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/projects/${projectId}/go-live`, { token: owner.token, body: {} })).body.error.code).toBe('not_provisioned');

    const prov = await call(app, 'POST', `/v1/orgs/${O}/franchise/projects/${projectId}/provision`, { token: owner.token, body: { name: 'Harbour Fitness Austin North', code: `AUS${uid().slice(0, 4)}`.toUpperCase(), address: { line1: '500 Lamar Blvd', city: 'Austin', region: 'TX', country: 'US' }, timeZone: 'America/Chicago', currency: 'USD' } });
    expect(prov.status, JSON.stringify(prov.body)).toBe(201);
    const [loc] = await app.ctx.db.select().from(locations).where(eq(locations.id, prov.body.locationId));
    expect(loc).toMatchObject({ status: 'onboarding', publiclyVisible: false, ownerGroupId: signed.body.ownerGroupId });
    const [inv] = await app.ctx.db.select().from(invitations).where(eq(invitations.id, prov.body.invitationId));
    expect(inv).toMatchObject({ email: franchisee.email, role: 'franchise_owner', scopeKind: 'owner_group', scopeId: signed.body.ownerGroupId, status: 'pending' });

    // The owner accepts and works through their part of the checklist.
    const acc = await call(app, 'POST', '/v1/invitations/accept', { token: franchisee.token, body: { token: prov.body.devInvitationToken } });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    const mine = await call(app, 'GET', `/v1/orgs/${O}/franchise/projects`, { token: franchisee.token });
    expect(mine.body.items.map((x: any) => x.id)).toEqual([projectId]);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects`, { token: franchisee.token })).status).toBe(403);

    proj = await call(app, 'GET', `/v1/orgs/${O}/franchise/projects/${projectId}`, { token: franchisee.token });
    const early = await call(app, 'POST', `/v1/orgs/${O}/franchise/projects/${projectId}/go-live`, { token: franchisee.token, body: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('checklist_incomplete');
    for (const t of proj.body.tasks.filter((x: any) => x.gate)) {
      const by = t.assignee === 'owner' ? franchisee.token : owner.token;
      if (t.assignee === 'hq') expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/tasks/${t.id}/complete`, { token: franchisee.token })).status).toBe(403);
      expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/tasks/${t.id}/complete`, { token: by })).status).toBe(200);
    }
    const req = await call(app, 'POST', `/v1/orgs/${O}/franchise/projects/${projectId}/go-live`, { token: franchisee.token, body: { comment: 'Ready to open' } });
    expect(req.status, JSON.stringify(req.body)).toBe(201);

    // The franchise owner cannot approve; HQ can, from the approvals inbox.
    const ownerInbox = await call(app, 'GET', `/v1/orgs/${O}/approvals?kind=location_go_live`, { token: franchisee.token });
    expect(ownerInbox.body.items?.[0]?.canDecide ?? false).toBe(false);
    expect((await call(app, 'POST', `/v1/orgs/${O}/approvals/${req.body.approvalId}/decision`, { token: franchisee.token, body: { decision: 'approve' } })).status).toBe(403);
    const inbox = await call(app, 'GET', `/v1/orgs/${O}/approvals?kind=location_go_live`, { token: hq.token });
    expect(inbox.body.items[0]).toMatchObject({ kind: 'location_go_live', canDecide: true, titleCode: 'location_go_live' });
    const dec = await call(app, 'POST', `/v1/orgs/${O}/approvals/${req.body.approvalId}/decision`, { token: hq.token, body: { decision: 'approve', comment: 'Welcome aboard' } });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    const [opened] = await app.ctx.db.select().from(locations).where(eq(locations.id, prov.body.locationId));
    expect(opened).toMatchObject({ status: 'operating', publiclyVisible: true });
    proj = await call(app, 'GET', `/v1/orgs/${O}/franchise/projects/${projectId}`, { token: owner.token });
    expect(proj.body.status).toBe('opened');
    const p = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects/${id}`, { token: owner.token });
    expect(p.body.stage).toBe('opened');

    // The owner sees only their own agreement in the register, and no legal vault.
    const ag = await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: franchisee.token });
    expect(ag.status).toBe(200);
    expect(ag.body.scope).toBe('own');
    expect(ag.body.items).toEqual([expect.objectContaining({ ownerGroupId: signed.body.ownerGroupId, royaltyBps: 600, marketingFundBps: 200, termYears: 10, territory: 'Austin North' })]);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/documents?kind=vault`, { token: franchisee.token })).status).toBe(403);
  });

  it('a rejected opening returns the project to active so it can be requested again', async () => {
    const id = await newProspect({ country: 'US', region: 'CO', city: 'Boulder' });
    await discloseAndReceipt(id, fddUS, 15);
    const sent = await sendAgreement(id);
    const signed = await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects/${id}/agreement/record-signature`, { token: owner.token, body: { signatureId: sent.body.signatureId, signerName: 'Boulder Owner' } });
    const projectId = signed.body.projectId;
    await call(app, 'POST', `/v1/orgs/${O}/franchise/projects/${projectId}/provision`, { token: owner.token, body: { name: `Boulder ${uid()}`, code: `BLD${uid().slice(0, 4)}`.toUpperCase(), address: { line1: '1 Pearl St', city: 'Boulder', region: 'CO', country: 'US' }, timeZone: 'America/Denver', currency: 'USD' } });
    const proj = await call(app, 'GET', `/v1/orgs/${O}/franchise/projects/${projectId}`, { token: owner.token });
    for (const t of proj.body.tasks.filter((x: any) => x.gate)) await call(app, 'POST', `/v1/orgs/${O}/franchise/tasks/${t.id}/complete`, { token: owner.token });
    const req = await call(app, 'POST', `/v1/orgs/${O}/franchise/projects/${projectId}/go-live`, { token: owner.token, body: {} });
    expect((await call(app, 'POST', `/v1/orgs/${O}/approvals/${req.body.approvalId}/decision`, { token: owner.token, body: { decision: 'approve' } })).status).toBe(403);
    const rej = await call(app, 'POST', `/v1/orgs/${O}/approvals/${req.body.approvalId}/decision`, { token: hq.token, body: { decision: 'reject', comment: 'Signage not approved yet' } });
    expect(rej.status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/projects/${projectId}`, { token: owner.token })).body).toMatchObject({ status: 'active', canRequestGoLive: true });
  });

  it('legal documents and the agreements register are not visible without legal permission', async () => {
    const vault = await upload('vault', 'Trademark licence', []);
    expect(vault.status).toBe(201);
    // Franchise sales (custom role): pipeline yes, legal no.
    expect((await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: hq.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/documents?kind=vault`, { token: hq.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/documents/${vault.body.id}/download`, { token: hq.token })).status).toBe(403);
    expect((await upload('vault', 'Sneaky upload', [], hq.token)).status).toBe(403);
    const visible = await call(app, 'GET', `/v1/orgs/${O}/franchise/documents`, { token: hq.token });
    expect(visible.status).toBe(200);
    expect(visible.body.items.every((d: any) => d.kind === 'disclosure' || d.kind === 'agreement_template')).toBe(true);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/documents/${fddUS}/download`, { token: hq.token })).status).toBe(200);
    // Owner (all permissions) sees everything, downloads are audited.
    const all = await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: owner.token });
    expect(all.body.scope).toBe('all');
    expect(all.body.items.length).toBeGreaterThanOrEqual(5);
    const dl = await call(app, 'GET', `/v1/orgs/${O}/franchise/documents/${vault.body.id}/download`, { token: owner.token });
    expect(dl.status).toBe(200);
    expect(dl.raw.body).toContain('%PDF');
    // A staff member of another org gets 404, not 403 (no tenant enumeration).
    const stranger = await verifiedUser(app, 'Stranger');
    expect((await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: stranger.token })).status).toBe(404);
  });

  it('agreement expiry reminders go to legal once per threshold', async () => {
    const groups = await call(app, 'GET', `/v1/orgs/${O}/franchise/owner-groups`, { token: owner.token });
    const soon = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
    const a = await call(app, 'POST', `/v1/orgs/${O}/legal/agreements`, { token: owner.token, body: { ownerGroupId: groups.body.items[0].id, startDate: '2016-11-01', endDate: soon, termYears: 10, royaltyBps: 500, marketingFundBps: 200, renewalOption: 'One 5-year renewal with 6 months’ notice' } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ expiringSoon: true });
    const r1 = await runFranchiseJobs(app.ctx, new Date(), O);
    expect(r1.expiry).toBe(1);
    const r2 = await runFranchiseJobs(app.ctx, new Date(), O);
    expect(r2.expiry).toBe(0);
    const list = await call(app, 'GET', `/v1/orgs/${O}/legal/agreements?expiringWithinDays=90`, { token: owner.token });
    expect(list.body.items.find((x: any) => x.id === a.body.id).remindersSent.sort((x: number, y: number) => x - y)).toEqual([90, 180]);
  });
  it('role templates: VP Franchise runs the pipeline, Legal reviews rules, location roles see neither', async () => {
    const vp = await memberWithRole(app, owner.token, O, 'vp_franchise', { kind: 'organization', id: O }, 'VP Franchise');
    const legal = await memberWithRole(app, owner.token, O, 'legal', { kind: 'organization', id: O }, 'Counsel');
    const lm = await memberWithRole(app, owner.token, O, 'location_manager', { kind: 'location', id: hqLocationId }, 'Location Manager');
    const rule = (await call(app, 'GET', `/v1/orgs/${O}/franchise/rules`, { token: vp.token })).body.items.find((x: any) => x.code === 'IT');
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects`, { token: vp.token })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: vp.token })).status).toBe(200);
    // Counsel review is Disclosure publish / approve: Legal has it, VP Franchise does not.
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/rules/${rule.id}/review`, { token: vp.token, body: { reviewed: true } })).status).toBe(403);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/rules/${rule.id}/review`, { token: legal.token, body: { reviewed: true } })).status).toBe(200);
    expect((await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects`, { token: legal.token })).status).toBe(200);
    expect((await call(app, 'POST', `/v1/orgs/${O}/franchise/prospects`, { token: legal.token, body: { name: 'Nope', email: `n-${uid()}@example.com`, source: 'referral', country: 'US', region: 'CO', city: 'Denver' } })).status).toBe(403);
    const denied = await call(app, 'GET', `/v1/orgs/${O}/franchise/prospects`, { token: lm.token });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('module_not_available');
    expect((await call(app, 'GET', `/v1/orgs/${O}/legal/agreements`, { token: lm.token })).status).toBe(403);
  });
});
