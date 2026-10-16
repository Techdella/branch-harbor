'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Drawer, Tabs, cx } from '@bh/ui';
import type { CateringEnquiry, ProductionSummary } from '@/lib/foods/types';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { fmtDateTime, fmtYmd } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../../ui/States';
import { ErrorLine, Labeled, LocationSelect, Money1, MoneyList, NoLocations, Section, StatusBadge, inputCls, toMinor, useFx, useLocationPick } from './common';

type Tab = 'pipeline' | 'dates' | 'production' | 'packages';
const STAGES = ['new', 'quoted', 'accepted', 'deposit_paid', 'confirmed'];

/** Preorders & catering: enquiry → quote → acceptance → deposit → confirmed; cooking dates with cut-offs; production summary per date. */
export function CateringScreen() {
  const t = useFx();
  const [tab, setTab] = useState<Tab>('pipeline');
  const pick = useLocationPick();
  if (!pick.loc) return <NoLocations />;
  return (
    <>
      <PageHeader icon="gift" title={t('catering.title')} description={t('catering.description')} />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs<Tab> items={[{ key: 'pipeline', label: t('catering.tabPipeline') }, { key: 'dates', label: t('catering.tabDates') }, { key: 'production', label: t('catering.tabProduction') }, { key: 'packages', label: t('catering.tabPackages') }]} value={tab} onChange={setTab} />
        {tab !== 'packages' && <LocationSelect pick={pick} />}
      </div>
      {tab === 'pipeline' && <Pipeline locationId={pick.locationId} tz={pick.loc.timeZone} />}
      {tab === 'dates' && <Dates locationId={pick.locationId} tz={pick.loc.timeZone} />}
      {tab === 'production' && <Production locationId={pick.locationId} tz={pick.loc.timeZone} />}
      {tab === 'packages' && <Packages />}
    </>
  );
}

function Pipeline({ locationId, tz }: { locationId: string; tz: string }) {
  const t = useFx();
  const locale = useLocale();
  const res = useFoods((api) => api.enquiries({ locationId }), [locationId]);
  const [open, setOpen] = useState<CateringEnquiry | null>(null);
  return (
    <>
      <Async res={res} loading={<LoadingBlock variant="calendar" />}>
        {(list) => (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {STAGES.map((st) => {
              const col = list.filter((e) => e.status === st);
              return (
                <section key={st} aria-label={t(`status.${st}`)} className="flex flex-col gap-2 rounded-xl bg-surface p-3">
                  <h2 className="flex items-center justify-between text-sm font-bold">{t(`status.${st}`)}<span className="rounded-full bg-canvas px-2 py-0.5 text-xs">{col.length}</span></h2>
                  {col.map((e) => (
                    <button key={e.id} type="button" onClick={() => setOpen(e)} className="flex flex-col gap-1 rounded-lg bg-canvas p-3 text-left text-sm hover:ring-2 hover:ring-ink">
                      <span className="font-bold">{e.reference} · {e.contact.name}</span>
                      <span className="text-xs text-stone">{fmtYmd(e.eventDate, locale)} {e.eventTime ?? ''} · {t('catering.guests', { n: e.guests })}</span>
                      {e.packageName && <span className="text-xs">{e.packageName}</span>}
                      {e.quote && <span className="text-xs font-semibold"><Money1 m={e.quote.total} /></span>}
                    </button>
                  ))}
                  {!col.length && <p className="text-xs text-stone">{t('common.none')}</p>}
                </section>
              );
            })}
          </div>
        )}
      </Async>
      {res.data && res.data.some((e) => ['declined', 'cancelled', 'completed', 'expired'].includes(e.status)) && (
        <Section title={t('catering.closed')}>
          <ul className="flex flex-wrap gap-2 text-sm">{res.data.filter((e) => ['declined', 'cancelled', 'completed', 'expired'].includes(e.status)).map((e) => <li key={e.id}><button type="button" onClick={() => setOpen(e)} className="flex items-center gap-2 rounded-full bg-canvas px-3 py-1">{e.reference}<StatusBadge status={e.status} /></button></li>)}</ul>
        </Section>
      )}
      {open && <EnquiryDrawer id={open.id} tz={tz} onClose={() => setOpen(null)} onChanged={res.reload} />}
    </>
  );
}

function EnquiryDrawer({ id, tz, onClose, onChanged }: { id: string; tz: string; onClose: () => void; onChanged: () => void }) {
  const t = useFx();
  const locale = useLocale();
  const app = useApp();
  const res = useFoods((api) => api.enquiry(id), [id]);
  const quote = useFoodsMutation((api, body: Parameters<typeof api.quote>[1]) => api.quote(id, body));
  const status = useFoodsMutation((api, to: 'confirmed' | 'completed' | 'declined' | 'cancelled', note?: string) => api.enquiryStatus(id, to, note));
  const [extra, setExtra] = useState({ description: '', qty: '1', price: '' });
  const [deposit, setDeposit] = useState('25');
  const [days, setDays] = useState('7');
  const [delivery, setDelivery] = useState('');
  const canWrite = app.can('operations.write');
  const done = (e?: unknown) => { if (e) { res.reload(); onChanged(); } };
  return (
    <Drawer open onClose={onClose} title={res.data?.reference ?? '…'} kicker={t('catering.enquiry')}>
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(e) => (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={e.status} />{e.packageName && <Badge tone="neutral" icon="gift">{e.packageName}</Badge>}</div>
            <dl className="grid grid-cols-2 gap-2">
              <dt className="text-stone">{t('catering.event')}</dt><dd>{fmtYmd(e.eventDate, locale)} {e.eventTime ?? ''}</dd>
              <dt className="text-stone">{t('catering.guestsLabel')}</dt><dd>{e.guests}</dd>
              <dt className="text-stone">{t('catering.fulfilment')}</dt><dd>{t(`catering.fulfil.${e.fulfilment}`)}</dd>
              <dt className="text-stone">{t('catering.contact')}</dt><dd>{e.contact.name}{e.contact.email ? ` · ${e.contact.email}` : ''}</dd>
            </dl>
            {e.notes && <p className="rounded-md bg-canvas p-2">{e.notes}</p>}
            {e.dietaryNotes && <Banner tone="warning" title={t('catering.dietaryNotes')}>{e.dietaryNotes} — {t('catering.dietaryNotesHint')}</Banner>}
            {e.quote && (
              <Section title={t('catering.quoteV', { v: e.quote.version })} className="bg-canvas">
                <ul className="flex flex-col gap-1">{e.quote.lines.map((l, i) => <li key={i} className="flex justify-between gap-2"><span>{l.quantity} × {l.description}</span><Money1 m={l.total} /></li>)}</ul>
                <dl className="mt-2 grid grid-cols-2 gap-1 border-t border-line-soft pt-2">
                  <dt>{t('catering.subtotal')}</dt><dd className="text-right"><Money1 m={e.quote.subtotal} /></dd>
                  {e.quote.serviceCharge && <><dt>{t('catering.serviceCharge')}</dt><dd className="text-right"><Money1 m={e.quote.serviceCharge} /></dd></>}
                  {e.quote.deliveryFee && <><dt>{t('catering.deliveryFee')}</dt><dd className="text-right"><Money1 m={e.quote.deliveryFee} /></dd></>}
                  <dt>{t('catering.tax')}</dt><dd className="text-right">{e.quote.tax ? <Money1 m={e.quote.tax} /> : t('catering.noTax')}</dd>
                  <dt className="font-bold">{t('catering.total')}</dt><dd className="text-right font-bold"><Money1 m={e.quote.total} /></dd>
                  <dt>{t('catering.deposit')}</dt><dd className="text-right"><Money1 m={e.quote.deposit} /></dd>
                </dl>
                <p className="mt-1 text-xs text-stone">{t('catering.validUntil', { when: fmtDateTime(e.quote.validUntil, tz, locale) })}</p>
              </Section>
            )}
            {canWrite && ['new', 'quoted', 'expired'].includes(e.status) && (
              <Section title={e.quote ? t('catering.revise') : t('catering.buildQuote')}>
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2"><Labeled label={t('catering.extraLine')}><input value={extra.description} onChange={(x) => setExtra({ ...extra, description: x.target.value })} placeholder={t('catering.extraPlaceholder')} className={inputCls} /></Labeled></div>
                  <Labeled label={t('catering.qty')}><input inputMode="numeric" value={extra.qty} onChange={(x) => setExtra({ ...extra, qty: x.target.value })} className={inputCls} /></Labeled>
                  <Labeled label={t('catering.unitPrice')}><input inputMode="decimal" value={extra.price} onChange={(x) => setExtra({ ...extra, price: x.target.value })} className={inputCls} /></Labeled>
                  <Labeled label={t('catering.deliveryFee')}><input inputMode="decimal" value={delivery} onChange={(x) => setDelivery(x.target.value)} className={inputCls} /></Labeled>
                  <Labeled label={t('catering.depositPct')}><input inputMode="numeric" value={deposit} onChange={(x) => setDeposit(x.target.value)} className={inputCls} /></Labeled>
                  <Labeled label={t('catering.validDays')}><input inputMode="numeric" value={days} onChange={(x) => setDays(x.target.value)} className={inputCls} /></Labeled>
                </div>
                <Button className="mt-3" icon="send" loading={quote.pending} onClick={async () => done(await quote.run({
                  fromPackage: !!e.packageId, lines: extra.description && extra.price ? [{ description: extra.description, quantity: Number(extra.qty) || 1, unitPriceMinor: toMinor(extra.price) }] : [],
                  depositBps: Math.round(Number(deposit || 0) * 100), validDays: Number(days) || 7, ...(delivery ? { deliveryFeeMinor: toMinor(delivery) } : {}),
                }))}>{t('catering.sendQuote')}</Button>
                <p className="mt-1 text-xs text-stone">{t('catering.quoteHint')}</p>
              </Section>
            )}
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                {['deposit_paid', 'accepted'].includes(e.status) && <Button icon="check" loading={status.pending} onClick={async () => done(await status.run('confirmed'))}>{t('catering.confirm')}</Button>}
                {['confirmed', 'deposit_paid'].includes(e.status) && <Button variant="secondary" loading={status.pending} onClick={async () => done(await status.run('completed'))}>{t('catering.complete')}</Button>}
                {['new', 'quoted'].includes(e.status) && <Button variant="ghost" onClick={async () => { const n = window.prompt(t('catering.reason')); if (n) done(await status.run('declined', n)); }}>{t('catering.decline')}</Button>}
                {STAGES.includes(e.status) && <Button variant="ghost" onClick={async () => { const n = window.prompt(t('catering.reason')); if (n) done(await status.run('cancelled', n)); }}>{t('catering.cancel')}</Button>}
              </div>
            )}
            <ErrorLine error={quote.error ?? status.error} />
            <ol className="flex flex-col gap-1 border-t border-line-soft pt-2 text-xs text-stone">{e.statusHistory.map((h, i) => <li key={i}>{fmtDateTime(h.at, tz, locale)} — {t(`status.${h.to}`)}{h.note ? ` (${h.note})` : ''}</li>)}</ol>
          </div>
        )}
      </Async>
    </Drawer>
  );
}

function Dates({ locationId, tz }: { locationId: string; tz: string }) {
  const t = useFx();
  const locale = useLocale();
  const app = useApp();
  const res = useFoods((api) => api.productionDates(locationId), [locationId]);
  const create = useFoodsMutation((api, body: Parameters<typeof api.createProductionDate>[1]) => api.createProductionDate(locationId, body));
  const update = useFoodsMutation((api, id: string, s: 'open' | 'closed') => api.updateProductionDate(id, { status: s }));
  const [form, setForm] = useState({ date: '', capacity: '20', days: '2', time: '18:00', windows: '10:00-12:00, 14:00-17:00' });
  return (
    <Section title={t('catering.tabDates')}>
      <p className="mb-2 text-sm text-stone">{t('catering.datesBody')}</p>
      <Async res={res} loading={<LoadingBlock variant="table" rows={2} />}>
        {(d) => (
          <ul className="divide-y divide-line-soft">
            {d.items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                <strong className="min-w-40">{fmtYmd(x.date, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
                <StatusBadge status={x.cutoffPassed ? 'closed' : x.status} label={x.cutoffPassed ? t('catering.cutoffPassed') : undefined} />
                <span className="text-xs text-stone">{t('catering.cutoff', { when: fmtDateTime(x.cutoffAt, tz, locale) })} · {x.collectionWindows.join(', ')}</span>
                <span className="ml-auto text-xs font-bold">{t('catering.booked', { n: x.booked, cap: x.capacity })}</span>
                {app.can('operations.write') && <Button size="sm" variant="ghost" onClick={async () => { await update.run(x.id, x.status === 'open' ? 'closed' : 'open'); res.reload(); }}>{x.status === 'open' ? t('catering.closeDate') : t('catering.reopen')}</Button>}
              </li>
            ))}
            {!d.items.length && <li className="py-2 text-sm text-stone">{t('catering.noDates')}</li>}
          </ul>
        )}
      </Async>
      {app.can('operations.write') && (
        <form className="mt-3 grid gap-2 md:grid-cols-5" onSubmit={async (e) => { e.preventDefault(); if (await create.run({ date: form.date, capacity: Number(form.capacity), cutoffDaysBefore: Number(form.days), cutoffTime: form.time, collectionWindows: form.windows.split(',').map((w) => w.trim()).filter(Boolean) })) res.reload(); }}>
          <Labeled label={t('catering.date')}><input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label={t('catering.capacity')}><input inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label={t('catering.cutoffDays')}><input inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label={t('catering.cutoffTime')}><input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label={t('catering.windows')}><input value={form.windows} onChange={(e) => setForm({ ...form, windows: e.target.value })} className={inputCls} /></Labeled>
          <div><Button type="submit" icon="plus" loading={create.pending}>{t('catering.openDate')}</Button></div>
        </form>
      )}
      <ErrorLine error={create.error ?? update.error} />
    </Section>
  );
}

function Production({ locationId, tz }: { locationId: string; tz: string }) {
  const t = useFx();
  const locale = useLocale();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [date, setDate] = useState(today);
  const res = useFoods((api) => api.production(locationId, date), [locationId, date]);
  const ai = useFoodsMutation((api) => api.aiProductionSummary(locationId, date));
  const [brief, setBrief] = useState<string | null>(null);
  return (
    <Section title={t('catering.tabProduction')} aside={
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" aria-label={t('catering.date')} value={date} onChange={(e) => { setDate(e.target.value); setBrief(null); }} className={cx(inputCls, 'w-44')} />
        <Button size="sm" variant="secondary" icon="marina" loading={ai.pending} onClick={async () => setBrief((await ai.run())?.summary ?? null)}>{t('catering.aiBrief')}</Button>
        <Button size="sm" variant="ghost" icon="download" onClick={() => window.print()}>{t('catering.print')}</Button>
      </div>
    }>
      {ai.error && <Banner tone="neutral" title={t('catering.aiUnavailable')}>{ai.error.message}</Banner>}
      {brief && <Banner tone="info" icon="marina" title={t('catering.aiBriefTitle')}>{brief}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={3} />}>
        {(p: ProductionSummary) => (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-stone">{t('catering.prodCounts', { orders: p.counts.orders, events: p.counts.cateringEvents, guests: p.counts.guests, boxes: p.counts.mealPlanBoxes })} · {fmtYmd(p.date, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            {p.stations.length === 0 && <p className="text-sm text-stone">{t('catering.nothingToProduce')}</p>}
            <div className="grid gap-3 md:grid-cols-3">
              {p.stations.map((s) => (
                <article key={s.key} className="rounded-lg bg-canvas p-3">
                  <h3 className="font-bold">{s.name}</h3>
                  <ul className="mt-1 flex flex-col gap-1 text-sm">{s.items.map((i) => <li key={i.name}><strong className="tabular">{i.quantity}×</strong> {i.name}{i.modifiers.length > 0 && <span className="block pl-6 text-xs text-stone">{i.modifiers.map((m) => `${m.quantity}× ${m.name}`).join(' · ')}</span>}</li>)}</ul>
                </article>
              ))}
            </div>
            {p.catering.length > 0 && <ul className="text-sm">{p.catering.map((c) => <li key={c.id}>{c.reference} · {c.eventTime ?? ''} · {t('catering.guests', { n: c.guests })} · {t(`catering.fulfil.${c.fulfilment}`)}{c.dietaryNotes ? ` · ${c.dietaryNotes}` : ''}</li>)}</ul>}
          </div>
        )}
      </Async>
    </Section>
  );
}

function Packages() {
  const t = useFx();
  const app = useApp();
  const res = useFoods((api) => api.packages(), [app.org.id]);
  return (
    <Section title={t('catering.tabPackages')}>
      <Async res={res} loading={<LoadingBlock variant="cards" rows={2} />}>
        {(list) => (
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((p) => (
              <article key={p.id} className="flex flex-col gap-1 rounded-lg bg-canvas p-4 text-sm">
                <div className="flex items-center justify-between"><h3 className="font-bold">{p.name}</h3>{!p.active && <StatusBadge status="closed" />}</div>
                <p className="text-stone">{p.description}</p>
                <p><MoneyList values={Object.entries(p.pricesPerGuest).map(([currency, amount]) => ({ amount, currency }) as never)} /> {t('catering.perGuest')}</p>
                <p className="text-xs">{t('catering.minGuests', { n: p.minGuests })} · {t('catering.leadDays', { n: p.leadDays })}</p>
                <p className="text-xs text-stone">{p.includes.join(' · ')}</p>
                <p className="text-xs">{p.allergensDeclared || p.allergens.length ? t('catering.allergens', { list: p.allergens.join(', ') || t('avail.noneDeclared') }) : t('avail.allergensNotProvided')}</p>
              </article>
            ))}
          </div>
        )}
      </Async>
    </Section>
  );
}
