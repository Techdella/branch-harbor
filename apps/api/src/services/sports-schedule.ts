/**
 * Sports schedule: recurring training, fixtures, venue conflicts and suggested resolutions.
 * Times are stored in UTC; recurrence and kick-off times are local wall-clock in the location time zone.
 */
import { and, eq, gt, inArray, lt, ne } from 'drizzle-orm';
import type { Exec } from '../db/client.ts';
import { sportsVenues, teams, trainingSessions } from '../db/schema/index.ts';
import { addDays, localDateParts, weekdayOf, zonedToUtc } from '../lib/tz.ts';

type Session = typeof trainingSessions.$inferSelect;
type Venue = typeof sportsVenues.$inferSelect;

/** A venue clashes with itself, its parent (whole pitch) and its children (half pitches). */
export function relatedVenueIds(venues: Pick<Venue, 'id' | 'parentVenueId'>[], venueId: string): Set<string> {
  const ids = new Set([venueId]);
  const v = venues.find((x) => x.id === venueId);
  if (v?.parentVenueId) ids.add(v.parentVenueId);
  for (const c of venues) if (c.parentVenueId === venueId) ids.add(c.id);
  return ids;
}

export interface SlotQuery {
  organizationId: string;
  locationId: string;
  venueId: string | null;
  venueName: string | null;
  startsAt: Date;
  endsAt: Date;
  excludeSessionIds?: string[];
}

/** Scheduled (not cancelled) sessions at the same location that overlap and share the venue (or a related one). */
export async function findVenueConflicts(db: Exec, q: SlotQuery) {
  if (!q.venueId && !q.venueName) return [];
  const venues = q.venueId ? await db.select({ id: sportsVenues.id, parentVenueId: sportsVenues.parentVenueId }).from(sportsVenues).where(eq(sportsVenues.locationId, q.locationId)) : [];
  const related = q.venueId ? relatedVenueIds(venues, q.venueId) : new Set<string>();
  const rows = await db.select({ s: trainingSessions, teamName: teams.name }).from(trainingSessions).innerJoin(teams, eq(teams.id, trainingSessions.teamId))
    .where(and(eq(trainingSessions.organizationId, q.organizationId), eq(trainingSessions.locationId, q.locationId), ne(trainingSessions.status, 'cancelled'), lt(trainingSessions.startsAt, q.endsAt), gt(trainingSessions.endsAt, q.startsAt)));
  return rows.filter(({ s }) => !(q.excludeSessionIds ?? []).includes(s.id) && (q.venueId ? (s.venueId ? related.has(s.venueId) : false) || (!s.venueId && !!q.venueName && s.venue === q.venueName) : s.venue === q.venueName))
    .map(({ s, teamName }) => ({ sessionId: s.id, teamId: s.teamId, teamName, venue: s.venue, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), kind: s.kind }));
}

/** Local dates between from..until (inclusive) on the given weekdays (0=Sunday), skipping listed dates. */
export function recurrenceDates(from: string, until: string, weekdays: number[], skip: string[] = []): string[] {
  const out: string[] = [];
  for (let d = from; d <= until && out.length < 400; d = addDays(d, 1)) if (weekdays.includes(weekdayOf(d)) && !skip.includes(d)) out.push(d);
  return out;
}

export function localSlot(date: string, time: string, durationMinutes: number, timeZone: string) {
  const startsAt = zonedToUtc(date, time, timeZone);
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000) };
}

export interface ResolutionCandidate {
  kind: 'move_venue' | 'move_time';
  venueId: string | null;
  venueName: string | null;
  startsAt: string;
  endsAt: string;
  shiftMinutes: number;
  summary: string;
}

/**
 * Deterministic suggestions for a clashing session: another free venue of the same kind at the same time,
 * then the same venue shifted by up to ±2 hours (30-minute steps, 06:00–22:00 local). Never applied automatically.
 */
export async function suggestResolutions(db: Exec, session: Session, timeZone: string, limit = 4): Promise<ResolutionCandidate[]> {
  const out: ResolutionCandidate[] = [];
  const venues = await db.select().from(sportsVenues).where(and(eq(sportsVenues.locationId, session.locationId), eq(sportsVenues.active, true)));
  const current = venues.find((v) => v.id === session.venueId);
  const related = session.venueId ? relatedVenueIds(venues, session.venueId) : new Set<string>();
  const dur = session.endsAt.getTime() - session.startsAt.getTime();
  const base = { organizationId: session.organizationId, locationId: session.locationId, excludeSessionIds: [session.id] };
  for (const v of venues) {
    if (related.has(v.id) || (current && v.kind !== current.kind)) continue;
    const clashes = await findVenueConflicts(db, { ...base, venueId: v.id, venueName: v.name, startsAt: session.startsAt, endsAt: session.endsAt });
    if (!clashes.length) out.push({ kind: 'move_venue', venueId: v.id, venueName: v.name, startsAt: session.startsAt.toISOString(), endsAt: session.endsAt.toISOString(), shiftMinutes: 0, summary: `Move to ${v.name} at the same time` });
    if (out.length >= 2) break;
  }
  const localDay = localDateParts(session.startsAt, timeZone).date;
  const dayStart = zonedToUtc(localDay, '06:00', timeZone).getTime();
  const dayEnd = zonedToUtc(localDay, '22:00', timeZone).getTime();
  for (const shift of [30, -30, 60, -60, 90, -90, 120, -120]) {
    if (out.length >= limit) break;
    const startsAt = new Date(session.startsAt.getTime() + shift * 60_000);
    const endsAt = new Date(startsAt.getTime() + dur);
    if (startsAt.getTime() < dayStart || endsAt.getTime() > dayEnd) continue;
    const clashes = await findVenueConflicts(db, { ...base, venueId: session.venueId, venueName: session.venue, startsAt, endsAt });
    if (!clashes.length) {
      const t = localDateParts(startsAt, timeZone).time;
      out.push({ kind: 'move_time', venueId: session.venueId, venueName: session.venue, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), shiftMinutes: shift, summary: `Keep ${session.venue ?? 'the venue'}, start ${Math.abs(shift)} min ${shift > 0 ? 'later' : 'earlier'} (${t})` });
    }
  }
  return out.slice(0, limit);
}

export async function sessionsByIds(db: Exec, ids: string[]) {
  return ids.length ? db.select().from(trainingSessions).where(inArray(trainingSessions.id, ids)) : [];
}
