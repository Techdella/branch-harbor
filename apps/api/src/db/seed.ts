/**
 * Demo seed: an international Stillwater Yoga network (Toronto CAD, Seattle USD, London GBP,
 * Berlin EUR, Sydney AUD) and the Maple & Ember foods group, based on design/prototype/bh-data.js.
 * Sample data only. Re-running replaces the demo organisations.
 *
 *   pnpm --filter @bh/api db:seed        (SEED_DEMO_PASSWORD=... to choose the password)
 */
import { inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { createDb, type Db } from './client.ts';
import * as t from './schema/index.ts';
import { hashPassword } from '../services/auth.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';
import { sha256 } from '../lib/crypto.ts';
import { clearOperationsDemo, OPERATIONS_DEMO_SLUGS, seedOperations } from './seed-operations.ts';
import { seedIndependent } from './seed-independent.ts';
import { seedFoods } from './seed-foods.ts';

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

async function main() {
  const slugs = ['stillwater-yoga', 'maple-and-ember', ...OPERATIONS_DEMO_SLUGS];
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
    { organizationId: swId, userId: priya.id, role: 'regional_manager', scopeKind: 'region', scopeId: eu!.id },
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
  // Network workspaces (Community, Help desk, Training academy) for the franchise demo networks.
  const network = await (await import('./seed-community.ts')).seedCommunity({ db, swId, meId, demo, maya, priya, upsertUser });
  const training = await (await import('./seed-training.ts')).seedTraining({ db, swId, meId, demo, maya, ...network });

  console.log('\nBranchHarbor demo data seeded (sample data only).');
  console.log('─────────────────────────────────────────────────');
  console.log(` Demo login:    demo@branchharbor.com`);
  console.log(` Password:      ${password}`);
  console.log(` Also:          maya.rao@demo.branchharbor.com (location manager, Queen West)`);
  console.log(`                priya.anand@demo.branchharbor.com (regional manager, Europe)`);
  console.log(`                carlos.ortega@demo.branchharbor.com (staff, Ballard) — same password`);
  console.log(` Organisations: Stillwater Yoga Collective (${swId}) — Toronto CAD, Seattle USD, London GBP, Berlin EUR, Sydney AUD`);
  console.log(`                Maple & Ember Restaurants (${meId}) — Seattle USD, Vancouver CAD, London GBP, Lisbon EUR`);
  console.log(`                  foods: table QR codes ${Object.values(foods.tableCodes).join(', ')} · ${foods.users.join(', ')}`);
  console.log(`                North Shore Football Academy (${ops.orgs.northShore}) — Toronto CAD, Manchester GBP, Austin USD`);
  console.log(`                Harbourline Wellness (${ops.orgs.harbourline}) — Toronto CAD, Dublin EUR, Melbourne AUD`);
  console.log(`                Fieldnote Goods (${ops.orgs.fieldnote}) — Portland USD, Montréal CAD, Amsterdam EUR`);
  console.log(` Staff/managers (same password): ${ops.users.join(', ')}`);
  console.log(` Real Estate:   Keystone Realty Network (${realty.orgId}) — Toronto/Vancouver CAD, London GBP, Madrid EUR, Dubai AED, Sydney AUD; ${realty.listings} listings · ${realty.users.join(', ')}`);
  console.log(` Location finder: GET /v1/public/locations/stillwater-yoga`);
  console.log(` Network:       Community, Training and Help desk for Stillwater · ${network.users.join(', ')} (same password)`);
  console.log(`                public course: ${cfg.SITES_BASE_URL}/stillwater-yoga/courses/${training.publicCourse}`);
  await seedIndependent({ db, today, upsertUser, sitesBaseUrl: cfg.SITES_BASE_URL });
  console.log('─────────────────────────────────────────────────\n');
}

main()
  .then(() => handle.close())
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await handle.close();
    process.exit(1);
  });
