'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { calendarLabel, localDate, money, time, zone } from '@/lib/format';
import type { FoodOrder, Menu, MenuItem, Quote, Slot } from '@/lib/foods';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, CardPayment, type PaymentInfo } from '@/components/forms';

type Line = { key: string; item: MenuItem; modifierIds: string[]; quantity: number };
type Step = 'time' | 'menu' | 'review' | 'details' | 'pay';

/**
 * Pickup ordering: slot → menu → modifiers → cart → server quote (tax only when configured) → details →
 * pay → status page ("awaiting acceptance" until the restaurant accepts). Every check is repeated server-side.
 */
export function OrderFlow(props: { locationId: string; locationName: string; brandName: string; timeZone: string; menu: Menu; slots: Slot[]; statusBase: string }) {
  const t = useTranslations('order');
  const tb = useTranslations('booking');
  const tc = useTranslations('common');
  const locale = useLocale();
  const tz = props.timeZone;
  const [step, setStep] = useState<Step>('time');
  const [slots, setSlots] = useState(props.slots);
  const [slotId, setSlotId] = useState<string | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [open, setOpen] = useState<MenuItem | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [contact, setContact] = useState({ name: '', email: '', phone: '', notes: '', consent: false });
  const [placed, setPlaced] = useState<{ order: FoodOrder; manageToken: string; payment: PaymentInfo | null } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { headingRef.current?.focus(); }, [step]);

  const slot = slots.find((s) => s.id === slotId) ?? null;
  const days = useMemo(() => [...new Set(slots.map((s) => localDate(s.startsAt, tz)))], [slots, tz]);
  const currency = props.menu.location.currency;
  const fmt = (amount: number) => money({ amount, currency }, locale);
  const unitPrice = (l: Pick<Line, 'item' | 'modifierIds'>) =>
    (l.item.price?.amount ?? 0) + l.item.modifierGroups.flatMap((g) => g.modifiers).filter((m) => l.modifierIds.includes(m.id)).reduce((a, m) => a + (m.price?.amount ?? 0), 0);
  const count = cart.reduce((a, l) => a + l.quantity, 0);
  const estimate = cart.reduce((a, l) => a + unitPrice(l) * l.quantity, 0);
  const goStatus = (o: FoodOrder, token: string) => window.location.assign(`${props.statusBase}/${o.id}?token=${encodeURIComponent(token)}`);

  async function refreshSlots() {
    const r = await call<{ items: Slot[] }>('GET', `/public/foods/${props.locationId}/pickup-slots`);
    if (r.ok) setSlots(r.data.items);
  }

  async function review() {
    setBusy(true);
    setError(null);
    const r = await call<Quote>('POST', `/public/foods/${props.locationId}/quote`, { lines: cart.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity, modifierIds: l.modifierIds })) });
    setBusy(false);
    if (!r.ok) { setError({ message: r.error.message, fields: r.error.fields }); return; }
    setQuote(r.data);
    setStep('review');
  }

  async function place(e: React.FormEvent) {
    e.preventDefault();
    if (!quote || !slotId) return;
    const fe: Record<string, string> = {};
    if (!contact.name.trim()) fe.name = tc('required', { field: tb('name') });
    if (!EMAIL_RE.test(contact.email)) fe.email = tc('invalidEmail');
    if (Object.keys(fe).length) { setError({ message: tb('yourDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await call<{ order: FoodOrder; manageToken: string; payment: PaymentInfo | null }>('POST', `/public/foods/${props.locationId}/orders`, {
      pickupSlotId: slotId,
      lines: cart.map((l) => ({ menuItemId: l.item.id, quantity: l.quantity, modifierIds: l.modifierIds })),
      contact: { name: contact.name.trim(), email: contact.email.trim(), ...(contact.phone.trim() ? { phone: contact.phone.trim() } : {}), marketingConsent: contact.consent },
      ...(contact.notes.trim() ? { notes: contact.notes.trim() } : {}),
      expectedTotalMinor: quote.total.amount,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === 'price_changed') { await review(); setError({ message: t('priceChanged') }); return; }
      if (r.error.code === 'slot_full' || r.error.code === 'slot_closed') { await refreshSlots(); setSlotId(null); setStep('time'); setError({ message: t('slotTaken') }); return; }
      if (r.error.code === 'payments_not_enabled' || r.error.code === 'location_not_accepting_orders') { setError({ message: t('notAccepting') }); return; }
      const f = r.error.fields ? Object.fromEntries(Object.entries(r.error.fields).map(([k, v]) => [k.replace(/^contact\./, ''), v])) : undefined;
      setError({ message: r.error.message, fields: f });
      return;
    }
    if (!r.data.payment) { goStatus(r.data.order, r.data.manageToken); return; }
    setPlaced(r.data);
    setStep('pay');
  }

  const steps: Array<[Step, string]> = [['time', t('stepTime')], ['menu', t('stepMenu')], ['review', t('stepReview')], ['details', t('stepDetails')]];
  const stepIdx = Math.min(steps.findIndex(([k]) => k === step) === -1 ? 3 : steps.findIndex(([k]) => k === step), 3);

  if (!props.menu.location.acceptingOrders) {
    return <p className="card mt-6 p-6">{t('notAccepting')}</p>;
  }

  return (
    <div className="mt-6">
      <ol className="mb-6 flex flex-wrap gap-2 text-sm font-semibold" aria-label={t('title')}>
        {steps.map(([k, label], i) => (
          <li key={k} aria-current={i === stepIdx ? 'step' : undefined} className={`rounded-full px-3 py-1 ${i === stepIdx ? 'bg-ink text-white' : i < stepIdx ? 'bg-success-bg text-success' : 'bg-canvas text-graphite'}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {slot && step !== 'time' && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <Icon name="clock" size={16} />
          <span className="font-semibold">{t('pickupAt', { when: `${calendarLabel(localDate(slot.startsAt, tz), locale)} ${time(slot.startsAt, tz, locale)} ${zone(tz, locale, slot.startsAt)}` })}</span>
          {step !== 'pay' && <button type="button" className="link font-semibold" onClick={() => setStep('time')}>{t('change')}</button>}
        </p>
      )}

      <ErrorSummary message={error?.message ?? null} fields={error?.fields} />

      {step === 'time' && (
        <section aria-labelledby="h-time" className="mt-4">
          <h2 id="h-time" ref={headingRef} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('chooseTime')}</h2>
          <p className="text-sm text-graphite">{tc('timesIn', { zone: `${zone(tz, locale)} (${tz})` })}</p>
          {!slots.some((s) => s.available) && <p className="card mt-4 p-6">{t('noSlots')}</p>}
          {days.map((d) => (
            <fieldset key={d} className="mt-4">
              <legend className="text-sm font-bold">{calendarLabel(d, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</legend>
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {slots.filter((s) => localDate(s.startsAt, tz) === d && new Date(s.cutoffAt) > new Date(Date.now() - 3600_000)).map((s) => {
                  const sel = s.id === slotId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={!s.available}
                      aria-pressed={sel}
                      onClick={() => { setSlotId(s.id); setError(null); setStep('menu'); }}
                      className={`flex min-h-14 flex-col items-center justify-center rounded-xl border px-1 text-sm font-bold disabled:cursor-not-allowed disabled:bg-canvas disabled:text-stone ${sel ? 'border-ink bg-ink text-white' : 'border-line bg-white hover:border-ink'}`}
                    >
                      <span className="tabular">{time(s.startsAt, tz, locale)}</span>
                      <span className="text-xs font-semibold opacity-80">{s.available ? t('slotsLeft', { n: s.remaining }) : s.remaining === 0 ? t('slotFull') : t('slotClosed')}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </section>
      )}

      {step === 'menu' && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <section aria-labelledby="h-menu">
            <h2 id="h-menu" ref={headingRef} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('stepMenu')}</h2>
            {props.menu.categories.map((c) => (
              <div key={c.name} className="mt-5">
                <h3 className="text-sm font-bold uppercase tracking-wider text-graphite">{c.name}</h3>
                <ul className="mt-2 grid gap-3 sm:grid-cols-2">
                  {c.items.map((it) => (
                    <li key={it.id} className="card flex flex-col p-4">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-bold">{it.name}</h4>
                        <span className="font-bold tabular">{it.price ? money(it.price, locale) : ''}</span>
                      </div>
                      {it.description && <p className="mt-1 text-sm text-graphite">{it.description}</p>}
                      {(it.dietary.length > 0 || it.allergens.length > 0) && (
                        <p className="mt-2 text-xs text-graphite">
                          {it.dietary.map((d) => <span key={d} className="me-1 inline-block rounded-full bg-canvas px-2 py-0.5 font-semibold">{d}</span>)}
                          {it.allergens.length > 0 && <span className="block pt-1">{t('allergens', { list: it.allergens.join(', ') })}</span>}
                        </p>
                      )}
                      <div className="mt-auto pt-3">
                        {it.available ? (
                          <button type="button" className="btn btn-secondary h-10 min-h-10" onClick={() => setOpen(it)} aria-label={`${t('add')}: ${it.name}`}><Icon name="plus" size={16} />{t('add')}</button>
                        ) : (
                          <span className="text-sm font-semibold text-stone">{it.unavailableReason === 'Sold out' ? t('soldOut') : t('unavailable')}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="mt-4 text-xs text-graphite">{t('dietary', { brand: props.brandName })}</p>
          </section>
          <aside aria-labelledby="h-cart" className="lg:sticky lg:top-20 lg:self-start">
            <div className="card p-4">
              <h2 id="h-cart" className="text-lg font-extrabold">{t('cart')} {count > 0 && <span className="text-graphite">({count})</span>}</h2>
              {cart.length === 0 && <p className="mt-2 text-sm text-graphite">{t('emptyCart')}</p>}
              <ul className="mt-2 divide-y divide-line-soft">
                {cart.map((l) => (
                  <li key={l.key} className="py-2 text-sm">
                    <div className="flex justify-between gap-2"><span className="font-semibold">{l.item.name}</span><span className="tabular">{fmt(unitPrice(l) * l.quantity)}</span></div>
                    {l.modifierIds.length > 0 && <p className="text-xs text-graphite">{l.item.modifierGroups.flatMap((g) => g.modifiers).filter((m) => l.modifierIds.includes(m.id)).map((m) => m.name).join(', ')}</p>}
                    <div className="mt-1 flex items-center gap-2">
                      <button type="button" className="grid size-9 place-items-center rounded-full border border-line" aria-label={t('decrease', { name: l.item.name })} onClick={() => setCart((c) => c.flatMap((x) => (x.key !== l.key ? [x] : x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : [])))}><Icon name="minus" size={14} /></button>
                      <span className="w-6 text-center tabular" aria-live="polite">{l.quantity}</span>
                      <button type="button" className="grid size-9 place-items-center rounded-full border border-line" aria-label={t('increase', { name: l.item.name })} onClick={() => setCart((c) => c.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(50, x.quantity + 1) } : x)))}><Icon name="plus" size={14} /></button>
                      <button type="button" className="ms-auto min-h-9 px-1 text-xs underline" aria-label={t('remove', { name: l.item.name })} onClick={() => setCart((c) => c.filter((x) => x.key !== l.key))}>{t('removeShort')}</button>
                    </div>
                  </li>
                ))}
              </ul>
              {cart.length > 0 && (
                <>
                  <div className="mt-2 flex justify-between border-t border-line-soft pt-2 font-bold"><span>{t('subtotal')}</span><span className="tabular">{fmt(estimate)}</span></div>
                  <button type="button" className="btn btn-primary mt-3 w-full" disabled={busy} onClick={review}>{t('review')}</button>
                </>
              )}
            </div>
          </aside>
        </div>
      )}

      {open && (
        <ItemDialog
          item={open}
          fmt={fmt}
          onClose={() => setOpen(null)}
          onAdd={(modifierIds, quantity) => {
            setCart((c) => {
              const key = `${open.id}:${[...modifierIds].sort().join(',')}`;
              const existing = c.find((x) => x.key === key);
              return existing ? c.map((x) => (x.key === key ? { ...x, quantity: Math.min(50, x.quantity + quantity) } : x)) : [...c, { key, item: open, modifierIds, quantity }];
            });
            setOpen(null);
          }}
        />
      )}

      {step === 'review' && quote && (
        <section aria-labelledby="h-review" className="card max-w-xl p-6">
          <h2 id="h-review" ref={headingRef} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('stepReview')}</h2>
          <Totals quote={quote} locale={locale} />
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('menu')}>{tc('back')}</button>
            <button type="button" className="btn btn-primary" onClick={() => setStep('details')}>{tc('continue')}</button>
          </div>
        </section>
      )}

      {step === 'details' && quote && (
        <form onSubmit={place} noValidate className="card max-w-xl space-y-4 p-6" aria-labelledby="h-details">
          <h2 id="h-details" ref={headingRef} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('stepDetails')}</h2>
          <Field label={tb('name')} autoComplete="name" required value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} error={error?.fields?.name} />
          <Field label={tb('email')} type="email" autoComplete="email" required value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} error={error?.fields?.email} />
          <Field label={tb('phone')} type="tel" autoComplete="tel" optional value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} error={error?.fields?.phone} />
          <div>
            <label htmlFor="notes" className="mb-1 block text-sm font-semibold">{t('notes')} <span className="font-normal text-graphite">({tc('optional')})</span></label>
            <textarea id="notes" maxLength={500} rows={2} className="field" value={contact.notes} onChange={(e) => setContact({ ...contact, notes: e.target.value })} />
          </div>
          <Checkbox label={tb('marketing', { brand: props.brandName })} checked={contact.consent} onChange={(v) => setContact({ ...contact, consent: v })} />
          <Totals quote={quote} locale={locale} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setStep('review')}>{tc('back')}</button>
            <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{t('placeOrder', { amount: money(quote.total, locale) })}</button>
          </div>
        </form>
      )}

      {step === 'pay' && placed?.payment && (
        <section aria-labelledby="h-pay" className="card max-w-xl space-y-4 p-6">
          <h2 id="h-pay" ref={headingRef} tabIndex={-1} className="text-xl font-extrabold outline-none">{t('statusTitle', { number: placed.order.orderNumber })}</h2>
          <p>{t('awaitingBody')}</p>
          <CardPayment
            payment={placed.payment}
            returnUrl={`${props.statusBase}/${placed.order.id}?token=${encodeURIComponent(placed.manageToken)}`}
            label={tb('payCta', { amount: money(placed.order.total, locale) })}
            onDone={(r) => { if (r.ok) goStatus(placed.order, placed.manageToken); else setError({ message: r.message ?? tb('paymentFailed') }); }}
          />
        </section>
      )}
    </div>
  );
}

function Totals({ quote, locale }: { quote: Quote; locale: string }) {
  const t = useTranslations('order');
  return (
    <dl className="mt-3 space-y-1 text-sm">
      {quote.lines.map((l, i) => (
        <div key={i} className="flex justify-between gap-3">
          <dt>{l.quantity} × {l.name}{l.modifiers.length ? <span className="text-graphite"> ({l.modifiers.join(', ')})</span> : null}</dt>
          <dd className="tabular">{money(l.lineTotal, locale)}</dd>
        </div>
      ))}
      <div className="flex justify-between border-t border-line-soft pt-2"><dt>{t('subtotal')}</dt><dd className="tabular">{money(quote.subtotal, locale)}</dd></div>
      {quote.tax ? (
        <div className="flex justify-between"><dt>{t('tax', { rate: `${((quote.taxRateBps ?? 0) / 100).toLocaleString(locale)}%` })}</dt><dd className="tabular">{money(quote.tax, locale)}</dd></div>
      ) : (
        <p className="text-xs text-graphite">{t('noTax')}</p>
      )}
      <div className="flex justify-between text-base font-extrabold"><dt>{t('total')}</dt><dd className="tabular">{money(quote.total, locale)}</dd></div>
    </dl>
  );
}

function ItemDialog({ item, fmt, onClose, onAdd }: { item: MenuItem; fmt: (n: number) => string; onClose: () => void; onAdd: (modifierIds: string[], quantity: number) => void }) {
  const t = useTranslations('order');
  const tc = useTranslations('common');
  const ref = useRef<HTMLDialogElement>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(item.modifierGroups.map((g) => [g.id, g.minSelect === 1 && g.maxSelect === 1 ? g.modifiers.filter((m) => m.available).slice(0, 1).map((m) => m.id) : []])));
  const [qty, setQty] = useState(1);
  useEffect(() => { ref.current?.showModal(); }, []);
  const ids = Object.values(picked).flat();
  const unit = (item.price?.amount ?? 0) + item.modifierGroups.flatMap((g) => g.modifiers).filter((m) => ids.includes(m.id)).reduce((a, m) => a + (m.price?.amount ?? 0), 0);
  const valid = item.modifierGroups.every((g) => (picked[g.id]?.length ?? 0) >= g.minSelect && (picked[g.id]?.length ?? 0) <= g.maxSelect);

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dlg-h" className="m-auto w-[min(520px,calc(100vw-24px))] rounded-3xl p-0 backdrop:bg-ink/50">
      <form method="dialog" className="p-6" onSubmit={(e) => { e.preventDefault(); if (valid) onAdd(ids, qty); }}>
        <div className="flex items-start justify-between gap-3">
          <h2 id="dlg-h" className="text-xl font-extrabold">{item.name}</h2>
          <button type="button" className="grid size-10 place-items-center rounded-full hover:bg-canvas" onClick={() => ref.current?.close()} aria-label={tc('close')}><Icon name="x" size={18} /></button>
        </div>
        {item.description && <p className="mt-1 text-sm text-graphite">{item.description}</p>}
        {item.modifierGroups.map((g) => {
          const single = g.maxSelect === 1;
          return (
            <fieldset key={g.id} className="mt-5">
              <legend className="font-bold">{g.name} <span className="text-sm font-normal text-graphite">· {g.minSelect > 0 ? t('required', { n: g.minSelect }) : t('chooseUpTo', { n: g.maxSelect })}</span></legend>
              <div className="mt-2 space-y-2">
                {g.modifiers.map((m) => {
                  const on = picked[g.id]?.includes(m.id) ?? false;
                  return (
                    <label key={m.id} className={`flex min-h-11 items-center gap-3 rounded-xl border px-3 ${on ? 'border-ink' : 'border-line'} ${m.available ? '' : 'opacity-50'}`}>
                      <input
                        type={single ? 'radio' : 'checkbox'}
                        name={g.id}
                        className="size-5 accent-[var(--site-brand)]"
                        disabled={!m.available}
                        checked={on}
                        onChange={(e) => setPicked((p) => {
                          const cur = p[g.id] ?? [];
                          const next = single ? [m.id] : e.target.checked ? [...cur, m.id].slice(-g.maxSelect) : cur.filter((x) => x !== m.id);
                          return { ...p, [g.id]: next };
                        })}
                      />
                      <span className="flex-1">{m.name}{!m.available && ` · ${t('soldOut')}`}</span>
                      {m.price && m.price.amount > 0 && <span className="text-sm tabular">+{fmt(m.price.amount)}</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          );
        })}
        <div className="mt-5 flex items-center gap-3">
          <span className="text-sm font-semibold" id="qty-l">{t('quantity')}</span>
          <button type="button" className="grid size-10 place-items-center rounded-full border border-line" aria-label={t('decrease', { name: item.name })} onClick={() => setQty((q) => Math.max(1, q - 1))}><Icon name="minus" size={14} /></button>
          <span className="w-6 text-center font-bold tabular" aria-labelledby="qty-l" aria-live="polite">{qty}</span>
          <button type="button" className="grid size-10 place-items-center rounded-full border border-line" aria-label={t('increase', { name: item.name })} onClick={() => setQty((q) => Math.min(50, q + 1))}><Icon name="plus" size={14} /></button>
        </div>
        <button type="submit" className="btn btn-primary mt-5 w-full" disabled={!valid}>{t('addToOrder', { amount: fmt(unit * qty) })}</button>
      </form>
    </dialog>
  );
}
