/**
 * HQ menu publishing with a preview and an independent result per location:
 *  - succeeded: every active item sells there;
 *  - partial: some items cannot sell there (e.g. no price in the location's currency) — the rest is live;
 *  - failed: nothing on the menu could sell there (the location keeps what it had before);
 *  - skipped: the location was not selected for this publish.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { foodMenuPublications, locations, menuItems, menus } from '../db/schema/index.ts';
import { notFound } from '../lib/errors.ts';
import { effectiveMenu } from './foods.ts';

type Location = typeof locations.$inferSelect;

async function evaluate(db: Exec, organizationId: string, menuId: string, kind: string, l: Location) {
  // Evaluate as if the menu were live at this location (drafts included, menu restricted to this one).
  const eff = await effectiveMenu(db, organizationId, l, { includeDrafts: true, kinds: [kind], menuIds: [menuId] });
  const priceProblems = eff.filter((i) => i.unavailableCode === 'no_price' || i.unavailableCode === 'not_offered');
  const sellable = eff.length - priceProblems.length;
  const status = eff.length === 0 || sellable === 0 ? 'failed' : priceProblems.length ? 'partial' : 'succeeded';
  return {
    status: status as 'succeeded' | 'partial' | 'failed',
    available: eff.filter((i) => i.available).length,
    sellable,
    unavailable: eff.filter((i) => !i.available).map((i) => ({ id: i.id, name: i.name, reason: i.unavailableReason, code: i.unavailableCode })),
    reason: eff.length === 0 ? 'The menu has no active items' : sellable === 0 ? `No item has a price in ${l.currency}` : undefined,
  };
}

/** What a publish would do at each location, without changing anything. */
export async function previewPublish(s: Services, organizationId: string, menuId: string) {
  const [m] = await s.db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.organizationId, organizationId)));
  if (!m) throw notFound('Menu');
  const locs = await s.db.select().from(locations).where(and(eq(locations.organizationId, organizationId), isNull(locations.archivedAt)));
  const last = await s.db.select().from(foodMenuPublications).where(eq(foodMenuPublications.menuId, menuId)).orderBy(desc(foodMenuPublications.publishedAt));
  const items = await s.db.select({ id: menuItems.id, active: menuItems.active }).from(menuItems).where(eq(menuItems.menuId, menuId));
  const out = [];
  for (const l of locs) {
    const r = await evaluate(s.db, organizationId, menuId, m.kind, l);
    const prev = last.find((p) => p.locationId === l.id);
    out.push({ locationId: l.id, name: l.name, currency: l.currency, status: l.status, wouldBe: r.status, sellable: r.sellable, available: r.available, unavailable: r.unavailable, reason: r.reason ?? null, lastPublish: prev ? { status: prev.status, at: prev.publishedAt.toISOString() } : null });
  }
  return { menu: { id: m.id, name: m.name, kind: m.kind, status: m.status, activeItems: items.filter((i) => i.active).length }, locations: out };
}

export async function publishMenu(s: Services, organizationId: string, menuId: string, opts: { locationIds?: string[]; onlyFailed?: boolean; actorUserId: string | null }) {
  const [m0] = await s.db.select().from(menus).where(and(eq(menus.id, menuId), eq(menus.organizationId, organizationId)));
  if (!m0) throw notFound('Menu');
  const locs = await s.db.select().from(locations).where(and(eq(locations.organizationId, organizationId), isNull(locations.archivedAt)));
  let targets = opts.locationIds ? locs.filter((l) => opts.locationIds!.includes(l.id)) : locs;
  if (opts.onlyFailed) {
    const pubs = await s.db.select().from(foodMenuPublications).where(eq(foodMenuPublications.menuId, menuId)).orderBy(desc(foodMenuPublications.publishedAt));
    targets = targets.filter((l) => pubs.find((p) => p.locationId === l.id)?.status === 'failed');
  }
  const [m] = await s.db.update(menus).set({ status: 'published', publishedAt: new Date() }).where(eq(menus.id, menuId)).returning();
  const perLocation = [];
  for (const l of locs) {
    if (!targets.some((t) => t.id === l.id)) {
      if (!opts.onlyFailed) {
        await s.db.insert(foodMenuPublications).values({ organizationId, menuId, locationId: l.id, status: 'skipped', detail: { available: 0, unavailable: [] }, publishedBy: opts.actorUserId });
        perLocation.push({ locationId: l.id, name: l.name, currency: l.currency, status: 'skipped' as const, available: 0, unavailable: [], reason: 'Not selected' });
      }
      continue;
    }
    try {
      const r = await evaluate(s.db, organizationId, menuId, m!.kind, l);
      await s.db.insert(foodMenuPublications).values({ organizationId, menuId, locationId: l.id, status: r.status, detail: { available: r.available, unavailable: r.unavailable, reason: r.reason }, publishedBy: opts.actorUserId });
      perLocation.push({ locationId: l.id, name: l.name, currency: l.currency, status: r.status, available: r.available, unavailable: r.unavailable, reason: r.reason ?? null });
    } catch (err) {
      await s.db.insert(foodMenuPublications).values({ organizationId, menuId, locationId: l.id, status: 'failed', detail: { available: 0, unavailable: [], reason: (err as Error).message }, publishedBy: opts.actorUserId });
      perLocation.push({ locationId: l.id, name: l.name, currency: l.currency, status: 'failed' as const, available: 0, unavailable: [], reason: (err as Error).message });
    }
  }
  const counts = perLocation.reduce<Record<string, number>>((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {});
  return { menu: m!, locations: perLocation, summary: { succeeded: counts.succeeded ?? 0, partial: counts.partial ?? 0, failed: counts.failed ?? 0, skipped: counts.skipped ?? 0 } };
}

/** Latest publish result per location for a set of menus (menu builder status column). */
export async function latestPublications(db: Exec, menuIds: string[]) {
  if (!menuIds.length) return [];
  const rows = await db.select().from(foodMenuPublications).where(inArray(foodMenuPublications.menuId, menuIds)).orderBy(desc(foodMenuPublications.publishedAt));
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.menuId}:${r.locationId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((r) => ({ menuId: r.menuId, locationId: r.locationId, status: r.status, detail: r.detail, publishedAt: r.publishedAt.toISOString() }));
}
