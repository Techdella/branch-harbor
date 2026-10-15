'use client';

import type { ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { ComplianceResult, FranchiseStage } from '@bh/shared';
import type { FResource } from '@/lib/franchise/api';
import { useApp } from '../../shell/AppContext';
import { Banner, ErrorState, LoadingBlock } from '../../ui/States';
import { NotAvailable } from '../NotAvailable';

export const STAGE_UI: Record<FranchiseStage, { tone: Tone; icon: IconName; dot: string }> = {
  enquiry: { tone: 'neutral', icon: 'mail', dot: 'bg-lilac' },
  qualified: { tone: 'info', icon: 'check', dot: 'bg-aqua' },
  discovery_call: { tone: 'info', icon: 'phone', dot: 'bg-aqua' },
  disclosure_sent: { tone: 'warning', icon: 'send', dot: 'bg-butter' },
  disclosure_receipt_signed: { tone: 'warning', icon: 'file', dot: 'bg-butter' },
  waiting_period: { tone: 'warning', icon: 'clock', dot: 'bg-butter' },
  agreement_sent: { tone: 'info', icon: 'signature', dot: 'bg-sage' },
  signed: { tone: 'success', icon: 'signature', dot: 'bg-lime' },
  onboarding: { tone: 'success', icon: 'flag', dot: 'bg-lime' },
  opened: { tone: 'success', icon: 'store', dot: 'bg-lime' },
  lost: { tone: 'danger', icon: 'x', dot: 'bg-blush' },
};

export function StageBadge({ stage }: { stage: FranchiseStage }) {
  const t = useTranslations('franchise.stage');
  const ui = STAGE_UI[stage] ?? STAGE_UI.enquiry;
  return <Badge tone={ui.tone} icon={ui.icon}>{t(stage)}</Badge>;
}

/** Franchise development is for networks: independent businesses get a short explanation instead. */
export function NetworkOnly({ children }: { children: ReactNode }) {
  const app = useApp();
  const t = useTranslations('franchise');
  if (app.org.model === 'independent') return <Banner tone="neutral" icon="info">{t('networkOnly')}</Banner>;
  return <>{children}</>;
}

/** Compliance aid banner, shown wherever rules are shown. */
export function CounselBanner({ reviewed, total }: { reviewed?: number; total?: number }) {
  const t = useTranslations('franchise.rules');
  return (
    <Banner tone="warning" icon="scale" title={t('counselTitle')}>
      {t('counselBody')}
      {total !== undefined && reviewed !== undefined ? ` ${t('counselCount', { reviewed, total })}` : ''}
    </Banner>
  );
}

export function FAsync<T>({ res, children, variant = 'cards' }: { res: FResource<T>; children: (d: T) => ReactNode; variant?: 'cards' | 'table' | 'detail' }) {
  if (res.status === 'error') {
    if (res.error?.isForbidden) return <NotAvailable />;
    return <ErrorState error={res.error} onRetry={res.reload} />;
  }
  if (res.data === undefined) return <LoadingBlock variant={variant} />;
  return <>{children(res.data)}</>;
}

export function useFmt() {
  const locale = useLocale();
  const date = (iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) => {
    if (!iso) return '—';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
    return new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(d);
  };
  const money = (m: { amount: number; currency: string } | null | undefined) => {
    if (!m) return '—';
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: m.currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency, maximumFractionDigits: 0 }).format(m.amount / 10 ** digits);
  };
  const pct = (bps: number | null | undefined) => (bps == null ? '—' : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(bps / 10_000));
  const place = (country: string, region?: string | null) => {
    let c = country;
    try { c = new Intl.DisplayNames([locale], { type: 'region' }).of(country) ?? country; } catch { /* keep code */ }
    return region ? `${region}, ${c}` : c;
  };
  return { date, money, pct, place, locale };
}

/** Blocker sentence in the viewer's language (the API's English text is the fallback). */
export function useBlockerText() {
  const t = useTranslations('franchise.blocker');
  const f = useFmt();
  return (b: { code: string; ruleCode: string; message: string; until: string | null }) =>
    t.has(b.code as 'waiting_period') ? t(b.code as 'waiting_period', { rule: b.ruleCode, date: f.date(b.until) }) : b.message;
}

export function ComplianceSummary({ c }: { c: ComplianceResult }) {
  const t = useTranslations('franchise.compliance');
  const f = useFmt();
  const text = useBlockerText();
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md bg-canvas-raised p-3">
          <div className="text-xs font-bold text-stone">{t('earliestSigning')}</div>
          <div className="text-base font-bold">{c.earliestSigningAt ? f.date(c.earliestSigningAt) : t('notYet')}</div>
          <div className="mt-1">{c.canSign ? <Badge tone="success" icon="check">{t('canSign')}</Badge> : <Badge tone="warning" icon="lock">{t('signingBlocked')}</Badge>}</div>
        </div>
        <div className="rounded-md bg-canvas-raised p-3">
          <div className="text-xs font-bold text-stone">{t('earliestPayment')}</div>
          <div className="text-base font-bold">{c.earliestPaymentAt ? f.date(c.earliestPaymentAt) : t('notYet')}</div>
          <div className="mt-1">{c.canPay ? <Badge tone="success" icon="check">{t('canPay')}</Badge> : <Badge tone="warning" icon="lock">{t('paymentBlocked')}</Badge>}</div>
        </div>
      </div>
      {[...c.signingBlockers, ...c.paymentBlockers.filter((p) => !c.signingBlockers.some((s) => s.code === p.code && s.ruleCode === p.ruleCode))].map((b, i) => (
        <Banner key={`${b.code}-${b.ruleCode}-${i}`} tone="warning" icon={b.code === 'waiting_period' ? 'clock' : 'lock'}>{text(b)}</Banner>
      ))}
      {c.coolingOffEndsAt && <Banner tone="info" icon="clock">{t('coolingOff', { date: f.date(c.coolingOffEndsAt) })}</Banner>}
    </div>
  );
}
