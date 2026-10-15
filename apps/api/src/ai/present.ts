import { minorUnitExponent, type AiChartBlock, type AiTableBlock } from '@bh/shared';

/** Formats integer minor units in their own currency (never converted). */
export function fmtMoney(minor: number | null | undefined, currency: string, locale = 'en'): string {
  if (minor === null || minor === undefined) return '—';
  const exp = minorUnitExponent(currency as never);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp);
  } catch {
    return `${(minor / 10 ** exp).toFixed(exp)} ${currency}`;
  }
}

type Col = AiTableBlock['columns'][number];

const cell = (v: unknown): string | number | null => (typeof v === 'string' || typeof v === 'number' ? v : typeof v === 'boolean' ? String(v) : null);

export function table(title: string, columns: Col[], rows: Array<Record<string, unknown>>, opts: { currencyKey?: string; note?: string; max?: number } = {}): AiTableBlock {
  const max = opts.max ?? 50;
  const clean = rows.slice(0, max).map((r) => Object.fromEntries(columns.map((c) => [c.key, cell(r[c.key])]).concat(opts.currencyKey ? [[opts.currencyKey, cell(r[opts.currencyKey])]] : [])));
  return {
    type: 'table', title, columns, rows: clean as AiTableBlock['rows'],
    ...(opts.currencyKey ? { currencyKey: opts.currencyKey } : {}),
    ...(rows.length > max ? { note: `${opts.note ? `${opts.note} ` : ''}Showing ${max} of ${rows.length}.` } : opts.note ? { note: opts.note } : {}),
  };
}

/** One bar chart per currency for money; one chart otherwise. */
export function barCharts(title: string, points: Array<{ label: string; value: number | null; currency?: string | null; previous?: number | null }>, opts: { unit: AiChartBlock['unit']; seriesName: string; previousName?: string }): AiChartBlock[] {
  const groups = opts.unit === 'money' ? [...new Set(points.map((p) => p.currency ?? null))] : [null];
  return groups.map((cur) => {
    const pts = points.filter((p) => opts.unit !== 'money' || (p.currency ?? null) === cur);
    const series: AiChartBlock['series'] = [{ name: opts.seriesName, points: pts.map((p) => ({ label: p.label, value: p.value })) }];
    if (opts.previousName) series.push({ name: opts.previousName, points: pts.map((p) => ({ label: p.label, value: p.previous ?? null })) });
    return { type: 'chart', kind: 'bar', title: cur ? `${title} (${cur})` : title, currency: cur, unit: opts.unit, series };
  });
}

/** Keeps tool payloads for the model small: long arrays trimmed, long strings cut. */
export function compact(v: unknown, opts: { maxItems?: number; maxString?: number } = {}, depth = 0): unknown {
  const maxItems = opts.maxItems ?? 40;
  const maxString = opts.maxString ?? 600;
  if (depth > 6) return '…';
  if (typeof v === 'string') return v.length > maxString ? `${v.slice(0, maxString)}…` : v;
  if (Array.isArray(v)) {
    const items = v.slice(0, maxItems).map((x) => compact(x, opts, depth + 1));
    return v.length > maxItems ? [...items, `… ${v.length - maxItems} more`] : items;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== '').map(([k, x]) => [k, compact(x, opts, depth + 1)]));
  return v;
}

/** Array of items from common list response shapes ({ items }, { data }, [..]). */
export function itemsOf<T = Record<string, any>>(r: unknown, key?: string): T[] {
  if (Array.isArray(r)) return r as T[];
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    for (const k of [key, 'items', 'data', 'rows', 'results'].filter(Boolean) as string[]) if (Array.isArray(o[k])) return o[k] as T[];
  }
  return [];
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

export type PeriodKey = 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'year_to_date' | 'last_30_days' | 'last_7_days';
export const PERIOD_KEYS = ['this_month', 'last_month', 'this_quarter', 'last_quarter', 'year_to_date', 'last_30_days', 'last_7_days'] as const;

/** Inclusive from/to dates (YYYY-MM-DD, UTC calendar) for a named period. */
export function periodRange(p: PeriodKey, now = new Date()): { from: string; to: string; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd));
  const today = ymd(now);
  switch (p) {
    case 'this_month': return { from: ymd(d(y, m, 1)), to: today, label: 'this month to date' };
    case 'last_month': return { from: ymd(d(y, m - 1, 1)), to: ymd(d(y, m, 0)), label: 'last month' };
    case 'this_quarter': { const q = Math.floor(m / 3) * 3; return { from: ymd(d(y, q, 1)), to: today, label: 'this quarter to date' }; }
    case 'last_quarter': { const q = Math.floor(m / 3) * 3; return { from: ymd(d(y, q - 3, 1)), to: ymd(d(y, q, 0)), label: 'last quarter' }; }
    case 'year_to_date': return { from: ymd(d(y, 0, 1)), to: today, label: 'year to date' };
    case 'last_7_days': return { from: ymd(new Date(now.getTime() - 6 * 86_400_000)), to: today, label: 'the last 7 days' };
    default: return { from: ymd(new Date(now.getTime() - 29 * 86_400_000)), to: today, label: 'the last 30 days' };
  }
}
