/**
 * Real Estate housekeeping: viewing reminders (service messages) and saved-search alerts (marketing — only with
 * explicit, current consent; one email per match, never repeated). Safe to run repeatedly.
 */
import { and, desc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { formatArea, formatInZone, formatMoney, PUBLIC_LISTING_STATUSES, type AreaUnit, type Currency } from '@bh/shared';
import type { Services } from '../context.ts';
import { consentRecords, locations, organizations, realtyAlertDeliveries, realtyListings, realtyOffices, realtySavedSearches, realtyViewings } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { matchesCriteria } from './realty.ts';

export const ALERT_CONSENT_PURPOSE = 'realty_search_alerts';
export const ALERT_CONSENT_VERSION = '2026-10';

export async function runViewingReminders(s: Services, opts: { organizationId?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const conds = [eq(realtyViewings.status, 'confirmed'), isNull(realtyViewings.reminderSentAt), gt(realtyViewings.startsAt, now), lte(realtyViewings.startsAt, new Date(now.getTime() + 24 * 3600_000))];
  if (opts.organizationId) conds.push(eq(realtyViewings.organizationId, opts.organizationId));
  const due = await s.db.select({ v: realtyViewings, l: realtyListings, loc: locations }).from(realtyViewings)
    .innerJoin(realtyListings, eq(realtyListings.id, realtyViewings.listingId)).innerJoin(locations, eq(locations.id, realtyViewings.locationId)).where(and(...conds));
  let sent = 0;
  for (const { v, l, loc } of due) {
    // Claim first so parallel runs never send twice.
    const [claimed] = await s.db.update(realtyViewings).set({ reminderSentAt: now }).where(and(eq(realtyViewings.id, v.id), isNull(realtyViewings.reminderSentAt))).returning({ id: realtyViewings.id });
    if (!claimed || !v.contactEmail) continue;
    const when = `${formatInZone(v.startsAt, loc.timeZone, loc.locale, { dateStyle: 'full', timeStyle: 'short' })} (${loc.timeZone})`;
    await s.mailer.send({ to: v.contactEmail, subject: `Reminder: viewing of ${l.title}`, text: `Hello ${v.contactName.split(' ')[0]},\n\nThis is a reminder of your viewing of ${l.title} on ${when}.\nNeed to change it? Reply to this email or use the link in your confirmation.\n\n${loc.name}`, tag: 'realty-viewing-reminder' }).catch((err) => s.log.warn({ err }, 'reminder email failed'));
    sent++;
  }
  return { checked: due.length, sent };
}

const FREQ_MS: Record<string, number> = { instant: 0, daily: 86400_000, weekly: 7 * 86400_000 };

/** Latest consent record for the email + purpose decides; withdrawal always wins over an older grant. */
async function hasAlertConsent(s: Services, organizationId: string, email: string) {
  const [latest] = await s.db.select().from(consentRecords)
    .where(and(eq(consentRecords.organizationId, organizationId), sql`lower(${consentRecords.email}) = ${email.toLowerCase()}`, eq(consentRecords.purpose, ALERT_CONSENT_PURPOSE)))
    .orderBy(desc(consentRecords.recordedAt)).limit(1);
  return !!latest?.granted;
}

export async function runSavedSearchAlerts(s: Services, opts: { organizationId?: string; now?: Date; manageUrl?: (id: string) => string } = {}) {
  const now = opts.now ?? new Date();
  const conds = [eq(realtySavedSearches.alertsConsent, true), isNull(realtySavedSearches.unsubscribedAt), ne(realtySavedSearches.frequency, 'off')];
  if (opts.organizationId) conds.push(eq(realtySavedSearches.organizationId, opts.organizationId));
  const searches = await s.db.select().from(realtySavedSearches).where(and(...conds));
  let emails = 0, matches = 0, skippedNoConsent = 0;
  for (const ss of searches) {
    const wait = FREQ_MS[ss.frequency] ?? FREQ_MS.weekly!;
    if (ss.lastAlertedAt && now.getTime() - ss.lastAlertedAt.getTime() < wait) continue;
    if (!(await hasAlertConsent(s, ss.organizationId, ss.email))) { skippedNoConsent++; continue; }
    const visibleLocs = await s.db.select().from(locations).where(and(eq(locations.organizationId, ss.organizationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!visibleLocs.length) continue;
    const listings = await s.db.select().from(realtyListings).where(and(eq(realtyListings.organizationId, ss.organizationId), inArray(realtyListings.status, [...PUBLIC_LISTING_STATUSES]), inArray(realtyListings.locationId, visibleLocs.map((l) => l.id)), gt(realtyListings.publishedAt, ss.createdAt)));
    const delivered = await s.db.select({ listingId: realtyAlertDeliveries.listingId }).from(realtyAlertDeliveries).where(eq(realtyAlertDeliveries.savedSearchId, ss.id));
    const done = new Set(delivered.map((d) => d.listingId));
    const fresh = listings.filter((l) => !done.has(l.id) && matchesCriteria(l, ss.criteria as Parameters<typeof matchesCriteria>[1])).slice(0, 10);
    if (!fresh.length) continue;
    const inserted = await s.db.insert(realtyAlertDeliveries).values(fresh.map((l) => ({ organizationId: ss.organizationId, savedSearchId: ss.id, listingId: l.id }))).onConflictDoNothing().returning();
    if (!inserted.length) continue;
    const [org] = await s.db.select({ name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, ss.organizationId));
    const offices = await s.db.select().from(realtyOffices).where(inArray(realtyOffices.locationId, fresh.map((l) => l.locationId)));
    const lines = fresh.filter((l) => inserted.some((x) => x.listingId === l.id)).map((l) => {
      const loc = visibleLocs.find((x) => x.id === l.locationId);
      const unit = (offices.find((o) => o.locationId === l.locationId)?.areaUnit ?? 'sqm') as AreaUnit;
      const area = formatArea(l.areaSqm, unit, ss.locale);
      return `• ${l.title} — ${formatMoney({ amount: l.priceMinor, currency: l.currency as Currency }, ss.locale)}${l.rentPeriod ? ` / ${l.rentPeriod}` : ''} · ${l.bedrooms ?? '–'} bd · ${l.city}${loc ? ` (${loc.name})` : ''}${area ? ` · ${area}` : ''}\n  ${s.cfg.SITES_BASE_URL.replace(/\/$/, '')}/${org?.slug}/properties/${l.id}`;
    });
    // Only a hash of the manage token is stored, so each alert carries a fresh token (older links stop working).
    const token = randomToken();
    await s.db.update(realtySavedSearches).set({ manageTokenHash: sha256(token) }).where(eq(realtySavedSearches.id, ss.id));
    const manage = opts.manageUrl?.(ss.id) ?? `${s.cfg.SITES_BASE_URL.replace(/\/$/, '')}/${org?.slug}/saved-search/${ss.id}?token=${encodeURIComponent(token)}`;
    await s.mailer.send({
      to: ss.email, subject: `${lines.length} new ${lines.length === 1 ? 'home matches' : 'homes match'} your search${ss.name ? ` “${ss.name}”` : ''}`,
      text: `New listings from ${org?.name ?? 'your agency'} that match your saved search:\n\n${lines.join('\n')}\n\nYou receive this because you asked for alerts. Unsubscribe or change frequency: ${manage}`,
      tag: 'realty-search-alert',
    }).catch((err) => s.log.warn({ err }, 'alert email failed'));
    await s.db.update(realtySavedSearches).set({ lastAlertedAt: now }).where(eq(realtySavedSearches.id, ss.id));
    emails++;
    matches += lines.length;
  }
  return { searches: searches.length, emails, matches, skippedNoConsent };
}

export async function runRealtyHousekeeping(s: Services) {
  try {
    await runViewingReminders(s);
    await runSavedSearchAlerts(s);
  } catch (err) {
    s.log.error({ err }, 'realty housekeeping failed');
  }
}
