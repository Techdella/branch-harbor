'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { Checkbox, EMAIL_RE, ErrorSummary, Field, CardPayment, type PaymentInfo } from '@/components/forms';
import { money } from '@/lib/format';
import { readCart, shop, writeCart, type CartLine, type PublicOrder, type Quote, type Storefront } from '@/lib/shop';

type Method = 'pickup' | 'local_delivery' | 'shipping';

/**
 * Cart → fulfilment (pickup here / collect at another store / delivery / shipping) → server quote with configured taxes
 * only → details → place order (stock held for the payment window) → pay → status page. All checks are server-side.
 */
export function Checkout({ sf, statusBase, shopHref }: { sf: Storefront; statusBase: string; shopHref: string }) {
  const t = useTranslations('storefront');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [method, setMethod] = useState<Method>(sf.fulfilment.pickup.enabled ? 'pickup' : sf.fulfilment.localDelivery.enabled ? 'local_delivery' : 'shipping');
  const [collectAt, setCollectAt] = useState<string>(sf.location.id);
  const [addr, setAddr] = useState({ line1: '', city: sf.location.address.city, postalCode: '', country: sf.location.country });
  const [contact, setContact] = useState({ name: '', email: '', phone: '', consent: false });
  const [gift, setGift] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<{ order: PublicOrder; manageToken: string; payment: PaymentInfo | null } | null>(null);
  const idem = useRef(`co-${Math.random().toString(36).slice(2)}-${Date.now()}`);

  useEffect(() => { setCart(readCart(sf.location.id)); }, [sf.location.id]);
  const save = (next: CartLine[]) => { setCart(next); writeCart(sf.location.id, next); setQuote(null); };
  const fulfilment = useCallback(() => ({ method, ...(method === 'pickup' && collectAt !== sf.location.id ? { collectLocationId: collectAt } : {}), ...(method !== 'pickup' ? { address: addr } : {}) }), [method, collectAt, addr, sf.location.id]);

  const reprice = useCallback(async () => {
    if (!cart.length) { setQuote(null); return; }
    if (method !== 'pickup' && (!addr.line1 || !addr.postalCode)) { setQuote(null); return; }
    const r = await shop<Quote>('POST', `/public/commerce/locations/${sf.location.id}/quote`, { lines: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), fulfilment: fulfilment(), ...(gift.trim() ? { giftCardCode: gift.trim() } : {}) });
    if (r.ok) setQuote(r.data); else setError({ message: r.error.message, fields: r.error.fields });
  }, [cart, method, addr, gift, fulfilment, sf.location.id]);
  useEffect(() => { const h = setTimeout(() => void reprice(), 250); return () => clearTimeout(h); }, [reprice]);

  async function place(e: React.FormEvent) {
    e.preventDefault();
    if (!quote) return;
    const fe: Record<string, string> = {};
    if (!contact.name.trim()) fe.name = tc('required', { field: t('name') });
    if (!EMAIL_RE.test(contact.email)) fe.email = tc('invalidEmail');
    if (Object.keys(fe).length) { setError({ message: t('checkDetails'), fields: fe }); return; }
    setBusy(true);
    setError(null);
    const r = await shop<{ order: PublicOrder; manageToken: string; payment: PaymentInfo | null }>('POST', `/public/commerce/locations/${sf.location.id}/checkout`, {
      lines: cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), fulfilment: fulfilment(),
      contact: { name: contact.name.trim(), email: contact.email.trim(), ...(contact.phone.trim() ? { phone: contact.phone.trim() } : {}), marketingConsent: contact.consent },
      ...(gift.trim() ? { giftCardCode: gift.trim() } : {}), expectedTotalMinor: quote.total.amount,
    }, { idempotencyKey: idem.current, token: typeof window !== 'undefined' ? sessionStorage.getItem('bh_shop_token') : null });
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === 'price_changed') { await reprice(); setError({ message: t('priceChanged') }); return; }
      if (r.error.code === 'out_of_stock') { await reprice(); setError({ message: r.error.message, fields: r.error.fields }); return; }
      setError({ message: r.error.message, fields: r.error.fields });
      return;
    }
    writeCart(sf.location.id, []);
    if (!r.data.payment) { window.location.assign(`${statusBase}/${r.data.order.id}?token=${encodeURIComponent(r.data.manageToken)}`); return; }
    setPlaced(r.data);
  }

  if (placed?.payment) {
    return (
      <section className="card mt-6 max-w-xl space-y-4 p-6" aria-labelledby="h-pay">
        <h2 id="h-pay" className="text-xl font-extrabold">{t('payTitle', { number: placed.order.number })}</h2>
        <p>{t('heldUntil', { minutes: sf.reservationMinutes })}</p>
        <CardPayment payment={placed.payment} returnUrl={`${statusBase}/${placed.order.id}?token=${encodeURIComponent(placed.manageToken)}`} label={t('payCta', { amount: money(placed.order.amountDue, locale) })} onDone={(r) => { if (r.ok) window.location.assign(`${statusBase}/${placed.order.id}?token=${encodeURIComponent(placed.manageToken)}`); else setError({ message: r.message ?? t('paymentFailed') }); }} />
        <ErrorSummary message={error?.message ?? null} />
        <a className="link text-sm" href={`${statusBase}/${placed.order.id}?token=${encodeURIComponent(placed.manageToken)}`}>{t('viewOrder')}</a>
      </section>
    );
  }
  if (!cart.length) return <div className="card mt-6 p-6"><p>{t('emptyCart')}</p><a className="btn btn-secondary mt-3" href={shopHref}>{t('backToShop')}</a></div>;

  const fees = sf.fulfilment;
  return (
    <form onSubmit={place} noValidate className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <ErrorSummary message={error?.message ?? null} fields={error?.fields} />
        <section aria-labelledby="h-items" className="card p-5">
          <h2 id="h-items" className="text-lg font-extrabold">{t('items')}</h2>
          <ul className="mt-2 divide-y divide-line-soft">
            {cart.map((l) => {
              const q = quote?.lines.find((x) => x.variantId === l.variantId);
              return (
                <li key={l.variantId} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="min-w-40 flex-1"><span className="block font-semibold">{l.name}</span><span className="text-sm text-graphite">{l.variantName}</span>{q?.message && <span className={`block text-sm font-semibold ${q.availability === 'unavailable' ? 'text-danger' : 'text-warning'}`}>{q.message}</span>}</span>
                  <span className="flex items-center gap-1">
                    <button type="button" className="grid size-9 place-items-center rounded-full border border-line" aria-label={t('decrease', { name: l.name })} onClick={() => save(cart.flatMap((x) => (x.variantId !== l.variantId ? [x] : x.quantity > 1 ? [{ ...x, quantity: x.quantity - 1 }] : [])))}><Icon name="minus" size={14} /></button>
                    <span className="w-7 text-center tabular" aria-live="polite">{l.quantity}</span>
                    <button type="button" className="grid size-9 place-items-center rounded-full border border-line" aria-label={t('increase', { name: l.name })} onClick={() => save(cart.map((x) => (x.variantId === l.variantId ? { ...x, quantity: Math.min(99, x.quantity + 1) } : x)))}><Icon name="plus" size={14} /></button>
                  </span>
                  <span className="w-24 text-end font-semibold tabular">{q ? money(q.lineTotal, locale) : l.unit ? money({ amount: l.unit.amount * l.quantity, currency: l.unit.currency }, locale) : ''}</span>
                  <button type="button" className="text-sm underline" onClick={() => save(cart.filter((x) => x.variantId !== l.variantId))}>{t('remove')}</button>
                </li>
              );
            })}
          </ul>
        </section>

        <fieldset className="card space-y-3 p-5">
          <legend className="px-1 text-lg font-extrabold">{t('howToGet')}</legend>
          {fees.pickup.enabled && <label className="flex min-h-11 items-start gap-3"><input type="radio" name="method" className="mt-1 size-5 accent-[var(--site-brand)]" checked={method === 'pickup' && collectAt === sf.location.id} onChange={() => { setMethod('pickup'); setCollectAt(sf.location.id); }} /><span><strong>{t('pickupHere', { store: sf.location.name })}</strong><span className="block text-sm text-graphite">{t('readyIn', { minutes: fees.pickup.readyMinutes })}{fees.pickup.instructions ? ` · ${fees.pickup.instructions}` : ''}</span></span></label>}
          {fees.collectAt.map((c) => <label key={c.id} className="flex min-h-11 items-start gap-3"><input type="radio" name="method" className="mt-1 size-5 accent-[var(--site-brand)]" checked={method === 'pickup' && collectAt === c.id} onChange={() => { setMethod('pickup'); setCollectAt(c.id); }} /><span><strong>{t('collectAt', { store: c.name })}</strong><span className="block text-sm text-graphite">{t('collectAtNote', { from: sf.location.name })}</span></span></label>)}
          {fees.localDelivery.enabled && <label className="flex min-h-11 items-start gap-3"><input type="radio" name="method" className="mt-1 size-5 accent-[var(--site-brand)]" checked={method === 'local_delivery'} onChange={() => setMethod('local_delivery')} /><span><strong>{t('localDelivery')}</strong><span className="block text-sm text-graphite">{money(fees.localDelivery.fee, locale)}{fees.localDelivery.freeOver ? ` · ${t('freeOver', { amount: money(fees.localDelivery.freeOver, locale) })}` : ''}</span></span></label>}
          {fees.shipping.enabled && <label className="flex min-h-11 items-start gap-3"><input type="radio" name="method" className="mt-1 size-5 accent-[var(--site-brand)]" checked={method === 'shipping'} onChange={() => setMethod('shipping')} /><span><strong>{t('shipping')}</strong><span className="block text-sm text-graphite">{money(fees.shipping.fee, locale)} · {fees.shipping.countries.join(', ')}</span></span></label>}
          {method !== 'pickup' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('address')} autoComplete="address-line1" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} error={error?.fields?.['fulfilment.address']} />
              <Field label={t('city')} autoComplete="address-level2" value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} />
              <Field label={t('postcode')} autoComplete="postal-code" value={addr.postalCode} onChange={(e) => setAddr({ ...addr, postalCode: e.target.value })} error={error?.fields?.['fulfilment.address.postalCode']} />
              <Field label={t('country')} autoComplete="country" maxLength={2} value={addr.country} onChange={(e) => setAddr({ ...addr, country: e.target.value.toUpperCase() })} error={error?.fields?.['fulfilment.address.country']} />
            </div>
          )}
        </fieldset>

        <section aria-labelledby="h-details" className="card space-y-4 p-5">
          <h2 id="h-details" className="text-lg font-extrabold">{t('yourDetails')}</h2>
          <Field label={t('name')} autoComplete="name" required value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} error={error?.fields?.name} />
          <Field label={t('email')} type="email" autoComplete="email" required value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} error={error?.fields?.email} />
          <Field label={t('phone')} type="tel" autoComplete="tel" optional value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
          <Checkbox label={t('marketing', { brand: sf.brand.name })} checked={contact.consent} onChange={(v) => setContact({ ...contact, consent: v })} />
          <Field label={t('giftCode')} optional value={gift} onChange={(e) => setGift(e.target.value)} error={quote?.issues.find((i) => i.field === 'giftCardCode')?.message} hint={t('giftHint')} />
        </section>
      </div>

      <aside aria-labelledby="h-sum" className="lg:sticky lg:top-20 lg:self-start">
        <div className="card p-5">
          <h2 id="h-sum" className="text-lg font-extrabold">{t('summary')}</h2>
          {!quote ? <p className="mt-2 text-sm text-graphite">{method !== 'pickup' ? t('enterAddress') : tc('loading')}</p> : (
            <dl className="mt-2 space-y-1 text-sm" aria-live="polite">
              <div className="flex justify-between"><dt>{t('subtotal')}</dt><dd className="tabular">{money(quote.subtotal, locale)}</dd></div>
              {method !== 'pickup' && <div className="flex justify-between"><dt>{method === 'shipping' ? t('shipping') : t('localDelivery')}</dt><dd className="tabular">{money(quote.fulfilmentFee, locale)}</dd></div>}
              {quote.taxLines.map((x) => <div key={x.name} className="flex justify-between"><dt>{x.inclusive ? t('taxIncluded', { name: x.name, rate: x.rateBps / 100 }) : t('tax', { name: x.name, rate: x.rateBps / 100 })}</dt><dd className="tabular">{money(x.amount, locale)}</dd></div>)}
              {!quote.taxConfigured && <p className="text-xs text-graphite">{t('noTaxConfigured')}</p>}
              <div className="flex justify-between border-t border-line-soft pt-2 text-base font-extrabold"><dt>{t('total')}</dt><dd className="tabular">{money(quote.total, locale)}</dd></div>
              {quote.credit && <div className="flex justify-between text-success"><dt>{t('credit', { last4: quote.credit.last4 })}</dt><dd className="tabular">−{money(quote.credit.applied, locale)}</dd></div>}
              {quote.credit && <div className="flex justify-between font-bold"><dt>{t('toPay')}</dt><dd className="tabular">{money(quote.amountDue, locale)}</dd></div>}
              {quote.fulfilment.transfer && <p className="pt-1 text-xs text-graphite">{t('transferNote', { store: quote.fulfilment.collectLocation?.name ?? '' })}</p>}
              {quote.lines.some((l) => l.availability === 'backorder') && <p className="pt-1 text-xs font-semibold text-warning">{t('backorderNote')}</p>}
            </dl>
          )}
          <button type="submit" className="btn btn-primary mt-4 w-full" disabled={busy || !quote || !quote.ok} aria-busy={busy}>{quote ? t('placeOrder', { amount: money(quote.amountDue, locale) }) : t('placeOrderShort')}</button>
          <p className="mt-2 text-xs text-graphite">{t('holdNote', { minutes: sf.reservationMinutes })}</p>
        </div>
      </aside>
    </form>
  );
}
