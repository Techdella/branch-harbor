import { headers, cookies } from 'next/headers';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { SUPPORTED_LOCALES } from '@bh/shared';
import { getBrandSite, getLocationSite, isNotFound } from './api';
import { SITES_BASE_URL } from './config';
import type { BrandSite, LocationSite } from './types';

export interface Routing {
  /** Custom hostname when served on a connected domain, else null (included address). */
  host: string | null;
  /** Location slug the custom domain points at ('' = brand-level domain). */
  hostLocation: string | null;
  brand: string;
  location: string;
  requestedLang: string | null;
  /** Independent business: the slug of its one location, served at the brand address. */
  single: string | null;
}

export const getRouting = cache(async (): Promise<Routing> => {
  const h = await headers();
  const c = await cookies();
  return {
    host: h.get('x-bh-host') || null,
    hostLocation: h.get('x-bh-host') ? h.get('x-bh-host-location') ?? '' : null,
    brand: h.get('x-bh-brand') ?? '',
    location: h.get('x-bh-location') ?? '',
    requestedLang: h.get('x-bh-lang') || c.get('bh_lang')?.value || null,
    single: h.get('x-bh-single') || null,
  };
});

/** Load the brand site or 404. API errors propagate to the friendly error page. */
export async function loadBrand(slug: string): Promise<BrandSite> {
  try {
    return await getBrandSite(slug);
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
}

export async function loadLocation(brand: string, location: string): Promise<LocationSite> {
  try {
    return await getLocationSite(brand, location);
  } catch (err) {
    if (isNotFound(err)) notFound();
    throw err;
  }
}

function pick(requested: string | null, allowed: string[], fallback: string): string {
  if (!requested) return fallback;
  const exact = allowed.find((l) => l.toLowerCase() === requested.toLowerCase());
  if (exact) return exact;
  const base = requested.split('-')[0]!.toLowerCase();
  return allowed.find((l) => l.toLowerCase() === base) ?? fallback;
}

/**
 * The site language: the visitor's explicit choice if the business offers it, else the location's own
 * locale, else the brand default.
 */
export const resolveSiteLocale = cache(async (): Promise<{ locale: string; available: string[] }> => {
  const r = await getRouting();
  const supported = SUPPORTED_LOCALES as readonly string[];
  if (!r.brand) return { locale: 'en', available: ['en'] };
  try {
    if (r.location) {
      const s = await getLocationSite(r.brand, r.location);
      const available = [...new Set([s.location.locale, ...s.brand.locales])].filter((l) => supported.includes(l));
      return { locale: pick(r.requestedLang, available, s.location.locale), available };
    }
    const b = await getBrandSite(r.brand);
    const available = b.brand.locales.filter((l) => supported.includes(l));
    return { locale: pick(r.requestedLang, available, b.brand.defaultLocale), available };
  } catch {
    return { locale: 'en', available: ['en'] };
  }
});

/**
 * Link and canonical helpers that respect how the site is being served:
 * included address (/{brand}/{location}/…), a brand-level custom domain (/{location}/…) or a
 * location-level custom domain (/…; other locations link back to the included address).
 */
export function makeLinks(r: Routing, brand: string, opts: { brandPrimaryHost?: string | null } = {}) {
  const brandAbs = opts.brandPrimaryHost ? `https://${opts.brandPrimaryHost}` : `${SITES_BASE_URL}/${brand}`;
  return {
    brand(path = ''): string {
      if (r.host && !r.hostLocation) return path || '/';
      if (r.host) return `${brandAbs}${path}`;
      return `/${brand}${path}`;
    },
    location(slug: string, path = ''): string {
      // Independent business: its location lives at the brand address.
      if (r.single === slug) return r.host ? path || '/' : `/${brand}${path}`;
      if (r.host && r.hostLocation === slug) return path || '/';
      if (r.host && !r.hostLocation) return `/${slug}${path}`;
      if (r.host) return `${SITES_BASE_URL}/${brand}/${slug}${path}`;
      return `/${brand}/${slug}${path}`;
    },
    brandCanonical(path = ''): string {
      return opts.brandPrimaryHost ? `https://${opts.brandPrimaryHost}${path || '/'}` : `${SITES_BASE_URL}/${brand}${path}`;
    },
    locationCanonical(slug: string, primaryHost: string | null, path = ''): string {
      if (r.single === slug && !primaryHost) return opts.brandPrimaryHost ? `https://${opts.brandPrimaryHost}${path || '/'}` : `${SITES_BASE_URL}/${brand}${path}`;
      return primaryHost ? `https://${primaryHost}${path || '/'}` : `${SITES_BASE_URL}/${brand}/${slug}${path}`;
    },
  };
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
