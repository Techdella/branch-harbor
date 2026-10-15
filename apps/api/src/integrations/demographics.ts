/**
 * Demographic data for territory scoring: population, households and median household income per postcode area.
 *
 * Provider choice (documented in docs/API_INTEGRATIONS.md, "Territory demographics"):
 * - United States: US Census Bureau ACS 5-year estimates by ZIP Code Tabulation Area (free API, key from
 *   api.census.gov/data/key_signup.html). Implemented for real when CENSUS_API_KEY is set.
 * - United Kingdom: ONS / Nomis Census 2021 by postcode district (free, no key) — planned, sandbox until built.
 * - Canada: Statistics Canada Census Profile by forward sortation area — planned.
 * - Everywhere else, and polygon-only territories: a commercial data partner (e.g. Esri GeoEnrichment) — Phase 3.
 *
 * Without a live provider the sandbox returns stable sample figures derived from the postcodes (or the drawn area),
 * always flagged `sandbox: true` so screens label them as sample data.
 */
import type { Demographics } from '@bh/shared';
import type { FetchLike } from './partners/http.ts';

export interface DemographicsRequest {
  country: string;
  postcodes: string[];
  /** Drawn area, used by the sandbox when there are no postcodes. */
  areaKm2: number | null;
}

export interface DemographicsProvider {
  key: string;
  sandbox: boolean;
  lookup(req: DemographicsRequest): Promise<Demographics>;
}

export const ACS_YEAR = 2023;
const ACS_VARS = { population: 'B01003_001E', households: 'B11001_001E', income: 'B19013_001E' } as const;
const CURRENCY: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', IE: 'EUR', FR: 'EUR', DE: 'EUR', ES: 'EUR', NL: 'EUR', IT: 'EUR', PT: 'EUR', BR: 'BRL', MX: 'MXN' };
export const currencyForCountry = (c: string) => CURRENCY[c] ?? 'USD';

/** Household-weighted mean of the areas' medians (an approximation: medians don't add up exactly). */
function combine(rows: Array<{ population: number | null; households: number | null; incomeMinor: number | null }>) {
  const pop = rows.reduce((s, r) => s + (r.population ?? 0), 0);
  const hh = rows.reduce((s, r) => s + (r.households ?? 0), 0);
  const weighted = rows.filter((r) => r.incomeMinor !== null && r.households);
  const w = weighted.reduce((s, r) => s + r.households!, 0);
  return {
    population: rows.length ? pop : null,
    households: rows.length ? hh : null,
    medianHouseholdIncomeMinor: w ? Math.round(weighted.reduce((s, r) => s + r.incomeMinor! * r.households!, 0) / w) : null,
  };
}

/** US Census ACS 5-year by ZCTA. ZIP codes that are not ZCTAs (PO boxes, single buildings) come back as missing. */
export function censusAcsProvider(apiKey: string, fetch: FetchLike, year = ACS_YEAR): DemographicsProvider {
  return {
    key: 'us_census_acs5',
    sandbox: false,
    async lookup(req) {
      const zips = [...new Set(req.postcodes.map((p) => p.slice(0, 5)).filter((p) => /^\d{5}$/.test(p)))];
      const rows: Array<{ zip: string; population: number | null; households: number | null; incomeMinor: number | null }> = [];
      for (let i = 0; i < zips.length; i += 50) {
        const chunk = zips.slice(i, i + 50);
        const url = `https://api.census.gov/data/${year}/acs/acs5?get=${Object.values(ACS_VARS).join(',')}&for=${encodeURIComponent('zip code tabulation area')}:${chunk.join(',')}&key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (res.status === 204) continue; // none of these ZIPs are ZCTAs
        if (!res.ok) throw new Error(`Census API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = JSON.parse(await res.text()) as string[][];
        const [head, ...body] = data;
        const col = (name: string) => head!.indexOf(name);
        const num = (v: string | undefined) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }; // ACS uses large negatives for "not available"
        for (const r of body) {
          const income = num(r[col(ACS_VARS.income)]);
          rows.push({ zip: r[col('zip code tabulation area')]!, population: num(r[col(ACS_VARS.population)]), households: num(r[col(ACS_VARS.households)]), incomeMinor: income === null ? null : income * 100 });
        }
      }
      const found = new Set(rows.map((r) => r.zip));
      return { ...combine(rows), currency: 'USD', source: 'us_census_acs5', year, areas: rows.length, missing: zips.filter((z) => !found.has(z)), sandbox: false, fetchedAt: new Date().toISOString() };
    },
  };
}

/** Stable pseudo-random number in [0, 1) from a string. */
function unit(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** Sample figures (clearly flagged) so screens and scoring work before a provider is connected. */
export const sandboxDemographics: DemographicsProvider = {
  key: 'sandbox',
  sandbox: true,
  async lookup(req) {
    const currency = currencyForCountry(req.country);
    const incomeBase = currency === 'USD' ? 7_400_000 : currency === 'GBP' ? 3_500_000 : currency === 'EUR' ? 4_200_000 : 7_000_000;
    let rows: Array<{ population: number; households: number; incomeMinor: number }>;
    if (req.postcodes.length) {
      rows = req.postcodes.map((p) => {
        const u = unit(`${req.country}:${p}`);
        const population = Math.round(9_000 + u * 32_000);
        return { population, households: Math.round(population / (2.2 + unit(p) * 0.6)), incomeMinor: Math.round((incomeBase * (0.7 + unit(`${p}:i`) * 0.8)) / 100) * 100 };
      });
    } else if (req.areaKm2) {
      const density = 900 + unit(`${req.country}:${Math.round(req.areaKm2)}`) * 2_600;
      const population = Math.round(req.areaKm2 * density);
      rows = [{ population, households: Math.round(population / 2.4), incomeMinor: Math.round((incomeBase * (0.8 + unit(String(req.areaKm2)) * 0.6)) / 100) * 100 }];
    } else rows = [];
    return { ...combine(rows), currency, source: 'sandbox', year: null, areas: rows.length, missing: [], sandbox: true, fetchedAt: new Date().toISOString() };
  },
};

/** Picks the live provider for the country when configured, otherwise the sandbox. */
export function demographicsFor(cfg: { CENSUS_API_KEY?: string }, fetch: FetchLike, country: string, hasPostcodes: boolean): DemographicsProvider {
  if (country === 'US' && cfg.CENSUS_API_KEY && hasPostcodes) return censusAcsProvider(cfg.CENSUS_API_KEY, fetch);
  return sandboxDemographics;
}
