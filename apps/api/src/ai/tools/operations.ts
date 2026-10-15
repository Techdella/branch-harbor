import { z } from 'zod';
import { INDUSTRY_MODULES } from '@bh/shared';
import type { AssistantContext } from '../context.ts';
import { defineTool } from '../types.ts';
import { itemsOf, table } from '../present.ts';
import { countBy, plural, resolveLocation } from './_helpers.ts';

/** Per industry: the bookings / orders / reservations endpoint and how to show a row. */
const SOURCES: Record<string, { label: string; path: string; window: 'datetime' | 'date' | 'none'; row: (x: any) => Record<string, string | number | null> ; screen: string }> = {
  studios: { label: 'Classes', path: '/studios/occurrences', window: 'datetime', screen: '/ops/classes', row: (x) => ({ when: x.startsAt, what: x.classTypeName ?? 'Class', who: x.instructorName ?? null, status: x.status, booked: `${x.booked ?? 0}/${x.capacity ?? '?'}${x.waitlist ? ` (+${x.waitlist} waitlist)` : ''}` }) },
  foods: { label: 'Orders', path: '/foods/orders', window: 'datetime', screen: '/ops/orders', row: (x) => ({ when: x.pickupAt ?? x.createdAt, what: x.number ? `#${x.number}` : x.id?.slice(0, 8), who: x.channel ?? null, status: x.status, booked: x.totalMinor !== undefined ? `${x.totalMinor / 100} ${x.currency ?? ''}`.trim() : null }) },
  commerce: { label: 'Orders', path: '/commerce/orders', window: 'none', screen: '/ops/orders', row: (x) => ({ when: x.createdAt, what: x.number ? `#${x.number}` : x.id?.slice(0, 8), who: x.channel ?? null, status: x.status, booked: x.totalMinor !== undefined ? `${x.totalMinor / 100} ${x.currency ?? ''}`.trim() : null }) },
  wellness: { label: 'Appointments', path: '/wellness/appointments', window: 'datetime', screen: '/ops/calendar', row: (x) => ({ when: x.startsAt, what: x.serviceName ?? x.service?.name ?? 'Appointment', who: x.practitionerName ?? x.practitioner?.name ?? null, status: x.status, booked: null }) },
  sports: { label: 'Registrations', path: '/sports/registrations', window: 'none', screen: '/ops/registrations', row: (x) => ({ when: x.createdAt, what: x.programmeName ?? x.programme?.name ?? 'Registration', who: x.teamName ?? null, status: x.status, booked: null }) },
  hospitality: { label: 'Reservations', path: '/hospitality/reservations', window: 'date', screen: '/ops/reservations', row: (x) => ({ when: x.arrival, what: x.code ?? x.reference ?? x.id?.slice(0, 8), who: x.roomTypeName ?? (Array.isArray(x.rooms) ? `${x.rooms.length} room(s)` : null), status: x.status, booked: x.nights ?? (x.departure ? `→ ${x.departure}` : null) }) },
  realty: { label: 'Enquiries', path: '/realty/enquiries', window: 'none', screen: '/ops/enquiries', row: (x) => ({ when: x.createdAt, what: x.listingTitle ?? x.listing?.title ?? 'Enquiry', who: null, status: x.status, booked: null }) },
};

function windowFor(when: 'today' | 'next_7_days' | 'last_7_days') {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  if (when === 'today') return { from: start, to: new Date(start.getTime() + 86_400_000) };
  if (when === 'next_7_days') return { from: new Date(), to: new Date(start.getTime() + 8 * 86_400_000) };
  return { from: new Date(start.getTime() - 7 * 86_400_000), to: new Date() };
}

async function fetchBookings(ctx: AssistantContext, i: { location?: string; when: 'today' | 'next_7_days' | 'last_7_days' }) {
  const src = SOURCES[ctx.org.industry];
  if (!src) return { label: 'Bookings', items: [] as any[], screen: '/overview' };
  const loc = await resolveLocation(ctx, i.location);
  const w = windowFor(i.when);
  const q: Record<string, string | undefined> = { locationId: loc?.id };
  if (src.window === 'datetime') Object.assign(q, { from: w.from.toISOString(), to: w.to.toISOString() });
  if (src.window === 'date') Object.assign(q, { from: w.from.toISOString().slice(0, 10), to: w.to.toISOString().slice(0, 10) });
  if (ctx.org.industry === 'foods') q.active = 'false';
  const r = await ctx.api.get(ctx.o(src.path), q);
  let items = itemsOf(r);
  if (src.window === 'none') items = items.filter((x) => { const t = Date.parse(x.createdAt ?? ''); return !Number.isFinite(t) || (t >= w.from.getTime() - 86_400_000 * 30 && t <= w.to.getTime()); });
  return { label: src.label, items, screen: src.screen, location: loc?.name ?? null };
}

const listBookings = defineTool({
  name: 'list_bookings',
  kind: 'read',
  area: 'operations',
  // Any industry Operations module (the REST routes check the exact one).
  modules: [...new Set(Object.values(INDUSTRY_MODULES).flat().map((m) => m.key))],
  description: 'Day-to-day activity for the business’s industry: classes with bookings (studios), orders (foods, commerce), appointments (wellness), registrations (sports), reservations (hospitality) or enquiries (real estate). Optional location (name or id) and window: today, next_7_days or last_7_days.',
  input: z.object({ location: z.string().max(120).optional(), when: z.enum(['today', 'next_7_days', 'last_7_days']).default('today') }),
  run: (ctx, i) => fetchBookings(ctx, i),
  present: (r: { label: string; items: any[]; screen: string; location: string | null }, i, ctx) => {
    const src = SOURCES[ctx.org.industry];
    const rows = r.items.map((x) => src ? src.row(x) : {});
    const by = countBy(rows, (x) => String(x.status ?? ''));
    return {
      summary: `${plural(rows.length, r.label.toLowerCase().replace(/s$/, ''))} ${i.when.replace(/_/g, ' ')}${r.location ? ` at ${r.location}` : ''} (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}).`,
      blocks: rows.length ? [table(`${r.label}: ${i.when.replace(/_/g, ' ')}`, [{ key: 'when', label: 'When', kind: 'date' }, { key: 'what', label: 'What' }, { key: 'who', label: 'With' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'booked', label: 'Booked' }], rows, { max: 40 })] : [],
      citations: [{ id: 'ops', title: r.label, url: r.screen, sourceType: 'screen' }],
    };
  },
});
export default [listBookings];
