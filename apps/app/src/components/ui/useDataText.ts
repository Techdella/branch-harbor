'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { Currency } from '@bh/shared';
import type { MsgParam, MsgParams, MsgRef } from '@/lib/msg';
import { fmtDateTime, fmtDay, fmtTime, moneyWithCode, zoneLabel } from '@/lib/format';

export type DataText = (key: string | undefined | null, params: MsgParams | undefined, fallback: string) => string;

/**
 * Translates text the data layer refers to by key (namespace "data", see lib/msg.ts). Keys the catalogue doesn't
 * know fall back to the English text the data layer sent alongside. Nested arguments are resolved first: message
 * refs are translated, dates and amounts are formatted in the viewer's locale, lists are joined.
 */
export function useDataText(): DataText {
  const t = useTranslations('data');
  const locale = useLocale();
  const resolve = (p: MsgParam): string | number => {
    if (typeof p === 'string' || typeof p === 'number') return p;
    if (Array.isArray(p)) return (p as MsgParam[]).map((x) => resolve(x)).join(', ');
    if (p.t === 'msg') return text(p.key, p.params, p.text ?? p.key);
    if (p.t === 'money') return moneyWithCode({ amount: p.amount, currency: p.currency as Currency }, locale);
    const tz = p.tz ?? 'UTC';
    if (p.style === 'time') return fmtTime(p.at, tz, locale);
    if (p.style === 'zone') return zoneLabel(tz, locale, new Date(p.at));
    if (p.style === 'weekday') return fmtDay(p.at, tz, locale, { weekday: 'short' });
    if (p.style === 'monthYear') return fmtDay(p.at, tz, locale, { month: 'short', year: 'numeric' });
    if (p.style === 'dayMonth') return fmtDay(p.at, tz, locale, { day: 'numeric', month: 'short' });
    const zone = p.tz ? ` ${zoneLabel(tz, locale, new Date(p.at))}` : '';
    if (p.style === 'dateTime') return `${fmtDateTime(p.at, tz, locale)}${zone}`;
    if (p.style === 'dayTime') return `${fmtDay(p.at, tz, locale)} ${fmtTime(p.at, tz, locale)}${zone}`;
    return fmtDay(p.at, tz, locale, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const text: DataText = (key, params, fallback) => {
    if (!key || !t.has(key)) return fallback;
    const values = params ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, resolve(v)])) : undefined;
    return t(key, values);
  };
  return text;
}

/** Plain text shown as is, or its catalogue reference translated (see `Txt` in lib/msg.ts). */
export function useTxt() {
  const dt = useDataText();
  return (text: string | undefined, msg?: MsgRef): string => (msg ? dt(msg.key, msg.params, msg.text ?? text ?? msg.key) : (text ?? ''));
}
