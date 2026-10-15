/**
 * Independent-business demos (product spec §1, §6: single-location customers skip network concepts).
 *
 *  - Lumen Pilates — one studio in Melbourne (AUD), studios vertical, owner + one instructor.
 *  - Café Alfama   — one café in Lisbon (EUR), foods vertical, owner only.
 *
 * Both are organisations with model "independent", one location, the Solo plan, a published home page and the
 * industry data their customer site needs (classes / menu + pickup slots). Sample data only. Idempotent: re-running
 * replaces these two organisations. Called from seed-demo.ts.
 */
import { inArray, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { SOLO_PLAN } from '@bh/shared';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';
import { addDays, zonedToUtc } from '../lib/tz.ts';

type User = typeof t.users.$inferSelect;
export const INDEPENDENT_DEMO_SLUGS = ['lumen-pilates', 'cafe-alfama'] as const;

export interface IndependentSeedInput {
  db: Db;
  today: string;
  upsertUser: (email: string, name: string, locale?: string) => Promise<User>;
  sitesBaseUrl: string;
}

async function clear(db: Db) {
  const old = await db.select({ id: t.organizations.id }).from(t.organizations).where(inArray(t.organizations.slug, [...INDEPENDENT_DEMO_SLUGS]));
  if (!old.length) return;
  const ids = old.map((o) => o.id);
  await db.delete(t.pushNotifications).where(inArray(t.pushNotifications.organizationId, ids));
  for (const tbl of [t.paymentReferences, t.webhookEvents, t.auditEvents, t.aiProposedActions, t.aiMessages, t.publishJobResults, t.pageVersions, t.fieldOverrides, t.externalMappings, t.syncRuns, t.refunds, t.consentRecords] as const) {
    await db.delete(tbl).where(inArray((tbl as typeof t.paymentReferences).organizationId, ids));
  }
  await db.delete(t.organizations).where(inArray(t.organizations.id, ids));
}

/** Hosted site for the single location, served at /{brand}; home page published (version 1). */
async function publishedSite(db: Db, orgId: string, locationId: string, slug: string, base: string, content: Record<string, unknown>, title: string, ownerId: string) {
  const [site] = await db.insert(t.websites).values({ organizationId: orgId, locationId, kind: 'hosted', includedAddress: `${base.replace(/\/$/, '')}/${slug}`, status: 'live' }).returning();
  const [page] = await db.insert(t.pages).values({ organizationId: orgId, websiteId: site!.id, locationId, slug: 'home', title, seo: { title, description: String(content.about ?? '').slice(0, 160) } }).returning();
  await db.insert(t.fieldOverrides).values(Object.entries(content).map(([fieldKey, value]) => ({ organizationId: orgId, pageId: page!.id, fieldKey, origin: 'local' as const, value, hqValue: value })));
  const [v] = await db.insert(t.pageVersions).values({ organizationId: orgId, pageId: page!.id, version: 1, content, createdBy: ownerId }).returning();
  await db.update(t.pages).set({ status: 'published', publishedVersionId: v!.id, publishedAt: new Date() }).where(sql`${t.pages.id} = ${page!.id}`);
  return site!;
}

const done = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { status: 'complete' as const, updatedAt: new Date().toISOString() }]));

export async function seedIndependent({ db, today, upsertUser, sitesBaseUrl }: IndependentSeedInput) {
  await clear(db);

  // ───────────── Lumen Pilates (Melbourne, AUD) ─────────────
  const hana = await upsertUser('hana@lumenpilates.demo.branchharbor.com', 'Hana Okafor', 'en-GB');
  const theo = await upsertUser('theo@lumenpilates.demo.branchharbor.com', 'Theo Marsh', 'en-GB');
  const [lumen] = await db.insert(t.organizations).values({
    slug: 'lumen-pilates', name: 'Lumen Pilates', industry: 'studios', model: 'independent', country: 'AU', defaultCurrency: 'AUD', defaultLocale: 'en-GB',
    defaultTimeZone: 'Australia/Melbourne', dataRegion: 'apac', applicationFeeBps: 100, paymentAccountMode: 'shared', stripeAccountId: 'acct_sandbox_lumen',
    onboarding: done(['industry', 'business_details', 'first_location', 'website', 'industry_data', 'connections', 'preview_publish']),
    settings: { site: { primaryColor: '#7A4E9B', tagline: 'Small-group reformer and mat Pilates in Fitzroy.', font: 'plus-jakarta-sans' } },
  }).returning();
  const lumenId = lumen!.id;
  const [studio] = await db.insert(t.locations).values({
    organizationId: lumenId, name: 'Fitzroy', code: 'MAIN', slug: 'fitzroy', address: { line1: '214 Gertrude St', city: 'Melbourne', region: 'VIC', postalCode: '3065', country: 'AU' },
    country: 'AU', timeZone: 'Australia/Melbourne', currency: 'AUD', locale: 'en-GB', phone: '+61 3 5550 0214', email: 'hello@lumenpilates.example',
    status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_lumen',
    hours: { summary: 'Mon–Fri 6:30am–8pm · Sat–Sun 8am–1pm', weekly: [1, 2, 3, 4, 5].map((day) => ({ day, opens: '06:30', closes: '20:00' })).concat([0, 6].map((day) => ({ day, opens: '08:00', closes: '13:00' }))) },
    geo: { lat: -37.8054, lng: 144.9818 },
  }).returning();
  await db.insert(t.roleAssignments).values([
    { organizationId: lumenId, userId: hana.id, role: 'org_owner', scopeKind: 'organization', scopeId: lumenId },
    { organizationId: lumenId, userId: theo.id, role: 'staff', scopeKind: 'location', scopeId: studio!.id },
  ]);
  await db.insert(t.subscriptions).values({ organizationId: lumenId, plan: 'solo', status: 'active', billedLocationCount: 1, currency: 'AUD', pricePerLocationMinor: SOLO_PLAN.priceMinor.AUD, currentPeriodEnd: new Date(Date.now() + 20 * 86400_000) });
  const classDefs = [
    { name: 'Reformer Foundations', duration: 50, cap: 8, time: '07:00', instructor: 'Hana Okafor', price: 4200 },
    { name: 'Mat Flow', duration: 45, cap: 14, time: '12:15', instructor: 'Theo Marsh', price: 2800 },
    { name: 'Reformer Intermediate', duration: 50, cap: 8, time: '18:00', instructor: 'Hana Okafor', price: 4500 },
  ];
  const types = await db.insert(t.classTypes).values(classDefs.map((c) => ({ organizationId: lumenId, name: c.name, durationMinutes: c.duration, defaultCapacity: c.cap, description: `${c.name} — small groups, all bodies welcome.` }))).returning();
  const occs: Array<typeof t.classOccurrences.$inferInsert> = [];
  for (let d = 0; d < 7; d++) {
    const date = addDays(today, d);
    classDefs.forEach((c, i) => {
      const startsAt = zonedToUtc(date, c.time, studio!.timeZone);
      occs.push({ organizationId: lumenId, locationId: studio!.id, classTypeId: types[i]!.id, startsAt, endsAt: new Date(startsAt.getTime() + c.duration * 60_000), capacity: c.cap, priceMinor: c.price, currency: 'AUD', instructorName: c.instructor, room: 'Main studio' });
    });
  }
  const occRows = await db.insert(t.classOccurrences).values(occs).returning();
  const members = await db.insert(t.customers).values(['Grace Liu', 'Sam Whitfield', 'Priya Das', 'Jack O’Brien', 'Mele Tupou'].map((n) => ({ organizationId: lumenId, locationId: studio!.id, name: n, email: `${n.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com` }))).returning();
  for (const [i, occ] of occRows.filter((o) => o.startsAt > new Date()).slice(0, 4).entries()) {
    for (const c of members.slice(0, 2 + i)) {
      const [b] = await db.insert(t.classBookings).values({ organizationId: lumenId, locationId: studio!.id, occurrenceId: occ.id, customerId: c.id, status: 'confirmed', confirmedAt: new Date(), source: 'web' }).returning();
      const [p] = await db.insert(t.paymentReferences).values({ organizationId: lumenId, locationId: studio!.id, provider: 'stripe', externalId: `pi_seed_${randomBytes(8).toString('hex')}`, connectedAccountId: 'acct_sandbox_lumen', amountMinor: occ.priceMinor, currency: 'AUD', applicationFeeMinor: Math.floor(occ.priceMinor / 100), state: 'succeeded', succeededAt: new Date(), targetType: 'class_booking', targetId: b!.id, sandbox: 1 }).returning();
      await db.update(t.classBookings).set({ paymentId: p!.id }).where(sql`${t.classBookings.id} = ${b!.id}`);
    }
  }
  await db.insert(t.leads).values({ organizationId: lumenId, locationId: studio!.id, customerId: members[4]!.id, name: members[4]!.name, email: members[4]!.email, source: 'website', message: 'Do you run beginner reformer courses?' });
  await publishedSite(db, lumenId, studio!.id, 'lumen-pilates', sitesBaseUrl, {
    hero_title: 'Pilates that fits your week',
    intro_offer: 'First reformer class A$25',
    about: 'Lumen is an independent Pilates studio on Gertrude Street. Classes are capped at eight on the reformer so every session gets proper attention.',
  }, 'Lumen Pilates — Fitzroy, Melbourne', hana.id);

  // ───────────── Café Alfama (Lisbon, EUR) ─────────────
  const ines = await upsertUser('ines@cafealfama.demo.branchharbor.com', 'Inês Carvalho', 'en');
  const [alfama] = await db.insert(t.organizations).values({
    slug: 'cafe-alfama', name: 'Café Alfama', industry: 'foods', model: 'independent', country: 'PT', defaultCurrency: 'EUR', defaultLocale: 'en',
    defaultTimeZone: 'Europe/Lisbon', dataRegion: 'eu', applicationFeeBps: 100, paymentAccountMode: 'shared', stripeAccountId: 'acct_sandbox_alfama',
    onboarding: done(['industry', 'business_details', 'first_location', 'website', 'industry_data', 'connections', 'preview_publish']),
    settings: { site: { primaryColor: '#1F5E8C', tagline: 'Coffee, pastéis and sandwiches by the Sé.', font: 'lora', enabledLocales: ['pt-BR'] } },
  }).returning();
  const alfamaId = alfama!.id;
  const [cafe] = await db.insert(t.locations).values({
    organizationId: alfamaId, name: 'Alfama', code: 'MAIN', slug: 'alfama', address: { line1: 'Rua de São Miguel 12', city: 'Lisbon', postalCode: '1100-544', country: 'PT' },
    country: 'PT', timeZone: 'Europe/Lisbon', currency: 'EUR', locale: 'en', phone: '+351 21 555 0112', email: 'ola@cafealfama.example',
    status: 'operating', publiclyVisible: true, paymentsEnabled: true, stripeAccountId: 'acct_sandbox_alfama',
    hours: { summary: 'Tue–Sun 8:00–18:00', weekly: [0, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '08:00', closes: '18:00' })) },
    settings: { taxRateBps: 1300 }, geo: { lat: 38.7118, lng: -9.1290 },
  }).returning();
  await db.insert(t.roleAssignments).values({ organizationId: alfamaId, userId: ines.id, role: 'org_owner', scopeKind: 'organization', scopeId: alfamaId });
  await db.insert(t.subscriptions).values({ organizationId: alfamaId, plan: 'solo', status: 'trialing', billedLocationCount: 1, currency: 'EUR', pricePerLocationMinor: SOLO_PLAN.priceMinor.EUR, currentPeriodEnd: new Date(Date.now() + 10 * 86400_000) });
  const [menu] = await db.insert(t.menus).values({ organizationId: alfamaId, name: 'Menu', status: 'published', publishedAt: new Date() }).returning();
  await db.insert(t.menuItems).values([
    { organizationId: alfamaId, menuId: menu!.id, category: 'Pastries', name: 'Pastel de nata', description: 'Baked every morning', prices: { EUR: 150 }, dietary: ['vegetarian'], allergens: ['gluten', 'egg', 'milk'], sortOrder: 1 },
    { organizationId: alfamaId, menuId: menu!.id, category: 'Sandwiches', name: 'Bifana', description: 'Garlic-marinated pork in a papo-seco', prices: { EUR: 450 }, allergens: ['gluten'], sortOrder: 2 },
    { organizationId: alfamaId, menuId: menu!.id, category: 'Sandwiches', name: 'Tosta mista', description: 'Ham and cheese toastie', prices: { EUR: 400 }, allergens: ['gluten', 'milk'], sortOrder: 3 },
    { organizationId: alfamaId, menuId: menu!.id, category: 'Coffee', name: 'Galão', description: 'Espresso with foamed milk', prices: { EUR: 220 }, dietary: ['vegetarian'], allergens: ['milk'], sortOrder: 4 },
    { organizationId: alfamaId, menuId: menu!.id, category: 'Coffee', name: 'Bica', description: 'Lisbon espresso', prices: { EUR: 90 }, dietary: ['vegan'], allergens: [], sortOrder: 5 },
  ]);
  const slots: Array<typeof t.pickupSlots.$inferInsert> = [];
  for (const date of [today, addDays(today, 1), addDays(today, 2)]) {
    const open = zonedToUtc(date, '08:00', cafe!.timeZone).getTime();
    const close = zonedToUtc(date, '18:00', cafe!.timeZone).getTime();
    for (let ts = open; ts < close; ts += 15 * 60_000) slots.push({ organizationId: alfamaId, locationId: cafe!.id, startsAt: new Date(ts), endsAt: new Date(ts + 15 * 60_000), capacity: 4, cutoffAt: new Date(ts - 15 * 60_000) });
  }
  await db.insert(t.pickupSlots).values(slots);
  await publishedSite(db, alfamaId, cafe!.id, 'cafe-alfama', sitesBaseUrl, {
    hero_title: 'Order ahead, skip the queue',
    offer: 'Free pastel de nata with your first online order',
    about: 'A family café a few steps from the Sé. Order coffee and sandwiches for pickup, or sit in and watch the trams go by.',
  }, 'Café Alfama — Lisbon', ines.id);

  console.log(' Independent businesses (one location each, no network concepts) — same password:');
  console.log(`   Lumen Pilates (${lumenId}) — Melbourne AUD · owner hana@lumenpilates.demo.branchharbor.com · staff theo@lumenpilates.demo.branchharbor.com · site /lumen-pilates`);
  console.log(`   Café Alfama   (${alfamaId}) — Lisbon EUR · owner ines@cafealfama.demo.branchharbor.com · site /cafe-alfama`);
  return { orgs: { lumen: lumenId, alfama: alfamaId }, users: [hana.email, theo.email, ines.email] };
}
