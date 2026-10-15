'use client';

import { useRef } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { Currency } from '@bh/shared';
import { ApiError } from './errors';
import { moneyWithCode } from './format';
import { slug } from './msg';

type Translate = ReturnType<typeof useTranslations<'apiError'>>;
type Vars = Record<string, string | number>;

const VALIDATION = new Set(['validation_failed', 'validation_error', 'bad_request']);

/** Fills `key` only when the catalogue has it and every `{placeholder}` it uses has a value. */
function phrase(t: Translate, key: string, vars: Vars): string | undefined {
  if (!t.has(key as never)) return undefined;
  const raw = t.raw(key as never) as unknown;
  if (typeof raw !== 'string') return undefined;
  const needed = [...raw.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]!);
  if (needed.some((n) => vars[n] === undefined)) return undefined;
  return t(key as never, vars as never);
}

/**
 * Field-level validation text in the viewer's language. The API sends English messages per field (from schema
 * validation or the service); known patterns are phrased from `apiError.field.*`, anything else is shown as sent.
 */
export function fieldMessage(t: Translate, msg: string): string {
  const m = msg.trim();
  const num = (re: RegExp) => re.exec(m)?.[1];
  let n: string | undefined;
  if (/^required$/i.test(m)) return t('field.required');
  if (/^(required when rejecting|a comment is required when rejecting)$/i.test(m)) return t('field.requiredWhenRejecting');
  if (/^(invalid email( address)?|enter a valid (work )?email( address)?)\.?$/i.test(m)) return t('field.invalidEmail');
  if (/^invalid ur[il]\.?$/i.test(m)) return t('field.invalidUrl');
  if (/time ?zone/i.test(m) && /(not a recogni[sz]ed|invalid|unknown)/i.test(m)) return t('field.invalidTimeZone');
  if ((n = num(/^too small: expected string to have >=?\s*(\d+)/i) ?? num(/^string must contain at least (\d+)/i))) return Number(n) <= 1 ? t('field.required') : t('field.tooShort', { min: n });
  if ((n = num(/^too big: expected string to have <=?\s*(\d+)/i) ?? num(/^string must contain at most (\d+)/i))) return t('field.tooLong', { max: n });
  if ((n = num(/^too small: expected number to be >=?\s*(-?[\d.]+)/i) ?? num(/^number must be greater than or equal to (-?[\d.]+)/i) ?? num(/^minimum (\d+)$/i))) return t('field.minValue', { min: n });
  if ((n = num(/^too big: expected number to be <=?\s*(-?[\d.]+)/i) ?? num(/^number must be less than or equal to (-?[\d.]+)/i) ?? num(/^maximum (\d+)$/i))) return t('field.maxValue', { max: n });
  if (/^must be > ?0$/i.test(m) || /^number must be greater than 0$/i.test(m)) return t('field.positive');
  if (/^enter the 6-digit code/i.test(m)) return t('field.code6');
  if (/^paste the link or token/i.test(m)) return t('field.pasteToken');
  if (/^enter the street address/i.test(m)) return t('field.streetAddress');
  if (/^add a reason for headquarters/i.test(m)) return t('field.reasonForHq');
  if ((n = num(/^max (\d+) days$/i))) return t('field.maxDays', { count: Number(n) });
  if (/^too soon$/i.test(m)) return t('field.tooSoon');
  if (/^invalid( input| value)?\b/i.test(m)) return t('field.invalid');
  return msg;
}

/** The English sentence the API sent, phrased in the viewer's language when the code is known. */
function messageFor(t: Translate, locale: string, e: { code: string; message: string; details?: Record<string, unknown>; fields?: Record<string, string> }): string {
  const d = e.details ?? {};
  const currency = typeof d.currency === 'string' ? (d.currency as Currency) : undefined;
  const money = (minor: unknown) => (typeof minor === 'number' && currency ? moneyWithCode({ amount: minor, currency }, locale) : undefined);
  const vars: Vars = {};
  const put = (k: string, v: unknown) => {
    if (typeof v === 'number' || (typeof v === 'string' && v)) vars[k] = v;
  };
  put('days', d.days);
  put('hours', d.freeCancelHours ?? d.hours);
  put('count', d.onHand ?? d.open);
  put('amount', money(d.remainingMinor ?? d.minimumMinor));
  put('min', money(d.minMinor));
  put('max', money(d.maxMinor));
  if (VALIDATION.has(e.code)) {
    // Specific validation sentences we know; otherwise the generic line when the fields carry the detail.
    const known = phrase(t, `validation.${slug(e.message)}`, vars);
    if (known) return known;
    if (e.fields && Object.keys(e.fields).length) return phrase(t, e.code, vars) ?? e.message;
    return e.message;
  }
  return phrase(t, e.code, vars) ?? e.message;
}

/**
 * Phrases API errors from the catalogue (`apiError.*`), the same way customer websites do: by `code` plus the
 * arguments in `details`, falling back to the API's English `message` for codes the catalogue doesn't know. Field
 * messages are mapped too. The original text stays available as `apiMessage`.
 */
export function useLocalizeError(): (e: ApiError) => ApiError {
  const t = useTranslations('apiError');
  const locale = useLocale();
  return (e) => {
    if (e.apiMessage !== undefined) return e;
    const fields = e.fields ? Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, fieldMessage(t, v)])) : undefined;
    return new ApiError(e.code, messageFor(t, locale, e), e.status, fields, e.details, e.message);
  };
}

/** For error objects that arrive inside results (`{ code, message }`) rather than thrown. */
export function useErrorText(): (e: { code: string; message: string; details?: Record<string, unknown> } | null | undefined) => string {
  const t = useTranslations('apiError');
  const locale = useLocale();
  return (e) => (e ? messageFor(t, locale, e) : '');
}

/** Move/booking conflicts (`kind` + English `message`): phrased from `apiError.conflictKind.*`. */
export function useConflictText(): (c: { kind: string; message: string }) => string {
  const t = useTranslations('apiError');
  return (c) => (t.has(`conflictKind.${c.kind}` as never) ? t(`conflictKind.${c.kind}` as never) : c.message);
}

/** Field validation text for rows the client checks itself (imports) — same mapping as API field errors. */
export function useFieldText(): (msg: string) => string {
  const t = useTranslations('apiError');
  return (msg) => fieldMessage(t, msg);
}

/** `useLocalizeError` kept in a ref, for load/mutation hooks whose callbacks are memoized. */
export function useLocalizeErrorRef() {
  const localize = useLocalizeError();
  const ref = useRef(localize);
  ref.current = localize;
  return ref;
}
