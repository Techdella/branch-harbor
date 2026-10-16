import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { complianceDocuments, complianceMissingReminders, financeInvoices, franchiseProjects, locations, paymentReferences, royaltyPeriods, royaltyStatements } from '../src/db/schema/index.ts';
import { runComplianceJobs } from '../src/services/compliance.ts';
import { runAuditJobs } from '../src/services/audits.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

/**
 * Field audits, compliance documents and the league table: templates and starters, scheduling, conducting with
 * autosave and photos, scoring with automatic critical fail, corrective actions with evidence and verification, the
 * re-audit, the pre-opening gate on go-live, compliance requirements / uploads / review / matrix / reminders, the
 * league table per currency with anonymised quartiles, and franchisee isolation throughout.
 */
describe.skipIf(!hasDb)('audits, compliance documents and league table (DB)', () => {
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof verifiedUser>>;
  let hqAdmin: Awaited<ReturnType<typeof verifiedUser>>;
  let auditor: Awaited<ReturnType<typeof verifiedUser>>;
  let fo1: Awaited<ReturnType<typeof verifiedUser>>;
  let fo2: Awaited<ReturnType<typeof verifiedUser>>;
  let lm: Awaited<ReturnType<typeof verifiedUser>>;
  let staff: Awaited<ReturnType<typeof verifiedUser>>;
  let orgId: string;
  let g1: string;
  let g2: string;
  let west: string;
  let tor: string;
  let van: string;
  let lon: string;
  let mtl: string;
  let templateId: string;
  let auditId: string;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e0005fe02fea7d1d5f30000000049454e44ae426082', 'hex').toString('base64');
  const photo = { filename: 'photo.png', contentType: 'image/png', dataBase64: png };
  const pdf = { filename: 'coi.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 certificate').toString('base64') };
  const A = () => `/v1/orgs/${orgId}/audits`;
  const C = () => `/v1/orgs/${orgId}/compliance`;

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Franchisor CEO');
    orgId = (await createOrg(app, owner.token, { name: `Northlight ${uid()}` })).id;
    g1 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Pacific Heat' } })).body.id;
    g2 = (await call(app, 'POST', `/v1/orgs/${orgId}/owner-groups`, { token: owner.token, body: { name: 'Thames Hot Yoga' } })).body.id;
    west = (await call(app, 'POST', `/v1/orgs/${orgId}/regions`, { token: owner.token, body: { name: 'West' } })).body.id;
    tor = (await createLocation(app, owner.token, orgId, { name: 'Toronto Annex', ownerGroupId: g1 })).id;
    van = (await createLocation(app, owner.token, orgId, { name: 'Vancouver Main', ownerGroupId: g1, regionId: west, timeZone: 'America/Vancouver', address: { line1: '1 Main', city: 'Vancouver', region: 'BC', country: 'CA' } })).id;
    lon = (await createLocation(app, owner.token, orgId, { name: 'London Hackney', ownerGroupId: g2, timeZone: 'Europe/London', currency: 'GBP', address: { line1: '1 Mare St', city: 'London', country: 'GB' } })).id;
    mtl = (await createLocation(app, owner.token, orgId, { name: 'Montréal Plateau', address: { line1: '1 Rue', city: 'Montréal', region: 'QC', country: 'CA' } })).id;
    hqAdmin = await memberWithRole(app, owner.token, orgId, 'hq_admin', { kind: 'organization', id: orgId }, 'HQ Admin');
    fo1 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g1 }, 'Owner Pacific');
    fo2 = await memberWithRole(app, owner.token, orgId, 'franchise_owner', { kind: 'owner_group', id: g2 }, 'Owner Thames');
    lm = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: tor }, 'Manager Toronto');
    staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: tor }, 'Staff Toronto');
    // A field consultant: a custom role with Audits view + edit, for the West region and Toronto.
    const role = await call(app, 'POST', `/v1/orgs/${orgId}/roles`, { token: owner.token, body: { name: 'Field consultant', capabilities: ['operations.audits:view', 'operations.audits:edit'] } });
    expect(role.status).toBe(201);
    auditor = await verifiedUser(app, 'Field Consultant');
    for (const scope of [{ kind: 'region', id: west }, { kind: 'location', id: tor }]) {
      const inv = await call(app, 'POST', `/v1/orgs/${orgId}/invitations`, { token: owner.token, body: { email: auditor.email, role: 'custom', customRoleId: role.body.id, scope } });
      expect(inv.status).toBe(201);
      expect((await call(app, 'POST', '/v1/invitations/accept', { token: auditor.token, body: { token: inv.body.devInvitationToken } })).status).toBe(200);
    }
  });
  afterAll(async () => { await app?.close(); });

  /* ------------------------------- audits -------------------------------- */

  it('keeps audits away from people without the module (staff)', async () => {
    expect((await call(app, 'GET', A(), { token: staff.token })).body.error.code).toBe('module_not_available');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/compliance/matrix`, { token: staff.token })).status).toBe(403);
  });

  it('offers starter checklists per industry and lets only HQ manage templates', async () => {
    const st = await call(app, 'GET', `${A()}/starters`, { token: hqAdmin.token });
    expect(st.body.items.map((x: any) => x.key)).toEqual(['brand_standards', 'cleanliness_safety', 'pre_opening']);
    expect((await call(app, 'POST', `${A()}/templates`, { token: fo1.token, body: { starterKey: 'brand_standards' } })).status).toBe(403);
    expect((await call(app, 'POST', `${A()}/templates`, { token: auditor.token, body: { starterKey: 'brand_standards' } })).status).toBe(403);
    const fromStarter = await call(app, 'POST', `${A()}/templates`, { token: hqAdmin.token, body: { starterKey: 'cleanliness_safety' } });
    expect(fromStarter.status).toBe(201);
    expect(fromStarter.body.criticalCount).toBeGreaterThan(0);
    const bad = await call(app, 'POST', `${A()}/templates`, { token: hqAdmin.token, body: { name: 'Dup', sections: [{ id: 's', title: 'S', questions: [{ id: 'q', text: 'Q', type: 'yes_no' }, { id: 'q', text: 'Q2', type: 'yes_no' }] }] } });
    expect(bad.status).toBe(400);
    const t = await call(app, 'POST', `${A()}/templates`, {
      token: hqAdmin.token,
      body: {
        name: 'Studio standards', passThreshold: 80, reauditDays: 21, correctiveDays: 10,
        sections: [
          { id: 'safety', title: 'Safety', questions: [{ id: 'exits', text: 'Exits clear', type: 'yes_no', weight: 2, critical: true }, { id: 'kit', text: 'First-aid kit', type: 'yes_no', weight: 1 }] },
          { id: 'studio', title: 'Studio', questions: [{ id: 'clean', text: 'Cleanliness', type: 'scale', weight: 4, photoRequired: true }, { id: 'temp', text: 'Room temperature', type: 'number', min: 35, max: 42, unit: '°C', weight: 2 }, { id: 'notes', text: 'Notes', type: 'text' }] },
        ],
      },
    });
    expect(t.status).toBe(201);
    templateId = t.body.id;
    expect(t.body.questionCount).toBe(5);
  });

  it('schedules audits only where HQ may, with an auditor who can audit that location', async () => {
    expect((await call(app, 'POST', A(), { token: fo1.token, body: { locationId: tor, templateId, dueDate: '2026-11-01', auditorUserId: auditor.userId } })).status).toBe(403);
    const wrong = await call(app, 'POST', A(), { token: hqAdmin.token, body: { locationId: lon, templateId, dueDate: '2026-11-01', auditorUserId: auditor.userId } });
    expect(wrong.status).toBe(400);
    const auditors = await call(app, 'GET', `${A()}/auditors?locationId=${tor}`, { token: hqAdmin.token });
    expect(auditors.body.items.map((x: any) => x.id)).toContain(auditor.userId);
    const r = await call(app, 'POST', A(), { token: hqAdmin.token, body: { locationId: tor, templateId, dueDate: '2026-11-01', auditorUserId: auditor.userId } });
    expect(r.status).toBe(201);
    auditId = r.body.id;
    expect(r.body.status).toBe('scheduled');
    // A London audit the Pacific franchisee must never see.
    const l = await call(app, 'POST', A(), { token: hqAdmin.token, body: { locationId: lon, templateId, dueDate: '2026-11-02', auditorUserId: hqAdmin.userId } });
    expect(l.status).toBe(201);
    expect((await call(app, 'GET', `${A()}/${l.body.id}`, { token: fo1.token })).status).toBe(404);
    const mine = await call(app, 'GET', A(), { token: fo1.token });
    expect(mine.body.items.map((x: any) => x.locationId)).toEqual([tor]);
    const theirs = await call(app, 'GET', A(), { token: fo2.token });
    expect(theirs.body.items.map((x: any) => x.locationId)).toEqual([lon]);
    // The field consultant sees their region and Toronto, never London.
    expect((await call(app, 'GET', A(), { token: auditor.token })).body.items.map((x: any) => x.locationId)).toEqual([tor]);
  });

  it('lets only the assigned auditor conduct: autosave merges per question and photos are private', async () => {
    expect((await call(app, 'PUT', `${A()}/${auditId}/answers`, { token: fo1.token, body: { answers: { exits: { value: 'yes' } } } })).status).toBe(403);
    const s1 = await call(app, 'PUT', `${A()}/${auditId}/answers`, { token: auditor.token, body: { answers: { exits: { value: 'yes' }, kit: { value: 'no', note: 'Kit expired in June' } } } });
    expect(s1.status).toBe(200);
    expect(s1.body.status).toBe('in_progress');
    // An offline save of another question doesn't wipe the first ones.
    const ph = await call(app, 'POST', `${A()}/${auditId}/photos`, { token: auditor.token, body: photo });
    expect(ph.status).toBe(201);
    expect(ph.body.url).toMatch(/\/v1\/files\/.+\?exp=\d+&sig=/);
    const s2 = await call(app, 'PUT', `${A()}/${auditId}/answers`, { token: auditor.token, body: { answers: { clean: { value: 4, photoIds: [ph.body.id] } } } });
    expect(s2.body.revision).toBe(s1.body.revision + 1);
    // The location doesn't see answers while the audit is in progress.
    const peek = await call(app, 'GET', `${A()}/${auditId}`, { token: fo1.token });
    expect(peek.body.answers).toEqual({});
    const live = await call(app, 'GET', `${A()}/${auditId}`, { token: auditor.token });
    expect(Object.keys(live.body.answers).sort()).toEqual(['clean', 'exits', 'kit']);
    expect(live.body.permissions.conduct).toBe(true);
    // The signed link serves the bytes; a tampered link doesn't.
    const path = new URL(ph.body.url).pathname + new URL(ph.body.url).search;
    const img = await app.inject({ method: 'GET', url: path });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: path.replace(/sig=.{4}/, 'sig=XXXX') })).statusCode).toBe(404);
    // Photos from another location can't be attached.
    expect((await call(app, 'PUT', `${A()}/${auditId}/answers`, { token: auditor.token, body: { answers: { exits: { value: 'yes', photoIds: [randomUUID()] } } } })).status).toBe(400);
  });

  it('refuses to complete an incomplete audit, then scores, raises corrective actions and schedules the re-audit', async () => {
    const early = await call(app, 'POST', `${A()}/${auditId}/complete`, { token: auditor.token, body: {} });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('audit_incomplete');
    expect(early.body.error.details.unanswered).toEqual(['temp', 'notes']);
    const done = await call(app, 'POST', `${A()}/${auditId}/complete`, { token: auditor.token, body: { summary: 'Good energy, kit needs replacing.', answers: { temp: { value: 45 }, notes: { value: 'Busy evening class' } } } });
    expect(done.status).toBe(200);
    // exits 2/2, kit 0/1, clean 3/4, temp 0/2 → 5/9 = 55.6 %
    expect(done.body.scorePct).toBe(55.6);
    expect(done.body.passed).toBe(false);
    expect(done.body.criticalFailed).toBe(false);
    expect(done.body.actions.map((x: any) => [x.questionId, x.reason]).sort()).toEqual([['kit', 'no'], ['temp', 'out_of_range']]);
    expect(done.body.actions.find((x: any) => x.questionId === 'kit').auditorNote).toBe('Kit expired in June');
    expect(done.body.reauditDueDate).toBeTruthy();
    expect(done.body.reaudit.status).toBe('scheduled');
    expect((await call(app, 'POST', `${A()}/${auditId}/complete`, { token: auditor.token, body: {} })).body.error.code).toBe('audit_closed');
    // The location sees its report now.
    const report = await call(app, 'GET', `${A()}/${auditId}`, { token: lm.token });
    expect(report.body.answers.clean.photos).toHaveLength(1);
    expect(report.body.permissions.respond).toBe(true);
    expect(report.body.permissions.verify).toBe(false);
  });

  it('a failed critical item fails the audit whatever the score', async () => {
    const r = await call(app, 'POST', A(), { token: hqAdmin.token, body: { locationId: van, templateId, dueDate: '2026-11-03', auditorUserId: auditor.userId } });
    const ph = await call(app, 'POST', `${A()}/${r.body.id}/photos`, { token: auditor.token, body: photo });
    const done = await call(app, 'POST', `${A()}/${r.body.id}/complete`, { token: auditor.token, body: { answers: { exits: { value: 'no' }, kit: { value: 'yes' }, clean: { value: 5, photoIds: [ph.body.id] }, temp: { value: 38 }, notes: { value: '-' } } } });
    expect(done.body.scorePct).toBe(77.8);
    expect(done.body.criticalFailed).toBe(true);
    expect(done.body.passed).toBe(false);
    expect(done.body.actions[0].critical).toBe(true);
  });

  it('corrective actions: the location fixes with evidence, the auditor verifies or reopens', async () => {
    const list = await call(app, 'GET', `${A()}/actions`, { token: lm.token });
    expect(list.body.items.every((x: any) => x.locationId === tor)).toBe(true);
    const kit = list.body.items.find((x: any) => x.questionId === 'kit');
    expect((await call(app, 'POST', `${A()}/actions/${kit.id}/submit`, { token: lm.token, body: { note: 'Replaced', evidenceFileIds: [] } })).status).toBe(400);
    expect((await call(app, 'POST', `${A()}/actions/${kit.id}/evidence`, { token: fo2.token, body: photo })).status).toBe(404);
    expect((await call(app, 'POST', `${A()}/actions/${kit.id}/evidence`, { token: staff.token, body: photo })).status).toBe(403);
    const ev = await call(app, 'POST', `${A()}/actions/${kit.id}/evidence`, { token: lm.token, body: photo });
    expect(ev.status).toBe(201);
    const sub = await call(app, 'POST', `${A()}/actions/${kit.id}/submit`, { token: lm.token, body: { note: 'New kit in place', evidenceFileIds: [ev.body.id] } });
    expect(sub.body.status).toBe('submitted');
    expect((await call(app, 'POST', `${A()}/actions/${kit.id}/verify`, { token: fo1.token, body: { decision: 'verify' } })).status).toBe(403);
    expect((await call(app, 'POST', `${A()}/actions/${kit.id}/verify`, { token: auditor.token, body: { decision: 'reopen' } })).status).toBe(400);
    const re = await call(app, 'POST', `${A()}/actions/${kit.id}/verify`, { token: auditor.token, body: { decision: 'reopen', note: 'The kit is missing burn gel' } });
    expect(re.body.status).toBe('open');
    expect(re.body.reopenedCount).toBe(1);
    await call(app, 'POST', `${A()}/actions/${kit.id}/submit`, { token: lm.token, body: { note: 'Burn gel added', evidenceFileIds: [ev.body.id] } });
    const ok = await call(app, 'POST', `${A()}/actions/${kit.id}/verify`, { token: auditor.token, body: { decision: 'verify' } });
    expect(ok.body.status).toBe('verified');
  });

  it('dashboard and reminders: overdue corrective actions and audits are reported and reminded once', async () => {
    const { auditActions, audits } = await import('../src/db/schema/index.ts');
    await app.ctx.db.update(auditActions).set({ dueDate: '2026-01-01' }).where(and(eq(auditActions.organizationId, orgId), eq(auditActions.questionId, 'temp'), eq(auditActions.locationId, tor)));
    await app.ctx.db.update(audits).set({ dueDate: '2026-01-02' }).where(and(eq(audits.organizationId, orgId), eq(audits.locationId, lon)));
    const d = await call(app, 'GET', `${A()}/dashboard`, { token: hqAdmin.token });
    expect(d.status).toBe(200);
    expect(d.body.overdueActions.map((x: any) => x.questionId)).toContain('temp');
    expect(d.body.overdueAudits.map((x: any) => x.locationId)).toContain(lon);
    expect(d.body.locations.find((l: any) => l.locationId === tor).latest.scorePct).toBe(55.6);
    const mine = await call(app, 'GET', `${A()}/dashboard`, { token: fo1.token });
    expect(mine.body.locations.map((l: any) => l.locationId).sort()).toEqual([tor, van].sort());
    expect(mine.body.overdueAudits).toEqual([]);
    const sent: string[] = [];
    const orig = app.ctx.jobs.enqueue.bind(app.ctx.jobs);
    app.ctx.jobs.enqueue = async (name: string, data: any, o?: any) => { if (name === 'email.send') sent.push(data.subject); return orig(name, data, o); };
    const r1 = await runAuditJobs(app.ctx, new Date(), orgId);
    expect(r1.actionReminders).toBe(1);
    expect(r1.auditReminders).toBe(1);
    expect(sent.some((x) => x.startsWith('Overdue corrective action at Toronto Annex'))).toBe(true);
    expect((await runAuditJobs(app.ctx, new Date(), orgId)).actionReminders).toBe(0);
    app.ctx.jobs.enqueue = orig;
    const csv = await call(app, 'GET', `${A()}/export`, { token: fo1.token });
    expect(csv.status).toBe(200);
    expect(csv.raw.body).toContain('Toronto Annex');
    expect(csv.raw.body).not.toContain('London Hackney');
    expect((await call(app, 'GET', `${A()}/export`, { token: lm.token })).status).toBe(403);
  });

  it('pre-opening checks: go-live needs the pre-opening audit to pass', async () => {
    const [proj] = await app.ctx.db.insert(franchiseProjects).values({ organizationId: orgId, ownerGroupId: g1, locationId: mtl, templateKey: 'standard_unit', name: 'Montréal opening', status: 'active' }).returning();
    await app.ctx.db.update(locations).set({ status: 'onboarding' }).where(eq(locations.id, mtl));
    const pre = await call(app, 'POST', `${A()}/templates`, { token: hqAdmin.token, body: { starterKey: 'pre_opening' } });
    const sched = await call(app, 'POST', A(), { token: hqAdmin.token, body: { locationId: mtl, templateId: pre.body.id, dueDate: '2026-11-10', auditorUserId: hqAdmin.userId, purpose: 'pre_opening', projectId: proj!.id } });
    expect(sched.status).toBe(201);
    const p1 = await call(app, 'GET', `/v1/orgs/${orgId}/franchise/projects/${proj!.id}`, { token: owner.token });
    expect(p1.body.preOpening.templateId).toBe(pre.body.id);
    expect(p1.body.preOpening.passed).toBe(false);
    expect(p1.body.canRequestGoLive).toBe(false);
    const blocked = await call(app, 'POST', `/v1/orgs/${orgId}/franchise/projects/${proj!.id}/go-live`, { token: owner.token, body: {} });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('pre_opening_audit_required');
    // Answer everything well and pass.
    const tpl = (await call(app, 'GET', `${A()}/templates/${pre.body.id}`, { token: hqAdmin.token })).body;
    const ph = await call(app, 'POST', `${A()}/${sched.body.id}/photos`, { token: hqAdmin.token, body: photo });
    const answers: Record<string, unknown> = {};
    for (const sec of tpl.sections) for (const q of sec.questions) answers[q.id] = q.type === 'yes_no' ? { value: 'yes', ...(q.photoRequired ? { photoIds: [ph.body.id] } : {}) } : q.type === 'scale' ? { value: 5 } : q.type === 'photo' ? { photoIds: [ph.body.id] } : { value: 'ok' };
    const done = await call(app, 'POST', `${A()}/${sched.body.id}/complete`, { token: hqAdmin.token, body: { answers } });
    expect(done.body.passed).toBe(true);
    const p2 = await call(app, 'GET', `/v1/orgs/${orgId}/franchise/projects/${proj!.id}`, { token: owner.token });
    expect(p2.body.preOpening.passed).toBe(true);
    const go = await call(app, 'POST', `/v1/orgs/${orgId}/franchise/projects/${proj!.id}/go-live`, { token: owner.token, body: {} });
    // The pre-opening audit no longer blocks (the location still needs its other gates, none on this project).
    expect(go.status).toBe(201);
  });

  /* ------------------------- compliance documents ------------------------ */

  let gl: string;
  let lic: string;
  it('lets HQ define requirements; franchisees cannot', async () => {
    expect((await call(app, 'POST', `${C()}/requirements`, { token: fo1.token, body: { name: 'x', category: 'insurance' } })).status).toBe(403);
    const r = await call(app, 'POST', `${C()}/requirements`, { token: hqAdmin.token, body: { name: 'General liability', category: 'insurance', coverageType: 'General liability', minAmountMinor: 200_000_000, currency: 'cad', jurisdictions: ['CA'] } });
    expect(r.status).toBe(201);
    expect(r.body.minAmount).toEqual({ amountMinor: 200_000_000, currency: 'CAD' });
    gl = r.body.id;
    lic = (await call(app, 'POST', `${C()}/requirements`, { token: hqAdmin.token, body: { name: 'Business licence', category: 'licence' } })).body.id;
    expect((await call(app, 'POST', `${C()}/requirements`, { token: hqAdmin.token, body: { name: 'x', category: 'insurance', minAmountMinor: 5 } })).status).toBe(400);
  });

  it('franchisees upload for their own locations only; HQ reviews; the matrix shows each state', async () => {
    const base = { requirementId: gl, locationId: tor, category: 'insurance', title: 'COI 2026', issuer: 'Maple Mutual', coverageType: 'General liability', coverageAmountMinor: 300_000_000, currency: 'CAD', issuedOn: '2026-01-01', expiresOn: '2027-01-01', file: pdf };
    expect((await call(app, 'POST', `${C()}/documents`, { token: fo2.token, body: base })).status).toBe(403);
    expect((await call(app, 'POST', `${C()}/documents`, { token: fo1.token, body: { ...base, expiresOn: null } })).status).toBe(400);
    expect((await call(app, 'POST', `${C()}/documents`, { token: fo1.token, body: { ...base, file: { ...pdf, contentType: 'text/html' } } })).status).toBe(400);
    const up = await call(app, 'POST', `${C()}/documents`, { token: fo1.token, body: base });
    expect(up.status).toBe(201);
    expect(up.body.status).toBe('pending');
    let m = await call(app, 'GET', `${C()}/matrix`, { token: hqAdmin.token });
    const cell = (mm: any, loc: string, req: string) => mm.body.rows.find((r: any) => r.location.id === loc).cells.find((c: any) => c.requirementId === req).state;
    expect(cell(m, tor, gl)).toBe('pending');
    expect(cell(m, lon, gl)).toBe('not_applicable');
    expect(cell(m, lon, lic)).toBe('missing');
    expect((await call(app, 'POST', `${C()}/documents/${up.body.id}/review`, { token: fo1.token, body: { decision: 'approve' } })).status).toBe(403);
    expect((await call(app, 'POST', `${C()}/documents/${up.body.id}/review`, { token: hqAdmin.token, body: { decision: 'approve' } })).body.status).toBe('approved');
    // Vancouver: below the minimum (approved by HQ upload, amount too low); expiring soon at Toronto's licence.
    const low = await call(app, 'POST', `${C()}/documents`, { token: hqAdmin.token, body: { ...base, locationId: van, coverageAmountMinor: 100_000_000 } });
    expect(low.body.status).toBe('approved');
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    await call(app, 'POST', `${C()}/documents`, { token: hqAdmin.token, body: { requirementId: lic, locationId: tor, category: 'licence', title: 'Business licence', expiresOn: soon, file: pdf } });
    m = await call(app, 'GET', `${C()}/matrix`, { token: hqAdmin.token });
    expect(cell(m, tor, gl)).toBe('valid');
    expect(cell(m, van, gl)).toBe('below_minimum');
    expect(cell(m, tor, lic)).toBe('expiring');
    // Franchisees see only their own rows.
    const own = await call(app, 'GET', `${C()}/matrix`, { token: fo1.token });
    expect(own.body.rows.map((r: any) => r.location.id).sort()).toEqual([tor, van].sort());
    expect(own.body.can.manage).toBe(false);
    const docs = await call(app, 'GET', `${C()}/documents`, { token: fo2.token });
    expect(docs.body.items).toEqual([]);
    expect((await call(app, 'GET', `${C()}/documents/${up.body.id}`, { token: fo2.token })).status).toBe(404);
    const renewals = await call(app, 'GET', `${C()}/documents?expiringWithinDays=60`, { token: hqAdmin.token });
    expect(renewals.body.items.map((d: any) => d.title)).toEqual(['Business licence']);
  });

  it('a newer approved document replaces the older one', async () => {
    const up = await call(app, 'POST', `${C()}/documents`, { token: fo1.token, body: { requirementId: gl, locationId: tor, category: 'insurance', title: 'COI 2027', coverageAmountMinor: 300_000_000, currency: 'CAD', expiresOn: '2028-01-01', file: pdf } });
    await call(app, 'POST', `${C()}/documents/${up.body.id}/review`, { token: hqAdmin.token, body: { decision: 'approve' } });
    const all = await app.ctx.db.select().from(complianceDocuments).where(and(eq(complianceDocuments.requirementId, gl), eq(complianceDocuments.locationId, tor)));
    expect(all.find((d) => d.title === 'COI 2026')!.supersededAt).not.toBeNull();
    expect(all.find((d) => d.title === 'COI 2027')!.supersededAt).toBeNull();
    const rej = await call(app, 'POST', `${C()}/documents`, { token: fo1.token, body: { requirementId: lic, locationId: van, category: 'licence', title: 'Licence', expiresOn: '2027-05-01', file: pdf } });
    expect((await call(app, 'POST', `${C()}/documents/${rej.body.id}/review`, { token: hqAdmin.token, body: { decision: 'reject' } })).status).toBe(400);
    expect((await call(app, 'POST', `${C()}/documents/${rej.body.id}/review`, { token: hqAdmin.token, body: { decision: 'reject', note: 'Wrong address' } })).body.status).toBe('rejected');
  });

  it('expiry reminders at 60, 30, 7 days and on expiry (with escalation to HQ), each once', async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const orig = app.ctx.jobs.enqueue.bind(app.ctx.jobs);
    app.ctx.jobs.enqueue = async (name: string, data: any, o?: any) => { if (name === 'email.send') sent.push({ to: data.to, subject: data.subject }); return orig(name, data, o); };
    const r1 = await runComplianceJobs(app.ctx, new Date(), orgId);
    expect(r1.reminders).toBe(1); // the licence expiring in 10 days (the 7-day step not yet)
    expect(sent.some((x) => /^Expires in 1[01] days: Business licence \(Toronto Annex\)/.test(x.subject) /* 10 or 11: UTC vs Toronto day */ && x.to === lm.email)).toBe(true);
    expect(sent.some((x) => x.to === fo2.email && !x.subject.startsWith('Missing:'))).toBe(false);
    expect((await runComplianceJobs(app.ctx, new Date(), orgId)).reminders).toBe(0);
    sent.length = 0;
    const r3 = await runComplianceJobs(app.ctx, new Date(Date.now() + 11 * 86_400_000), orgId);
    expect(r3.escalations).toBe(1);
    expect(sent.some((x) => x.subject.startsWith('Compliance: Business licence (Toronto Annex) has expired') && x.to === hqAdmin.email)).toBe(true);
    app.ctx.jobs.enqueue = orig;
  });

  it('required but missing documents: weekly reminders to the uploaders, HQ after 30 days, stopped by an upload', async () => {
    const sent: Array<{ to: string; subject: string }> = [];
    const orig = app.ctx.jobs.enqueue.bind(app.ctx.jobs);
    app.ctx.jobs.enqueue = async (name: string, data: any, o?: any) => { if (name === 'email.send') sent.push({ to: data.to, subject: data.subject }); return orig(name, data, o); };
    // The expiry test above already ran the jobs (and so these reminders) eleven days ahead: start from a clean slate.
    await app.ctx.db.delete(complianceMissingReminders).where(eq(complianceMissingReminders.organizationId, orgId));
    const day = (n: number) => new Date(Date.now() + n * 86_400_000);
    const missingFor = (to: string) => sent.filter((x) => x.to === to && x.subject === 'Missing: Business licence (London Hackney)');
    const first = await runComplianceJobs(app.ctx, day(0), orgId);
    expect(first.missing.missing).toBeGreaterThanOrEqual(1);
    expect(missingFor(fo2.email)).toHaveLength(1);
    expect(missingFor(hqAdmin.email)).toHaveLength(0); // HQ is not nagged weekly
    await runComplianceJobs(app.ctx, day(3), orgId);
    expect(missingFor(fo2.email)).toHaveLength(1); // weekly, not daily
    await runComplianceJobs(app.ctx, day(8), orgId);
    expect(missingFor(fo2.email)).toHaveLength(2);
    expect(sent.some((x) => x.to === hqAdmin.email && x.subject.startsWith('Compliance: Business licence (London Hackney) missing for'))).toBe(false);
    const late = await runComplianceJobs(app.ctx, day(31), orgId);
    expect(late.missing.escalations).toBeGreaterThanOrEqual(1);
    expect(sent.filter((x) => x.to === hqAdmin.email && x.subject.startsWith('Compliance: Business licence (London Hackney) missing for 3'))).toHaveLength(1);
    await runComplianceJobs(app.ctx, day(40), orgId);
    expect(sent.filter((x) => x.to === hqAdmin.email && x.subject.startsWith('Compliance: Business licence (London Hackney) missing for'))).toHaveLength(1); // once
    // An upload (even before review) ends the reminders.
    await call(app, 'POST', `${C()}/documents`, { token: fo2.token, body: { requirementId: lic, locationId: lon, category: 'licence', title: 'Hackney licence', expiresOn: '2028-01-01', file: pdf } });
    sent.length = 0;
    await runComplianceJobs(app.ctx, day(50), orgId);
    expect(missingFor(fo2.email)).toHaveLength(0);
    const rows = await app.ctx.db.select().from(complianceMissingReminders).where(and(eq(complianceMissingReminders.requirementId, lic), eq(complianceMissingReminders.locationId, lon)));
    expect(rows).toHaveLength(0);
    app.ctx.jobs.enqueue = orig;
  });

  /* ------------------------------ league table ---------------------------- */

  it('ranks per currency, hides finance without access, and gives franchisees anonymised quartiles only', async () => {
    const pay = async (locationId: string, currency: string, amountMinor: number, at: string) => app.ctx.db.insert(paymentReferences).values({
      organizationId: orgId, locationId, provider: 'stripe', externalId: `pi_${uid()}${uid()}`, amountMinor, currency, state: 'succeeded', createdAt: new Date(at), succeededAt: new Date(at), targetType: 'class_booking', targetId: randomUUID(), sandbox: 1,
    });
    await app.ctx.db.update(locations).set({ status: 'operating' }).where(eq(locations.organizationId, orgId));
    await pay(tor, 'CAD', 500_000, '2026-09-10T12:00:00Z');
    await pay(tor, 'CAD', 400_000, '2026-08-10T12:00:00Z');
    await pay(van, 'CAD', 300_000, '2026-09-10T12:00:00Z');
    await pay(mtl, 'CAD', 900_000, '2026-09-11T12:00:00Z');
    await pay(lon, 'GBP', 800_000, '2026-09-12T12:00:00Z');
    await pay(lon, 'USD', 999_999, '2026-09-12T12:00:00Z'); // foreign currency: never counted or converted
    // An overdue royalty invoice for London.
    const [per] = await app.ctx.db.insert(royaltyPeriods).values({ organizationId: orgId, frequency: 'monthly', startDate: '2026-08-01', endDate: '2026-09-01', status: 'closed' }).returning();
    const [st] = await app.ctx.db.insert(royaltyStatements).values({ organizationId: orgId, periodId: per!.id, locationId: lon, currency: 'GBP', timeZone: 'Europe/London', periodStartAt: new Date('2026-08-01'), periodEndAt: new Date('2026-09-01'), status: 'invoiced' } as any).returning();
    await app.ctx.db.insert(financeInvoices).values({ organizationId: orgId, statementId: st!.id, locationId: lon, number: `T-${uid()}`, seq: 1, currency: 'GBP', issueDate: '2026-09-01', dueDate: '2026-09-15', subtotalMinor: 1000, totalMinor: 1000, status: 'open' });

    const q = '?from=2026-09-01&to=2026-09-30&sort=revenue';
    const hq = await call(app, 'GET', `/v1/orgs/${orgId}/league-table${q}`, { token: owner.token });
    expect(hq.status).toBe(200);
    expect(hq.body.view).toBe('network');
    const row = (b: any, id: string) => b.rows.find((r: any) => r.locationId === id);
    expect(row(hq.body, mtl).rank).toBe(1);
    expect(row(hq.body, tor).rank).toBe(2);
    expect(row(hq.body, lon).rank).toBe(1); // first in GBP: never ranked against CAD
    expect(row(hq.body, lon).revenueMinor).toBe(800_000);
    expect(row(hq.body, tor).growthPct).toBe(25);
    // Audit scores are the latest completed audit up to the end of the period.
    expect(row(hq.body, tor).auditScorePct).toBeNull();
    const today = new Date().toISOString().slice(0, 10);
    const now = await call(app, 'GET', `/v1/orgs/${orgId}/league-table?from=2026-09-01&to=${today}&sort=auditScore`, { token: owner.token });
    expect(row(now.body, tor).auditScorePct).toBe(55.6);
    expect(row(now.body, mtl).rank).toBe(1); // the passed pre-opening audit
    expect(row(hq.body, lon).royaltyStatus).toBe('overdue');
    expect(hq.body.currencies).toEqual(['CAD', 'GBP']);
    // HQ admin has no finance access: revenue and royalty status are hidden.
    const admin = await call(app, 'GET', `/v1/orgs/${orgId}/league-table${q}`, { token: hqAdmin.token });
    expect(row(admin.body, tor).revenueMinor).toBeNull();
    expect(row(admin.body, lon).royaltyStatus).toBeNull();
    expect(admin.body.columns.revenue).toBe(false);
    // The franchise owner: own locations, quartiles and an anonymised network position; no other names.
    const fo = await call(app, 'GET', `/v1/orgs/${orgId}/league-table?from=2026-09-01&to=2026-09-30&sort=auditScore`, { token: fo1.token });
    expect(fo.body.view).toBe('own');
    expect(fo.body.rows.map((r: any) => r.locationId).sort()).toEqual([tor, van].sort());
    expect(JSON.stringify(fo.body)).not.toContain('London Hackney');
    expect(JSON.stringify(fo.body)).not.toContain('Montréal');
    const rev = await call(app, 'GET', `/v1/orgs/${orgId}/league-table${q}`, { token: fo1.token });
    expect(rev.body.benchmarks.revenue[0].currency).toBe('CAD');
    expect(rev.body.benchmarks.revenue[0].quartiles).toBeNull(); // only 3 CAD locations: too few to stay anonymous
    expect(rev.body.benchmarks.activity.count).toBe(4);
    // HQ turns the quartiles off: franchise owners see just their own ranking.
    expect((await call(app, 'PUT', `/v1/orgs/${orgId}/league-table/settings`, { token: fo1.token, body: { franchiseeQuartiles: false } })).status).toBe(403);
    expect((await call(app, 'PUT', `/v1/orgs/${orgId}/league-table/settings`, { token: hqAdmin.token, body: { franchiseeQuartiles: false } })).status).toBe(200);
    const off = await call(app, 'GET', `/v1/orgs/${orgId}/league-table${q}`, { token: fo1.token });
    expect(off.body.benchmarks).toBeNull();
    expect(off.body.networkRanks).toBeNull();
    await call(app, 'PUT', `/v1/orgs/${orgId}/league-table/settings`, { token: hqAdmin.token, body: { franchiseeQuartiles: true } });
    // Filters and the CSV export.
    const g = await call(app, 'GET', `/v1/orgs/${orgId}/league-table${q}&ownerGroupId=${g2}`, { token: owner.token });
    expect(g.body.rows.map((r: any) => r.locationId)).toEqual([lon]);
    const csv = await call(app, 'GET', `/v1/orgs/${orgId}/league-table/export${q}`, { token: owner.token });
    expect(csv.status).toBe(200);
    expect(csv.raw.body).toContain('London Hackney');
    expect(csv.raw.body).toContain('8000.00');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/league-table/export${q}`, { token: lm.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/league-table${q}`, { token: staff.token })).status).toBe(403);
  });
});
