/**
 * Live data for website builder industry blocks (class schedule, programmes, services, products, menu, listings,
 * rooms). Each block reads the same public endpoint as the matching module page; anything unavailable renders
 * the block's empty state — never invented data.
 */
import type { LiveItem } from '@bh/ui/site';
import type { PageDocument } from '@bh/shared';
import { ApiError, apiGet } from './api';
import { dateTime, money } from './format';
import type { LocationSite, Money, Product, Programme, ScheduleItem } from './types';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

type Fetched = Record<string, LiveItem[] | null>;

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch (err) { if (err instanceof ApiError) return null; return null; }
}

export async function liveData(doc: PageDocument, site: LocationSite, locale: string, href: (path: string) => string, brandHref: (path: string) => string): Promise<Fetched> {
  const loc = site.location;
  const types = new Set(doc.sections.map((s) => s.type));
  const cache: Record<string, Promise<LiveItem[] | null>> = {};
  const external = site.module.mode === 'external';

  const load = (type: string): Promise<LiveItem[] | null> => {
    if (cache[type]) return cache[type]!;
    const run = async (): Promise<LiveItem[] | null> => {
      switch (type) {
        case 'class_schedule': {
          if (site.module.kind !== 'studios' || external) return null;
          const r = await safe(apiGet<{ items: ScheduleItem[] }>(`/v1/public/studios/${loc.id}/schedule`, { revalidate: 30 }));
          return r ? r.items.filter((i) => i.status !== 'cancelled').map((i) => ({ id: i.id, title: i.classType.name, meta: dateTime(i.startsAt, loc.timeZone, locale), subtitle: i.instructorName, price: i.price.amount ? money(i.price, locale) : null, href: href(`/classes/${i.id}`) })) : null;
        }
        case 'programmes': {
          if (site.module.kind !== 'sports') return null;
          const r = await safe(apiGet<{ items: Programme[] }>(`/v1/public/sports/${loc.id}/programmes`, { revalidate: 60 }));
          return r ? r.items.map((p) => ({ id: p.id, title: p.name, subtitle: p.description, meta: p.season?.name ?? null, price: money(p.fee, locale), href: href('/programmes') })) : null;
        }
        case 'services': {
          if (site.module.kind !== 'wellness') return null;
          const r = await safe(apiGet<{ items: Array<{ id: string; name: string; description: string | null; durationMinutes: number; price: Money }> }>(`/v1/public/wellness/${loc.id}/services`, { revalidate: 60 }));
          return r ? r.items.map((x) => ({ id: x.id, title: x.name, subtitle: x.description, meta: new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(x.durationMinutes), price: money(x.price, locale), href: href('/book') })) : null;
        }
        case 'product_grid': {
          if (site.module.kind !== 'commerce') return null;
          const r = await safe(apiGet<{ items: Product[] }>(`/v1/public/sites/${encodeURIComponent(site.brand.slug)}/${encodeURIComponent(loc.slug)}/products`, { revalidate: 60 }));
          return r ? r.items.map((p) => {
            const v = p.variants.find((x) => x.price) ?? p.variants[0];
            return { id: p.id, title: p.name, subtitle: p.description, image: p.image, price: v?.price ? money(v.price, locale) : null, href: href(`/shop/p/${p.id}`) };
          }) : null;
        }
        case 'menu': {
          if (site.module.kind !== 'foods' || external) return null;
          const r = await safe(apiGet<{ categories: Array<{ name: string; items: Array<{ id: string; name: string; description: string | null; price: Money; image?: string | null; soldOut?: boolean }> }> }>(`/v1/public/foods/${loc.id}/menu`, { revalidate: 30 }));
          return r ? r.categories.flatMap((c) => c.items.map((i) => ({ id: i.id, title: i.name, subtitle: i.description, meta: c.name, image: i.image ?? null, price: money(i.price, locale) }))) : null;
        }
        case 'listings': {
          if (site.module.kind !== 'realty') return null;
          const r = await safe(apiGet<{ items: Array<{ id: string; title: string; transaction: string; price: Money; city: string; photo: { url: string } | null; bedrooms: number | null }> }>(`/v1/public/realty/${encodeURIComponent(site.brand.slug)}/listings?office=${encodeURIComponent(loc.slug)}`, { revalidate: 60 }));
          return r ? r.items.map((l) => ({ id: l.id, title: l.title, subtitle: l.city, image: l.photo?.url ?? null, price: money(l.price, locale), href: brandHref(`/properties/${l.id}`), badge: null, meta: l.transaction })) : null;
        }
        case 'rooms': {
          // Hospitality workspace endpoint; until it exists (or the location has none) the block shows its empty state.
          const r = await safe(apiGet<{ items: Array<{ id: string; name: string; description?: string | null; image?: string | null; fromPrice?: Money | null }> }>(`/v1/public/hospitality/${loc.id}/rooms`, { revalidate: 60 }));
          return r ? r.items.map((x) => ({ id: x.id, title: x.name, subtitle: x.description ?? null, image: x.image ?? null, price: x.fromPrice ? money(x.fromPrice, locale) : null })) : null;
        }
        default:
          return null;
      }
    };
    cache[type] = run();
    return cache[type]!;
  };

  const out: Fetched = {};
  await Promise.all(doc.sections.filter((s) => types.has(s.type)).map(async (s) => {
    const items = await load(s.type);
    if (items === null) { out[s.id] = null; return; }
    let list = items;
    if (s.type === 'listings' && s.props.transaction && s.props.transaction !== 'any') list = list.filter((x) => x.meta === s.props.transaction);
    out[s.id] = list.slice(0, num(s.props.limit, 6)).map((x) => (s.type === 'listings' ? { ...x, meta: null } : x));
  }));
  return out;
}
