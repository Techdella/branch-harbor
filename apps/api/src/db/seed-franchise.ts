/**
 * Franchise development demo (sample data only) for a Toronto-based franchisor (Stillwater Yoga, Northlight Yoga):
 * territories, prospects across the US, Canada and Australia at every stage (one blocked by the disclosure waiting
 * period, one blocked by a pending state registration, one ready to sign, one in onboarding), sample disclosure
 * documents per jurisdiction (labelled samples — real ones come from franchise counsel), registrations, cadence
 * tasks and the agreements register. Jurisdiction rules are the shipped platform rules (not reviewed by counsel).
 *
 * DEMO SITE ONLY: called from seed-demo.ts, never from the production seed.
 */
import { eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { addActivity, ensureFranchiseDefaults, ensurePlatformRules, generateCadenceTasks, startOnboarding } from '../services/franchise.ts';

type User = typeof t.users.$inferSelect;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

/** A tiny valid PDF whose single page says it is a sample. */
function samplePdf(title: string) {
  const text = `SAMPLE - ${title} - replace with the document from your franchise counsel`.replace(/[()\\]/g, '');
  const stream = `BT /F1 12 Tf 40 760 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const buf = Buffer.from(out, 'latin1');
  return { contentBase64: buf.toString('base64'), sizeBytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

export interface FranchiseSeedInput {
  db: Db;
  orgId: string;
  /** Uploads and register entries are attributed to this HQ user. */
  demo: User;
  /** Franchise development lead (VP Franchise): owns the prospects and the HQ tasks. */
  lead: User;
  /** Brand name used in sample document titles. */
  brand: string;
  /** Location that collects franchise fees (its payment account). */
  collectLocationCode?: string;
  /**
   * The signed prospect's new studio: when given, the onboarding project belongs to this existing owner group and
   * location (so that franchise owner's demo login sees it); otherwise a new owner group is created.
   */
  onboarding?: { ownerGroupId: string; locationId: string; prospect: { name: string; email: string; country: string; region?: string; city: string; currency: string } };
}

export async function seedFranchise(c: FranchiseSeedInput) {
  const { db, orgId, demo } = c;
  const lucia = c.lead;
  await ensurePlatformRules(db);
  await ensureFranchiseDefaults(db, orgId);

  const [org] = await db.select().from(t.organizations).where(eq(t.organizations.id, orgId));
  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const collect = locs.find((l) => l.code === c.collectLocationCode);
  await db.update(t.organizations).set({ settings: { ...org!.settings, franchise: { homeRegion: 'ON', enquiryFormEnabled: true, defaultOwnerUserId: lucia.id, collectLocationId: collect?.id ?? null } } }).where(eq(t.organizations.id, orgId));

  await db.insert(t.franchiseRegistrations).values([
    { organizationId: orgId, jurisdiction: 'US-WA', status: 'registered', fileNumber: 'SAMPLE-WA-2026', effectiveFrom: ago(200), expiresAt: new Date(Date.now() + 165 * DAY), notes: 'Sample record' },
    { organizationId: orgId, jurisdiction: 'US-CA', status: 'registered', fileNumber: 'SAMPLE-CA-2026', effectiveFrom: ago(120), expiresAt: new Date(Date.now() + 245 * DAY), notes: 'Sample record' },
    { organizationId: orgId, jurisdiction: 'US-MN', status: 'pending', notes: 'Application filed; waiting for the Department of Commerce (sample)' },
    { organizationId: orgId, jurisdiction: 'US-TX', status: 'exempt', notes: 'Business opportunity exemption notice filed (sample)' },
  ]);

  const terr = await db.insert(t.franchiseTerritories).values([
    { organizationId: orgId, name: 'Calgary Beltline', country: 'CA', region: 'AB' },
    { organizationId: orgId, name: 'Halifax Peninsula', country: 'CA', region: 'NS' },
    { organizationId: orgId, name: 'Ottawa Glebe', country: 'CA', region: 'ON', status: 'sold' },
    { organizationId: orgId, name: 'Victoria Downtown', country: 'CA', region: 'BC', status: 'reserved' },
    { organizationId: orgId, name: 'Austin North', country: 'US', region: 'TX' },
    { organizationId: orgId, name: 'Phoenix East', country: 'US', region: 'AZ', status: 'reserved' },
    { organizationId: orgId, name: 'Minneapolis Uptown', country: 'US', region: 'MN' },
    { organizationId: orgId, name: 'Denver LoHi', country: 'US', region: 'CO' },
    { organizationId: orgId, name: 'Brisbane Fortitude Valley', country: 'AU', region: 'QLD' },
    { organizationId: orgId, name: 'Melbourne Fitzroy', country: 'AU', region: 'VIC', showOnSite: false, status: 'unavailable', description: 'Held for the Harbour Flow development agreement' },
  ]).returning();
  const T = Object.fromEntries(terr.map((x) => [x.name, x]));

  const doc = async (kind: string, title: string, jurisdictions: string[], extra: Partial<typeof t.franchiseDocuments.$inferInsert> = {}) => {
    const f = samplePdf(title);
    const [d] = await db.insert(t.franchiseDocuments).values({ organizationId: orgId, kind, title, version: '2026', jurisdictions, issuedOn: '2026-04-30', fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-sample.pdf`, contentType: 'application/pdf', uploadedBy: demo.id, ...f, ...extra }).returning();
    return d!;
  };
  const fddUS = await doc('disclosure', 'Franchise Disclosure Document (sample)', ['US']);
  const fddCA = await doc('disclosure', 'Canadian Disclosure Document (sample)', ['CA']);
  const fddAU = await doc('disclosure', 'Australian Disclosure Document (sample)', ['AU']);
  const agreement = await doc('agreement_template', 'Franchise Agreement 2026.2 (sample)', ['US', 'CA', 'AU']);
  await doc('vault', `Trademark licence — ${c.brand} marks (sample)`, []);

  type P = typeof t.franchiseProspects.$inferInsert;
  const base = { organizationId: orgId, ownerUserId: lucia.id } as const;
  const mk = async (p: Omit<P, 'organizationId'>, enteredDaysAgo: number) => {
    const [row] = await db.insert(t.franchiseProspects).values({ ...base, ...p, stageEnteredAt: ago(enteredDaysAgo), createdAt: ago(enteredDaysAgo + 10) }).returning();
    await addActivity(db, row!, 'enquiry', p.message ?? null, null, { source: p.source });
    await generateCadenceTasks(db, row!);
    return row!;
  };
  const cad = (n: number) => n * 100;

  await mk({ name: 'Olivia Chen', email: 'olivia.chen@example.com', phone: '+1 403 555 0110', country: 'CA', region: 'AB', city: 'Calgary', territoryId: T['Calgary Beltline']!.id, liquidCapitalMinor: cad(180_000), netWorthMinor: cad(650_000), currency: 'CAD', source: 'brand_site', message: '8 years managing boutique fitness studios. Interested in Calgary.', stage: 'enquiry' }, 1);
  await mk({ name: 'Rahul & Mira Shah', email: 'shah.family@example.com', country: 'CA', region: 'NS', city: 'Halifax', territoryId: T['Halifax Peninsula']!.id, units: 2, liquidCapitalMinor: cad(400_000), netWorthMinor: cad(1_500_000), currency: 'CAD', source: 'ads', attribution: { source: 'meta', medium: 'paid_social', campaign: 'own-a-studio-fall' }, stage: 'qualified' }, 3);
  await mk({ name: 'Ben Okafor', email: 'ben.okafor@example.com', country: 'US', region: 'TX', city: 'Austin', territoryId: T['Austin North']!.id, liquidCapitalMinor: 25_000_000, netWorthMinor: 90_000_000, currency: 'USD', source: 'referral', stage: 'discovery_call' }, 2);

  // Blocked by the waiting period: receipt signed 5 days ago.
  const sofia = await mk({ name: 'Sofia Marquez', email: 'sofia.marquez@example.com', country: 'US', region: 'AZ', city: 'Phoenix', territoryId: T['Phoenix East']!.id, units: 3, liquidCapitalMinor: 60_000_000, netWorthMinor: 250_000_000, currency: 'USD', source: 'franchise_portal', stage: 'waiting_period' }, 5);
  await db.update(t.franchiseTerritories).set({ reservedForProspectId: sofia.id }).where(eq(t.franchiseTerritories.id, T['Phoenix East']!.id));
  await db.insert(t.franchiseDeliveries).values({ organizationId: orgId, prospectId: sofia.id, documentId: fddUS.id, tokenHash: sha256(`seed-sofia-${orgId}`), deliveredAt: ago(6), deliveredBy: lucia.id, openedAt: ago(5), receiptSignedAt: ago(5), receiptName: 'Sofia Marquez', receiptIp: '203.0.113.24', receiptUserAgent: 'Sample browser' });
  await addActivity(db, sofia, 'disclosure_sent', `${fddUS.title} v${fddUS.version}`, lucia.id, { documentId: fddUS.id });
  await addActivity(db, sofia, 'receipt_signed', 'Sofia Marquez', null, { ip: '203.0.113.24' });

  // Blocked by a pending state registration (Minnesota) although the waiting period is over.
  const tom = await mk({ name: 'Tom Becker', email: 'tom.becker@example.com', country: 'US', region: 'MN', city: 'Minneapolis', territoryId: T['Minneapolis Uptown']!.id, liquidCapitalMinor: 15_000_000, netWorthMinor: 70_000_000, currency: 'USD', source: 'event', stage: 'disclosure_receipt_signed' }, 18);
  await db.insert(t.franchiseDeliveries).values({ organizationId: orgId, prospectId: tom.id, documentId: fddUS.id, tokenHash: sha256(`seed-tom-${orgId}`), deliveredAt: ago(19), deliveredBy: lucia.id, openedAt: ago(18), receiptSignedAt: ago(18), receiptName: 'Tom Becker', receiptIp: '198.51.100.7' });
  await addActivity(db, tom, 'receipt_signed', 'Tom Becker', null, {});

  // Ready to sign: waiting period over (Canada, British Columbia).
  const grace = await mk({ name: 'Grace Liu', email: 'grace.liu@example.com', country: 'CA', region: 'BC', city: 'Victoria', territoryId: T['Victoria Downtown']!.id, liquidCapitalMinor: cad(220_000), netWorthMinor: cad(800_000), currency: 'CAD', source: 'brand_site', stage: 'agreement_sent' }, 2);
  await db.update(t.franchiseTerritories).set({ reservedForProspectId: grace.id }).where(eq(t.franchiseTerritories.id, T['Victoria Downtown']!.id));
  const [gd] = await db.insert(t.franchiseDeliveries).values({ organizationId: orgId, prospectId: grace.id, documentId: fddCA.id, tokenHash: sha256(`seed-grace-${orgId}`), deliveredAt: ago(21), deliveredBy: lucia.id, openedAt: ago(20), receiptSignedAt: ago(20), receiptName: 'Grace Liu', receiptIp: '192.0.2.44' }).returning();
  const [ga] = await db.insert(t.franchiseDeliveries).values({ organizationId: orgId, prospectId: grace.id, documentId: agreement.id, kind: 'agreement', tokenHash: sha256(`seed-grace-ag-${orgId}`), deliveredAt: ago(2), deliveredBy: lucia.id }).returning();
  await db.insert(t.franchiseSignatures).values({ organizationId: orgId, prospectId: grace.id, documentId: agreement.id, deliveryId: ga!.id, provider: 'builtin', providerEnvelopeId: 'bh_env_sample', tokenHash: sha256(`seed-grace-sign-${orgId}`), terms: { termYears: 10, royaltyBps: 600, marketingFundBps: 200, renewalOption: 'One 10-year renewal', territory: 'Victoria Downtown' }, sentAt: ago(2), sentBy: lucia.id });
  void gd;

  // Disclosure sent, receipt not signed yet (Australia).
  const liam = await mk({ name: 'Liam Walsh', email: 'liam.walsh@example.com', country: 'AU', region: 'QLD', city: 'Brisbane', territoryId: T['Brisbane Fortitude Valley']!.id, liquidCapitalMinor: 30_000_000, netWorthMinor: 110_000_000, currency: 'AUD', source: 'campaign', attribution: { campaign: 'au-launch' }, stage: 'disclosure_sent' }, 1);
  await db.insert(t.franchiseDeliveries).values({ organizationId: orgId, prospectId: liam.id, documentId: fddAU.id, tokenHash: sha256(`seed-liam-${orgId}`), deliveredAt: ago(1), deliveredBy: lucia.id });

  // Signed and in onboarding (Ontario): owner group, agreement, onboarding project with progress.
  const op = c.onboarding?.prospect;
  const aisha = await mk({ name: 'Aisha Rahman', email: 'aisha.rahman@example.com', country: 'CA', region: 'ON', city: 'Ottawa', territoryId: op ? null : T['Ottawa Glebe']!.id, liquidCapitalMinor: cad(300_000), netWorthMinor: cad(1_100_000), currency: 'CAD', source: 'referral', stage: 'onboarding', ...(op ? { ...op, region: op.region ?? null } : {}) }, 30);
  const signer = aisha.name;
  await db.insert(t.franchiseDeliveries).values({ organizationId: orgId, prospectId: aisha.id, documentId: fddCA.id, tokenHash: sha256(`seed-aisha-${orgId}`), deliveredAt: ago(60), deliveredBy: lucia.id, receiptSignedAt: ago(59), receiptName: signer, receiptIp: '192.0.2.10' });
  const [aSig] = await db.insert(t.franchiseSignatures).values({ organizationId: orgId, prospectId: aisha.id, documentId: agreement.id, provider: 'builtin', status: 'signed', terms: { termYears: 10, royaltyBps: 600, marketingFundBps: 200 }, sentAt: ago(35), sentBy: lucia.id, signedAt: ago(30), signerName: signer, signerIp: '192.0.2.10' }).returning();
  const [aGroup] = c.onboarding
    ? await db.select().from(t.ownerGroups).where(eq(t.ownerGroups.id, c.onboarding.ownerGroupId))
    : await db.insert(t.ownerGroups).values({ organizationId: orgId, name: 'Glebe Flow Inc.', legalName: 'Glebe Flow Inc.' }).returning();
  await db.update(t.franchiseProspects).set({ ownerGroupId: aGroup!.id }).where(eq(t.franchiseProspects.id, aisha.id));
  if (!op) await db.update(t.franchiseTerritories).set({ ownerGroupId: aGroup!.id }).where(eq(t.franchiseTerritories.id, T['Ottawa Glebe']!.id));
  const start = ago(30).toISOString().slice(0, 10);
  await db.insert(t.franchiseAgreements).values({ organizationId: orgId, ownerGroupId: aGroup!.id, prospectId: aisha.id, territoryId: op ? null : T['Ottawa Glebe']!.id, territory: op ? op.city : 'Ottawa Glebe', jurisdiction: op ? (op.region ? `${op.country}-${op.region}` : op.country) : 'CA-ON', startDate: start, endDate: `${Number(start.slice(0, 4)) + 10}${start.slice(4)}`, termYears: 10, renewalOption: 'One 10-year renewal', royaltyBps: 600, marketingFundBps: 200, terms: { signatureId: aSig!.id }, documentId: agreement.id, createdBy: lucia.id });
  await addActivity(db, aisha, 'agreement_signed', signer, null, { signatureId: aSig!.id });
  const proj = await startOnboarding(db, { ...aisha, ownerGroupId: aGroup!.id }, org!.name);
  await db.update(t.franchiseProjects).set({ startedAt: ago(28), ...(c.onboarding ? { locationId: c.onboarding.locationId } : {}) }).where(eq(t.franchiseProjects.id, proj.id));
  const projTasks = await db.select().from(t.franchiseTasks).where(eq(t.franchiseTasks.projectId, proj.id));
  const doneKeys = ['site_criteria', 'site_submitted', 'training_owner'];
  await db.update(t.franchiseTasks).set({ status: 'done', completedAt: ago(5), completedBy: lucia.id }).where(inArray(t.franchiseTasks.id, projTasks.filter((x) => doneKeys.some((k) => x.sourceKey?.endsWith(`:${k}`))).map((x) => x.id)));
  for (const task of projTasks) await db.update(t.franchiseTasks).set({ dueAt: new Date(task.dueAt!.getTime() - 28 * DAY) }).where(eq(t.franchiseTasks.id, task.id));

  await mk({ name: 'Summit Flow Partners', email: 'hello@summitflow.example', country: 'US', region: 'CO', city: 'Denver', territoryId: T['Denver LoHi']!.id, liquidCapitalMinor: 50_000_000, netWorthMinor: 200_000_000, currency: 'USD', source: 'broker', stage: 'lost', lostReason: 'Chose a different brand' }, 12);

  // Agreements register for the existing franchisees (one expiring within six months).
  const groups = await db.select().from(t.ownerGroups).where(eq(t.ownerGroups.organizationId, orgId));
  const rows: Array<typeof t.franchiseAgreements.$inferInsert> = [];
  for (const [i, g] of groups.filter((x) => x.id !== aGroup!.id).entries()) {
    const own = locs.filter((l) => l.ownerGroupId === g.id);
    if (!own.length) continue;
    const first = own[0]!;
    const region = (first.address as { region?: string } | null)?.region;
    const startYear = 2016 + (i % 6);
    const endDate = i === 1 ? new Date(Date.now() + 140 * DAY).toISOString().slice(0, 10) : `${startYear + 10}-${String((i % 12) + 1).padStart(2, '0')}-28`;
    rows.push({
      organizationId: orgId, ownerGroupId: g.id, territory: own.map((l) => l.name).join(' & '), jurisdiction: region && ['CA', 'US', 'AU'].includes(first.country) ? `${first.country}-${region}` : first.country,
      locationIds: own.map((l) => l.id), startDate: `${startYear}-${String((i % 12) + 1).padStart(2, '0')}-01`, endDate, termYears: 10,
      renewalOption: i === 1 ? 'One 5-year renewal, 6 months’ notice' : 'One 10-year renewal, 12 months’ notice', royaltyBps: 550 + (i % 3) * 50, marketingFundBps: 200,
    });
  }
  if (rows.length) await db.insert(t.franchiseAgreements).values(rows.map((r) => ({ ...r, createdBy: demo.id })));

  return { prospects: 9, lead: lucia.email, blocked: { waitingPeriod: sofia.name, registration: tom.name }, readyToSign: grace.name, onboarding: aisha.name };
}
