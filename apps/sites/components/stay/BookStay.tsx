'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { addDays, calendarLabel, money } from '@/lib/format';
import type { AvailabilityItem, Policy, RateChoice } from '@/lib/stay';
import { CardPayment, Checkbox, EMAIL_RE, ErrorSummary, Field, type PaymentInfo } from '@/components/forms';

type Booked = { reservation: { id: string; code: string; status: string; total: { amount: number; currency: string }; depositRequired: { amount: number; currency: string } }; manageToken: string; payment: PaymentInfo | null };
type Err = { message: string; fields?: Record<string, string> } | null;

/** One line describing the cancellation terms, from the policy the business configured. */
export function usePolicyText() {
  const t = useTranslations('stay');
  return (p: Policy) => {
    if (p.nonRefundable) return t('policy.nonRefundable');
    if (p.freeUntilHours === null) return t('policy.noFreeWindow');
    const fee = p.lateFee.type === 'first_night' ? t('policy.feeFirstNight') : p.lateFee.type === 'full' ? t('policy.feeFull') : p.lateFee.type === 'percent' ? t('policy.feePercent', { percent: (p.lateFee.percentBps ?? 0) / 100 }) : p.lateFee.type === 'none' ? t('policy.feeNone') : t('policy.feeFixed');
    return t('policy.freeUntil', { hours: p.freeUntilHours, fee });
  };
}

/**
 * Hotel booking: dates & guests → room type and rate (total incl. configured taxes, deposit, cancellation terms) →
 * guest details and message consent → hold → deposit with the card form → confirmation & manage link.
 */
export function BookStay(props: { locationId: string; today: string; currency: string; checkInTime: string; manageBase: string; brandName: string }) {
  const t = useTranslations('stay');
  const locale = useLocale();
  const policyText = usePolicyText();
  const [q, setQ] = useState({ arrival: props.today, departure: addDays(props.today, 2), adults: 2, children: 0, rooms: 1 });
  const [results, setResults] = useState<AvailabilityItem[] | null>(null);
  const [searched, setSearched] = useState<typeof q | null>(null);
  const [pick, setPick] = useState<{ type: AvailabilityItem; rate: RateChoice } | null>(null);
  const [guest, setGuest] = useState({ name: '', email: '', phone: '', arrivalTime: '', requests: '' });
  const [consent, setConsent] = useState({ email: false, sms: false, terms: false });
  const [error, setError] = useState<Err>(null);
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<Booked | null>(null);

  const manageUrl = (b: Booked) => `${props.manageBase}/stay/${b.reservation.id}?token=${encodeURIComponent(b.manageToken)}`;

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPick(null);
    if (q.departure <= q.arrival) { setError({ message: t('errors.dates') }); return; }
    setBusy(true);
    const r = await call<{ items: AvailabilityItem[]; message?: string }>('GET', `/public/hospitality/properties/${props.locationId}/availability?arrival=${q.arrival}&departure=${q.departure}&adults=${q.adults}&children=${q.children}&rooms=${q.rooms}`);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setResults(r.data.items);
    setSearched(q);
  }

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (!pick || !searched) return;
    const fields: Record<string, string> = {};
    if (!guest.name.trim()) fields.name = t('errors.name');
    if (!EMAIL_RE.test(guest.email)) fields.email = t('errors.email');
    if (!consent.terms) fields.terms = t('errors.terms');
    if (Object.keys(fields).length) { setError({ message: t('errors.check'), fields }); return; }
    setError(null);
    setBusy(true);
    const dorm = pick.type.kind === 'dorm';
    const units = dorm ? searched.adults + searched.children : searched.rooms;
    const per = { adults: dorm ? 1 : Math.ceil(searched.adults / searched.rooms), children: dorm ? 0 : Math.ceil(searched.children / searched.rooms) };
    const r = await call<Booked>('POST', `/public/hospitality/properties/${props.locationId}/reservations`, {
      arrival: searched.arrival, departure: searched.departure, rooms: Array.from({ length: units }, () => ({ roomTypeId: pick.type.roomTypeId, ratePlanId: pick.rate.ratePlanId, ...per })),
      guest: { name: guest.name.trim(), email: guest.email.trim(), ...(guest.phone.trim() ? { phone: guest.phone.trim() } : {}) },
      arrivalTime: guest.arrivalTime || null, specialRequests: guest.requests.trim() || null, consent: { email: consent.email, sms: consent.sms }, expectedTotalMinor: pick.rate.total?.amount,
    });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    if (!r.data.payment) { window.location.assign(manageUrl(r.data)); return; }
    setBooked(r.data);
  }

  if (booked && booked.payment) {
    return (
      <section className="card mt-6 space-y-4 p-6" aria-labelledby="pay-h">
        <h2 id="pay-h" className="text-xl font-extrabold">{t('pay.title')}</h2>
        <p>{t('pay.held', { code: booked.reservation.code })}</p>
        <p className="font-semibold">{t('pay.depositToday', { amount: money(booked.reservation.depositRequired, locale), total: money(booked.reservation.total, locale) })}</p>
        <ErrorSummary message={error?.message ?? null} />
        <CardPayment payment={booked.payment} returnUrl={manageUrl(booked)} label={t('pay.cta', { amount: money(booked.reservation.depositRequired, locale) })} onDone={(r) => (r.ok ? window.location.assign(manageUrl(booked)) : setError({ message: r.message ?? t('pay.failed') }))} />
      </section>
    );
  }

  const nights = searched ? Math.round((Date.parse(searched.departure) - Date.parse(searched.arrival)) / 86_400_000) : 0;
  return (
    <div className="mt-6 space-y-6">
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
      <form onSubmit={search} className="card grid gap-3 p-5 sm:grid-cols-5" aria-label={t('search.label')}>
        <Field label={t('search.arrival')} type="date" min={props.today} required value={q.arrival} onChange={(e) => setQ({ ...q, arrival: e.target.value, departure: e.target.value >= q.departure ? addDays(e.target.value, 1) : q.departure })} />
        <Field label={t('search.departure')} type="date" min={addDays(q.arrival, 1)} required value={q.departure} onChange={(e) => setQ({ ...q, departure: e.target.value })} />
        <Field label={t('search.adults')} type="number" min={1} max={20} value={q.adults} onChange={(e) => setQ({ ...q, adults: Math.max(1, Number(e.target.value)) })} />
        <Field label={t('search.children')} type="number" min={0} max={20} value={q.children} onChange={(e) => setQ({ ...q, children: Math.max(0, Number(e.target.value)) })} />
        <Field label={t('search.rooms')} type="number" min={1} max={9} value={q.rooms} onChange={(e) => setQ({ ...q, rooms: Math.max(1, Number(e.target.value)) })} />
        <div className="sm:col-span-5"><button type="submit" className="btn btn-primary" disabled={busy}><Icon name="search" size={18} />{t('search.cta')}</button></div>
      </form>

      {results && searched && (
        <section aria-labelledby="rooms-h" className="space-y-3">
          <h2 id="rooms-h" className="text-xl font-extrabold">{t('results.title', { nights, from: calendarLabel(searched.arrival, locale), to: calendarLabel(searched.departure, locale) })}</h2>
          {results.filter((r) => r.rates.some((x) => x.ok)).length === 0 && <p className="card p-5">{t('results.none')}</p>}
          {results.map((rt) => (
            <article key={rt.roomTypeId} className="card overflow-hidden" data-testid="room-type">
              <div className="grid gap-4 p-5 sm:grid-cols-[200px_1fr]">
                {rt.photos[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={rt.photos[0].url} alt={rt.photos[0].alt ?? ''} className="aspect-[4/3] w-full rounded-xl object-cover" />
                ) : <div className="grid aspect-[4/3] place-items-center rounded-xl bg-brand-tint" aria-hidden><Icon name="bed" size={40} /></div>}
                <div>
                  <h3 className="text-lg font-bold">{rt.name}</h3>
                  <p className="text-sm text-graphite">
                    {rt.kind === 'dorm' ? t('results.dormBed') : t('results.sleeps', { count: rt.maxOccupancy })}{rt.sizeSqm ? ` · ${t('results.size', { size: rt.sizeSqm })}` : ''}
                    {rt.available < rt.unitsNeeded ? ` · ${t('results.soldOut')}` : rt.available <= 3 ? ` · ${t('results.left', { count: rt.available })}` : ''}
                  </p>
                  {rt.amenities.length > 0 && <p className="mt-1 text-sm text-graphite">{rt.amenities.join(' · ')}</p>}
                  <ul className="mt-3 divide-y divide-line">
                    {rt.rates.map((rate) => (
                      <li key={rate.ratePlanId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                        <div className="min-w-0">
                          <p className="font-semibold">{rate.name}{rate.includesBreakfast && <span className="ms-2 rounded-full bg-brand-tint px-2 py-0.5 text-xs">{t('results.breakfast')}</span>}</p>
                          <p className="text-xs text-graphite">{policyText(rate.policy)}</p>
                          {rate.ok && rate.deposit && <p className="text-xs text-graphite">{rate.deposit.amount > 0 ? t('results.deposit', { amount: money(rate.deposit, locale) }) : t('results.noDeposit')}</p>}
                          {!rate.ok && <p className="text-xs font-semibold text-graphite">{t(`reason.${rate.reason}` as 'reason.min_stay')}</p>}
                        </div>
                        {rate.ok && rate.total && (
                          <div className="text-end">
                            <p className="text-lg font-extrabold tabular-nums">{money(rate.total, locale)}</p>
                            <p className="text-xs text-graphite">{rate.taxes && rate.taxes.some((x) => !x.inclusive) ? t('results.inclTaxes') : rate.taxes?.length ? t('results.taxIncluded') : t('results.noTaxes')}</p>
                            <button type="button" className="btn btn-primary mt-1" disabled={rt.available < rt.unitsNeeded} onClick={() => { setPick({ type: rt, rate }); setTimeout(() => document.getElementById('guest-h')?.scrollIntoView({ behavior: 'smooth' }), 50); }} aria-label={t('results.selectAria', { room: rt.name, rate: rate.name })}>{t('results.select')}</button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {pick && searched && pick.rate.total && (
        <form onSubmit={book} className="card space-y-4 p-6" aria-labelledby="guest-h" noValidate>
          <h2 id="guest-h" className="text-xl font-extrabold">{t('guest.title')}</h2>
          <div className="rounded-2xl bg-canvas p-4 text-sm">
            <p className="font-bold">{pick.type.name} · {pick.rate.name}</p>
            <p>{calendarLabel(searched.arrival, locale)} → {calendarLabel(searched.departure, locale)} · {t('guest.party', { adults: searched.adults, children: searched.children })}</p>
            {pick.rate.nights && <p className="mt-1 text-graphite">{t('guest.nightly', { from: money({ amount: Math.min(...pick.rate.nights.map((n) => n.amountMinor)), currency: props.currency }, locale) })}</p>}
            {pick.rate.taxes?.map((x) => <p key={x.name} className="text-graphite">{x.name}: {money({ amount: x.amountMinor * (pick.rate.total!.amount / (pick.rate.perUnit?.total || 1)), currency: props.currency }, locale)}{x.inclusive ? ` (${t('results.taxIncluded')})` : ''}</p>)}
            <p className="mt-1 text-base font-extrabold">{t('guest.total', { amount: money(pick.rate.total, locale) })}</p>
            <p>{pick.rate.deposit && pick.rate.deposit.amount > 0 ? t('guest.depositNow', { amount: money(pick.rate.deposit, locale) }) : t('guest.payAtProperty')}</p>
            <p className="text-graphite">{policyText(pick.rate.policy)} · {t('guest.checkIn', { time: props.checkInTime })}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('guest.name')} autoComplete="name" required value={guest.name} error={error?.fields?.name} onChange={(e) => setGuest({ ...guest, name: e.target.value })} />
            <Field label={t('guest.email')} type="email" autoComplete="email" required value={guest.email} error={error?.fields?.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
            <Field label={t('guest.phone')} type="tel" autoComplete="tel" optional value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
            <Field label={t('guest.arrivalTime')} type="time" optional value={guest.arrivalTime} onChange={(e) => setGuest({ ...guest, arrivalTime: e.target.value })} />
          </div>
          <Field label={t('guest.requests')} optional value={guest.requests} onChange={(e) => setGuest({ ...guest, requests: e.target.value })} />
          <Checkbox label={t('guest.consentEmail')} checked={consent.email} onChange={(v) => setConsent({ ...consent, email: v })} />
          {guest.phone.trim() && <Checkbox label={t('guest.consentSms')} checked={consent.sms} onChange={(v) => setConsent({ ...consent, sms: v })} />}
          <Checkbox label={t('guest.terms', { business: props.brandName })} checked={consent.terms} error={error?.fields?.terms} onChange={(v) => setConsent({ ...consent, terms: v })} />
          <p className="text-xs text-graphite">{t('guest.privacy')}</p>
          <button type="submit" className="btn btn-primary" disabled={busy}>{pick.rate.deposit && pick.rate.deposit.amount > 0 ? t('guest.holdCta') : t('guest.bookCta')}</button>
        </form>
      )}
    </div>
  );
}
