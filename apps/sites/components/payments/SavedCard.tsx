'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Icon } from '@bh/ui';
import { call, type ApiResult } from '@/lib/client';
import { paymentErrorKey } from '@/lib/stripe';
import { LiveElements } from './CardPayment';

export interface CardOnFile { card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; sandbox: boolean } | null; purposes: string[]; config?: { mode: 'live' | 'sandbox'; merchantDisplayName: string } }
export interface SetupStart {
  setupIntentId: string; clientSecret: string | null; publishableKey: string | null; stripeAccount: string | null; merchantDisplayName: string; mode: 'live' | 'sandbox';
  sandbox: boolean; sandboxToken: string | null; paymentCustomerId: string; cardEntryAvailable: boolean;
}

/**
 * "Saved card" panel for account pages (studio account, guardian portal, meal plan): shows the card on file and lets
 * the customer add/update it with a SetupIntent (Stripe confirmSetup; 3-D Secure in place). The new card becomes the
 * default for renewals/instalments, and a failed renewal is retried with it (server side, after the signed webhook).
 */
export function SavedCard(props: {
  load: () => Promise<ApiResult<CardOnFile>>;
  start: (consentText: string, locale: string) => Promise<ApiResult<SetupStart>>;
  remove?: () => Promise<ApiResult<unknown>>;
  returnUrl?: string;
}) {
  const t = useTranslations('payment');
  const locale = useLocale();
  const [data, setData] = useState<CardOnFile | null>(null);
  const [setup, setSetup] = useState<SetupStart | null>(null);
  const [agree, setAgree] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const r = await props.load();
    if (r.ok) setData(r.data);
  }, [props]);
  useEffect(() => { void refresh(); }, [refresh]);

  const business = data?.config?.merchantDisplayName || setup?.merchantDisplayName || '';
  const card = data?.card ?? null;
  const done = async (ok: boolean, text?: string) => {
    setSetup(null);
    setAgree(false);
    setMsg(ok ? { tone: 'ok', text: t('card.saved') } : { tone: 'err', text: text ?? t('errors.generic') });
    // The card becomes the default once the signed webhook arrives: refresh a few times.
    for (let i = 0; i < 5; i++) { await refresh(); await new Promise((r) => setTimeout(r, 800)); }
  };

  return (
    <section className="card space-y-3 p-5" data-testid="saved-card">
      <h2 className="flex items-center gap-2 text-lg font-extrabold"><Icon name="card" size={20} />{t('card.title')}</h2>
      {card ? (
        <div>
          <p className="font-semibold">{t('card.onFile', { brand: (card.brand ?? 'card').toUpperCase(), last4: card.last4 ?? '••••' })}{card.sandbox ? ` · ${t('testMode')}` : ''}</p>
          {card.expMonth && card.expYear && <p className="text-sm text-graphite">{t('card.expires', { month: String(card.expMonth).padStart(2, '0'), year: card.expYear })}</p>}
          {data!.purposes.length > 0 && <p className="text-sm text-graphite">{t('card.usedFor', { purposes: data!.purposes.map((p) => t(`card.purpose_${p}` as 'card.purpose_fees')).join(', ') })}</p>}
        </div>
      ) : <p className="text-sm text-graphite">{t('card.none')}</p>}
      {msg && <p role={msg.tone === 'err' ? 'alert' : 'status'} className={`text-sm font-semibold ${msg.tone === 'err' ? 'text-danger' : 'text-success'}`}>{msg.text}</p>}

      {!setup && (
        <div className="space-y-2">
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--site-brand)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>{t('card.updateConsent', { business: business || '—' })}</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={!agree || busy} aria-busy={busy} onClick={async () => {
              setBusy(true);
              setMsg(null);
              const r = await props.start(t('card.updateConsent', { business: business || '—' }), locale);
              setBusy(false);
              if (!r.ok) { setMsg({ tone: 'err', text: r.error.message }); return; }
              setSetup(r.data);
            }}>{card ? t('card.update') : t('card.add')}</button>
            {card && props.remove && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={async () => { const r = await props.remove!(); if (r.ok) { setMsg({ tone: 'ok', text: t('card.removed') }); await refresh(); } }}>{t('card.remove')}</button>
            )}
          </div>
        </div>
      )}

      {setup && setup.sandbox && (
        <div className="space-y-2">
          <button type="button" className="btn btn-primary" data-testid="sandbox-save-card" onClick={async () => {
            const r = await call('POST', `/public/payments/setup/${setup.setupIntentId}/sandbox-complete`, { paymentCustomerId: setup.paymentCustomerId, token: setup.sandboxToken, card: 'ok' });
            await done(r.ok, r.ok ? undefined : r.error.message);
          }}>{t('card.simulateSave')}</button>
          <p className="flex items-center gap-1.5 text-xs text-graphite"><span className="rounded-full bg-warning-bg px-2 py-0.5 font-bold text-warning">{t('testMode')}</span>{t('sandboxNote')}</p>
        </div>
      )}
      {setup && !setup.sandbox && (setup.publishableKey && setup.clientSecret && setup.cardEntryAvailable ? (
        <LiveElements publishableKey={setup.publishableKey} stripeAccount={setup.stripeAccount} clientSecret={setup.clientSecret} business={business}>
          <SetupForm returnUrl={props.returnUrl} onDone={done} />
        </LiveElements>
      ) : <p role="alert" data-testid="card-unavailable" className="rounded-2xl bg-warning-bg p-4 text-sm text-warning">{t('unavailable', { business: business || '—' })}</p>)}
    </section>
  );
}

function SetupForm({ returnUrl, onDone }: { returnUrl?: string; onDone: (ok: boolean, text?: string) => void }) {
  const t = useTranslations('payment');
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  return (
    <div className="space-y-3">
      <PaymentElement options={{ layout: 'tabs' }} onReady={() => setReady(true)} />
      {err && <p role="alert" className="text-sm font-semibold text-danger">{err}</p>}
      <button type="button" className="btn btn-primary" disabled={!ready || busy || !stripe} aria-busy={busy} onClick={async () => {
        if (!stripe || !elements) return;
        setBusy(true);
        setErr(null);
        const sub = await elements.submit();
        if (sub.error) { setBusy(false); setErr(sub.error.message ?? t(paymentErrorKey(sub.error))); return; }
        const { error } = await stripe.confirmSetup({ elements, redirect: 'if_required', confirmParams: { return_url: returnUrl ? new URL(returnUrl, window.location.href).toString() : window.location.href } });
        setBusy(false);
        if (error) { const k = paymentErrorKey(error); setErr(k === 'errors.generic' && error.message ? error.message : t(k)); return; }
        onDone(true);
      }}>{t('card.save')}</button>
    </div>
  );
}
