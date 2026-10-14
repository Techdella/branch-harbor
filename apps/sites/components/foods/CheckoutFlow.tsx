'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { calendarLabel, dateTime, localDate, money, time, zone } from '@/lib/format';
import type { FoodOrder, Slot } from '@/lib/foods';
import type { CheckoutQuote, DeliveryCheck, MenuItemX, MenuX, ProductionDateX } from '@/lib/foods-ext';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, PayButton, type PaymentInfo } from '@/components/forms';

type Channel = 'pickup' | 'delivery' | 'dine_in' | 'preorder';
type Line = { key: string; item: MenuItemX; modifierIds: string[]; quantity: number };
type Step = 'when' | 'menu' | 'review' | 'details' | 'pay';
type Addr = { line1: string; city: string; postalCode: string; instructions: string };

export interface CheckoutProps {
  locationId: string; locationName: string; brandName: string; timeZone: string; statusBase: string;
  channels: Channel[]; initialChannel?: Channel; tableCode?: string; tableLabel?: string; payments: boolean; tabStorageKey?: string;
}

/**
 * Pickup, delivery, dine-in (QR) and preorder ordering: choose the time (or date, or the table) first, browse the
 * menu as it will be at that time (day-parts in the location's time zone), filter by business-declared allergens,
 * configure options, review a server quote (service charge, delivery fee, configured tax, optional tip), then pay or
 * add to the table's tab. Every check is repeated on the server at confirmation.
 */
export function CheckoutFlow(p: CheckoutProps) {
  const t = useTranslations('foodsite');
  const to = useTranslations('order');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  const tz = p.timeZone;
  const [channel, setChannel] = useState<Channel>(p.initialChannel ?? p.channels[0] ?? 'pickup');
  const [step, setStep] = useState<Step>(channel === 'dine_in' ? 'menu' : 'when');
  const [slots, setSlots] = useState<Slot[]>([]);
  const [dates, setDates] = useState<ProductionDateX[]>([]);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [dateId, setDateId] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState<string | null>(null);
  const [addr, setAddr] = useState<Addr>({ line1: '', city: '', postalCode: '', instructions: '' });
  const [check, setCheck] = useState<DeliveryCheck | null>(null);
  const [menu, setMenu] = useState<MenuX | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [open, setOpen] = useState<MenuItemX | null>(null);
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [tipBps, setTipBps] = useState<number | null>(null);
  const [customTip, setCustomTip] = useState('');
  const [hide, setHide] = useState<string[]>([]);
  const [diet, setDiet] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState({ name: '', email: '', phone: '', notes: '', consent: false });
  const [payMode, setPayMode] = useState<'pay_now' | 'tab'>(p.payments ? 'pay_now' : 'tab');
  const [placed, setPlaced] = useState<{ order: FoodOrder; manageToken: string; payment: PaymentInfo | null } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step]);

  const slot = slots.find((s) => s.id === slotId) ?? null;
  const pDate = dates.find((d) => d.id === dateId) ?? null;
  const at = channel === 'pickup' || channel === 'delivery' ? slot?.startsAt ?? null : null;
  const currency = menu?.location.currency ?? '';
  const fmt = (amount: number) => money({ amount, currency } as never, locale);

  // Load times for the chosen channel.
  useEffect(() => {
    setError(null);
    if (channel === 'pickup') void call<{ items: Slot[] }>('GET', `/public/foods/${p.locationId}/pickup-slots`).then((r) => r.ok && setSlots(r.data.items));
    if (channel === 'delivery') void call<{ items: Slot[] }>('GET', `/public/foods/${p.locationId}/delivery-slots`).then((r) => r.ok && setSlots(r.data.items));
    if (channel === 'preorder') void call<{ items: ProductionDateX[] }>('GET', `/public/foods/${p.locationId}/preorder-dates`).then((r) => r.ok && setDates(r.data.items));
    if (channel === 'dine_in') void loadMenu(null);
    setSlotId(null); setDateId(null); setCart([]); setQuote(null);
    setStep(channel === 'dine_in' ? 'menu' : 'when');
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMenu(whenIso: string | null, kind: 'standard' | 'preorder' = 'standard', menuId?: string | null) {
    const q = new URLSearchParams({ lang: locale, kind });
    if (whenIso) q.set('at', whenIso);
    if (menuId) q.set('menuId', menuId);
    const r = await call<MenuX>('GET', `/public/foods/${p.locationId}/menu?${q}`);
    if (r.ok) setMenu(r.data); else setError({ message: r.error.message });
  }

  const days = useMemo(() => [...new Set(slots.map((s) => localDate(s.startsAt, tz)))], [slots, tz]);
  const unitPrice = (l: Pick<Line, 'item' | 'modifierIds'>) => (l.item.price?.amount ?? 0) + l.item.modifierGroups.flatMap((g) => g.modifiers).filter((m) => l.modifierIds.includes(m.id)).reduce((a, m) => a + (m.price?.amount ?? 0), 0);
  const count = cart.reduce((a, l) => a + l.quantity, 0);
  const estimate = cart.reduce((a, l) => a + unitPrice(l) * l.quantity, 0);
  const allergenKeys = useMemo(() => [...new Map((menu?.categories ?? []).flatMap((c) => c.items.flatMap((i) => i.allergenInfo?.items ?? [])).map((a) => [a.key, a.label])).entries()], [menu]);
  const dietKeys = useMemo(() => [...new Set((menu?.categories ?? []).flatMap((c) => c.items.flatMap((i) => i.dietary)))], [menu]);
  const visible = (i: MenuItemX) => {
    if (diet.length && !diet.every((d) => i.dietary.includes(d))) return false;
    if (!hide.length) return true;
    if (i.allergenInfo?.status !== 'declared') return false;
    return !i.allergenInfo.items.some((a) => hide.includes(a.key));
  };
  const hiddenUnknown = hide.length ? (menu?.categories ?? []).flatMap((c) => c.items).filter((i) => i.allergenInfo?.status !== 'declared').length : 0;
  const tipMinor = () => {
    if (!quote?.tips) return 0;
    if (tipBps === -1) { const n = Math.round(Number(customTip.replace(',', '.')) * 100); return Number.isFinite(n) && n > 0 ? n : 0; }
    return tipBps ? Math.round((quote.subtotal.amount * tipBps) / 10_000) : 0;
  };
  const baseBody = () => ({
    channel, lines: cart.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity, modifierIds: l.modifierIds })), lang: locale,
    ...(channel === 'pickup' ? { pickupSlotId: slotId } : {}),
    ...(channel === 'delivery' ? { deliverySlotId: slotId, address: { line1: addr.line1, city: addr.city, postalCode: addr.postalCode, ...(addr.instructions ? { instructions: addr.instructions } : {}) } } : {}),
    ...(channel === 'dine_in' ? { tableCode: p.tableCode } : {}),
    ...(channel === 'preorder' ? { productionDateId: dateId, ...(windowStart ? { collectionWindow: windowStart } : {}) } : {}),
  });

  async function review(withTip = tipMinor()) {
    setBusy(true); setError(null);
    const r = await call<CheckoutQuote>('POST', `/public/foods/${p.locationId}/checkout/quote`, { ...baseBody(), ...(withTip ? { tipMinor: withTip } : {}) });
    setBusy(false);
    if (!r.ok) return handleError(r.error);
    setQuote(r.data);
    setStep('review');
  }

  function handleError(e: { code: string; message: string; fields?: Record<string, string>; details?: Record<string, unknown> }) {
    if (e.code === 'slot_full' || e.code === 'slot_closed' || e.code === 'preorder_closed' || e.code === 'date_full') { setStep('when'); setSlotId(null); setError({ message: e.code === 'slot_full' ? to('slotTaken') : e.message }); return; }
    if (e.code === 'location_closed') { setError({ message: t('kitchenClosed') }); return; }
    if (e.code === 'menu_check_failed') { setStep('menu'); setError({ message: e.message, fields: e.fields }); void loadMenu(at, channel === 'preorder' ? 'preorder' : 'standard', pDate?.menuId); return; }
    if (e.code === 'below_minimum') { setStep('menu'); setError({ message: e.message }); return; }
    if (e.code === 'outside_delivery_area') { setStep('when'); setError({ message: e.message }); return; }
    if (e.code === 'tab_open') { setPayMode('pay_now'); setError({ message: e.message }); return; }
    setError({ message: e.message, fields: e.fields ? Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k.replace(/^contact\./, ''), v])) : undefined });
  }

  async function place(e: React.FormEvent) {
    e.preventDefault();
    if (!quote) return;
    const fe: Record<string, string> = {};
    if (!contact.name.trim()) fe.name = tc('required', { field: tb('name') });
    if (!EMAIL_RE.test(contact.email)) fe.email = tc('invalidEmail');
    if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
    setBusy(true); setError(null);
    const tab = channel === 'dine_in' && payMode === 'tab';
    let tabToken: string | undefined;
    try { tabToken = p.tabStorageKey ? window.localStorage.getItem(p.tabStorageKey) ?? undefined : undefined; } catch { /* storage unavailable */ }
    const r = await call<{ order: FoodOrder; manageToken: string; payment: PaymentInfo | null; tabToken: string | null }>('POST', `/public/foods/${p.locationId}/checkout`, {
      ...baseBody(), contact: { name: contact.name.trim(), email: contact.email.trim(), ...(contact.phone.trim() ? { phone: contact.phone.trim() } : {}), marketingConsent: contact.consent },
      ...(contact.notes.trim() ? { notes: contact.notes.trim() } : {}), ...(quote.tip ? { tipMinor: quote.tip.amount } : {}), expectedTotalMinor: quote.total.amount,
      ...(channel === 'dine_in' ? { payMode, ...(tab && tabToken ? { tabToken } : {}) } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === 'price_changed') { await review(); setError({ message: to('priceChanged') }); return; }
      return handleError(r.error);
    }
    if (r.data.tabToken && p.tabStorageKey) { try { window.localStorage.setItem(p.tabStorageKey, r.data.tabToken); window.localStorage.setItem(`${p.tabStorageKey}:id`, String((r.data.order as unknown as { fulfilment: { tabId?: string } }).fulfilment.tabId ?? '')); } catch { /* ignore */ } }
    if (!r.data.payment) { window.location.assign(`${p.statusBase}/${r.data.order.id}?token=${encodeURIComponent(r.data.manageToken)}`); return; }
    setPlaced(r.data); setStep('pay');
  }

  const steps: Array<[Step, string]> = [...(channel === 'dine_in' ? [] : [['when', channel === 'delivery' ? t('stepDelivery') : channel === 'preorder' ? t('stepDate') : to('stepTime')] as [Step, string]]), ['menu', to('stepMenu')], ['review', to('stepReview')], ['details', to('stepDetails')]];
  const stepIdx = Math.max(0, steps.findIndex(([k]) => k === (step === 'pay' ? 'details' : step)));

  return (
    <div className="mt-6">
      {p.channels.length > 1 && (
        <div role="radiogroup" aria-label={t('howToOrder')} className="mb-5 flex flex-wrap gap-2">
          {p.channels.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={channel === c} onClick={() => setChannel(c)} className={`flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-bold ${channel === c ? 'border-ink bg-ink text-white' : 'border-line bg-white'}`}>
              <Icon name={c === 'delivery' ? 'truck' : c === 'preorder' ? 'calendar' : c === 'dine_in' ? 'utensils' : 'bag'} size={16} />{t(`channel.${c}`)}
            </button>
          ))}
        </div>
      )}
      <ol className="mb-6 flex flex-wrap gap-2 text-sm font-semibold" aria-label={to('title')}>
        {steps.map(([k, label], i) => <li key={k} aria-current={i === stepIdx ? 'step' : undefined} className={`rounded-full px-3 py-1 ${i === stepIdx ? 'bg-ink text-white' : i < stepIdx ? 'bg-success-bg text-success' : 'bg-canvas text-graphite'}`}>{i + 1}. {label}</li>)}
      </ol>
      {channel === 'dine_in' && p.tableLabel && <p className="mb-4 flex items-center gap-2 text-sm font-semibold"><Icon name="utensils" size={16} />{t('atTable', { table: p.tableLabel })}</p>}
      {slot && step !== 'when' && channel !== 'dine_in' && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm"><Icon name="clock" size={16} />
          <span className="font-semibold">{(() => { const when = `${calendarLabel(localDate(slot.startsAt, tz), locale)} ${time(slot.startsAt, tz, locale)} ${zone(tz, locale, slot.startsAt)}`; return channel === 'delivery' ? t('deliveryAt', { when }) : to('pickupAt', { when }); })()}</span>
          {step !== 'pay' && <button type="button" className="link font-semibold" onClick={() => setStep('when')}>{to('change')}</button>}
        </p>
      )}
      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />

      {step === 'when' && channel === 'delivery' && (
        <section aria-labelledby="h-addr" className="card mt-4 max-w-xl space-y-3 p-5">
          <h2 id="h-addr" ref={heading} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('whereTo')}</h2>
          <Field label={t('address')} autoComplete="address-line1" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} error={error?.fields?.line1} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('city')} autoComplete="address-level2" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} />
            <Field label={t('postcode')} autoComplete="postal-code" value={addr.postalCode} onChange={(e) => { setAddr({ ...addr, postalCode: e.target.value }); setCheck(null); }} />
          </div>
          <Field label={t('instructions')} optional value={addr.instructions} onChange={(e) => setAddr({ ...addr, instructions: e.target.value })} />
          <button type="button" className="btn btn-secondary" disabled={!addr.postalCode.trim()} onClick={async () => { const r = await call<DeliveryCheck>('GET', `/public/foods/${p.locationId}/delivery/check?postalCode=${encodeURIComponent(addr.postalCode)}`); if (r.ok) setCheck(r.data); }}>{t('checkAddress')}</button>
          {check && (check.deliverable && check.zone ? (
            <p role="status" className="rounded-2xl bg-success-bg p-3 text-sm text-success">{t('weDeliver', { zone: check.zone.name, fee: money(check.zone.fee, locale), min: money(check.zone.minimumOrder, locale) })}{check.zone.freeDeliveryAbove ? ` ${t('freeAbove', { amount: money(check.zone.freeDeliveryAbove, locale) })}` : ''}</p>
          ) : <p role="status" className="rounded-2xl bg-warning-bg p-3 text-sm text-warning">{check.reason}</p>)}
        </section>
      )}

      {step === 'when' && (channel === 'pickup' || (channel === 'delivery' && check?.deliverable && addr.line1 && addr.city)) && (
        <section aria-labelledby="h-time" className="mt-4">
          <h2 id="h-time" ref={channel === 'pickup' ? heading : undefined} tabIndex={-1} className="text-xl font-extrabold outline-none">{channel === 'delivery' ? t('chooseDeliveryTime') : to('chooseTime')}</h2>
          <p className="text-sm text-graphite">{tc('timesIn', { zone: `${zone(tz, locale)} (${tz})` })}</p>
          {!slots.some((s) => s.available) && <p className="card mt-4 p-6">{channel === 'delivery' ? t('noDeliverySlots') : to('noSlots')}</p>}
          {days.map((d) => (
            <fieldset key={d} className="mt-4">
              <legend className="text-sm font-bold">{calendarLabel(d, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</legend>
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {slots.filter((s) => localDate(s.startsAt, tz) === d && new Date(s.cutoffAt) > new Date(Date.now() - 3600_000)).map((s) => (
                  <button key={s.id} type="button" disabled={!s.available} aria-pressed={s.id === slotId} onClick={() => { setSlotId(s.id); setError(null); void loadMenu(s.startsAt); setStep('menu'); }}
                    className={`flex min-h-14 flex-col items-center justify-center rounded-xl border px-1 text-sm font-bold disabled:cursor-not-allowed disabled:bg-canvas disabled:text-stone ${s.id === slotId ? 'border-ink bg-ink text-white' : 'border-line bg-white hover:border-ink'}`}>
                    <span className="tabular">{time(s.startsAt, tz, locale)}</span>
                    <span className="text-xs font-semibold opacity-80">{s.available ? to('slotsLeft', { n: s.remaining }) : s.remaining === 0 ? to('slotFull') : to('slotClosed')}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          ))}
        </section>
      )}

      {step === 'when' && channel === 'preorder' && (
        <section aria-labelledby="h-date" className="mt-4">
          <h2 id="h-date" ref={heading} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('chooseDate')}</h2>
          <p className="text-sm text-graphite">{t('dateFirst')}</p>
          {!dates.length && <p className="card mt-4 p-6">{t('noDates')}</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {dates.map((d) => (
              <div key={d.id} className={`card p-4 ${dateId === d.id ? 'ring-2 ring-ink' : ''}`}>
                <p className="font-bold">{calendarLabel(d.date, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                <p className="text-xs text-graphite">{t('orderBy', { when: dateTime(d.cutoffAt, tz, locale) })} · {t('remaining', { n: d.remaining })}</p>
                {d.note && <p className="mt-1 text-xs">{d.note}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {(d.collectionWindows.length ? d.collectionWindows : ['12:00-12:00']).map((w) => (
                    <button key={w} type="button" disabled={!d.available} onClick={() => { setDateId(d.id); const ws = w.split('-')[0]!; setWindowStart(d.collectionWindows.length ? ws : null); void loadMenu(null, 'preorder', d.menuId); setStep('menu'); }} className="btn btn-secondary h-10 min-h-10">{d.collectionWindows.length ? t('collect', { window: w.replace('-', '–') }) : t('chooseThisDate')}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {step === 'menu' && menu && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <section aria-labelledby="h-menu">
            <h2 id="h-menu" ref={heading} tabIndex={-1} className="text-xl font-extrabold outline-none">{to('stepMenu')}</h2>
            {(allergenKeys.length > 0 || dietKeys.length > 0) && (
              <details className="card mt-3 p-4">
                <summary className="cursor-pointer text-sm font-bold">{t('filters')}{hide.length + diet.length ? ` (${hide.length + diet.length})` : ''}</summary>
                {dietKeys.length > 0 && <fieldset className="mt-3"><legend className="text-xs font-bold uppercase tracking-wider text-graphite">{t('showOnly')}</legend><div className="mt-1 flex flex-wrap gap-2">{dietKeys.map((d) => <label key={d} className="flex min-h-10 items-center gap-2 rounded-full border border-line px-3 text-sm"><input type="checkbox" checked={diet.includes(d)} onChange={(e) => setDiet(e.target.checked ? [...diet, d] : diet.filter((x) => x !== d))} />{d}</label>)}</div></fieldset>}
                {allergenKeys.length > 0 && <fieldset className="mt-3"><legend className="text-xs font-bold uppercase tracking-wider text-graphite">{t('hideContaining')}</legend><div className="mt-1 flex flex-wrap gap-2">{allergenKeys.map(([k, label]) => <label key={k} className="flex min-h-10 items-center gap-2 rounded-full border border-line px-3 text-sm"><input type="checkbox" checked={hide.includes(k)} onChange={(e) => setHide(e.target.checked ? [...hide, k] : hide.filter((x) => x !== k))} />{label}</label>)}</div></fieldset>}
                <p className="mt-3 text-xs text-graphite">{t('filterNote', { brand: p.brandName })}</p>
                {hiddenUnknown > 0 && <p className="mt-1 text-xs font-semibold">{t('hiddenUnknown', { n: hiddenUnknown })}</p>}
              </details>
            )}
            {menu.categories.map((c) => {
              const items = c.items.filter(visible);
              if (!items.length) return null;
              return (
                <div key={c.name} className="mt-5">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-graphite">{c.name}</h3>
                  <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                    {items.map((it) => (
                      <li key={it.id} className="card flex flex-col p-4">
                        <div className="flex items-start justify-between gap-2"><h4 className="font-bold">{it.name}</h4><span className="font-bold tabular">{it.price ? money(it.price, locale) : ''}</span></div>
                        {it.description && <p className="mt-1 text-sm text-graphite">{it.description}</p>}
                        <div className="mt-2 text-xs text-graphite">
                          {it.dietary.map((d) => <span key={d} className="me-1 inline-block rounded-full bg-canvas px-2 py-0.5 font-semibold">{d}</span>)}
                          <span className="block pt-1">{it.allergenInfo?.status === 'declared' ? (it.allergenInfo.items.length ? to('allergens', { list: it.allergenInfo.items.map((a) => a.label).join(', ') }) : t('noAllergensDeclared')) : t('allergensNotProvided')}</span>
                        </div>
                        <div className="mt-auto pt-3">
                          {it.available ? <button type="button" className="btn btn-secondary h-10 min-h-10" onClick={() => setOpen(it)} aria-label={`${to('add')}: ${it.name}`}><Icon name="plus" size={16} />{to('add')}</button>
                            : <span className="text-sm font-semibold text-stone">{it.unavailableCode === 'sold_out' ? to('soldOut') : it.unavailableCode === 'outside_day_part' ? it.unavailableReason : to('unavailable')}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <p className="mt-4 text-xs text-graphite">{to('dietary', { brand: p.brandName })}</p>
          </section>
          <aside aria-labelledby="h-cart" className="lg:sticky lg:top-20 lg:self-start">
            <div className="card p-4">
              <h2 id="h-cart" className="text-lg font-extrabold">{to('cart')} {count > 0 && <span className="text-graphite">({count})</span>}</h2>
              {cart.length === 0 && <p className="mt-2 text-sm text-graphite">{to('emptyCart')}</p>}
              <ul className="mt-2 divide-y divide-line-soft">
                {cart.map((l) => (
                  <li key={l.key} className="py-2 text-sm">
                    <div className="flex justify-between gap-2"><span className="font-semibold">{l.quantity} × {l.item.name}</span><span className="tabular">{fmt(unitPrice(l) * l.quantity)}</span></div>
                    {l.modifierIds.length > 0 && <p className="text-xs text-graphite">{l.item.modifierGroups.flatMap((g) => g.modifiers).filter((m) => l.modifierIds.includes(m.id)).map((m) => m.name).join(', ')}</p>}
                    <button type="button" className="min-h-9 px-1 text-xs underline" aria-label={to('remove', { name: l.item.name })} onClick={() => setCart((cc) => cc.filter((x) => x.key !== l.key))}>{to('removeShort')}</button>
                  </li>
                ))}
              </ul>
              {cart.length > 0 && (<>
                <div className="mt-2 flex justify-between border-t border-line-soft pt-2 font-bold"><span>{to('subtotal')}</span><span className="tabular">{fmt(estimate)}</span></div>
                <button type="button" className="btn btn-primary mt-3 w-full" disabled={busy} onClick={() => review()}>{to('review')}</button>
              </>)}
            </div>
          </aside>
        </div>
      )}

      {open && <ItemDialog item={open} fmt={fmt} onClose={() => setOpen(null)} onAdd={(ids, qty) => { setCart((c) => { const key = `${open.id}:${[...ids].sort().join(',')}`; const ex = c.find((x) => x.key === key); return ex ? c.map((x) => (x.key === key ? { ...x, quantity: Math.min(50, x.quantity + qty) } : x)) : [...c, { key, item: open, modifierIds: ids, quantity: qty }]; }); setOpen(null); }} />}

      {(step === 'review' || step === 'details') && quote && (
        <section aria-labelledby="h-review" className="card max-w-xl p-6">
          <h2 id="h-review" ref={step === 'review' ? heading : undefined} tabIndex={-1} className="text-xl font-extrabold outline-none">{to('stepReview')}</h2>
          {quote.tips && step === 'review' && (
            <fieldset className="mt-3">
              <legend className="text-sm font-bold">{t('tipOptional')}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {[0, ...quote.tips.presetsBps].map((b) => <button key={b} type="button" aria-pressed={(tipBps ?? 0) === b} onClick={() => { setTipBps(b); void review(b ? Math.round((quote.subtotal.amount * b) / 10_000) : 0); }} className={`min-h-10 rounded-full border px-3 text-sm font-bold ${(tipBps ?? 0) === b ? 'border-ink bg-ink text-white' : 'border-line'}`}>{b ? `${b / 100}%` : t('noTip')}</button>)}
                {quote.tips.allowCustom && <span className="flex items-center gap-1"><input aria-label={t('customTip')} inputMode="decimal" value={customTip} onChange={(e) => setCustomTip(e.target.value)} placeholder={t('customTip')} className="field h-10 w-28" /><button type="button" className="btn btn-secondary h-10 min-h-10" onClick={() => { setTipBps(-1); const n = Math.round(Number(customTip.replace(',', '.')) * 100); void review(Number.isFinite(n) && n > 0 ? n : 0); }}>{t('apply')}</button></span>}
              </div>
            </fieldset>
          )}
          <Totals q={quote} locale={locale} />
          {quote.orderBy && <p className="mt-2 text-xs text-graphite">{t('orderBy', { when: dateTime(quote.orderBy, tz, locale) })}</p>}
          {step === 'review' && <div className="mt-5 flex flex-wrap gap-2"><button type="button" className="btn btn-secondary" onClick={() => setStep('menu')}>{tc('back')}</button><button type="button" className="btn btn-primary" onClick={() => setStep('details')}>{tc('continue')}</button></div>}
        </section>
      )}

      {step === 'details' && quote && (
        <form onSubmit={place} noValidate className="card mt-4 max-w-xl space-y-4 p-6" aria-labelledby="h-details">
          <h2 id="h-details" ref={heading} tabIndex={-1} className="text-xl font-extrabold outline-none">{to('stepDetails')}</h2>
          <Field label={tb('name')} autoComplete="name" required value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} error={error?.fields?.name} />
          <Field label={tb('email')} type="email" autoComplete="email" required value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} error={error?.fields?.email} />
          <Field label={tb('phone')} type="tel" autoComplete="tel" optional value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
          <div><label htmlFor="notes" className="mb-1 block text-sm font-semibold">{to('notes')} <span className="font-normal text-graphite">({tc('optional')})</span></label><textarea id="notes" maxLength={500} rows={2} className="field" value={contact.notes} onChange={(e) => setContact({ ...contact, notes: e.target.value })} /></div>
          {channel === 'dine_in' && (
            <fieldset><legend className="text-sm font-bold">{t('howToPay')}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {p.payments && <label className="flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-sm"><input type="radio" name="pm" checked={payMode === 'pay_now'} onChange={() => setPayMode('pay_now')} />{t('payNow')}</label>}
                <label className="flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-sm"><input type="radio" name="pm" checked={payMode === 'tab'} onChange={() => setPayMode('tab')} />{t('addToTab')}</label>
              </div>
            </fieldset>
          )}
          <Checkbox label={tb('marketing', { brand: p.brandName })} checked={contact.consent} onChange={(v) => setContact({ ...contact, consent: v })} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('review')}>{tc('back')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{channel === 'dine_in' && payMode === 'tab' ? t('sendToKitchen') : to('placeOrder', { amount: money(quote.total, locale) })}</button>
          </div>
        </form>
      )}

      {step === 'pay' && placed?.payment && (
        <section aria-labelledby="h-pay" className="card max-w-xl space-y-4 p-6">
          <h2 id="h-pay" ref={heading} tabIndex={-1} className="text-xl font-extrabold outline-none">{to('statusTitle', { number: placed.order.orderNumber })}</h2>
          <p>{to('awaitingBody')}</p>
          <PayButton payment={placed.payment} label={tb('payCta', { amount: money(placed.order.total, locale) })} onDone={(r) => { if (r.ok) window.location.assign(`${p.statusBase}/${placed.order.id}?token=${encodeURIComponent(placed.manageToken)}`); else setError({ message: r.message ?? tb('paymentFailed') }); }} />
        </section>
      )}
    </div>
  );
}

export function Totals({ q, locale }: { q: CheckoutQuote; locale: string }) {
  const t = useTranslations('foodsite');
  const to = useTranslations('order');
  return (
    <dl className="mt-3 space-y-1 text-sm">
      {q.lines.map((l, i) => <div key={i} className="flex justify-between gap-3"><dt>{l.quantity} × {l.name}{l.modifiers.length ? <span className="text-graphite"> ({l.modifiers.join(', ')})</span> : null}</dt><dd className="tabular">{money(l.lineTotal, locale)}</dd></div>)}
      <div className="flex justify-between border-t border-line-soft pt-2"><dt>{to('subtotal')}</dt><dd className="tabular">{money(q.subtotal, locale)}</dd></div>
      {q.serviceCharge && <div className="flex justify-between"><dt>{q.serviceCharge.label ?? t('serviceCharge')}</dt><dd className="tabular">{money(q.serviceCharge, locale)}</dd></div>}
      {q.deliveryFee && <div className="flex justify-between"><dt>{t('deliveryFee')}</dt><dd className="tabular">{q.deliveryFee.amount ? money(q.deliveryFee, locale) : t('free')}</dd></div>}
      {q.tax ? <div className="flex justify-between"><dt>{to('tax', { rate: `${((q.taxRateBps ?? 0) / 100).toLocaleString(locale)}%` })}</dt><dd className="tabular">{money(q.tax, locale)}</dd></div> : <p className="text-xs text-graphite">{to('noTax')}</p>}
      {q.tip && <div className="flex justify-between"><dt>{t('tip')}</dt><dd className="tabular">{money(q.tip, locale)}</dd></div>}
      <div className="flex justify-between text-base font-extrabold"><dt>{to('total')}</dt><dd className="tabular">{money(q.total, locale)}</dd></div>
    </dl>
  );
}

function ItemDialog({ item, fmt, onClose, onAdd }: { item: MenuItemX; fmt: (n: number) => string; onClose: () => void; onAdd: (ids: string[], qty: number) => void }) {
  const to = useTranslations('order');
  const t = useTranslations('foodsite');
  const tc = useTranslations('common');
  const ref = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>(() => Object.fromEntries(item.modifierGroups.map((g) => [g.id, g.minSelect === 1 && g.maxSelect === 1 ? g.modifiers.filter((m) => m.available).slice(0, 1).map((m) => m.id) : []])));
  const [qty, setQty] = useState(1);
  useEffect(() => { ref.current?.showModal(); }, []);
  const ids = Object.values(picked).flat();
  const unit = (item.price?.amount ?? 0) + item.modifierGroups.flatMap((g) => g.modifiers).filter((m) => ids.includes(m.id)).reduce((a, m) => a + (m.price?.amount ?? 0), 0);
  const valid = item.modifierGroups.every((g) => (picked[g.id]?.length ?? 0) >= g.minSelect && (picked[g.id]?.length ?? 0) <= g.maxSelect);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dlg-h" className="m-auto w-[min(520px,calc(100vw-24px))] rounded-3xl p-0 backdrop:bg-ink/50">
      <form method="dialog" className="p-6" onSubmit={(e) => { e.preventDefault(); if (valid) onAdd(ids, qty); }}>
        <div className="flex items-start justify-between gap-3"><h2 id="dlg-h" className="text-xl font-extrabold">{item.name}</h2><button type="button" className="grid size-10 place-items-center rounded-full hover:bg-canvas" onClick={() => ref.current?.close()} aria-label={tc('close')}><Icon name="x" size={18} /></button></div>
        {item.description && <p className="mt-1 text-sm text-graphite">{item.description}</p>}
        {item.modifierGroups.map((g) => {
          const single = g.maxSelect === 1;
          return (
            <fieldset key={g.id} className="mt-5">
              <legend className="font-bold">{g.name} <span className="text-sm font-normal text-graphite">· {g.minSelect > 0 ? to('required', { n: g.minSelect }) : to('chooseUpTo', { n: g.maxSelect })}</span></legend>
              <div className="mt-2 space-y-2">
                {g.modifiers.map((m) => {
                  const on = picked[g.id]?.includes(m.id) ?? false;
                  return (
                    <label key={m.id} className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 ${on ? 'border-ink' : 'border-line'} ${m.available ? '' : 'opacity-50'}`}>
                      <input type={single ? 'radio' : 'checkbox'} name={g.id} className="size-5" disabled={!m.available} checked={on} onChange={(e) => setPicked((pk) => { const cur = pk[g.id] ?? []; const next = single ? [m.id] : e.target.checked ? [...cur, m.id].slice(-g.maxSelect) : cur.filter((x) => x !== m.id); return { ...pk, [g.id]: next }; })} />
                      <span className="flex-1">{m.name}{!m.available && ` · ${to('soldOut')}`}{((m as { allergens?: string[] }).allergens ?? []).length > 0 && <span className="block text-xs text-graphite">{t("optionAdds", { list: ((m as { allergens?: string[] }).allergens ?? []).join(", ") })}</span>}</span>
                      {m.price && m.price.amount > 0 && <span className="text-sm tabular">+{fmt(m.price.amount)}</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
        <div className="mt-5 flex items-center gap-3">
          <span className="text-sm font-semibold">{to('quantity')}</span>
          <button type="button" className="grid size-10 place-items-center rounded-full border border-line" aria-label={to('decrease', { name: item.name })} onClick={() => setQty((q) => Math.max(1, q - 1))}><Icon name="minus" size={14} /></button>
          <span className="w-6 text-center font-bold tabular" aria-live="polite">{qty}</span>
          <button type="button" className="grid size-10 place-items-center rounded-full border border-line" aria-label={to('increase', { name: item.name })} onClick={() => setQty((q) => Math.min(50, q + 1))}><Icon name="plus" size={14} /></button>
        </div>
        <button type="submit" className="btn btn-primary mt-5 w-full" disabled={!valid}>{to('addToOrder', { amount: fmt(unit * qty) })}</button>
      </form>
    </dialog>
  );
}
