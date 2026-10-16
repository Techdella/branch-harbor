'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Icon } from '@bh/ui';
import { ASSISTANT_NAME } from '@bh/shared';
import { marina, type VisitBrief } from '@/lib/marina';
import { useErrorText } from '@/lib/useErrorText';
import { ApiError } from '@/lib/errors';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { LoadingBlock, SectionCard } from '../ui/States';
import { StatusPill, useFormatters } from './Blocks';

/** One-page visit brief for field consultants (printable). */
export function VisitBriefScreen() {
  const t = useTranslations('marina');
  const app = useApp();
  const f = useFormatters();
  const errText = useErrorText();
  const params = useSearchParams();
  const router = useRouter();
  const loc = params.get('location') ?? '';
  const [brief, setBrief] = useState<VisitBrief | null>(null);
  const [error, setError] = useState<string | null>(null);
  // useErrorText returns a new function each render; keep it out of the effect's dependencies so the brief loads once
  // per location instead of on every render.
  const errTextRef = useRef(errText);
  errTextRef.current = errText;
  useEffect(() => {
    let live = true;
    setBrief(null);
    setError(null);
    if (loc) {
      marina.visitBrief(loc)
        .then((b) => { if (live) setBrief(b); })
        .catch((e) => { if (live) setError(errTextRef.current(e instanceof ApiError ? e : new ApiError('unknown_error', String(e)))); });
    }
    return () => { live = false; };
  }, [loc]);
  return (
    <>
      <PageHeader icon="pin" title={t('visit.title')} description={t('visit.description', { name: ASSISTANT_NAME })} scope={false}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm">
              <span className="sr-only">{t('visit.location')}</span>
              <select value={loc} onChange={(e) => router.push(`/marina/visit-brief?location=${e.target.value}`)} className="h-11 rounded-full bg-canvas px-4 text-sm" data-testid="visit-location">
                <option value="">{t('visit.choose')}</option>
                {app.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            {brief && <Button variant="secondary" icon="file" onClick={() => window.print()}>{t('visit.print')}</Button>}
          </>
        } />
      {!loc && <SectionCard><p className="text-sm text-stone">{t('visit.pick')}</p></SectionCard>}
      {loc && !brief && !error && <LoadingBlock variant="detail" />}
      {error && <SectionCard><p role="alert" className="text-sm text-danger">{error}</p></SectionCard>}
      {brief && (
        <div className="grid gap-3 lg:grid-cols-2" data-testid="visit-brief">
          <SectionCard title={t('visit.talkingPoints')} className="lg:col-span-2">
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-[15px]">
              {brief.talkingPoints.map((p, i) => <li key={i}>{p}</li>)}
            </ol>
          </SectionCard>
          <SectionCard title={t('visit.kpis', { period: brief.kpis?.period ?? '' })}>
            {brief.kpis ? (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-xs text-stone">{t('visit.revenue')}</dt><dd className="text-lg font-bold">{brief.kpis.revenue ?? '—'}</dd><dd className="text-xs text-stone">{brief.kpis.previousRevenue ? t('visit.previous', { value: brief.kpis.previousRevenue }) : ''}</dd></div>
                <div><dt className="text-xs text-stone">{t('visit.growth')}</dt><dd className="text-lg font-bold">{brief.kpis.growthPct === null ? '—' : `${f.num(brief.kpis.growthPct)}%`}</dd></div>
                <div><dt className="text-xs text-stone">{t('visit.activity')}</dt><dd className="text-lg font-bold">{f.num(brief.kpis.activity)}</dd></div>
                <div><dt className="text-xs text-stone">{t('visit.rank')}</dt><dd className="text-lg font-bold">{brief.kpis.rank ?? '—'}</dd></div>
                <div><dt className="text-xs text-stone">{t('visit.rating')}</dt><dd className="text-lg font-bold">{brief.kpis.reviewRating ?? '—'}</dd></div>
                <div><dt className="text-xs text-stone">{t('visit.royalties')}</dt><dd>{brief.kpis.royaltyStatus ? <StatusPill value={brief.kpis.royaltyStatus} /> : '—'}</dd></div>
              </dl>
            ) : <p className="text-sm text-stone">{t('visit.noKpis')}</p>}
          </SectionCard>
          <SectionCard title={t('visit.audits')}>
            {brief.lastAudit ? (
              <p className="text-sm"><Link href={`/audits/${brief.lastAudit.id}`} className="font-bold hover:underline">{brief.lastAudit.name}</Link> · {f.date(brief.lastAudit.completedAt)} · {brief.lastAudit.scorePct ?? '—'}% <StatusPill value={brief.lastAudit.passed ? 'passed' : 'failed'} /></p>
            ) : <p className="text-sm text-stone">{t('visit.noAudit')}</p>}
            {brief.nextAudit && <p className="mt-1 text-xs text-stone">{t('visit.nextAudit', { date: f.date(brief.nextAudit.dueDate) })}</p>}
            <ul className="mt-3 flex flex-col gap-1.5 text-sm">
              {brief.openActions.map((a, i) => <li key={i} className="flex items-center gap-2"><Icon name="alert" size={13} />{a.title} · {f.date(a.dueDate)} {a.overdue && <StatusPill value="overdue" />}</li>)}
              {!brief.openActions.length && <li className="text-stone">{t('visit.noActions')}</li>}
            </ul>
          </SectionCard>
          <SectionCard title={t('visit.reviews')}>
            {brief.reviews ? (
              <>
                <p className="text-sm">{t('visit.reviewSummary', { average: brief.reviews.average ?? '—', count: brief.reviews.count })}</p>
                <ul className="mt-2 flex flex-col gap-1.5 text-sm">{brief.reviews.negative.map((r, i) => <li key={i} className="rounded-md bg-canvas p-2"><strong>{r.rating}★</strong> {r.comment}</li>)}</ul>
              </>
            ) : <p className="text-sm text-stone">{t('visit.notInAccess')}</p>}
          </SectionCard>
          <SectionCard title={t('visit.compliance')}>
            <ul className="flex flex-col gap-1.5 text-sm">
              {brief.compliance.map((c, i) => <li key={i} className="flex flex-wrap items-center gap-2">{c.title} · {f.date(c.expiresOn)} {c.state && <StatusPill value={c.state} />}</li>)}
              {!brief.compliance.length && <li className="text-stone">{t('visit.none')}</li>}
            </ul>
          </SectionCard>
          <SectionCard title={t('visit.tickets')}>
            <ul className="flex flex-col gap-1.5 text-sm">
              {brief.tickets.map((x) => <li key={x.number}>#{x.number} {x.subject} <StatusPill value={x.status} /></li>)}
              {!brief.tickets.length && <li className="text-stone">{t('visit.none')}</li>}
            </ul>
          </SectionCard>
          <SectionCard title={t('visit.royaltiesOverdue')}>
            <ul className="flex flex-col gap-1.5 text-sm">
              {brief.royalties.map((x) => <li key={x.number}>{x.number} · {x.outstanding} · {t('visit.daysOverdue', { days: x.daysOverdue ?? 0 })}</li>)}
              {!brief.royalties.length && <li className="text-stone">{t('visit.none')}</li>}
            </ul>
          </SectionCard>
        </div>
      )}
    </>
  );
}
