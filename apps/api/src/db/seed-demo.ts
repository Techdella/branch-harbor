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
  const barre = await seedNorthlightBarre(northlight.orgId);
  console.log(` Multi-brand:   Northlight Barre (/${barre.slug}) — ${barre.locations.join(', ')}; own theme, sender, royalty terms (7% + 2.5% fund), disclosure and agreement template · brand lead: ${barre.login}`);
  const quality = await (await import('./seed-quality.ts')).seedQuality({ db, today, upsertUser });
  console.log(` Audits:        ${quality.audits} completed audits with scores, open corrective actions, a re-audit and a pre-opening audit; ${quality.documents} compliance documents (one expiring, one expired); league table. Field consultant: ${quality.logins.join(', ')}`);
  const marina = await seedMarinaDemo(northlight.orgId, northlight.logins);
  console.log(` Assistant:     ${marina.insights} insights, ${marina.briefings} briefings and a sample conversation (${marina.turns} questions, ${marina.actions} action card waiting) for ${marina.email}; sandbox engine, answers from the seeded data only`);
  const platform = await seedDataPlatformDemo(northlight.orgId);
  console.log(` Data platform: ${platform.connections} sales connectors (sandbox) with ${platform.days} daily sales rows, a self-reported variance, ${platform.imports} imports, a bulk launch of ${platform.launched} locations and opted-in benchmarks`);
  const supply = await (await import('./seed-supply.ts')).seedSupply({ db, today, upsertUser, appUrl: cfg.APP_URL });
  console.log(` Suppliers:     Maple & Ember — ${supply.suppliers} approved suppliers, ${supply.orders} purchase orders (one waiting for HQ approval, one due at Ballard today), rebates with a claim, off-contract spend`);
  console.log(`                supplier confirmation link (no login): ${supply.confirmLink}`);
  console.log(` Audits ph. 2:  recurring schedules (${supply.visits} visits created), visit planner, retraining link, ${supply.selfChecks} self-check runs · ${supply.logins.join(', ')}`);
  const lm = await seedLocalMarketingDemo(northlight.orgId, today);
  console.log(` Local marketing: listings for ${lm.locations} locations on Google/Apple/Bing (sandbox) with drift and holiday hours (${lm.holidaysApplied} locations), ${lm.inboxConversations} Google reviews in the inbox, co-op requests at every stage (${lm.reimbursed} reimbursed), ${lm.calls} tracked calls (${lm.missed} missed), a content calendar`);
  const fdev = await (await import('./seed-fdev.ts')).seedFranchiseDev({ db, today });
  if (fdev) {
    console.log(` Franchise dev: ${fdev.territories} territories on the map (sandbox demographics), satisfaction survey with ${fdev.surveyRounds} rounds, validation calls, a transfer, a notice of default, the Washington development schedule, ${fdev.statements} master split statements (Northlight Ireland)`);
    if (fdev.validationToken) console.log(`                validation scheduling page: ${cfg.SITES_BASE_URL}/northlight-yoga/franchise/validation?token=${fdev.validationToken}`);
  }
  console.log(` Demo site:     run the API with DEMO_MODE=true and the app with NEXT_PUBLIC_DEMO_MODE=true for the demo sign-in picker.`);
  console.log('─────────────────────────────────────────────────\n');
}

/**
 * Multi-brand HQ demo: Northlight runs a second brand of the same industry, "Northlight Barre", with its own identity
 * (theme, colours, fonts, languages, sender), two locations in two currencies, brand royalty terms, a disclosure document
 * and agreement template, a territory and a prospect, and a brand-scoped brand lead who only ever sees Barre.
 */
async function seedNorthlightBarre(orgId: string) {
  const MAIL = 'northlight.demo.branchharbor.com';
  const [org] = await db.select().from(t.organizations).where(sql`${t.organizations.id} = ${orgId}`);
  const [main] = await db.select().from(t.brands).where(sql`${t.brands.organizationId} = ${orgId} and ${t.brands.isDefault}`);
  await db.update(t.brands).set({ slug: org!.slug, primaryColor: '#E2552B', themeId: 'pulse', emailFromName: 'Northlight Yoga' }).where(sql`${t.brands.id} = ${main!.id}`);
  const slug = 'northlight-barre';
  const [brand] = await db.insert(t.brands).values({
    organizationId: orgId, name: 'Northlight Barre', slug, primaryColor: '#B4436C', accentColor: '#F6D9E3', headingFont: 'cormorant-garamond', bodyFont: 'work-sans',
    themeId: 'atelier', tagline: 'Low-impact barre, high-energy community.', domain: 'barre.northlight-demo.example', locales: ['en', 'fr'], defaultCurrency: 'USD',
    emailFromName: 'Northlight Barre', emailReplyTo: `hello@barre.${MAIL}`, onboardingTemplateKey: 'standard_unit',
    settings: { reviews: { links: [{ kind: 'facebook', label: '', url: 'https://www.facebook.com/northlightbarre/reviews' }] }, assetFolder: 'Northlight Barre' },
  }).returning();
  const [na] = await db.select().from(t.regions).where(sql`${t.regions.organizationId} = ${orgId} and ${t.regions.name} = 'North America'`);
  const locs = await db.insert(t.locations).values([
    { organizationId: orgId, regionId: na?.id ?? null, brandId: brand!.id, name: 'Seattle Capitol Hill', code: 'BAR-SEA', slug: 'barre-capitol-hill', address: { line1: '1520 E Olive Way', city: 'Seattle', region: 'WA', postalCode: '98122', country: 'US' }, country: 'US', timeZone: 'America/Los_Angeles', currency: 'USD', locale: 'en', phone: '+1 206 555 0123', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nlb_seattle', hours: { summary: 'Mon–Sat 6am–8pm' } },
    { organizationId: orgId, regionId: na?.id ?? null, brandId: brand!.id, name: 'Montréal Mile End', code: 'BAR-MTL', slug: 'barre-mile-end', address: { line1: '5333 Av. Casgrain', city: 'Montréal', region: 'QC', postalCode: 'H2T 1X3', country: 'CA' }, country: 'CA', timeZone: 'America/Toronto', currency: 'CAD', locale: 'fr', phone: '+1 514 555 0188', status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_nlb_mtl', hours: { summary: 'Tous les jours 7h–20h' } },
  ]).returning();
  // Brand site and location sites at /northlight-barre/{location}, from the brand's own template.
  const [tpl] = await db.insert(t.templates).values({ organizationId: orgId, brandId: brand!.id, name: 'Northlight Barre studio home', industry: 'studios', fields: [
    { key: 'brand_tagline', label: 'Brand tagline', type: 'text', policy: 'locked', defaultValue: 'Low-impact barre, high-energy community.' },
    { key: 'hero_title', label: 'Hero title', type: 'text', policy: 'editable', defaultValue: 'Barre classes in your neighbourhood' },
  ] }).returning();
  await db.update(t.brands).set({ settings: { ...brand!.settings, siteTemplateId: tpl!.id } }).where(sql`${t.brands.id} = ${brand!.id}`);
  await db.insert(t.websites).values({ organizationId: orgId, brandId: brand!.id, kind: 'hosted', includedAddress: `${cfg.SITES_BASE_URL}/${slug}`, status: 'live' });
  for (const l of locs) {
    const [site] = await db.insert(t.websites).values({ organizationId: orgId, locationId: l.id, kind: 'hosted', templateId: tpl!.id, includedAddress: `${cfg.SITES_BASE_URL}/${slug}/${l.slug}`, status: 'live' }).returning();
    await db.insert(t.pages).values({ organizationId: orgId, websiteId: site!.id, locationId: l.id, templateId: tpl!.id, slug: 'home', title: `${l.name} — Northlight Barre` });
  }
  await db.insert(t.classTypes).values(locs.map((l) => ({ organizationId: orgId, locationId: l.id, name: 'Barre Burn', durationMinutes: 50, defaultCapacity: 16, category: 'barre' })));
  // Revenue in two currencies (the comparison never adds them up).
  const ago = (d: number) => new Date(Date.now() - d * 86400_000);
  await db.insert(t.paymentReferences).values(locs.flatMap((l, li) => Array.from({ length: 6 }, (_, i) => ({
    organizationId: orgId, locationId: l.id, externalId: `pi_demo_barre_${li}_${i}`, amountMinor: (li ? 3200 : 2800) + i * 500, currency: l.currency, state: 'succeeded', sandbox: 1, succeededAt: ago(i * 4 + 1), createdAt: ago(i * 4 + 1),
  }))));
  // Brand franchise terms: royalty 7% and fund 2.5% in USD and CAD (the yoga network default stays 6% + 2%).
  const finance = (await db.select().from(t.users).where(sql`${t.users.email} = ${`elena.marsh@${MAIL}`}`))[0];
  const year = Number(today.slice(0, 4));
  const basis = { streams: ['bookings', 'memberships', 'retail'], netOfRefunds: true, excludeTax: true, excludeTips: true, includeExternalSales: true } as const;
  await db.insert(t.royaltyTerms).values((['USD', 'CAD'] as const).map((currency) => ({
    organizationId: orgId, brandId: brand!.id, currency, effectiveFrom: `${year - 1}-01-01`, royaltyBps: 700, marketingFundBps: 250, technologyFeeMinor: currency === 'USD' ? 9_900 : 12_900,
    basis: { ...basis, streams: [...basis.streams] }, lateFee: { kind: 'percent' as const, bps: 150, graceDays: 5 }, notes: 'Northlight Barre standard terms', createdBy: finance?.id ?? null,
  })));
  const pdf = (title: string) => Buffer.from(`%PDF-1.4\n% ${title} (demo document)\n`);
  const doc = (kind: string, title: string, jurisdictions: string[]) => {
    const b = pdf(title);
    return { organizationId: orgId, brandId: brand!.id, kind, title, version: `${year}.1`, jurisdictions, status: 'current', issuedOn: `${year}-03-01`, fileName: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, contentType: 'application/pdf', sizeBytes: b.length, sha256: sha256(b.toString('base64')), contentBase64: b.toString('base64'), uploadedBy: finance?.id ?? null };
  };
  await db.insert(t.franchiseDocuments).values([
    doc('disclosure', 'Northlight Barre Franchise Disclosure Document', ['US']),
    doc('disclosure', 'Northlight Barre disclosure document (Canada)', ['CA-ON', 'CA-AB', 'CA-BC']),
    doc('agreement_template', 'Northlight Barre franchise agreement', []),
  ]);
  const [terr] = await db.insert(t.franchiseTerritories).values({ organizationId: orgId, brandId: brand!.id, name: 'Seattle Eastside (Barre)', country: 'US', region: 'WA', description: 'Bellevue, Kirkland and Redmond', status: 'available' }).returning();
  const vp = (await db.select().from(t.users).where(sql`${t.users.email} = ${`daniel.okafor@${MAIL}`}`))[0];
  await db.insert(t.franchiseProspects).values([
    { organizationId: orgId, brandId: brand!.id, name: 'Renée Dubois', email: 'renee.dubois@example.com', country: 'US', region: 'WA', city: 'Bellevue', territoryId: terr!.id, currency: 'USD', liquidCapitalMinor: 25_000_000, source: 'website', stage: 'qualified', ownerUserId: vp?.id ?? null, message: 'Barre teacher for 8 years, looking at the Eastside.' },
    { organizationId: orgId, brandId: brand!.id, name: 'Marc-André Côté', email: 'ma.cote@example.com', country: 'CA', region: 'QC', city: 'Québec', currency: 'CAD', liquidCapitalMinor: 20_000_000, source: 'referral', stage: 'enquiry', ownerUserId: vp?.id ?? null, locale: 'fr' },
  ]);
  // Brand-scoped brand lead: Operations lead on the Barre brand only (no access to the yoga studios).
  const lead = await upsertUser(`isla.reyes@${MAIL}`, 'Isla Reyes');
  await db.insert(t.roleAssignments).values([
    { organizationId: orgId, userId: lead.id, role: 'operations_lead', scopeKind: 'brand', scopeId: brand!.id, createdBy: finance?.id ?? null },
    { organizationId: orgId, userId: lead.id, role: 'brand_manager', scopeKind: 'brand', scopeId: brand!.id, createdBy: finance?.id ?? null },
  ]);
  await db.insert(t.memberProfiles).values({ organizationId: orgId, userId: lead.id, jobTitle: 'Brand lead, Northlight Barre' }).onConflictDoNothing();
  return { slug, locations: locs.map((l) => `${l.name} ${l.currency}`), login: `isla.reyes@${MAIL} (brand lead, Barre only)` };
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
 * Demo data for the AI assistant (Northlight): today's briefings, the insights feed and a sample conversation. All of it
 * is produced by the real engine in sandbox mode (MARINA_SANDBOX), which answers only from tool results over the data
 * seeded above, so nothing here is invented copy.
 */
async function seedMarinaDemo(orgId: string, logins: string[]) {
  const { buildApp } = await import('../app.ts');
  const { signAccessToken } = await import('../plugins/auth.ts');
  const { refreshInsights } = await import('../ai/skills/insights.ts');
  const { generateBriefing } = await import('../ai/skills/briefing.ts');
  const { syncOrgKnowledge } = await import('../ai/knowledge.ts');
  const app = await buildApp({ config: { ...cfg, LOG_LEVEL: 'error', MARINA_SANDBOX: true }, logger: false });
  await app.ready();
  try {
    const s = app.ctx;
    await syncOrgKnowledge(s, orgId);
    const insights = await refreshInsights(s, orgId);
    const people = await db.select({ id: t.users.id, email: t.users.email }).from(t.users).where(inArray(t.users.email, logins));
    let briefings = 0;
    for (const p of people) {
      await generateBriefing(s, orgId, p.id, { kind: 'daily', force: true }).then(() => briefings++).catch(() => undefined);
    }
    // The sample conversation belongs to the CEO login (the first Northlight login).
    const owner = people.find((p) => p.email === logins[0]) ?? people[0]!;
    const token = await signAccessToken(s.cfg, { id: owner.id, email: owner.email, emailVerified: true });
    const questions = [
      'Which locations have overdue royalties?',
      'Show revenue by location this quarter vs last quarter',
      'Any overdue corrective actions?',
      'Remind me to call the Thames Hot Yoga owner about the audit on Friday',
    ];
    let conversationId: string | null = null;
    let actions = 0;
    for (const message of questions) {
      const r = await app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/ai/ask`, headers: { authorization: `Bearer ${token}` }, payload: { message, conversationId, screen: { path: '/home' } } });
      if (r.statusCode !== 200) throw new Error(`Assistant demo turn failed (${r.statusCode}): ${r.body.slice(0, 200)}`);
      const j = r.json() as { conversationId: string; actions: unknown[] };
      conversationId = j.conversationId;
      actions += j.actions.length;
    }
    if (conversationId) await db.update(t.aiConversations).set({ title: 'Royalties, revenue and audits' }).where(sql`${t.aiConversations.id} = ${conversationId}`);
    return { insights, briefings, turns: questions.length, actions, email: owner.email };
  } finally {
    await app.close();
  }
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

/**
 * Demo data for local marketing (Northlight): listings (profiles, structured hours, Google/Apple/Bing sandbox
 * directories, drift, a change waiting for approval, network holiday hours), Google reviews as inbox conversations with
 * reply templates, the co-op fund (allowance, requests at every stage, a reimbursement in the fund ledger, a brand
 * template), call tracking (sandbox numbers, a month of calls with missed-call leads) and the content calendar. All
 * sandbox: no directory, phone number or social account is real.
 */
async function seedLocalMarketingDemo(orgId: string, today: string) {
  const noop = () => {};
  const s = { cfg, db, log: { info: noop, warn: noop, error: noop, debug: noop }, jobs: { enqueue: async () => {} }, partnerFetch: async () => ({ ok: false, status: 503, text: async () => '' }) } as unknown as import('../context.ts').Services;
  const { pushLocation, simulateDirectoryEdit, applyHolidayHours, updateListing, ensureSyncs } = await import('../services/listings.ts');
  const { backfillReviewConversations } = await import('../services/review-inbox.ts');
  const { DEFAULT_RECORDING_DISCLOSURE } = await import('@bh/shared');
  const user = async (local: string) => (await db.select().from(t.users).where(sql`${t.users.email} = ${`${local}@northlight.demo.branchharbor.com`}`))[0]!;
  const [cmo, digital, brand, noah, mia, oliver, liam, ava] = (await Promise.all(['hannah.cho', 'priyanka.shah', 'theo.laurent', 'noah.williams', 'mia.rossi', 'oliver.grant', 'liam.oconnor', 'ava.thompson'].map(user))) as [typeof t.users.$inferSelect, typeof t.users.$inferSelect, typeof t.users.$inferSelect, typeof t.users.$inferSelect, typeof t.users.$inferSelect, typeof t.users.$inferSelect, typeof t.users.$inferSelect, typeof t.users.$inferSelect];
  const locs = await db.select().from(t.locations).where(sql`${t.locations.organizationId} = ${orgId} and ${t.locations.status} = 'operating'`).orderBy(t.locations.name);
  const L = Object.fromEntries(locs.map((l) => [l.code, l]));
  const [orgRow] = await db.select({ slug: t.organizations.slug }).from(t.organizations).where(sql`${t.organizations.id} = ${orgId}`);
  const site = `${cfg.SITES_BASE_URL.replace(/\/$/, '')}/${orgRow!.slug}`;
  const now = Date.now();
  const ago = (days: number, hours = 0) => new Date(now - days * 86_400_000 - hours * 3_600_000);
  const year = Number(today.slice(0, 4));

  // Settings: default field policy, review reply SLA, call recording only in the UK (with the disclosure).
  await db.insert(t.localMarketingSettings).values({ organizationId: orgId, updatedBy: cmo.id, settings: {
    reviewSla: { positiveHours: 48, negativeHours: 12 },
    callRecording: { enabled: true, jurisdictions: { GB: { message: DEFAULT_RECORDING_DISCLOSURE['en-GB'] } } },
  } });

  // Listings: structured weekly hours (the hosted sites show them), profiles and categories.
  const weekly = (opens: string, closes: string, weekendOpens = '08:00', weekendCloses = '18:00') => [1, 2, 3, 4, 5].map((day) => ({ day, opens, closes })).concat([6, 0].map((day) => ({ day, opens: weekendOpens, closes: weekendCloses })));
  for (const [i, l] of locs.entries()) {
    await db.update(t.locations).set({ hours: { weekly: weekly(i % 2 ? '06:30' : '06:00', i % 3 ? '21:00' : '21:30') } }).where(sql`${t.locations.id} = ${l.id}`);
    const complete = i % 3 !== 2;
    await db.insert(t.listingProfiles).values({
      organizationId: orgId, locationId: l.id, primaryCategory: 'Yoga studio', additionalCategories: ['Meditation centre', 'Gym'],
      description: complete ? `Hot yoga, vinyasa and yin classes in ${l.address.city}, with mats, towels and showers for every member. Intro month for new students.` : 'Hot yoga studio.',
      photos: complete ? [1, 2, 3].map((n) => ({ url: `https://images.northlight.demo.branchharbor.com/${l.code.toLowerCase()}/${n}.jpg`, kind: n === 1 ? 'cover' as const : 'interior' as const, alt: '' })) : [],
      websiteUrl: `${site}/${l.slug}`, bookingUrl: complete ? `${site}/${l.slug}/classes` : null, attributes: { wheelchair_accessible: i % 2 === 0, showers: true }, updatedBy: brand.id,
    });
  }
  // Apple Business Connect and Bing Places in sandbox (no partner approval yet); Google comes from the Reviews connection.
  for (const provider of ['apple', 'bing'] as const) {
    const [c] = await db.insert(t.listingConnections).values({ organizationId: orgId, provider, mode: 'sandbox', connectedBy: digital.id }).returning();
    for (const l of locs) await db.insert(t.listingSyncs).values({ organizationId: orgId, locationId: l.id, provider, connectionId: c!.id, externalId: `sandbox-${provider}-${l.code.toLowerCase()}`, mode: 'sandbox', status: 'pending' });
  }
  await ensureSyncs(db, orgId);
  for (const l of locs) await pushLocation(s, orgId, l.id, { actorUserId: digital.id });
  // Edited outside BranchHarbor: Apple Maps shows other Monday hours for Hackney; someone changed Kitsilano's phone on Google.
  const syncOf = async (code: string, provider: string) => (await db.select().from(t.listingSyncs).where(sql`${t.listingSyncs.locationId} = ${L[code]!.id} and ${t.listingSyncs.provider} = ${provider}`))[0]!;
  const freshHours = async (code: string) => (((await db.select({ hours: t.locations.hours }).from(t.locations).where(sql`${t.locations.id} = ${L[code]!.id}`))[0]!.hours ?? {}) as { weekly?: Array<{ day: number; opens: string; closes: string }>; special?: unknown[] });
  if (L['LON-HK']) await simulateDirectoryEdit(s, orgId, (await syncOf('LON-HK', 'apple')).id, { hours: [{ day: 1, opens: '09:00', closes: '17:00' }, ...((await freshHours('LON-HK')).weekly ?? []).filter((h) => h.day !== 1)] });
  if (L['YVR-KT']) await simulateDirectoryEdit(s, orgId, (await syncOf('YVR-KT', 'google')).id, { phone: '+1 604 555 0199' });
  // A location change waiting for HQ (descriptions need approval).
  if (L['LON-HK']) await updateListing(s, orgId, L['LON-HK'].id, { description: 'Hackney’s friendliest hot yoga studio: 40 classes a week, a sauna-warm room and a community that keeps you coming back.' }, { userId: noah.id, hq: false, note: 'New studio description for the autumn season' });
  // Network holiday hours (Hackney had already set its own Boxing Day hours, so it keeps them).
  if (L['LON-HK']) await db.update(t.locations).set({ hours: { ...(await freshHours('LON-HK')), special: [{ date: `${year}-12-26`, closed: false, opens: '10:00', closes: '14:00', label: 'Boxing Day' }] } }).where(sql`${t.locations.id} = ${L['LON-HK'].id}`);
  const hol = await applyHolidayHours(s, orgId, { name: `Winter holidays ${year}`, entries: [{ date: `${year}-12-25`, closed: true, label: 'Christmas Day' }, { date: `${year}-12-26`, closed: false, opens: '09:00', closes: '13:00', label: 'Boxing Day' }, { date: `${year + 1}-01-01`, closed: false, opens: '10:00', closes: '16:00', label: 'New Year’s Day' }], locationIds: locs.map((l) => l.id), overwrite: false }, cmo.id);

  // Reviews in the inbox: reply templates, and every Google review becomes a conversation.
  await db.insert(t.reviewReplyTemplates).values([
    { organizationId: orgId, name: 'Thank you (4–5★)', minRating: 4, maxRating: 5, locale: 'en', body: 'Thank you, {first_name}! We’re so glad you enjoy practising with us at {location}. See you on the mat soon.', createdBy: cmo.id },
    { organizationId: orgId, name: 'Sorry, let’s talk (1–2★)', minRating: 1, maxRating: 2, locale: 'en', body: 'Thank you for telling us, {first_name}. We’re sorry your visit to {location} fell short. Please write to the studio so we can make it right.', createdBy: cmo.id },
    { organizationId: orgId, name: 'Mixed visit (3★)', minRating: 3, maxRating: 3, locale: 'en', body: 'Thanks for the honest feedback, {first_name}. We’ve shared it with the {location} team.', createdBy: cmo.id },
  ]);
  const inboxConversations = await backfillReviewConversations(s, orgId);
  // Older unanswered reviews were already dealt with before the inbox existed: only the last three weeks are open.
  await db.execute(sql`update comms_conversations set status = 'closed', reply_due_at = null, unread = 0 where organization_id = ${orgId} and channel = 'review' and last_inbound_at < now() - interval '21 days'`);

  // This quarter's marketing fund contributions per location (sample), so reimbursements have a balance to come from.
  const qStart = (await import('@bh/shared')).coopPeriodBounds('quarter', today).start;
  await db.insert(t.marketingFundEntries).values(locs.map((l) => ({ organizationId: orgId, kind: 'contribution', currency: l.currency, amountMinor: 400_000, occurredOn: qStart, description: 'Marketing fund contribution (sample)', locationId: l.id, ownerGroupId: l.ownerGroupId })));
  // Co-op fund: 1,500 per quarter in each location's currency, HQ matches 50%.
  await db.insert(t.coopAllowances).values({ organizationId: orgId, locationId: null, period: 'quarter', basis: 'fixed', fixedMinor: 150_000, matchRatioBps: 5000, updatedBy: cmo.id });
  const q = (await import('@bh/shared')).coopPeriodBounds('quarter', today);
  const checklist = (passed: boolean) => (['logo', 'colours_fonts', 'approved_claims', 'offer_terms', 'legal_disclaimer', 'local_details', 'placement']).map((key) => ({ key, label: null, passed, note: null }));
  const doc = async (locationId: string, name: string, by: string) => (await db.insert(t.financeDocuments).values({ organizationId: orgId, kind: 'receipt', locationId, filename: name, contentType: 'application/pdf', sizeBytes: 20, dataBase64: Buffer.from('%PDF-1.4 demo invoice').toString('base64'), sha256: sha256(name), uploadedBy: by }).returning())[0]!.id;
  const day = (offset: number) => addDays(today, offset);
  const coop: Array<{ code: string; by: typeof noah; kind: string; title: string; vendor: string; start: number; budget: number; status: string; claim?: 'submitted' | 'approved' | 'paid'; spent?: number }> = [
    { code: 'LON-HK', by: oliver, kind: 'print', title: 'Mare Street flyers and posters', vendor: 'Hackney Print Co', start: -40, budget: 80_000, status: 'claimed', claim: 'paid', spent: 76_500 },
    { code: 'YVR-KT', by: liam, kind: 'event', title: 'Kits Beach sunrise yoga', vendor: 'Parks Board permit + rentals', start: -20, budget: 120_000, status: 'claimed', claim: 'submitted', spent: 112_000 },
    { code: 'PDX-PR', by: ava, kind: 'ad', title: 'Pearl District radio spots', vendor: 'KXPD Radio', start: 10, budget: 90_000, status: 'submitted' },
    { code: 'YVR-MS', by: liam, kind: 'digital', title: 'Main Street Instagram boost', vendor: 'Meta', start: 5, budget: 40_000, status: 'approved' },
    { code: 'LON-HK', by: oliver, kind: 'sponsorship', title: 'Hackney Half Marathon stand', vendor: 'Hackney Half', start: 25, budget: 150_000, status: 'changes_requested' },
  ];
  let reimbursed = 0;
  for (const c of coop) {
    const l = L[c.code];
    if (!l) continue;
    const startsOn = day(c.start) < q.start ? q.start : day(c.start);
    const decided = c.status !== 'submitted';
    const [r] = await db.insert(t.coopRequests).values({
      organizationId: orgId, locationId: l.id, kind: c.kind, title: c.title, description: `${c.title} to promote the intro month at ${l.name}.`, vendor: c.vendor, startsOn, budgetMinor: c.budget, currency: l.currency,
      periodKey: q.key, creative: [{ kind: 'link', url: `https://assets.northlight.demo.branchharbor.com/${l.code.toLowerCase()}/${c.kind}.pdf`, name: `${c.kind}-proof.pdf` }], status: c.status,
      checklist: checklist(c.status === 'approved' || c.status === 'claimed'), approvedMinor: c.status === 'approved' || c.status === 'claimed' ? c.budget : null,
      decidedBy: decided ? cmo.id : null, decidedAt: decided ? ago(Math.max(1, -c.start)) : null, decisionNote: c.status === 'changes_requested' ? 'Please use the approved race-day banner template and add the offer terms.' : null, requestedBy: c.by.id,
    }).returning();
    if (!c.claim) continue;
    const reimbursable = Math.floor((Math.min(c.spent!, c.budget) * 5000) / 10_000);
    const invoice = await doc(l.id, `${c.code.toLowerCase()}-invoice.pdf`, c.by.id);
    const proof = await doc(l.id, `${c.code.toLowerCase()}-proof.pdf`, c.by.id);
    let fundEntryId: string | null = null;
    if (c.claim === 'paid') {
      const [e] = await db.insert(t.marketingFundEntries).values({ organizationId: orgId, kind: 'spend', currency: l.currency, amountMinor: -reimbursable, occurredOn: day(-3), description: `Co-op reimbursement: ${c.title} (${l.name})`, locationId: l.id, receiptDocumentId: invoice, vendor: c.vendor, createdBy: cmo.id }).returning();
      fundEntryId = e!.id;
      reimbursed++;
    }
    await db.insert(t.coopClaims).values({
      organizationId: orgId, requestId: r!.id, locationId: l.id, spentMinor: c.spent!, currency: l.currency, invoiceDocumentId: invoice, proofDocumentIds: [proof], proofNotes: '5,000 flyers delivered door to door; 12 posters in local cafés.',
      performance: { leads: 34, impressions: 5000 }, reimbursableMinor: c.claim === 'submitted' ? null : reimbursable, status: c.claim, decidedBy: c.claim === 'submitted' ? null : cmo.id, decidedAt: c.claim === 'submitted' ? null : ago(4),
      fundEntryId, payoutMethod: c.claim === 'paid' ? 'bank_transfer' : null, payoutReference: c.claim === 'paid' ? `NL-COOP-${year}-0042` : null, paidAt: c.claim === 'paid' ? ago(3) : null, paidBy: c.claim === 'paid' ? cmo.id : null, submittedBy: c.by.id,
    });
  }
  const [tpl] = await db.insert(t.localAssetTemplates).values({ organizationId: orgId, name: 'Intro month poster', kind: 'poster', width: 1080, height: 1350, status: 'published', createdBy: brand.id, fields: [
    { key: 'headline', label: 'Headline', locked: true, default: 'Find your warmth', maxLength: 40, x: 8, y: 18, size: 64 },
    { key: 'offer', label: 'Offer', locked: false, default: '30 days unlimited for £39', maxLength: 40, x: 8, y: 70, size: 34 },
    { key: 'address', label: 'Studio address', locked: false, default: 'Your studio address', maxLength: 60, x: 8, y: 80, size: 26 },
  ] }).returning();
  if (L['LON-HK']) await db.insert(t.localAssetVersions).values({ organizationId: orgId, templateId: tpl!.id, locationId: L['LON-HK'].id, values: { headline: 'Find your warmth', offer: '30 days unlimited for £39', address: '210 Mare St, Hackney' }, createdBy: noah.id });

  // Call tracking: sandbox numbers per location and campaign, a month of calls, missed calls that became leads.
  const [campaign] = await db.select().from(t.adCampaigns).where(sql`${t.adCampaigns.organizationId} = ${orgId} and ${t.adCampaigns.kind} = 'network'`).limit(1);
  const numberRows: Array<typeof t.trackingNumbers.$inferSelect> = [];
  const fictional: Record<string, string[]> = { 'TOR-AX': ['+14165550101', '+14165550102'], 'YVR-KT': ['+16045550101', '+16045550102'], 'LON-HK': ['+447700900101', '+447700900102'], 'PDX-PR': ['+15035550101'] };
  for (const [code, nums] of Object.entries(fictional)) {
    const l = L[code];
    if (!l?.phone) continue;
    const [web] = await db.insert(t.trackingNumbers).values({ organizationId: orgId, locationId: l.id, label: 'Website', source: 'website', number: nums[0]!, mode: 'sandbox', forwardTo: l.phone.replace(/[^0-9+]/g, ''), isDefault: true, recordCalls: l.country === 'GB', createdBy: digital.id }).returning();
    numberRows.push(web!);
    if (nums[1]) {
      const [ads] = await db.insert(t.trackingNumbers).values({ organizationId: orgId, locationId: l.id, campaignId: campaign?.id ?? null, label: 'Google Ads — intro month', source: 'google_ads', number: nums[1], mode: 'sandbox', forwardTo: l.phone.replace(/[^0-9+]/g, ''), dniMatch: { utmSource: 'google' }, recordCalls: l.country === 'GB', createdBy: digital.id }).returning();
      numberRows.push(ads!);
    }
  }
  const callers = [['Jordan Price', '+16475550111'], [null, '+14375550123'], ['Amelia Ross', '+16045550144'], [null, '+447700900555'], ['Sam Kim', '+15035550166'], ['Hiro Tanaka', '+16045550177'], [null, '+14165550188'], ['Grace Liu', '+447700900199']] as const;
  let calls = 0;
  let missed = 0;
  for (let i = 0; i < 36; i++) {
    const n = numberRows[i % numberRows.length]!;
    const [name, phone] = callers[(i * 5) % callers.length]!;
    const status = i % 7 === 3 ? 'missed' : i % 11 === 5 ? 'busy' : 'answered';
    const startedAt = ago(i % 28, (i * 3) % 9 + 1);
    let leadId: string | null = null;
    if (status !== 'answered' && i % 2 === 1) {
      const [lead] = await db.insert(t.leads).values({ organizationId: orgId, locationId: n.locationId, adCampaignId: n.campaignId, source: 'phone_call', kind: 'customer', name, phone, message: `Missed call (${n.source}).`, utm: { source: n.source }, createdAt: startedAt }).returning();
      leadId = lead!.id;
    }
    await db.insert(t.trackedCalls).values({
      organizationId: orgId, locationId: n.locationId, trackingNumberId: n.id, campaignId: n.campaignId, source: n.source, callerNumber: phone, callerName: name, externalSid: `CA_demo_${i}_${randomBytes(4).toString('hex')}`,
      status, startedAt, durationSeconds: status === 'answered' ? 45 + ((i * 37) % 400) : 0, recorded: n.recordCalls && status === 'answered', sandbox: true, leadId, firstTimeCaller: i % 3 !== 0,
      missedAlertedAt: status === 'answered' ? null : startedAt, followedUpAt: status !== 'answered' && i % 4 === 0 ? new Date(startedAt.getTime() + 3_600_000) : null,
    });
    calls++;
    if (status !== 'answered') missed++;
  }

  // Content calendar: HQ posts for the coming weeks; Kitsilano already scheduled two on its Google Business Profile.
  const [gbpKits] = L['YVR-KT'] ? await db.select().from(t.socialAccounts).where(sql`${t.socialAccounts.locationId} = ${L['YVR-KT'].id} and ${t.socialAccounts.ownerKind} = 'location'`).limit(1) : [];
  const at = (d: number, h: number) => new Date(`${day(d)}T${String(h).padStart(2, '0')}:00:00Z`);
  const posts = [
    { title: 'Intro month is back', body: 'New to hot yoga? Your first 30 days at {location} are unlimited. Book your first class: {booking_link}', d: 2, h: 15, status: 'published' },
    { title: 'Meet the teachers', body: 'Say hello to the teachers at Northlight {location} in {city} — drop in this week and find your favourite class.', d: 6, h: 16, status: 'published' },
    { title: 'Winter holiday hours', body: 'Holiday hours at {location}: check the timetable before you come. Questions? Call us on {phone}.', d: 12, h: 15, status: 'published', allowEdits: true },
    { title: 'Bring a friend week', body: 'Bring a friend to {location} for free this week. Book together: {booking_link}', d: 17, h: 17, status: 'published' },
    { title: 'New Year intentions', body: 'Start the year grounded at {location}. New beginner series starting soon.', d: 24, h: 15, status: 'draft' },
  ];
  for (const [i, p] of posts.entries()) {
    const [item] = await db.insert(t.socialCalendarItems).values({ organizationId: orgId, title: p.title, body: p.body, networks: ['facebook', 'instagram', 'google_business'], suggestedAt: at(p.d, p.h), allowEdits: !!p.allowEdits, status: p.status, publishedAt: p.status === 'published' ? ago(3) : null, createdBy: digital.id }).returning();
    if (gbpKits && L['YVR-KT'] && i < 2) {
      const body = p.body.replace('{location}', L['YVR-KT'].name).replace('{city}', 'Vancouver').replace('{booking_link}', `${site}/${L['YVR-KT'].slug}/classes`);
      const [post] = await db.insert(t.socialPosts).values({ organizationId: orgId, locationId: L['YVR-KT'].id, body, accountIds: [gbpKits.id], scheduledAt: at(p.d, p.h), status: 'scheduled', authorUserId: mia.id }).returning();
      await db.insert(t.socialCalendarAdoptions).values({ organizationId: orgId, itemId: item!.id, locationId: L['YVR-KT'].id, postId: post!.id, status: 'scheduled', adoptedBy: mia.id });
    }
  }
  return { locations: locs.length, holidaysApplied: hol.applied.length, inboxConversations, reimbursed, calls, missed };
}

main()
  .then(() => handle.close())
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await handle.close();
    process.exit(1);
  });
