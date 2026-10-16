/**
 * DEMO SITE ONLY — never run against the production database. The production seed is `seed.ts`
 * (`pnpm db:seed`), which creates no businesses.
 *
 * Seeds the demo account for prospects and investors (demo.branchharbor.com: same code, DEMO_MODE=true, a separate
 * database): an international Stillwater Yoga network (Toronto CAD, Seattle USD, London GBP, Berlin EUR, Sydney
 * AUD), the Maple & Ember foods group, sports, wellness, commerce, real-estate and independent businesses, and the
 * Northlight Yoga International franchisor team that shows the access model (one demo login per role).
 * Sample data only. Re-running replaces the demo organisations.
 *
 *   pnpm db:seed:demo        (SEED_DEMO_PASSWORD=... to choose the password; the demo picker needs none)
 */
import { inArray, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { createDb, type Db } from './client.ts';
import * as t from './schema/index.ts';
import { hashPassword } from '../services/auth.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';
import { clearOperationsDemo, OPERATIONS_DEMO_SLUGS, seedOperations } from './seed-operations.ts';
import { seedIndependent } from './seed-independent.ts';
import { seedFoods } from './seed-foods.ts';
import { NORTHLIGHT_SLUG, seedNorthlight } from './seed-northlight.ts';

const cfg = config();
const handle = createDb(cfg.DATABASE_URL, { max: 2 });
const db: Db = handle.db;
const password = process.env.SEED_DEMO_PASSWORD ?? `Harbor-${randomBytes(4).toString('hex')}!`;
const today = new Date().toISOString().slice(0, 10);

async function upsertUser(email: string, name: string, locale = 'en') {
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select().from(t.users).where(sql`lower(${t.users.email}) = ${email.toLowerCase()}`);
  const [u] = existing
    ? await db.update(t.users).set({ passwordHash, name, emailVerifiedAt: new Date(), deletedAt: null }).where(sql`${t.users.id} = ${existing.id}`).returning()
    : await db.insert(t.users).values({ email, name, passwordHash, locale, emailVerifiedAt: new Date() }).returning();
  return u!;
}

/**
 * Stillwater: a small team where people cover several areas (team shape "small"). The combined roles are the
 * business's own roles built from the templates; Owen Reid holds two roles (access is the union). Nobody approves
 * disclosure yet, so Team & access shows it as an uncovered area (it goes to the owner meanwhile).
 */
async function seedSmallTeam(swId: string, ownerId: string, luciaId: string) {
  const { COMBINED_ROLES, combinedRoleCapabilities } = await import('@bh/shared');
  const created: Record<string, string> = {};
  for (const c of COMBINED_ROLES) {
    const [role] = await db.insert(t.customRoles).values({ organizationId: swId, name: c.name, description: c.description, primaryWorkspace: c.primaryWorkspace, createdBy: ownerId }).returning();
    await db.insert(t.roleCapabilities).values([...combinedRoleCapabilities(c.key, 'studios')].map((capability) => ({ roleId: role!.id, organizationId: swId, capability })));
    created[c.key] = role!.id;
  }
  const [org] = await db.select({ settings: t.organizations.settings }).from(t.organizations).where(sql`${t.organizations.id} = ${swId}`);
  await db.update(t.organizations).set({ settings: { ...(org?.settings ?? {}), teamShape: 'small', teamShapeRoles: created } }).where(sql`${t.organizations.id} = ${swId}`);
  const byEmail = async (email: string) => (await db.select().from(t.users).where(sql`lower(${t.users.email}) = ${email}`))[0]!;
  const elena = await byEmail('elena.costa@demo.branchharbor.com');
  const lena = await byEmail('lena.okafor@demo.branchharbor.com');
  const owen = await upsertUser('owen.reid@demo.branchharbor.com', 'Owen Reid');
  const asCustom = (userId: string, key: string) => db.update(t.roleAssignments).set({ role: 'custom', customRoleId: created[key]! })
    .where(sql`${t.roleAssignments.organizationId} = ${swId} and ${t.roleAssignments.userId} = ${userId} and ${t.roleAssignments.scopeKind} = 'organization'`);
  await asCustom(elena.id, 'marketing_sales');
  await asCustom(luciaId, 'development_training');
  await db.insert(t.roleAssignments).values([
    { organizationId: swId, userId: owen.id, role: 'custom', customRoleId: created.operations_finance!, scopeKind: 'organization', scopeId: swId, createdBy: ownerId },
    { organizationId: swId, userId: owen.id, role: 'trainer', scopeKind: 'organization', scopeId: swId, createdBy: ownerId },
  ]);
  // Lena teaches and follows up course leads at Queen West (a trainer with one extra module).
  const [lenaA] = await db.select().from(t.roleAssignments).where(sql`${t.roleAssignments.organizationId} = ${swId} and ${t.roleAssignments.userId} = ${lena.id}`);
  if (lenaA) await db.insert(t.memberAccessOverrides).values(['sales.course_leads:view', 'sales.course_leads:edit'].map((capability) => ({ organizationId: swId, assignmentId: lenaA.id, capability, effect: 'grant', createdBy: ownerId })));
  await db.insert(t.memberProfiles).values([
    { organizationId: swId, userId: elena.id, jobTitle: 'Head of growth' },
    { organizationId: swId, userId: owen.id, jobTitle: 'Operations, finance & teacher training' },
    { organizationId: swId, userId: luciaId, jobTitle: 'Franchise development & teacher training' },
  ]);
  return { combined: Object.keys(created), owen: owen.email };
}

async function main() {
  const slugs = ['stillwater-yoga', 'maple-and-ember', NORTHLIGHT_SLUG, ...OPERATIONS_DEMO_SLUGS];
  const old = await db.select({ id: t.organizations.id }).from(t.organizations).where(inArray(t.organizations.slug, slugs));
  if (old.length) {
    const ids = old.map((o) => o.id);
    await clearOperationsDemo(db, ids);
    // Tables without an FK cascade to organizations are cleared explicitly.
    for (const tbl of [t.paymentReferences, t.webhookEvents, t.auditEvents, t.aiProposedActions, t.aiMessages, t.publishJobResults, t.pageVersions, t.fieldOverrides, t.externalMappings, t.syncRuns, t.refunds, t.consentRecords] as const) {
      await db.delete(tbl).where(inArray((tbl as typeof t.paymentReferences).organizationId, ids));
    }
    await db.delete(t.organizations).where(inArray(t.organizations.id, ids));
  }

  const demo = await upsertUser('demo@branchharbor.com', 'Demo Owner');
  const maya = await upsertUser('maya.rao@demo.branchharbor.com', 'Maya Rao');
  const carlos = await upsertUser('carlos.ortega@demo.branchharbor.com', 'Carlos Ortega');
  const priya = await upsertUser('priya.anand@demo.branchharbor.com', 'Priya Anand', 'en-GB');

  // ───────────── Stillwater Yoga Collective ─────────────
  const [sw] = await db.insert(t.organizations).values({
    slug: 'stillwater-yoga', name: 'Stillwater Yoga Collective', industry: 'studios', model: 'network', country: 'CA', defaultCurrency: 'CAD', defaultLocale: 'en',
    defaultTimeZone: 'America/Toronto', dataRegion: 'us', applicationFeeBps: 100, paymentAccountMode: 'per_location',
    onboarding: Object.fromEntries(['industry', 'business_details', 'website', 'industry_data', 'connections', 'invite_staff'].map((k) => [k, { status: 'complete', updatedAt: new Date().toISOString() }])),
  }).returning();
  const swId = sw!.id;
  const [na, eu, apac] = await db.insert(t.regions).values([{ organizationId: swId, name: 'North America' }, { organizationId: swId, name: 'Europe' }, { organizationId: swId, name: 'Asia-Pacific' }]).returning();
  const [lakeshore, northbound, thames, spree, harbour] = await db.insert(t.ownerGroups).values([
    { organizationId: swId, name: 'Lakeshore Holdings', legalName: 'Lakeshore Holdings Inc.' },
    { organizationId: swId, name: 'Northbound Studios LLC', legalName: 'Northbound Studios LLC' },
    { organizationId: swId, name: 'Thames Wellness Ltd', legalName: 'Thames Wellness Ltd' },
    { organizationId: swId, name: 'Spree Studios GmbH', legalName: 'Spree Studios GmbH' },
    { organizationId: swId, name: 'Harbour Flow Pty Ltd', legalName: 'Harbour Flow Pty Ltd' },
  ]).returning();
  const swLocs = await db.insert(t.locations).values([
    { organizationId: swId, regionId: na!.id, ownerGroupId: lakeshore!.id, name: 'Queen West', code: 'TOR-QW', slug: 'queen-west', address: { line1: '812 Queen St W', city: 'Toronto', region: 'ON', postalCode: 'M6J 1G1', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: 'en', phone: '+1 416 555 0142', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_queenwest', hours: { summary: 'Mon–Fri 6am–9pm · Sat–Sun 8am–6pm' }, geo: { lat: 43.6447, lng: -79.4106 } },
    { organizationId: swId, regionId: na!.id, ownerGroupId: northbound!.id, name: 'Capitol Hill', code: 'SEA-CH', slug: 'capitol-hill', address: { line1: '1520 E Pine St', city: 'Seattle', region: 'WA', postalCode: '98122', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', locale: 'en', phone: '+1 206 555 0163', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_capitolhill', hours: { summary: 'Daily 6am–8pm' }, geo: { lat: 47.6152, lng: -122.3125 } },
    { organizationId: swId, regionId: eu!.id, ownerGroupId: thames!.id, name: 'Shoreditch', code: 'LON-SH', slug: 'shoreditch', address: { line1: '1 Rivington St', city: 'London', postalCode: 'EC2A 3DT', country: 'GB' }, country: 'GB', timeZone: 'Europe/London', currency: 'GBP', locale: 'en-GB', phone: '+44 20 7946 0142', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_shoreditch', hours: { summary: 'Daily 7am–9pm' }, geo: { lat: 51.5262, lng: -0.0794 } },
    { organizationId: swId, regionId: eu!.id, ownerGroupId: spree!.id, name: 'Mitte', code: 'BER-MI', slug: 'mitte', address: { line1: 'Torstraße 118', city: 'Berlin', postalCode: '10119', country: 'DE' }, country: 'DE', timeZone: 'Europe/Berlin', currency: 'EUR', locale: 'de', phone: '+49 30 555 0118', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_mitte', hours: { summary: 'Mo–So 7–21 Uhr' }, geo: { lat: 52.5297, lng: 13.4016 } },
    { organizationId: swId, regionId: apac!.id, ownerGroupId: harbour!.id, name: 'Surry Hills', code: 'SYD-SH', slug: 'surry-hills', address: { line1: '410 Crown St', city: 'Sydney', region: 'NSW', postalCode: '2010', country: 'AU' }, country: 'AU', timeZone: 'Australia/Sydney', currency: 'AUD', locale: 'en-GB', phone: '+61 2 5550 0410', status: 'operating', publiclyVisible: true, paymentsEnabled: false, hours: { summary: 'Daily 6am–8pm' }, geo: { lat: -33.8861, lng: 151.2135 } },
    { organizationId: swId, regionId: na!.id, ownerGroupId: lakeshore!.id, name: 'Leslieville', code: 'TOR-LV', slug: 'leslieville', address: { line1: '1104 Queen St E', city: 'Toronto', region: 'ON', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: 'en', status: 'opening_soon', publiclyVisible: false },
  ]).returning();
  const swByCode = Object.fromEntries(swLocs.map((l) => [l.code, l]));

  await db.insert(t.roleAssignments).values([
    { organizationId: swId, userId: demo.id, role: 'org_owner', scopeKind: 'organization', scopeId: swId },
    { organizationId: swId, userId: priya.id, role: 'field_consultant', scopeKind: 'region', scopeId: eu!.id },
    { organizationId: swId, userId: maya.id, role: 'location_manager', scopeKind: 'location', scopeId: swByCode['TOR-QW']!.id },
  ]);
  await db.insert(t.subscriptions).values({ organizationId: swId, plan: 'network', status: 'active', billedLocationCount: 5, currency: 'CAD' });

  const classDefs = [
    { name: 'Morning Vinyasa', duration: 60, cap: 20, time: '07:00', instructor: 'Maya Rao' },
    { name: 'Slow Flow', duration: 75, cap: 16, time: '09:00', instructor: 'Sam Tran' },
    { name: 'Lunchtime Pilates', duration: 45, cap: 12, time: '12:15', instructor: 'Ana Silva' },
    { name: 'Yin & Restore', duration: 60, cap: 18, time: '18:30', instructor: 'Jordan Lee' },
  ];
  const types = await db.insert(t.classTypes).values(classDefs.map((c) => ({ organizationId: swId, name: c.name, durationMinutes: c.duration, defaultCapacity: c.cap, description: `${c.name} — all levels welcome.` }))).returning();
  const price: Record<string, number> = { CAD: 2800, USD: 2800, GBP: 1800, EUR: 2000, AUD: 3200 };
  const occs: Array<typeof t.classOccurrences.$inferInsert> = [];
  for (const loc of swLocs.filter((l) => l.status === 'operating')) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(today, d);
      classDefs.forEach((c, i) => {
        const startsAt = zonedToUtc(date, c.time, loc.timeZone);
        occs.push({ organizationId: swId, locationId: loc.id, classTypeId: types[i]!.id, startsAt, endsAt: new Date(startsAt.getTime() + c.duration * 60_000), capacity: c.cap, priceMinor: price[loc.currency] ?? 0, currency: loc.currency, instructorName: c.instructor, room: 'Studio A' });
      });
    }
  }
  const occRows = await db.insert(t.classOccurrences).values(occs).returning();

  // Members, bookings and settled payments across currencies (for reports and reconciliation demos).
  const names = ['Avery Chen', 'Noah Patel', 'Isla Murphy', 'Lena Vogel', 'Oliver Smith', 'Mia Rossi', 'Lucas Martin', 'Chloe Nguyen'];
  for (const loc of swLocs.filter((l) => l.status === 'operating')) {
    const custs = await db.insert(t.customers).values(names.map((n, i) => ({ organizationId: swId, locationId: loc.id, name: n, email: `${n.toLowerCase().replace(/\s+/g, '.')}+${loc.code.toLowerCase()}@example.com` }))).returning();
    const upcoming = occRows.filter((o) => o.locationId === loc.id && o.startsAt > new Date()).slice(0, 4);
    for (const [i, occ] of upcoming.entries()) {
      for (const c of custs.slice(0, 3 + i)) {
        const [b] = await db.insert(t.classBookings).values({ organizationId: swId, locationId: loc.id, occurrenceId: occ.id, customerId: c.id, status: 'confirmed', confirmedAt: new Date(), source: 'web' }).returning();
        if (loc.paymentsEnabled) {
          const [p] = await db.insert(t.paymentReferences).values({ organizationId: swId, locationId: loc.id, provider: 'stripe', externalId: `pi_seed_${randomBytes(8).toString('hex')}`, connectedAccountId: loc.stripeAccountId, amountMinor: occ.priceMinor, currency: loc.currency, applicationFeeMinor: Math.floor(occ.priceMinor / 100), state: 'succeeded', succeededAt: new Date(), targetType: 'class_booking', targetId: b!.id, sandbox: 1 }).returning();
          await db.update(t.classBookings).set({ paymentId: p!.id }).where(sql`${t.classBookings.id} = ${b!.id}`);
        }
      }
    }
    await db.insert(t.leads).values(custs.slice(5).map((c) => ({ organizationId: swId, locationId: loc.id, customerId: c.id, name: c.name, email: c.email, source: 'website', message: 'Interested in an intro offer' })));
  }
  // One reconciliation example: payment succeeded but the booking hold expired.
  const qw = swByCode['TOR-QW']!;
  const [lateCust] = await db.insert(t.customers).values({ organizationId: swId, locationId: qw.id, name: 'Riley Brooks', email: 'riley.brooks@example.com' }).returning();
  const lateOcc = occRows.find((o) => o.locationId === qw.id && o.startsAt > new Date())!;
  const [lateBooking] = await db.insert(t.classBookings).values({ organizationId: swId, locationId: qw.id, occurrenceId: lateOcc.id, customerId: lateCust!.id, status: 'expired', holdExpiresAt: new Date(Date.now() - 3600_000), source: 'web' }).returning();
  await db.insert(t.paymentReferences).values({ organizationId: swId, locationId: qw.id, provider: 'stripe', externalId: `pi_seed_late_${randomBytes(6).toString('hex')}`, connectedAccountId: qw.stripeAccountId, amountMinor: 2800, currency: 'CAD', state: 'succeeded', succeededAt: new Date(), targetType: 'class_booking', targetId: lateBooking!.id, recordSnapshot: { occurrenceId: lateOcc.id, customerId: lateCust!.id }, sandbox: 1 });

  // Website template, sites and pages.
  const [tpl] = await db.insert(t.templates).values({ organizationId: swId, name: 'Studio home', industry: 'studios', fields: [
    { key: 'brand_tagline', label: 'Brand tagline', type: 'text', policy: 'locked', defaultValue: 'Yoga, Pilates and breathwork for every body.' },
    { key: 'hero_title', label: 'Hero title', type: 'text', policy: 'editable', defaultValue: 'Find your calm' },
    { key: 'intro_offer', label: 'Intro offer', type: 'text', policy: 'approval', defaultValue: 'Your first class is on us' },
    { key: 'about', label: 'About this studio', type: 'richtext', policy: 'editable', defaultValue: 'A welcoming neighbourhood studio.' },
  ] }).returning();
  for (const loc of swLocs) {
    const [site] = await db.insert(t.websites).values({ organizationId: swId, locationId: loc.id, kind: 'hosted', templateId: tpl!.id, includedAddress: `${cfg.SITES_BASE_URL}/stillwater-yoga/${loc.slug}`, status: loc.publiclyVisible ? 'live' : 'draft' }).returning();
    const [page] = await db.insert(t.pages).values({ organizationId: swId, websiteId: site!.id, locationId: loc.id, templateId: tpl!.id, slug: 'home', title: `${loc.name} — Stillwater Yoga` }).returning();
    await db.insert(t.fieldOverrides).values(tpl!.fields.map((f) => ({
      organizationId: swId, pageId: page!.id, fieldKey: f.key, origin: (f.policy === 'locked' ? 'locked' : f.policy === 'approval' ? 'approval' : 'hq') as t.FieldOrigin,
      value: f.key === 'hero_title' && loc.code === 'TOR-QW' ? 'Welcome to Queen West' : f.defaultValue, hqValue: f.defaultValue,
    })).map((f) => (f.fieldKey === 'hero_title' && loc.code === 'TOR-QW' ? { ...f, origin: 'local' as const } : f)));
    if (loc.code === 'TOR-QW') {
      await db.insert(t.domains).values({ organizationId: swId, websiteId: site!.id, locationId: loc.id, hostname: 'queenwest.stillwater-demo.example', state: 'awaiting_dns', verificationToken: 'seedtoken123', provider: 'sandbox', dnsRecords: [
        { type: 'CNAME', name: 'queenwest.stillwater-demo.example', value: cfg.DOMAINS_CNAME_TARGET, purpose: 'Routes traffic for your domain to BranchHarbor', ttl: 300 },
        { type: 'TXT', name: '_bh-verify.queenwest.stillwater-demo.example', value: 'bh-verify=seedtoken123', purpose: 'Proves you control this domain', ttl: 300 },
      ] });
    }
  }
  const [mb] = await db.insert(t.connections).values({ organizationId: swId, locationId: swByCode['SEA-CH']!.id, provider: 'mindbody', kind: 'booking', direction: 'import', authoritative: 'external', state: 'degraded', config: { siteId: '-99' }, lastSuccessAt: new Date(Date.now() - 6 * 3600_000), lastError: '1 record(s) need mapping', lastErrorAt: new Date() }).returning();
  await db.insert(t.externalMappings).values([
    { organizationId: swId, connectionId: mb!.id, entityType: 'location', externalId: 'mb-site-1', internalId: swByCode['SEA-CH']!.id, status: 'mapped', externalData: { name: 'Capitol Hill' } },
    { organizationId: swId, connectionId: mb!.id, entityType: 'class_type', externalId: 'mb-ct-55', status: 'error', error: 'No matching BranchHarbor class type for "Hot Vinyasa"', externalData: { name: 'Hot Vinyasa' } },
  ]);

  // ───────────── Maple & Ember Restaurants ─────────────
  const [me] = await db.insert(t.organizations).values({
    slug: 'maple-and-ember', name: 'Maple & Ember Restaurants', industry: 'foods', model: 'network', country: 'US', defaultCurrency: 'USD', defaultLocale: 'en',
    defaultTimeZone: 'America/Los_Angeles', dataRegion: 'us', applicationFeeBps: 100, paymentAccountMode: 'shared', stripeAccountId: 'acct_sandbox_mapleember',
  }).returning();
  const meId = me!.id;
  const [emberNw, rose] = await db.insert(t.ownerGroups).values([{ organizationId: meId, name: 'Ember NW Group' }, { organizationId: meId, name: 'Rose City Hospitality' }]).returning();
  const meLocs = await db.insert(t.locations).values([
    { organizationId: meId, ownerGroupId: emberNw!.id, name: 'Ballard', code: 'SEA-BL', slug: 'ballard', address: { line1: '5410 22nd Ave NW', city: 'Seattle', region: 'WA', postalCode: '98107', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', phone: '+1 206 555 0154', status: 'operating', publiclyVisible: true, paymentsEnabled: true, hours: { summary: 'Daily 11am–10pm' }, settings: { taxRateBps: 1035 } },
    { organizationId: meId, ownerGroupId: emberNw!.id, name: 'Fremont', code: 'SEA-FR', slug: 'fremont', address: { line1: '3500 Fremont Ave N', city: 'Seattle', region: 'WA', postalCode: '98103', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', phone: '+1 206 555 0182', status: 'operating', publiclyVisible: true, paymentsEnabled: true, hours: { summary: 'Daily 11am–10pm' }, settings: { taxRateBps: 1035 } },
    { organizationId: meId, name: 'Gastown', code: 'YVR-GT', slug: 'gastown', address: { line1: '12 Water St', city: 'Vancouver', region: 'BC', postalCode: 'V6B 1A4', country: 'CA' }, country: 'CA', timeZone: 'America/Vancouver', currency: 'CAD', phone: '+1 604 555 0166', status: 'operating', publiclyVisible: true, paymentsEnabled: true, hours: { summary: 'Daily 11am–11pm' } },
    { organizationId: meId, ownerGroupId: rose!.id, name: 'Pearl', code: 'PDX-PL', slug: 'pearl', address: { line1: '1205 NW Glisan St', city: 'Portland', region: 'OR', postalCode: '97209', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', status: 'opening_soon', publiclyVisible: false },
  ]).returning();
  await db.insert(t.roleAssignments).values([
    { organizationId: meId, userId: demo.id, role: 'org_owner', scopeKind: 'organization', scopeId: meId },
    { organizationId: meId, userId: carlos.id, role: 'staff', scopeKind: 'location', scopeId: meLocs[0]!.id },
  ]);
  await db.insert(t.subscriptions).values({ organizationId: meId, plan: 'network', status: 'active', billedLocationCount: 3, currency: 'USD' });
  const [menu] = await db.insert(t.menus).values({ organizationId: meId, name: 'All-day menu', status: 'published', publishedAt: new Date() }).returning();
  const items = await db.insert(t.menuItems).values([
    { organizationId: meId, menuId: menu!.id, category: 'Bowls', name: 'Ember chicken bowl', description: 'Rice, greens, charred corn', prices: { USD: 1600, CAD: 2100 }, dietary: ['gluten-free'], allergens: [], sortOrder: 1 },
    { organizationId: meId, menuId: menu!.id, category: 'Sandwiches', name: 'Smoked brisket sandwich', description: 'Pickles, slaw, brioche', prices: { USD: 1500, CAD: 1950 }, allergens: ['gluten', 'egg', 'mustard'], sortOrder: 2 },
    { organizationId: meId, menuId: menu!.id, category: 'Pizza', name: 'Margherita, wood-fired', description: '12-inch', prices: { USD: 1800, CAD: 2350 }, dietary: ['vegetarian'], allergens: ['gluten', 'milk'], sortOrder: 3 },
    { organizationId: meId, menuId: menu!.id, category: 'Drinks', name: 'Maple lemonade', description: 'House-made', prices: { USD: 500, CAD: 650 }, dietary: ['vegan'], localOverridable: ['available'], sortOrder: 4 },
  ]).returning();
  const [size] = await db.insert(t.modifierGroups).values({ organizationId: meId, menuItemId: items[0]!.id, name: 'Size', minSelect: 1, maxSelect: 1 }).returning();
  await db.insert(t.modifiers).values([{ organizationId: meId, groupId: size!.id, name: 'Regular', prices: { USD: 0, CAD: 0 } }, { organizationId: meId, groupId: size!.id, name: 'Large', prices: { USD: 300, CAD: 400 } }]);
  await db.insert(t.locationMenuOverrides).values({ organizationId: meId, locationId: meLocs[2]!.id, menuItemId: items[2]!.id, priceMinor: 2450 });

  for (const loc of meLocs.filter((l) => l.status === 'operating')) {
    const slots: Array<typeof t.pickupSlots.$inferInsert> = [];
    for (const date of [today, addDays(today, 1)]) {
      const open = zonedToUtc(date, '11:00', loc.timeZone).getTime();
      const close = zonedToUtc(date, '21:00', loc.timeZone).getTime();
      for (let ts = open; ts < close; ts += 15 * 60_000) slots.push({ organizationId: meId, locationId: loc.id, startsAt: new Date(ts), endsAt: new Date(ts + 15 * 60_000), capacity: 6, cutoffAt: new Date(ts - 20 * 60_000) });
    }
    await db.insert(t.pickupSlots).values(slots);
  }
  const ballard = meLocs[0]!;
  const futureSlots = await db.select().from(t.pickupSlots).where(sql`${t.pickupSlots.locationId} = ${ballard.id} and ${t.pickupSlots.cutoffAt} > now()`).orderBy(t.pickupSlots.startsAt).limit(4);
  const states = ['awaiting_acceptance', 'accepted', 'preparing', 'ready'] as const;
  for (const [i, slot] of futureSlots.entries()) {
    const line = { menuItemId: items[i % 3]!.id, name: items[i % 3]!.name, quantity: 1, unitPriceMinor: items[i % 3]!.prices.USD!, modifiers: [], lineTotalMinor: items[i % 3]!.prices.USD! };
    const subtotal = line.lineTotalMinor;
    const tax = Math.round((subtotal * 1035) / 10_000);
    const [o] = await db.insert(t.foodOrders).values({
      organizationId: meId, locationId: ballard.id, pickupSlotId: slot.id, orderNumber: `SEA-BL-${1001 + i}`, status: states[i]!, paymentStatus: 'paid', lines: [line],
      subtotalMinor: subtotal, taxMinor: tax, totalMinor: subtotal + tax, currency: 'USD', contact: { name: ['Jamie Fox', 'Ren Ito', 'Sam Lowe', 'Ava Diaz'][i]!, email: `guest${i}@example.com` },
      promisedAt: slot.startsAt, manageTokenHash: sha256(`seed-${i}`), statusHistory: [{ at: new Date().toISOString(), from: null, to: states[i]!, by: null }],
    }).returning();
    const [p] = await db.insert(t.paymentReferences).values({ organizationId: meId, locationId: ballard.id, provider: 'stripe', externalId: `pi_seed_${randomBytes(8).toString('hex')}`, connectedAccountId: 'acct_sandbox_mapleember', amountMinor: subtotal + tax, currency: 'USD', state: 'succeeded', succeededAt: new Date(), targetType: 'food_order', targetId: o!.id, sandbox: 1 }).returning();
    await db.update(t.foodOrders).set({ paymentId: p!.id }).where(sql`${t.foodOrders.id} = ${o!.id}`);
    await db.update(t.pickupSlots).set({ booked: 1 }).where(sql`${t.pickupSlots.id} = ${slot.id}`);
  }

  const ops = await seedOperations({ db, today, upsertUser, demo, maya, carlos, priya, swId, meId });
  await (await import('./seed-sports.ts')).seedSports({ db, today, upsertUser, orgId: ops.orgs.northShore }).then((r) => console.log(`[seed] Sports: coach ${r.users[0]}, guardian app account ${r.guardianLogin} (same password)`));
  const realty = await (await import('./seed-realty.ts')).seedRealty({ db, today, upsertUser, demo, sitesBaseUrl: cfg.SITES_BASE_URL });
  ops.users.push(...(await (await import('./seed-wellness.ts')).seedWellness({ db, today, orgId: ops.orgs.harbourline, demo, upsertUser })).users);
  console.log('Studios:', await (await import('./seed-studios.ts')).seedStudios({ db, today, swId, demo, maya }));
  await (await import('./seed-commerce.ts')).seedCommerce({ db, orgId: ops.orgs.fieldnote, demo, upsertUser });
  const foods = await seedFoods({ db, today, meId, demo, carlos, upsertUser });
  // Franchise development (Stillwater): Lucia Reyes leads franchise development.
  const lucia = await upsertUser('lucia.reyes@demo.branchharbor.com', 'Lucia Reyes');
  await db.insert(t.roleAssignments).values({ organizationId: swId, userId: lucia.id, role: 'development_lead', scopeKind: 'organization', scopeId: swId });
  const franchise = await (await import('./seed-franchise.ts')).seedFranchise({ db, orgId: swId, demo, lead: lucia, brand: 'Stillwater', collectLocationCode: 'TOR-QW' });
  // Network workspaces (Community, Help desk, Training academy) for Stillwater and Maple & Ember.
  const network = await (await import('./seed-community.ts')).seedCommunity({ db, swId, meId, demo, maya, priya, upsertUser });
  const training = await (await import('./seed-training.ts')).seedTraining({ db, swId, meId, demo, maya, ...network });
  // Stillwater is a small team where people wear several hats (team shape "small"): combined roles.
  const smallTeam = await seedSmallTeam(swId, demo.id, lucia.id);
  // Hospitality (Tidewater Stays): front-desk manager and staff logins appear in the demo picker.
  const hospitality = await (await import('./seed-hospitality.ts')).seedHospitality({ db, upsertUser, demo });

  console.log('\nBranchHarbor demo data seeded (sample data only).');
  console.log('─────────────────────────────────────────────────');
  console.log(` Demo login:    demo@branchharbor.com`);
  console.log(` Password:      ${password}`);
  console.log(` Also:          maya.rao@demo.branchharbor.com (location manager, Queen West)`);
  console.log(`                priya.anand@demo.branchharbor.com (field consultant, Europe)`);
  console.log(`                ${smallTeam.owen} (Stillwater small team: Operations & finance + Trainer) — combined roles: ${smallTeam.combined.join(', ')}`);
  console.log(`                carlos.ortega@demo.branchharbor.com (staff, Ballard) — same password`);
  console.log(` Organisations: Stillwater Yoga Collective (${swId}) — Toronto CAD, Seattle USD, London GBP, Berlin EUR, Sydney AUD`);
  console.log(`                Maple & Ember Restaurants (${meId}) — Seattle USD, Vancouver CAD, London GBP, Lisbon EUR`);
  console.log(`                  foods: table QR codes ${Object.values(foods.tableCodes).join(', ')} · ${foods.users.join(', ')}`);
  console.log(`                North Shore Football Academy (${ops.orgs.northShore}) — Toronto CAD, Manchester GBP, Austin USD`);
  console.log(`                Harbourline Wellness (${ops.orgs.harbourline}) — Toronto CAD, Dublin EUR, Melbourne AUD`);
  console.log(`                Fieldnote Goods (${ops.orgs.fieldnote}) — Portland USD, Montréal CAD, Amsterdam EUR`);
  console.log(` Staff/managers (same password): ${ops.users.join(', ')}`);
  console.log(` Real Estate:   Keystone Realty Network (${realty.orgId}) — Toronto/Vancouver CAD, London GBP, Madrid EUR, Dubai AED, Sydney AUD; ${realty.listings} listings · ${realty.users.join(', ')}`);
  console.log(` Franchise:     Stillwater pipeline (${franchise.prospects} prospects; ${franchise.blocked.waitingPeriod} waiting period, ${franchise.blocked.registration} registration pending, ${franchise.readyToSign} ready to sign, ${franchise.onboarding} onboarding) · ${franchise.lead} (Franchise development & training)`);
  console.log(` Hospitality:   Tidewater Stays (${hospitality.orgId}) — Lisbon EUR (hotel + outlet), Vancouver CAD, London GBP, Sydney AUD (hostel); ${hospitality.rooms} rooms · ${hospitality.users.join(', ')}`);
  console.log(` Location finder: GET /v1/public/locations/stillwater-yoga`);
  console.log(` Network:       Community, Training and Help desk for Stillwater · ${network.users.join(', ')} (same password)`);
  console.log(`                public course: ${cfg.SITES_BASE_URL}/stillwater-yoga/courses/${training.publicCourse}`);
  await seedIndependent({ db, today, upsertUser, sitesBaseUrl: cfg.SITES_BASE_URL });
  const northlight = await seedNorthlight({ db, today, upsertUser, sitesBaseUrl: cfg.SITES_BASE_URL });
  console.log(` Access model:  Northlight Yoga International (${northlight.orgId}) — franchisor team, one login per role (same password):`);
  for (const l of northlight.logins) console.log(`                ${l}`);
  const comms = await (await import('./seed-comms.ts')).seedComms({ db, orgId: northlight.orgId });
  console.log(` Marketing & sales: Northlight inboxes (sandbox; SMS ${comms.smsAddress}, WhatsApp ${comms.waAddress}), ${comms.conversations} conversations, social accounts, network / coming-soon / course / local campaigns`);
  // Website builder: seeded classic pages become builder documents (as `db:migrate` does for existing data).
  const sites = await (await import('../services/site-builder.ts')).migrateSiteDocuments(db);
  console.log(` Websites:      ${sites.migratedPages} pages converted to website builder documents`);
  const financeSeed = await (await import('./seed-finance.ts')).seedFinance({ db, today, upsertUser });
  {
    // Marketing's network campaign spend (seed-comms) is booked into the fund ledger, on top of an opening balance
    // carried over from the previous fund year so the demo fund isn't overdrawn.
    const { consumePendingSpendEvents } = await import('../services/finance/fund.ts');
    const pending = await db.select({ currency: t.marketingFundSpendEvents.currency, total: sql<number>`sum(${t.marketingFundSpendEvents.amountMinor})::int` })
      .from(t.marketingFundSpendEvents).where(sql`${t.marketingFundSpendEvents.organizationId} = ${northlight.orgId} and ${t.marketingFundSpendEvents.consumedAt} is null`).groupBy(t.marketingFundSpendEvents.currency);
    const year = Number(today.slice(0, 4));
    if (pending.length) await db.insert(t.marketingFundEntries).values(pending.map((p) => ({ organizationId: northlight.orgId, kind: 'adjustment', currency: p.currency, amountMinor: Math.ceil((p.total * 1.5) / 100) * 100, occurredOn: `${year}-01-01`, description: 'Opening balance carried over from last year (sample)' })));
    await consumePendingSpendEvents(db, northlight.orgId);
  }
  console.log(` Finance:       closed royalty periods, a disputed statement, an overdue invoice and fund spend with receipts (sandbox). Finance lead: ${financeSeed.logins.join(', ')}`);
  const reviewsSeed = await seedReviewsAndDebitDemo(northlight.orgId);
  console.log(` Reviews:       ${reviewsSeed.reviews} demo reviews (Google sandbox + private feedback), ${reviewsSeed.requests} review requests; hosted page: ${reviewsSeed.link}`);
  console.log(` Bank debit:    Thames Hot Yoga on SEPA Direct Debit (EUR); ${reviewsSeed.statements} monthly franchisee statements issued`);
  const quality = await (await import('./seed-quality.ts')).seedQuality({ db, today, upsertUser });
  console.log(` Audits:        ${quality.audits} completed audits with scores, open corrective actions, a re-audit and a pre-opening audit; ${quality.documents} compliance documents (one expiring, one expired); league table. Field consultant: ${quality.logins.join(', ')}`);
  const platform = await seedDataPlatformDemo(northlight.orgId);
  console.log(` Data platform: ${platform.connections} sales connectors (sandbox) with ${platform.days} daily sales rows, a self-reported variance, ${platform.imports} imports, a bulk launch of ${platform.launched} locations and opted-in benchmarks`);
  const supply = await (await import('./seed-supply.ts')).seedSupply({ db, today, upsertUser, appUrl: cfg.APP_URL });
  console.log(` Suppliers:     Maple & Ember — ${supply.suppliers} approved suppliers, ${supply.orders} purchase orders (one waiting for HQ approval, one due at Ballard today), rebates with a claim, off-contract spend`);
  console.log(`                supplier confirmation link (no login): ${supply.confirmLink}`);
  console.log(` Audits ph. 2:  recurring schedules (${supply.visits} visits created), visit planner, retraining link, ${supply.selfChecks} self-check runs · ${supply.logins.join(', ')}`);
  console.log(` Demo site:     run the API with DEMO_MODE=true and the app with NEXT_PUBLIC_DEMO_MODE=true for the demo sign-in picker.`);
  console.log('─────────────────────────────────────────────────\n');
}

/**
 * Demo data for Marketing → Reviews and bank-debit royalty collection (Northlight). Everything here is labelled demo /
 * sandbox: the Google reviews are sample rows on a sandbox connection (the live adapter never invents reviews).
 */
async function seedReviewsAndDebitDemo(orgId: string) {
  const { reviewSettingsSchema } = await import('@bh/shared');
  const { tokenHashFor, reviewPageUrl } = await import('../services/reviews.ts');
  const { confirmSandboxMethod, startPaymentMethodSetup } = await import('../services/finance/invoices.ts');
  const { issueFranchiseeStatements } = await import('../services/finance/franchisee-statements.ts');
  const noop = () => {};
  const s = { cfg, db, payments: { mode: 'sandbox', client: null, publishableKey: null }, log: { info: noop, warn: noop, error: noop, debug: noop }, mailer: { mode: 'log', outbox: [], send: async () => ({ id: null, delivered: false }) } } as unknown as import('../context.ts').Services;
  const [org] = await db.select().from(t.organizations).where(sql`${t.organizations.id} = ${orgId}`);
  const user = async (local: string) => (await db.select().from(t.users).where(sql`${t.users.email} = ${`${local}@northlight.demo.branchharbor.com`}`))[0]!;
  const cmo = await user('hannah.cho');
  const noah = await user('noah.williams');
  const oliver = await user('oliver.grant');
  const finance = await user('ruth.adeyemi');
  const locs = await db.select().from(t.locations).where(sql`${t.locations.organizationId} = ${orgId} and ${t.locations.status} = 'operating'`);
  const byCode = Object.fromEntries(locs.map((l) => [l.code, l]));
  const now = Date.now();
  const ago = (days: number, hours = 0) => new Date(now - days * 86_400_000 - hours * 3_600_000);

  // HQ defaults: requests after class visits, email, 2 h delay, Google + Facebook links, HQ approves negative replies.
  await db.insert(t.reviewSettings).values({
    organizationId: orgId, locationId: null, enabledAt: ago(120), updatedBy: cmo.id,
    settings: reviewSettingsSchema.parse({ enabled: true, sources: ['class_visit'], delayMinutes: 120, channel: 'email', frequencyCapDays: 60, consentMode: 'marketing', replyApproval: 'negative', links: [{ kind: 'facebook', label: '', url: 'https://www.facebook.com/northlightyoga/reviews' }] }),
  });
  if (byCode['LON-HK']) await db.insert(t.reviewSettings).values({ organizationId: orgId, locationId: byCode['LON-HK'].id, enabledAt: ago(120), updatedBy: noah.id, settings: { delayMinutes: 180, templates: { 'en-GB': { subject: 'How was your class at Hackney?', body: '' } } } });

  // A sandbox Google connection (HQ) with listings: replies stay in BranchHarbor.
  const [conn] = await db.insert(t.reviewConnections).values({ organizationId: orgId, ownerKind: 'hq', mode: 'sandbox', status: 'connected', accountName: 'accounts/demo', accountEmail: 'marketing@northlight.demo.branchharbor.com', connectedBy: cmo.id, lastSyncAt: ago(0, 1) }).returning();
  for (const l of locs) await db.insert(t.reviewListings).values({ organizationId: orgId, connectionId: conn!.id, locationId: l.id, externalLocationName: `locations/demo-${l.code.toLowerCase()}`, title: `Northlight Yoga ${l.name}`, reviewUrl: `https://search.google.com/local/writereview?placeid=demo-${l.code.toLowerCase()}`, lastFetchedAt: ago(0, 1) });

  const SAMPLE: Array<[number, string | null, string]> = [
    [5, 'The hot flow classes are the best in the city. Teachers know everyone by name.', 'Jordan P.'],
    [5, 'Spotless studio and a really welcoming front desk.', 'Amelia R.'],
    [4, 'Great classes, the 7am slot gets crowded though.', 'Sam K.'],
    [5, null, 'Lucas M.'],
    [2, 'Changing rooms were cold and two showers were out of order.', 'Priya D.'],
    [4, 'Lovely yin class, would love more evening options.', 'Hiro T.'],
    [1, 'Booked a class that was cancelled 20 minutes before, no message.', 'Daniel F.'],
    [5, 'Intro month was fantastic value.', 'Grace L.'],
    [3, 'Good teachers, music was a bit loud.', 'Ellie W.'],
    [5, 'Feels like a community, not a gym.', 'Marco S.'],
  ];
  let reviews = 0;
  let requests = 0;
  let link = '';
  for (const [li, loc] of locs.entries()) {
    // Google reviews (sample data on the sandbox connection), spread over ~5 months, some answered.
    for (let i = 0; i < 7; i++) {
      const [rating, comment, author] = SAMPLE[(i + li * 3) % SAMPLE.length]!;
      const at = ago(5 + i * 19 + li * 3, i);
      const answered = rating >= 4 ? i % 2 === 0 : i % 3 !== 0;
      const pending = rating <= 2 && !answered;
      await db.insert(t.reviews).values({
        organizationId: orgId, locationId: loc.id, source: 'google', externalId: `accounts/demo/locations/demo-${loc.code.toLowerCase()}/reviews/r${i}`, authorName: author, rating, comment, language: loc.locale, reviewedAt: at, sandbox: true,
        alertedAt: rating <= 2 ? at : null,
        ...(answered ? { replyStatus: 'published', replyText: rating >= 4 ? `Thank you, ${author.split(' ')[0]}! We’re so glad you enjoy practising with us at ${loc.name}.` : `Thank you for telling us, ${author.split(' ')[0]}. We’re sorry about this — please write to ${loc.name} so we can make it right.`, replyBy: cmo.id, repliedAt: new Date(at.getTime() + (6 + i * 5) * 3_600_000), replyAiSuggested: i % 2 === 1 } : {}),
        ...(pending ? { replyStatus: 'pending_approval', replyText: `We’re sorry, ${author.split(' ')[0]}. The team at ${loc.name} would like to hear more — please contact the studio.`, replyBy: noah.id, replySubmittedAt: ago(1), replyAiSuggested: true } : {}),
      });
      reviews++;
    }
    // Review requests after classes; some answered with private feedback (in the inbox), some skipped.
    const custs = await db.select().from(t.customers).where(sql`${t.customers.locationId} = ${loc.id}`).orderBy(t.customers.name).offset(li % 4).limit(6);
    for (const [ci, c] of custs.entries()) {
      const id = randomUUID();
      const sentAt = ago(2 + ci * 6 + li, 3);
      const status = ci === 5 ? 'skipped' : ci % 2 === 0 ? 'completed' : 'sandboxed';
      await db.insert(t.reviewRequests).values({
        id, organizationId: orgId, locationId: loc.id, customerId: c.id, contact: { name: c.name, email: c.email, phone: c.phone, locale: loc.locale }, channel: 'email', source: 'class_visit', triggerKey: `demo:${id}`,
        status, skipReason: status === 'skipped' ? 'no_consent' : null, tokenHash: tokenHashFor(s, id), locale: loc.locale, sendAt: sentAt, sentAt: status === 'skipped' ? null : sentAt,
        openedAt: status === 'completed' ? new Date(sentAt.getTime() + 3_600_000) : null, completedAt: status === 'completed' ? new Date(sentAt.getTime() + 3_700_000) : null,
      });
      requests++;
      if (status === 'completed') {
        const rating = [5, 4, 2][ci / 2]!;
        await db.insert(t.reviews).values({ organizationId: orgId, locationId: loc.id, source: 'branchharbor', requestId: id, customerId: c.id, authorName: c.name, rating, comment: rating >= 4 ? 'Loved the class, thank you!' : 'The room was too hot for a beginner class.', language: loc.locale, reviewedAt: new Date(sentAt.getTime() + 3_700_000), alertedAt: rating <= 2 ? sentAt : null });
        reviews++;
      }
      if (!link && status === 'sandboxed') link = reviewPageUrl(s, org!, loc, (await import('../services/reviews.ts')).requestToken(s, id));
    }
  }

  // Thames Hot Yoga (London + Dublin): EUR royalties collected by SEPA Direct Debit.
  const thames = (await db.select().from(t.ownerGroups).where(sql`${t.ownerGroups.organizationId} = ${orgId} and ${t.ownerGroups.name} like 'Thames%'`))[0];
  if (thames) {
    const m = await startPaymentMethodSetup(s, orgId, { ownerGroupId: thames.id, currency: 'EUR', methodType: 'sepa_debit', acceptMandate: true, locale: 'en-GB' }, { userId: oliver.id, ip: null });
    await confirmSandboxMethod(s, orgId, m.id, 'ok', oliver.id);
  }
  // Monthly franchisee statements for the invoiced periods (emails go to the sandbox log).
  let statements = 0;
  const periods = await db.select().from(t.royaltyPeriods).where(sql`${t.royaltyPeriods.organizationId} = ${orgId}`);
  for (const p of periods) {
    const invoiced = await db.select({ id: t.financeInvoices.id }).from(t.financeInvoices).innerJoin(t.royaltyStatements, sql`${t.royaltyStatements.id} = ${t.financeInvoices.statementId}`).where(sql`${t.royaltyStatements.periodId} = ${p.id}`).limit(1);
    if (invoiced.length) statements += (await issueFranchiseeStatements(s, orgId, p.id, finance.id)).items.length;
  }
  return { reviews, requests, link, statements };
}

/**
 * Demo data for the network data platform (Northlight). Everything is sandbox / sample data and labelled as such:
 *  - sales connectors: Kitsilano on Mindbody (its gross-sales source), Portland Pearl on Square (self-reported, with a
 *    variance against Square), Toronto Annex on Shopify (online shop, not the source), London Hackney on Mindbody with
 *    an expired authorisation; ~95 days of sandbox daily sales written through the real upsert;
 *  - import history (a Mindbody customer import and a dry run), a completed bulk launch of three opening-soon
 *    locations from the brand template, and benchmark participation with demo cohort percentiles (aggregates only;
 *    the demo site keeps them because `recomputeBenchmarks` does not withdraw cohorts in DEMO_MODE).
 */
async function seedDataPlatformDemo(orgId: string) {
  const { sandboxSales } = await import('../integrations/sales/index.ts');
  const { bucketSales, writeDailySales } = await import('../services/sales-connectors.ts');
  const { runLaunch } = await import('../services/launches.ts');
  const { computeContributions, lastFullMonth } = await import('../services/benchmarks.ts');
  const { datesBetween } = await import('@bh/shared');
  const user = async (local: string) => (await db.select().from(t.users).where(sql`${t.users.email} = ${`${local}@northlight.demo.branchharbor.com`}`))[0]!;
  const ceo = await user('elena.marsh');
  const finance = await user('ruth.adeyemi');
  const locs = await db.select().from(t.locations).where(sql`${t.locations.organizationId} = ${orgId}`);
  const byCode = (code: string) => locs.find((l) => l.code === code)!;
  const days = datesBetween(addDays(today, -95), addDays(today, -1));
  const plan: Array<{ code: string; provider: string; status: string; account: string; config: Record<string, unknown> }> = [
    { code: 'YVR-KT', provider: 'mindbody', status: 'connected', account: 'Mindbody sandbox site -99', config: { siteId: '-99', externalLocationId: '1' } },
    { code: 'PDX-PR', provider: 'square', status: 'connected', account: 'Square sandbox', config: { externalLocationId: 'L-PEARL' } },
    { code: 'TOR-AX', provider: 'shopify', status: 'connected', account: 'northlight-shop.myshopify.com', config: { shopDomain: 'northlight-shop.myshopify.com' } },
    { code: 'LON-HK', provider: 'mindbody', status: 'authorization_expired', account: 'Mindbody sandbox site -77', config: { siteId: '-77' } },
  ];
  let rows = 0;
  const conns: Record<string, typeof t.salesConnections.$inferSelect> = {};
  for (const p of plan) {
    const loc = byCode(p.code);
    if (!loc) continue;
    const [c] = await db.insert(t.salesConnections).values({
      organizationId: orgId, locationId: loc.id, provider: p.provider, status: p.status, mode: 'sandbox', config: p.config, externalAccountName: p.account, createdBy: ceo.id,
      lastSyncAt: new Date(Date.now() - 6 * 3600_000), lastSyncStatus: p.status === 'connected' ? 'succeeded' : 'failed',
      lastError: p.status === 'connected' ? null : 'Mindbody returned 401: the site owner removed BranchHarbor’s access (sample)', lastErrorAt: p.status === 'connected' ? null : new Date(Date.now() - 6 * 3600_000),
    }).returning();
    conns[p.code] = c!;
    const recs = sandboxSales(c!.id, p.status === 'connected' ? days : days.slice(0, 60), loc.currency);
    const r = await writeDailySales(db, c!, loc, bucketSales(recs, loc.timeZone, days[0]!, days[days.length - 1]!), days[0]!, p.status === 'connected' ? days[days.length - 1]! : days[59]!);
    rows += r.written;
    await db.insert(t.salesSyncRuns).values([
      { organizationId: orgId, connectionId: c!.id, trigger: 'initial', status: 'succeeded', fromDate: days[0]!, toDate: days[34]!, daysWritten: 70, sandbox: true, startedAt: new Date(Date.now() - 40 * 86_400_000), finishedAt: new Date(Date.now() - 40 * 86_400_000) },
      p.status === 'connected'
        ? { organizationId: orgId, connectionId: c!.id, trigger: 'nightly', status: 'succeeded', fromDate: addDays(today, -3), toDate: addDays(today, -1), daysWritten: 2, daysUnchanged: 4, ordersSeen: 118, sandbox: true, startedAt: new Date(Date.now() - 6 * 3600_000), finishedAt: new Date(Date.now() - 6 * 3600_000) }
        : { organizationId: orgId, connectionId: c!.id, trigger: 'nightly', status: 'failed', fromDate: addDays(today, -3), toDate: addDays(today, -1), sandbox: true, error: 'Mindbody returned 401 (sample)', startedAt: new Date(Date.now() - 6 * 3600_000), finishedAt: new Date(Date.now() - 6 * 3600_000) },
    ]);
  }
  // Gross-sales sources: Kitsilano from Mindbody; Portland Pearl self-reported (and 12 % above what Square shows).
  if (conns['YVR-KT']) await db.insert(t.locationSalesSources).values({ locationId: byCode('YVR-KT').id, organizationId: orgId, source: 'connector', connectionId: conns['YVR-KT'].id, setBy: finance.id });
  const pearl = byCode('PDX-PR');
  if (pearl && conns['PDX-PR']) {
    await db.insert(t.locationSalesSources).values({ locationId: pearl.id, organizationId: orgId, source: 'self_reported', varianceThresholdBps: 500, note: 'Franchisee reports from the Square end-of-month summary', setBy: finance.id });
    const monthStart = `${today.slice(0, 7)}-01`;
    const lastStart = addDays(monthStart, -1).slice(0, 7) + '-01';
    const lastEnd = addDays(monthStart, -1);
    const sq = await db.select().from(t.dailySales).where(sql`${t.dailySales.connectionId} = ${conns['PDX-PR'].id} and ${t.dailySales.businessDate} >= ${lastStart} and ${t.dailySales.businessDate} <= ${lastEnd}`);
    const observed = sq.reduce((a, x) => a + x.grossMinor - x.refundsMinor - x.taxMinor, 0);
    const pdf = Buffer.from('%PDF-1.4 Square end-of-month summary (sample)').toString('base64');
    const [doc] = await db.insert(t.financeDocuments).values({ organizationId: orgId, kind: 'evidence', locationId: pearl.id, filename: 'square-month-summary.pdf', contentType: 'application/pdf', sizeBytes: 44, dataBase64: pdf, sha256: sha256(pdf), uploadedBy: ceo.id }).returning();
    await db.insert(t.externalSalesReports).values({
      organizationId: orgId, locationId: pearl.id, frequency: 'monthly', periodStart: lastStart, currency: pearl.currency, grossMinor: Math.round(observed * 1.12), refundsMinor: 0, taxMinor: 0,
      note: 'From the Square end-of-month summary', evidenceDocumentId: doc!.id, status: 'accepted', submittedBy: ceo.id, reviewedBy: finance.id, reviewedAt: new Date(),
    }).onConflictDoNothing();
  }
  // Import history.
  const yesterday = new Date(Date.now() - 86_400_000);
  await db.insert(t.importBatches).values([
    { organizationId: orgId, entity: 'customers', templateKey: 'mindbody_clients', filename: 'mindbody-client-export.csv', format: 'csv', status: 'completed', headers: ['Client ID', 'First Name', 'Last Name', 'Email', 'Mobile Phone', 'Send Promotional Emails'], mapping: { first_name: 1, last_name: 2, email: 3, phone: 4, marketing_email: 5 }, totalRows: 412, validRows: 405, errorRows: 7, processedRows: 412, createdCount: 361, updatedCount: 44, skippedCount: 7, errors: [{ row: 18, field: 'email', code: 'invalid_email', message: 'Invalid email' }, { row: 92, field: 'email', code: 'contact_required', message: 'An email or a phone number is required' }], createdBy: ceo.id, startedAt: yesterday, finishedAt: yesterday, undoUntil: new Date(yesterday.getTime() - 1000) },
    { organizationId: orgId, entity: 'staff', templateKey: null, filename: 'instructors.xlsx', format: 'xlsx', status: 'completed', dryRun: true, headers: ['Employee Name', 'Work Email', 'Job Title', 'Home Location'], mapping: { name: 0, email: 1, role: 2, location_code: 3 }, totalRows: 14, validRows: 13, errorRows: 1, processedRows: 14, createdCount: 13, skippedCount: 1, errors: [{ row: 9, field: 'location_code', code: 'unknown_location', message: 'No location with code or name "YYZ-QW"' }], createdBy: ceo.id, startedAt: yesterday, finishedAt: yesterday },
  ]);
  // Bulk launch: three opening-soon locations from the brand template (drafts), run through the real launch steps.
  const [tpl] = await db.select().from(t.templates).where(sql`${t.templates.organizationId} = ${orgId}`).limit(1);
  const [launch] = await db.insert(t.bulkLaunches).values({ organizationId: orgId, name: 'Spring 2027 openings', templateId: tpl?.id ?? null, siteMode: 'draft', locationStatus: 'opening_soon', inviteStaff: true, total: 3, createdBy: ceo.id }).returning();
  const launchRows = [
    { name: 'Calgary Beltline', code: 'YYC-BL', address_line1: '1010 17 Ave SW', city: 'Calgary', state_region: 'AB', postal_code: 'T2T 0A7', country: 'CA', time_zone: 'America/Edmonton', currency: 'CAD', manager_email: 'calgary.manager@northlight.demo.branchharbor.com', staff_emails: 'calgary.front@northlight.demo.branchharbor.com', listing_categories: 'Yoga studio;Hot yoga', listing_description: 'Heated flow and yin in the Beltline.', staff_role: 'staff' },
    { name: 'Ottawa Glebe', code: 'YOW-GL', address_line1: '800 Bank St', city: 'Ottawa', state_region: 'ON', postal_code: 'K1S 3V8', country: 'CA', time_zone: 'America/Toronto', currency: 'CAD', manager_email: 'ottawa.manager@northlight.demo.branchharbor.com', listing_categories: 'Yoga studio', staff_role: 'staff' },
    { name: 'Seattle Capitol Hill', code: 'SEA-CH', address_line1: '1520 E Olive Way', city: 'Seattle', state_region: 'WA', postal_code: '98122', country: 'US', time_zone: 'America/Los_Angeles', currency: 'USD', listing_categories: 'Yoga studio;Pilates studio', staff_role: 'staff' },
  ];
  await db.insert(t.bulkLaunchItems).values(launchRows.map((r, i) => ({ organizationId: orgId, launchId: launch!.id, rowNumber: i + 1, name: r.name, code: r.code, input: r, steps: {} })));
  const noop = () => {};
  const launchCtx = { cfg, db, geocoder: { geocode: async () => null }, jobs: { enqueue: async () => {} }, log: { info: noop, warn: noop, error: noop, debug: noop } } as unknown as import('../context.ts').Services;
  await runLaunch(launchCtx, launch!.id);
  // Benchmarks: opted in, with demo cohorts around Northlight's own values (aggregates only, k ≥ 10 by construction).
  const [org] = await db.select().from(t.organizations).where(sql`${t.organizations.id} = ${orgId}`);
  await db.update(t.organizations).set({ settings: { ...org!.settings, benchmarks: { optIn: true, optedInAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), optedInBy: ceo.id } } }).where(sql`${t.organizations.id} = ${orgId}`);
  const period = lastFullMonth();
  const mine = await computeContributions(db, org!, period);
  const DEFAULTS: Record<string, number> = { bookings_per_location: 640, occupancy_pct: 58, review_rating: 4.5, audit_pass_rate: 78, royalty_on_time_rate: 88 };
  const cohort = (metric: string, currency: string, v: number, size: number, scale: [number, number, number, number, number], cap?: number) => {
    const p = scale.map((s) => Math.round(v * s * 100) / 100).map((x) => (cap ? Math.min(cap, x) : x));
    return { period, industry: 'studios', region: 'north_america', metric, currency, cohortSize: size, p10: p[0]!, p25: p[1]!, p50: p[2]!, p75: p[3]!, p90: p[4]! };
  };
  const cohorts = [];
  for (const m of mine.filter((x) => x.metric === 'revenue_per_location' && ['CAD', 'USD'].includes(x.currency))) cohorts.push(cohort('revenue_per_location', m.currency, Math.max(m.value, 1_500_000), m.currency === 'CAD' ? 25 : 15, [0.45, 0.7, 0.92, 1.15, 1.45]));
  for (const metric of ['bookings_per_location', 'occupancy_pct', 'review_rating', 'audit_pass_rate', 'royalty_on_time_rate']) {
    const v = mine.find((x) => x.metric === metric)?.value || DEFAULTS[metric]!;
    const cap = metric === 'review_rating' ? 5 : metric === 'bookings_per_location' ? undefined : 100;
    cohorts.push(cohort(metric, '', v, 25, metric === 'review_rating' ? [0.86, 0.93, 0.98, 1.01, 1.04] : [0.55, 0.78, 0.95, 1.08, 1.2], cap));
  }
  await db.insert(t.benchmarkCohorts).values(cohorts).onConflictDoNothing();
  return { connections: Object.keys(conns).length, days: rows, imports: 2, launched: launchRows.length };
}

main()
  .then(() => handle.close())
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await handle.close();
    process.exit(1);
  });
