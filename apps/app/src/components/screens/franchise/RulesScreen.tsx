'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, cx } from '@bh/ui';
import { franchiseApi, useFranchise, useFranchiseAction, type Rule } from '@/lib/franchise/api';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { ComplianceSummary, CounselBanner, FAsync, LiveOnly, useFmt } from './common';

export function RulesScreen() {
  return <LiveOnly><Rules /></LiveOnly>;
}

function Rules() {
  const t = useTranslations('franchise');
  const app = useApp();
  const sp = useSearchParams();
  const res = useFranchise(() => franchiseApi.rules(), [app.org.id]);
  const [country, setCountry] = useState(sp.get('country') ?? '');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader icon="scale" title={t('rules.title')} description={t('rules.description')} scope={false} />
      <FAsync res={res}>
        {(d) => {
          const countries = [...new Set(d.items.map((r) => r.country))].sort();
          const list = d.items.filter((r) => !country || r.country === country);
          return (
            <div className="flex flex-col gap-3">
              <CounselBanner reviewed={d.reviewedCount} total={new Set(d.items.map((r) => r.code)).size} />
              <Evaluate initialCountry={sp.get('country') ?? ''} initialRegion={sp.get('region') ?? ''} />
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-48"><Field label={t('rules.filterCountry')}>{(x) => (
                  <Select id={x.id} value={country} onChange={(e) => setCountry(e.target.value)}>
                    <option value="">{t('rules.allCountries')}</option>
                    {countries.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                )}</Field></div>
              </div>
              {list.length ? (
                <ul className="flex flex-col gap-2">
                  {list.map((r) => <RuleRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onReviewed={res.reload} />)}
                </ul>
              ) : <Empty icon="scale" title={t('rules.noneApplicable')} />}
              <p className="text-xs text-stone">{d.disclaimer}</p>
            </div>
          );
        }}
      </FAsync>
    </>
  );
}

function RuleRow({ r, open, onToggle, onReviewed }: { r: Rule; open: boolean; onToggle: () => void; onReviewed: () => void }) {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const act = useFranchiseAction();
  const days = (n: number | null) => (n == null ? t('rules.none') : t('rules.days', { count: n, kind: t(`rules.dayCount.${r.disclosure.dayCount}`) }));
  return (
    <li className="rounded-xl bg-surface">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full flex-wrap items-center gap-2 p-4 text-left">
        <span className="w-16 font-extrabold">{r.code}</span>
        <span className="min-w-0 flex-1 font-bold">{r.name}</span>
        <Badge tone={r.status === 'statute' ? 'info' : r.status === 'verify' ? 'warning' : 'neutral'}>{t(`rules.status.${r.status}`)}</Badge>
        <Badge tone={r.confidence === 'high' ? 'success' : r.confidence === 'medium' ? 'neutral' : 'warning'}>{t(`rules.confidence.${r.confidence}`)}</Badge>
        {r.reviewedByCounsel ? <Badge tone="success" icon="check">{t('rules.reviewed')}</Badge> : <Badge tone="warning" icon="scale">{t('rules.needsReview')}</Badge>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={16} />
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line-soft p-4 text-[13px]">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-stone">{t('rules.disclosure')}</dt><dd>{r.disclosure.required ? (r.disclosure.document ?? t('rules.required')) : t('rules.none')}</dd>
            <dt className="text-stone">{t('rules.beforeSigning')}</dt><dd className="font-semibold">{days(r.disclosure.minDaysBeforeSigning)}</dd>
            <dt className="text-stone">{t('rules.beforePayment')}</dt><dd className="font-semibold">{days(r.disclosure.minDaysBeforePayment)}</dd>
            {r.disclosure.changedTermsDays ? <><dt className="text-stone">{t('rules.changedTerms')}</dt><dd>{t('rules.days', { count: r.disclosure.changedTermsDays, kind: t('rules.dayCount.calendar') })}</dd></> : null}
            <dt className="text-stone">{t('rules.registration')}</dt><dd>{t(`rules.registrationKind.${r.registration.kind}`)}{r.registration.authority ? ` · ${r.registration.authority}` : ''}</dd>
            <dt className="text-stone">{t('rules.coolingOff')}</dt><dd>{r.coolingOff ? t('rules.days', { count: r.coolingOff.days, kind: t('rules.dayCount.calendar') }) : t('rules.none')}</dd>
            {r.language && <><dt className="text-stone">{t('rules.language')}</dt><dd>{r.language}</dd></>}
            {r.renewalTermination && <><dt className="text-stone">{t('rules.renewalTermination')}</dt><dd>{r.renewalTermination}</dd></>}
            <dt className="text-stone">{t('rules.version')}</dt><dd>{r.version} · {t('rules.effective', { date: f.date(r.effectiveFrom) })}{r.origin === 'organization' ? ` · ${t('rules.orgVersion')}` : ''}</dd>
          </dl>
          {r.disclosure.note && <p>{r.disclosure.note}</p>}
          {r.registration.note && <p>{r.registration.note}</p>}
          {r.notes.map((n, i) => <p key={i}>{n}</p>)}
          {r.verify.length > 0 && (
            <div className="rounded-md bg-warning-bg p-3 text-warning">
              <div className="font-bold">{t('rules.verify')}</div>
              <ul className="list-disc pl-5">{r.verify.map((v, i) => <li key={i}>{v}</li>)}</ul>
            </div>
          )}
          <div>
            <div className="font-bold">{t('rules.sources')}</div>
            <ul className="list-disc pl-5">
              {r.sources.map((s, i) => <li key={i}>{s.url ? <a className="underline" href={s.url} target="_blank" rel="noreferrer">{s.law}</a> : s.law}{s.citation ? `, ${s.citation}` : ''}</li>)}
            </ul>
          </div>
          {act.error && <Banner tone="danger">{act.error.message}</Banner>}
          {app.can('legal.edit') && (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant={r.reviewedByCounsel ? 'secondary' : 'primary'} icon={r.reviewedByCounsel ? 'undo' : 'check'} loading={act.pending} onClick={async () => { if (await act.run(() => franchiseApi.reviewRule(r.id, !r.reviewedByCounsel))) onReviewed(); }}>
                {r.reviewedByCounsel ? t('rules.markUnreviewed') : t('rules.markReviewed')}
              </Button>
              {r.reviewedAt && <span className="text-xs text-stone">{t('rules.reviewedOn', { date: f.date(r.reviewedAt) })}</span>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function Evaluate({ initialCountry, initialRegion }: { initialCountry: string; initialRegion: string }) {
  const t = useTranslations('franchise');
  const [country, setCountry] = useState(initialCountry);
  const [region, setRegion] = useState(initialRegion);
  const [q, setQ] = useState<{ country: string; region: string } | null>(initialCountry ? { country: initialCountry, region: initialRegion } : null);
  const key = useMemo(() => (q ? `${q.country}-${q.region}` : ''), [q]);
  const res = useFranchise(() => franchiseApi.evaluate(q!.country, q!.region), [key], !!q);
  return (
    <SectionCard title={t('rules.evaluateTitle')}>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setQ({ country, region }); }}>
        <div className="w-28"><Field label={t('prospect.country')}>{(x) => <Input id={x.id} maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />}</Field></div>
        <div className="w-28"><Field label={t('prospect.region')} optional>{(x) => <Input id={x.id} maxLength={6} value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} />}</Field></div>
        <Button type="submit" icon="search" disabled={country.length !== 2}>{t('rules.evaluate')}</Button>
      </form>
      {q && (
        <div className={cx('mt-3')}>
          <FAsync res={res} variant="detail">
            {(c) => (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">{c.applicable.map((a) => <Badge key={a.code} tone="neutral" icon="scale">{a.name}</Badge>)}</div>
                {!c.applicable.length && c.warnings[0] && <Banner tone="warning">{c.warnings[0].message}</Banner>}
                <p className="text-[13px] text-stone">{t('rules.evaluateHint')}</p>
                <ComplianceSummary c={c} />
                {c.requiredDocuments.length > 0 && <ul className="list-disc pl-5 text-[13px]">{c.requiredDocuments.map((d) => <li key={d.key}>{d.label}</li>)}</ul>}
              </div>
            )}
          </FAsync>
        </div>
      )}
    </SectionCard>
  );
}
