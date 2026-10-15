'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button, Field, Icon, Input } from '@bh/ui';
import { fmtNumber, fmtYmd, relativeTime } from '@/lib/format';
import { hosp, useHosp } from '@/lib/hospitality/api';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Empty } from '../../ui/States';
import { HAsync, M, addDaysYmd, pct } from './common';

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-canvas p-3">
      <div className="text-[12px] font-semibold text-stone">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-stone">{sub}</div>}
    </div>
  );
}

/** Tonight at each property: occupancy, ADR, RevPAR (each in the property currency), arrivals, departures, rooms to clean. */
export function PulseScreen() {
  const t = useTranslations('hosp');
  const tOps = useTranslations('ops.hospitality.pulse');
  const locale = useLocale();
  const app = useApp();
  const res = useHosp(() => hosp.pulse(), []);
  return (
    <>
      <PageHeader icon="grid" title={tOps('title')} description={tOps('description')} actions={<Button size="sm" variant="secondary" icon="refresh" onClick={res.reload}>{t('common.refresh')}</Button>} />
      <HAsync res={res} variant="cards">
        {(rows) => {
          const visible = rows.filter((r) => app.scope.locationIds.length === 0 || app.scope.locationIds.includes(r.locationId));
          if (!visible.length) return <Empty icon="bed" title={t('common.noPropertiesTitle')} body={t('common.noPropertiesBody')} />;
          return (
            <div className="grid gap-3 lg:grid-cols-2">
              {visible.map((p) => (
                <section key={p.locationId} className="rounded-xl bg-surface p-4" data-testid="pulse-property">
                  <div className="mb-3 flex items-baseline justify-between gap-2">
                    <h2 className="text-base font-bold">{p.name}</h2>
                    <span className="text-xs text-stone">{fmtYmd(p.date, locale)} · {p.currency}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Stat label={t('pulse.occupancy')} value={pct(p.occupancy, locale) ?? t('common.notAvailable')} sub={t('pulse.roomsSold', { sold: p.roomNightsSold, available: p.roomNightsAvailable })} />
                    <Stat label={t('pulse.adr')} value={<M value={p.adr} />} />
                    <Stat label={t('pulse.revpar')} value={<M value={p.revpar} />} />
                    <Stat label={t('pulse.arrivals')} value={fmtNumber(p.arrivals, locale)} sub={t('pulse.checkedIn', { count: p.arrivalsCheckedIn })} />
                    <Stat label={t('pulse.departures')} value={fmtNumber(p.departures, locale)} sub={t('pulse.checkedOut', { count: p.departuresCheckedOut })} />
                    <Stat label={t('pulse.inHouse')} value={fmtNumber(p.inHouse, locale)} />
                  </div>
                  <p className="mt-3 flex flex-wrap gap-3 text-xs text-stone">
                    <span><Icon name="refresh" size={12} /> {t('pulse.dirty', { count: p.dirtyRooms })}</span>
                    <span><Icon name="alert" size={12} /> {t('pulse.outOfOrder', { count: p.outOfOrder })}</span>
                    <span><Icon name="check-circle" size={12} /> {t('pulse.openTasks', { count: p.openTasks })}</span>
                  </p>
                </section>
              ))}
              <p className="text-xs text-stone lg:col-span-2">{t('pulse.note')}</p>
            </div>
          );
        }}
      </HAsync>
    </>
  );
}

/** Occupancy, ADR and RevPAR per property and per currency (never combined), pickup and cancellations. */
export function ReportsScreen() {
  const t = useTranslations('hosp');
  const tOps = useTranslations('ops.hospitality.hotelreports');
  const locale = useLocale();
  const app = useApp();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(addDaysYmd(today, -14));
  const [to, setTo] = useState(addDaysYmd(today, 16));
  const res = useHosp(() => hosp.report({ from, to }), [from, to]);
  return (
    <>
      <PageHeader icon="chart" title={tOps('title')} description={tOps('description')} />
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label={t('reports.from')}>{({ id }) => <Input id={id} type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />}</Field>
        <Field label={t('reports.to')}>{({ id }) => <Input id={id} type="date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />}</Field>
      </div>
      <HAsync res={res}>
        {(r) => {
          const props = r.properties.filter((p) => app.scope.locationIds.length === 0 || app.scope.locationIds.includes(p.locationId));
          return (
            <div className="flex flex-col gap-3">
              <section className="overflow-x-auto rounded-xl bg-surface p-4" tabIndex={0}>
                <table className="w-full min-w-[640px] text-sm" data-testid="report-currency">
                  <caption className="mb-2 text-start text-sm font-bold">{t('reports.byCurrency')}</caption>
                  <thead><tr className="text-xs text-stone"><th className="py-1 text-start">{t('reports.currency')}</th><th className="text-end">{t('reports.available')}</th><th className="text-end">{t('reports.sold')}</th><th className="text-end">{t('pulse.occupancy')}</th><th className="text-end">{t('pulse.adr')}</th><th className="text-end">{t('pulse.revpar')}</th><th className="text-end">{t('reports.revenue')}</th></tr></thead>
                  <tbody>
                    {r.byCurrency.map((c) => (
                      <tr key={c.currency} className="border-t border-line-soft">
                        <td className="py-2 font-bold">{c.currency}</td>
                        <td className="text-end tabular-nums">{fmtNumber(c.roomNightsAvailable, locale)}</td>
                        <td className="text-end tabular-nums">{fmtNumber(c.roomNightsSold, locale)}</td>
                        <td className="text-end tabular-nums">{pct(c.occupancy, locale) ?? t('common.notAvailable')}</td>
                        <td className="text-end"><M value={c.adr} /></td>
                        <td className="text-end"><M value={c.revpar} /></td>
                        <td className="text-end"><M value={c.roomRevenue} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-stone">{t('reports.neverCombined')}</p>
              </section>
              <section className="overflow-x-auto rounded-xl bg-surface p-4" tabIndex={0}>
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="mb-2 text-start text-sm font-bold">{t('reports.byProperty')}</caption>
                  <thead><tr className="text-xs text-stone"><th className="py-1 text-start">{t('common.property')}</th><th className="text-end">{t('reports.sold')}</th><th className="text-end">{t('pulse.occupancy')}</th><th className="text-end">{t('pulse.adr')}</th><th className="text-end">{t('pulse.revpar')}</th><th className="text-end">{t('reports.beds')}</th></tr></thead>
                  <tbody>
                    {props.map((p) => (
                      <tr key={p.locationId} className="border-t border-line-soft">
                        <td className="py-2"><strong>{p.name}</strong> <span className="text-xs text-stone">{p.currency}</span></td>
                        <td className="text-end tabular-nums">{p.roomNightsSold} / {p.roomNightsAvailable}</td>
                        <td className="text-end tabular-nums">{pct(p.occupancy, locale) ?? t('common.notAvailable')}</td>
                        <td className="text-end"><M value={p.adr} /></td>
                        <td className="text-end"><M value={p.revpar} /></td>
                        <td className="text-end tabular-nums">{p.beds ? `${p.beds.bedNightsSold} / ${p.beds.bedNightsAvailable}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <div className="grid gap-3 lg:grid-cols-2">
                <section className="overflow-x-auto rounded-xl bg-surface p-4" tabIndex={0}>
                  <h2 className="mb-2 text-sm font-bold">{t('reports.pickup')}</h2>
                  {r.pickup.length === 0 ? <p className="text-sm text-stone">{t('reports.noPickup')}</p> : (
                    <table className="w-full text-sm">
                      <thead><tr className="text-xs text-stone"><th className="py-1 text-start">{t('reports.bookedOn')}</th><th className="text-end">{t('reports.bookings')}</th><th className="text-end">{t('reports.roomNights')}</th><th className="text-end">{t('reports.revenue')}</th></tr></thead>
                      <tbody>{r.pickup.map((p) => <tr key={`${p.date}${p.currency}`} className="border-t border-line-soft"><td className="py-1.5">{fmtYmd(p.date, locale)}</td><td className="text-end tabular-nums">{p.bookings}</td><td className="text-end tabular-nums">{p.roomNights}</td><td className="text-end"><M value={p.revenue} /></td></tr>)}</tbody>
                    </table>
                  )}
                </section>
                <section className="overflow-x-auto rounded-xl bg-surface p-4" tabIndex={0}>
                  <h2 className="mb-2 text-sm font-bold">{t('reports.cancellations')}</h2>
                  {r.cancellations.length === 0 ? <p className="text-sm text-stone">{t('reports.noCancellations')}</p> : (
                    <table className="w-full text-sm">
                      <thead><tr className="text-xs text-stone"><th className="py-1 text-start">{t('reports.currency')}</th><th className="text-end">{t('reports.cancelled')}</th><th className="text-end">{t('reports.noShows')}</th><th className="text-end">{t('reports.nightsLost')}</th><th className="text-end">{t('reports.feesRetained')}</th></tr></thead>
                      <tbody>{r.cancellations.map((c) => <tr key={c.currency} className="border-t border-line-soft"><td className="py-1.5 font-bold">{c.currency}</td><td className="text-end tabular-nums">{c.cancelled}</td><td className="text-end tabular-nums">{c.noShows}</td><td className="text-end tabular-nums">{c.roomNightsLost}</td><td className="text-end"><M value={c.feesRetained} /></td></tr>)}</tbody>
                    </table>
                  )}
                </section>
              </div>
              <p className="text-xs text-stone">{t('reports.definitions')} · {t('reports.generated', { when: relativeTime(r.generatedAt, locale) })}</p>
            </div>
          );
        }}
      </HAsync>
    </>
  );
}
