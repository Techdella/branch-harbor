/**
 * Demo data for field audits, compliance documents and the league table (demo site only, never `db:seed`):
 * Northlight Yoga's checklists from the starters, a field consultant, completed audits with scores over the last
 * months (one failed on a critical item with open corrective actions and a re-audit due), a pre-opening audit for
 * Dublin Portobello, compliance requirements with documents in every state (one expiring soon), and the league table
 * fed by the finance seed's sales and invoices. Called from seed-demo.ts after seed-finance.ts.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { STARTER_AUDIT_TEMPLATES, auditTemplateBodySchema, type AuditAnswers, type AuditSection } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays } from '../lib/tz.ts';
import { completeAudit, scheduleAudit } from '../services/audits.ts';

type User = typeof t.users.$inferSelect;
export interface QualitySeedInput { db: Db; today: string; upsertUser: (email: string, name: string, locale?: string) => Promise<User> }

const MAIL = 'northlight.demo.branchharbor.com';

/** A small solid-colour PNG (stands in for a photo taken on site). */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) { const shade = 1 - (y / h) * 0.25; row[1 + x * 3] = Math.round(rgb[0] * shade); row[2 + x * 3] = Math.round(rgb[1] * shade); row[3 + x * 3] = Math.round(rgb[2] * shade); }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

export async function seedQuality({ db, today, upsertUser }: QualitySeedInput) {
  const [org] = await db.select().from(t.organizations).where(eq(t.organizations.slug, 'northlight-yoga'));
  if (!org) return { logins: [] as string[], audits: 0, documents: 0 };
  const orgId = org.id;
  const s = { db } as unknown as Services;
  const user = async (local: string) => (await db.select().from(t.users).where(eq(t.users.email, `${local}@${MAIL}`)))[0]!;
  const ceo = await user('elena.marsh');
  const ops = await user('grace.kim');
  const mia = await user('mia.rossi');
  const regions = await db.select().from(t.regions).where(eq(t.regions.organizationId, orgId));
  const na = regions.find((r) => r.name === 'North America')!;
  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const L = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<string, (typeof locs)[number]>;

  // A field consultant for North America: a custom role with Audits (view, edit) and the league table.
  const jordan = await upsertUser(`jordan.reyes@${MAIL}`, 'Jordan Reyes');
  const [role] = await db.insert(t.customRoles).values({ organizationId: orgId, name: 'Field consultant', description: 'Visits studios, conducts audits and follows up corrective actions in their region.', baseRole: 'staff', primaryWorkspace: 'operations', createdBy: ceo.id }).returning();
  await db.insert(t.roleCapabilities).values(['operations.audits:view', 'operations.audits:edit', 'network.league_table:view'].map((capability) => ({ roleId: role!.id, organizationId: orgId, capability })));
  await db.insert(t.roleAssignments).values({ organizationId: orgId, userId: jordan.id, role: 'custom', customRoleId: role!.id, scopeKind: 'region', scopeId: na.id, createdBy: ceo.id });

  // ── Checklists from the starters ──
  const tpl: Record<string, typeof t.auditTemplates.$inferSelect> = {};
  for (const key of ['brand_standards', 'cleanliness_safety', 'pre_opening']) {
    const st = STARTER_AUDIT_TEMPLATES.find((x) => x.key === key)!;
    const [row] = await db.insert(t.auditTemplates).values({ organizationId: orgId, ...auditTemplateBodySchema.parse(st), name: st.key === 'brand_standards' ? 'Northlight brand standards visit' : st.name, starterKey: key, createdBy: ops.id, updatedBy: ops.id }).returning();
    tpl[key] = row!;
  }

  // Photos stand-ins, one per location and purpose.
  const photoFor = new Map<string, string>();
  const photo = async (locationId: string, purpose: 'audit_photo' | 'corrective_evidence', rgb: [number, number, number]) => {
    const k = `${locationId}:${purpose}`;
    if (photoFor.has(k)) return photoFor.get(k)!;
    const data = png(160, 120, rgb);
    const [f] = await db.insert(t.opsFiles).values({ organizationId: orgId, locationId, purpose, name: purpose === 'audit_photo' ? 'site-photo.png' : 'fix-photo.png', mime: 'image/png', size: data.length, sha256: createHash('sha256').update(data).digest('hex'), storage: 'db', storageKey: `${orgId}/private/${purpose}/seed-${locationId}.png`, data, uploadedBy: jordan.id }).returning();
    photoFor.set(k, f!.id);
    return f!.id;
  };

  /** Answers for every question: `fail` lists question ids that fail; `scale` sets 1–5 answers. */
  const answer = (sections: AuditSection[], photoId: string, fail: string[], scale = 4, notes: Record<string, string> = {}): AuditAnswers => {
    const out: AuditAnswers = {};
    for (const sec of sections) for (const q of sec.questions) {
      const bad = fail.includes(q.id);
      const photos = q.photoRequired || q.type === 'photo' ? { photoIds: [photoId] } : {};
      if (q.type === 'yes_no') out[q.id] = { value: bad ? 'no' : 'yes', ...photos };
      else if (q.type === 'scale') out[q.id] = { value: bad ? 2 : scale, ...photos };
      else if (q.type === 'number') out[q.id] = { value: bad ? (q.max ?? 0) + 4 : (q.max ?? q.min ?? 0) - 1, ...photos };
      else if (q.type === 'text') out[q.id] = { value: notes[q.id] ?? 'Busy evening class, friendly front desk.' };
      else out[q.id] = photos;
      if (notes[q.id] && q.type !== 'text') out[q.id]!.note = notes[q.id];
    }
    return out;
  };

  let auditCount = 0;
  /** Runs one audit for a location: schedules it (or takes the pending re-audit), answers and completes it on `day`. */
  const run = async (locCode: string, key: string, day: string, auditor: User, fail: string[], scale: number, opts: { notes?: Record<string, string>; summary?: string } = {}) => {
    const loc = L[locCode]!;
    const [pending] = await db.select().from(t.audits).where(and(eq(t.audits.locationId, loc.id), eq(t.audits.status, 'scheduled'), eq(t.audits.templateId, tpl[key]!.id)));
    const a = pending ?? await scheduleAudit(db, orgId, { locationId: loc.id, templateId: tpl[key]!.id, dueDate: day, auditorUserId: auditor.id, purpose: 'routine' }, ops.id);
    const photoId = await photo(loc.id, 'audit_photo', [220, 205, 170]);
    const answers = answer(a.checklist.sections, photoId, fail, scale, opts.notes);
    const at = new Date(`${day}T15:00:00Z`);
    const [started] = await db.update(t.audits).set({ answers, status: 'in_progress', startedAt: new Date(at.getTime() - 90 * 60_000), revision: 6, dueDate: pending ? pending.dueDate : day }).where(eq(t.audits.id, a.id)).returning();
    const out = await completeAudit(s, started!, auditor.id, opts.summary ?? null, at);
    auditCount++;
    return out;
  };
  /** Closes the corrective actions of an audit: fixed with a photo and verified by the auditor. */
  const closeActions = async (auditId: string, locCode: string, auditor: User, fixedBy: User, day: string) => {
    const evidence = await photo(L[locCode]!.id, 'corrective_evidence', [186, 214, 196]);
    await db.update(t.auditActions).set({ status: 'verified', responseNote: 'Fixed and checked with the team.', evidenceFileIds: [evidence], submittedBy: fixedBy.id, submittedAt: new Date(`${day}T10:00:00Z`), verifiedBy: auditor.id, verifiedAt: new Date(`${day}T16:00:00Z`) }).where(eq(t.auditActions.auditId, auditId));
  };

  const liam = await user('liam.oconnor');
  const ava = await user('ava.thompson');
  const oliver = await user('oliver.grant');
  const noah = await user('noah.williams');
  const d = (n: number) => addDays(today, n);

  // Toronto Annex (company-owned): steady and improving.
  for (const [day, fail, sc] of [[d(-110), ['music_lighting', 'online_listing', 'complaints_logged'], 5], [d(-70), ['online_listing', 'music_lighting'], 5], [d(-28), ['online_listing'], 5]] as Array<[string, string[], number]>) {
    const r = await run('TOR-AX', 'brand_standards', day, jordan, fail, sc);
    await closeActions(r.audit.id, 'TOR-AX', jordan, ops, addDays(day, 6));
  }
  // Vancouver Main Street: failed, re-audited, now passing.
  {
    const r1 = await run('YVR-MS', 'brand_standards', d(-95), jordan, ['sign_clean', 'brand_materials', 'current_campaign', 'complaints_logged'], 3, { summary: 'Outdated campaign posters and a damaged sign. Re-audit booked.' });
    await closeActions(r1.audit.id, 'YVR-MS', jordan, liam, d(-85));
    const r2 = await run('YVR-MS', 'brand_standards', d(-66), jordan, ['online_listing'], 4);
    await closeActions(r2.audit.id, 'YVR-MS', jordan, liam, d(-60));
    const r3 = await run('YVR-MS', 'brand_standards', d(-21), jordan, ['hours_posted'], 5);
    await closeActions(r3.audit.id, 'YVR-MS', jordan, liam, d(-15));
  }
  // Kitsilano: good brand visits, then a cleanliness & safety audit failed on a critical item (blocked fire exit).
  {
    const r1 = await run('YVR-KT', 'brand_standards', d(-100), jordan, [], 5);
    void r1;
    const r2 = await run('YVR-KT', 'brand_standards', d(-58), jordan, ['training_current'], 4);
    await closeActions(r2.audit.id, 'YVR-KT', jordan, mia, d(-50));
    const r3 = await run('YVR-KT', 'cleanliness_safety', d(-16), jordan, ['exits_clear', 'cleaning_log', 'first_aid_kit'], 4, {
      notes: { exits_clear: 'Mats stacked against the rear fire exit.', first_aid_kit: 'Burn gel and plasters out of date.' },
      summary: 'Studio is clean and welcoming, but the rear fire exit was blocked by stored mats. Critical: fixed on the spot, needs a permanent storage solution.',
    });
    // The fire exit fix is submitted with a photo and waits for Jordan; the first-aid kit and cleaning log are still open (one overdue).
    const acts = await db.select().from(t.auditActions).where(eq(t.auditActions.auditId, r3.audit.id));
    const evidence = await photo(L['YVR-KT']!.id, 'corrective_evidence', [186, 214, 196]);
    const exits = acts.find((x) => x.questionId === 'exits_clear')!;
    await db.update(t.auditActions).set({ status: 'submitted', responseNote: 'New wall rack installed for mats; exit route marked on the floor.', evidenceFileIds: [evidence], submittedBy: mia.id, submittedAt: new Date(`${d(-3)}T17:00:00Z`) }).where(eq(t.auditActions.id, exits.id));
    await db.update(t.auditActions).set({ dueDate: d(-2) }).where(eq(t.auditActions.id, acts.find((x) => x.questionId === 'first_aid_kit')!.id));
    await db.update(t.auditActions).set({ dueDate: d(5) }).where(eq(t.auditActions.id, acts.find((x) => x.questionId === 'cleaning_log')!.id));
    // The automatic re-audit is due in a few days.
    await db.update(t.audits).set({ dueDate: d(4) }).where(and(eq(t.audits.parentAuditId, r3.audit.id), eq(t.audits.status, 'scheduled')));
    await db.update(t.audits).set({ reauditDueDate: d(4) }).where(eq(t.audits.id, r3.audit.id));
  }
  // Portland Pearl (Rose City): passing, one fix verified.
  for (const [day, fail, sc] of [[d(-90), ['greeting', 'hours_posted'], 5], [d(-55), ['hours_posted'], 4], [d(-12), ['uniforms'], 5]] as Array<[string, string[], number]>) {
    const r = await run('PDX-PR', 'brand_standards', day, jordan, fail, sc);
    if (day !== d(-12)) await closeActions(r.audit.id, 'PDX-PR', jordan, ava, addDays(day, 8));
    else await db.update(t.auditActions).set({ dueDate: d(9) }).where(eq(t.auditActions.auditId, r.audit.id));
  }
  // London Hackney (Thames): failed, re-audited by HQ operations, two actions open from the latest visit.
  {
    const r1 = await run('LON-HK', 'brand_standards', d(-104), ops, ['brand_materials', 'uniforms', 'greeting', 'current_campaign'], 3, { summary: 'Team uniforms and in-studio campaign need attention. Re-audit booked.' });
    await closeActions(r1.audit.id, 'LON-HK', ops, noah, d(-96));
    const r2 = await run('LON-HK', 'brand_standards', d(-75), ops, ['current_campaign'], 4);
    await closeActions(r2.audit.id, 'LON-HK', ops, noah, d(-68));
    const r3 = await run('LON-HK', 'brand_standards', d(-9), ops, ['online_listing', 'training_current'], 5);
    await db.update(t.auditActions).set({ dueDate: d(5) }).where(eq(t.auditActions.auditId, r3.audit.id));
  }
  // Upcoming routine visits.
  await scheduleAudit(db, orgId, { locationId: L['TOR-AX']!.id, templateId: tpl.cleanliness_safety!.id, dueDate: d(12), auditorUserId: jordan.id, purpose: 'routine' }, ops.id);
  await scheduleAudit(db, orgId, { locationId: L['PDX-PR']!.id, templateId: tpl.cleanliness_safety!.id, dueDate: d(18), auditorUserId: jordan.id, purpose: 'routine' }, ops.id);
  await scheduleAudit(db, orgId, { locationId: L['LON-HK']!.id, templateId: tpl.cleanliness_safety!.id, dueDate: d(-1), auditorUserId: ops.id, purpose: 'routine' }, ops.id);

  // Pre-opening: Dublin Portobello's go-live needs the pre-opening audit to pass.
  if (L['DUB-PB']) {
    const [proj] = await db.select().from(t.franchiseProjects).where(eq(t.franchiseProjects.locationId, L['DUB-PB']!.id));
    if (proj) {
      await db.update(t.franchiseProjects).set({ preOpeningTemplateId: tpl.pre_opening!.id }).where(eq(t.franchiseProjects.id, proj.id));
      await scheduleAudit(db, orgId, { locationId: L['DUB-PB']!.id, templateId: tpl.pre_opening!.id, dueDate: d(10), auditorUserId: ops.id, purpose: 'pre_opening', projectId: proj.id }, ops.id);
    }
  }

  // ── Compliance documents ──
  const legal = await user('amara.nwosu');
  const reqs = await db.insert(t.complianceRequirements).values([
    { organizationId: orgId, name: 'General liability insurance (Canada)', category: 'insurance', description: 'Commercial general liability naming Northlight Yoga International as additional insured.', coverageType: 'General liability', minAmountMinor: 200_000_000, currency: 'CAD', jurisdictions: ['CA'], createdBy: legal.id },
    { organizationId: orgId, name: 'General liability insurance (US)', category: 'insurance', description: 'Commercial general liability naming Northlight Yoga International as additional insured.', coverageType: 'General liability', minAmountMinor: 200_000_000, currency: 'USD', jurisdictions: ['US'], createdBy: legal.id },
    { organizationId: orgId, name: 'Public liability insurance (UK)', category: 'insurance', description: 'Public and products liability.', coverageType: 'Public liability', minAmountMinor: 500_000_000, currency: 'GBP', jurisdictions: ['GB'], createdBy: legal.id },
    { organizationId: orgId, name: 'Business licence', category: 'licence', description: 'Municipal business licence for the studio address.', createdBy: legal.id },
    { organizationId: orgId, name: 'Fire safety inspection', category: 'permit', description: 'Latest fire safety inspection certificate for the premises.', createdBy: legal.id },
  ]).returning();
  const R = (name: string) => reqs.find((r) => r.name.startsWith(name))!;
  const pdfFile = async (locationId: string, name: string) => {
    const [f] = await db.insert(t.opsFiles).values({ organizationId: orgId, locationId, purpose: 'compliance_document', name, mime: 'application/pdf', size: PDF.length, sha256: createHash('sha256').update(PDF).digest('hex'), storage: 'db', storageKey: `${orgId}/private/compliance_document/seed-${name}`, data: PDF }).returning();
    return f!.id;
  };
  let docCount = 0;
  const doc = async (code: string, req: (typeof reqs)[number], o: { title: string; issuer?: string; reference?: string; amount?: number; issued: string; expires: string | null; status?: 'approved' | 'pending' | 'rejected'; by: User; note?: string; reminders?: number[] }) => {
    const loc = L[code]!;
    await db.insert(t.complianceDocuments).values({
      organizationId: orgId, requirementId: req.id, locationId: loc.id, category: req.category, title: o.title, issuer: o.issuer ?? null, reference: o.reference ?? null, coverageType: req.coverageType,
      coverageAmountMinor: o.amount ?? null, currency: o.amount ? req.currency : null, issuedOn: o.issued, expiresOn: o.expires, fileId: await pdfFile(loc.id, `${code}-${req.category}-${docCount}.pdf`),
      status: o.status ?? 'approved', reviewNote: o.note ?? null, reviewedBy: (o.status ?? 'approved') === 'pending' ? null : legal.id, reviewedAt: (o.status ?? 'approved') === 'pending' ? null : new Date(`${o.issued}T12:00:00Z`), uploadedBy: o.by.id,
      remindersSent: o.reminders ?? [],
    });
    docCount++;
  };
  // Toronto Annex: all valid.
  await doc('TOR-AX', R('General liability insurance (Canada)'), { title: 'CGL certificate 2026', issuer: 'Maple Mutual Insurance', reference: 'CGL-448812', amount: 500_000_000, issued: d(-120), expires: d(245), by: ops });
  await doc('TOR-AX', R('Business licence'), { title: 'City of Toronto business licence', issuer: 'City of Toronto', reference: 'B02-7781', issued: d(-200), expires: d(165), by: ops });
  await doc('TOR-AX', R('Fire safety inspection'), { title: 'Fire inspection report', issuer: 'Toronto Fire Services', issued: d(-80), expires: d(285), by: ops });
  // Vancouver Main Street: insurance valid, licence valid, fire inspection missing.
  await doc('YVR-MS', R('General liability insurance (Canada)'), { title: 'CGL certificate', issuer: 'Pacific Coast Underwriters', reference: 'PCU-22091', amount: 300_000_000, issued: d(-150), expires: d(215), by: liam });
  await doc('YVR-MS', R('Business licence'), { title: 'Vancouver business licence', issuer: 'City of Vancouver', reference: '25-118842', issued: d(-60), expires: d(305), by: liam });
  // Kitsilano: insurance expiring in 19 days (reminders at 60 and 30 days sent), licence valid, fire inspection valid.
  await doc('YVR-KT', R('General liability insurance (Canada)'), { title: 'CGL certificate', issuer: 'Pacific Coast Underwriters', reference: 'PCU-22188', amount: 300_000_000, issued: d(-346), expires: d(19), by: liam, reminders: [60, 30] });
  await doc('YVR-KT', R('Business licence'), { title: 'Vancouver business licence', issuer: 'City of Vancouver', reference: '25-119310', issued: d(-60), expires: d(305), by: liam });
  await doc('YVR-KT', R('Fire safety inspection'), { title: 'Fire inspection report', issuer: 'Vancouver Fire Rescue Services', issued: d(-120), expires: d(245), by: mia });
  // Portland Pearl: insurance below the minimum; renewed business licence waiting for review; fire inspection valid.
  await doc('PDX-PR', R('General liability insurance (US)'), { title: 'COI — general liability', issuer: 'Cascade Casualty', reference: 'CC-7781-OR', amount: 100_000_000, issued: d(-40), expires: d(325), by: ava, note: 'Accepted for now: limit is below the 2M requirement, increase at renewal.' });
  await doc('PDX-PR', R('Business licence'), { title: 'Portland business tax registration', issuer: 'City of Portland', reference: 'BTR-559210', issued: d(-2), expires: d(363), status: 'pending', by: ava });
  await doc('PDX-PR', R('Fire safety inspection'), { title: 'Fire & life safety inspection', issuer: 'Portland Fire & Rescue', issued: d(-150), expires: d(215), by: ava });
  // London Hackney: insurance valid, licence valid, fire risk assessment expired last week (HQ escalated).
  await doc('LON-HK', R('Public liability insurance (UK)'), { title: 'Public liability schedule', issuer: 'Thames Mutual', reference: 'TM-PL-30455', amount: 1_000_000_000, issued: d(-90), expires: d(275), by: oliver });
  await doc('LON-HK', R('Business licence'), { title: 'Premises licence', issuer: 'London Borough of Hackney', reference: 'HK-PL-2210', issued: d(-300), expires: d(430), by: oliver });
  await doc('LON-HK', R('Fire safety inspection'), { title: 'Fire risk assessment', issuer: 'Clerkenwell Fire Safety Ltd', issued: d(-372), expires: d(-7), by: noah, reminders: [60, 30, 7, 0] });
  await db.update(t.complianceDocuments).set({ escalatedAt: new Date(`${d(-7)}T09:00:00Z`) }).where(and(eq(t.complianceDocuments.organizationId, orgId), eq(t.complianceDocuments.title, 'Fire risk assessment')));

  return { logins: [jordan.email], audits: auditCount, documents: docCount };
}
