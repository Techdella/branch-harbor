'use client';

import { Component, createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import type { Appearance, Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Icon } from '@bh/ui';
import { call, sleep } from '@/lib/client';
import { money } from '@/lib/format';
import { getStripe, paymentErrorKey } from '@/lib/stripe';

export interface PaymentInfo { id?: string; sandbox: boolean; amount?: number; currency?: string; clientSecret?: string | null }

type SavePurpose = 'save_card' | 'renewals' | 'instalments' | 'fees';
interface FeePolicy { lateCancel: { amount: number; currency: string } | null; lateCancelPercent: number | null; noShow: { amount: number; currency: string } | null; noShowPercent: number | null; windowHours: number }
export interface PaymentView {
  id: string; state: string; amount: { amount: number; currency: string }; sandbox: boolean; mode: 'live' | 'sandbox';
  publishableKey: string | null; stripeAccount: string | null; merchantDisplayName: string; cardEntryAvailable: boolean;
  saveCard: { mode: 'required' | 'optional' | 'none'; purposes: SavePurpose[]; feePolicy: FeePolicy | null; consented: SavePurpose[] };
}
/** Inline configuration for payments without a BranchHarbor payment id (e.g. a subscription's first invoice). */
export interface InlineConfig { publishableKey: string | null; stripeAccount: string | null; merchantDisplayName: string; mode: 'live' | 'sandbox'; requiredConsent?: 'renewals' | 'instalments' }

export type PaymentResult = { ok: boolean; message?: string; pending?: boolean };

/**
 * The one card-entry component for every customer payment on hosted sites.
 *
 * Live: Stripe.js Payment Element (cards, Apple Pay / Google Pay where the connected account allows) loaded with the
 * location's connected account (direct charges), confirmed with `redirect: 'if_required'` so 3-D Secure happens in
 * place; when a bank needs a full redirect it returns to `returnUrl` (the order/booking status page, which polls).
 * The component never decides that something is paid: after Stripe confirms it polls the API, which only marks the
 * payment succeeded after the signed webhook.
 * Sandbox (API without Stripe keys): the "simulate payment" path, clearly labelled.
 */
export function CardPayment(props: { payment: PaymentInfo; label: string; onDone: (r: PaymentResult) => void; disabled?: boolean; returnUrl?: string; config?: InlineConfig }) {
  const t = useTranslations('payment');
  const locale = useLocale();
  const [view, setView] = useState<PaymentView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const id = props.payment.id;

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void call<PaymentView>('GET', `/public/payments/${id}`).then((r) => {
      if (!alive) return;
      if (r.ok) setView(r.data);
      else setLoadError(r.error.message);
    });
    return () => { alive = false; };
  }, [id]);

  const inline = props.config;
  const sandbox = view ? view.mode === 'sandbox' : inline ? inline.mode === 'sandbox' : props.payment.sandbox;
  const business = view?.merchantDisplayName || inline?.merchantDisplayName || '';
  const required: SavePurpose[] = view?.saveCard.mode === 'required' ? view.saveCard.purposes : inline?.requiredConsent ? [inline.requiredConsent] : [];
  const optional = view?.saveCard.mode === 'optional';
  const feePolicy = view?.saveCard.feePolicy ?? null;
  const [agreeRequired, setAgreeRequired] = useState(false);
  const [saveCard, setSaveCard] = useState(false);
  const [feeConsent, setFeeConsent] = useState(false);
  const [consentError, setConsentError] = useState(false);

  /** Records the consent before confirmation (attaches the Stripe Customer + setup_future_usage server-side). */
  const recordConsent = useCallback(async (): Promise<string | null> => {
    if (required.length && !agreeRequired) { setConsentError(true); return t('consentRequired'); }
    setConsentError(false);
    if (!id) return null;
    const purposes: SavePurpose[] = [...required];
    if (optional && (saveCard || feeConsent)) purposes.push('save_card');
    if (optional && feeConsent) purposes.push('fees');
    const already = view?.saveCard.consented ?? [];
    const todo = purposes.filter((p) => !already.includes(p));
    if (!todo.length) return null;
    const text = todo.map((p) => (p === 'renewals' ? t('consentRenewals', { business }) : p === 'instalments' ? t('consentInstalments', { business }) : p === 'fees' ? t('consentFees', { business }) : t('saveCard', { business }))).join(' ');
    const r = await call('POST', `/public/payments/${id}/save-card`, { purposes: todo, text, locale });
    return r.ok ? null : r.error.message;
  }, [required, agreeRequired, optional, saveCard, feeConsent, id, view, business, locale, t]);

  /** After the provider confirmed: wait for the server (webhook) to mark the payment succeeded. */
  const waitForServer = useCallback(async (): Promise<PaymentResult> => {
    if (!id) return { ok: true };
    for (let i = 0; i < 40; i++) {
      const r = await call<PaymentView>('GET', `/public/payments/${id}`);
      if (r.ok && r.data.state === 'succeeded') return { ok: true };
      if (r.ok && (r.data.state === 'failed' || r.data.state === 'cancelled')) return { ok: false, message: t('errors.generic') };
      await sleep(i < 10 ? 1000 : 2000);
    }
    return { ok: false, pending: true, message: t('pending') };
  }, [id, t]);

  if (id && !view && !loadError) return <p className="text-sm text-graphite" role="status">{t('loading')}</p>;
  if (view?.state === 'succeeded') return <p role="status" className="rounded-2xl bg-success-bg p-4 text-sm font-semibold text-success">{t('succeeded')}</p>;

  const consentBlock = (
    <ConsentBlock
      required={required} optional={optional} feePolicy={feePolicy} business={business} locale={locale}
      agreeRequired={agreeRequired} setAgreeRequired={setAgreeRequired} saveCard={saveCard} setSaveCard={setSaveCard} feeConsent={feeConsent} setFeeConsent={setFeeConsent} consentError={consentError}
    />
  );

  if (sandbox) {
    return (
      <div className="space-y-3" data-testid="card-payment" data-mode="sandbox">
        {consentBlock}
        <SandboxPay {...props} beforePay={recordConsent} />
      </div>
    );
  }

  const pk = view?.publishableKey ?? inline?.publishableKey ?? null;
  const account = view ? view.stripeAccount : inline?.stripeAccount ?? null;
  const clientSecret = props.payment.clientSecret ?? null;
  if (!pk || !clientSecret || (view && !view.cardEntryAvailable)) return <Unavailable business={business} />;

  return (
    <div className="space-y-3" data-testid="card-payment" data-mode="live">
      {consentBlock}
      <LiveElements publishableKey={pk} stripeAccount={account} clientSecret={clientSecret} business={business}>
        <LivePayForm business={business} label={props.label} disabled={props.disabled} returnUrl={props.returnUrl} beforePay={recordConsent} afterConfirm={waitForServer} onDone={props.onDone} />
      </LiveElements>
    </div>
  );
}

function ConsentBlock(p: {
  required: SavePurpose[]; optional: boolean; feePolicy: FeePolicy | null; business: string; locale: string; consentError: boolean;
  agreeRequired: boolean; setAgreeRequired: (v: boolean) => void; saveCard: boolean; setSaveCard: (v: boolean) => void; feeConsent: boolean; setFeeConsent: (v: boolean) => void;
}) {
  const t = useTranslations('payment');
  const rid = useId();
  if (!p.required.length && !p.optional) return null;
  return (
    <div className="space-y-2 rounded-2xl border border-line p-3 text-sm">
      {p.required.length > 0 && (
        <label htmlFor={`${rid}-req`} className="flex items-start gap-3">
          <input id={`${rid}-req`} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--site-brand)]" checked={p.agreeRequired} onChange={(e) => p.setAgreeRequired(e.target.checked)} aria-invalid={p.consentError || undefined} aria-describedby={p.consentError ? `${rid}-err` : undefined} />
          <span>{p.required.includes('renewals') ? t('consentRenewals', { business: p.business }) : t('consentInstalments', { business: p.business })}</span>
        </label>
      )}
      {p.consentError && <p id={`${rid}-err`} className="font-semibold text-danger" role="alert">{t('consentRequired')}</p>}
      {p.optional && (
        <label htmlFor={`${rid}-save`} className="flex items-start gap-3">
          <input id={`${rid}-save`} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--site-brand)]" checked={p.saveCard || p.feeConsent} onChange={(e) => { p.setSaveCard(e.target.checked); if (!e.target.checked) p.setFeeConsent(false); }} />
          <span>{t('saveCard', { business: p.business })}</span>
        </label>
      )}
      {p.optional && p.feePolicy && (
        <>
          <FeePolicyLines policy={p.feePolicy} locale={p.locale} />
          <label htmlFor={`${rid}-fees`} className="flex items-start gap-3">
            <input id={`${rid}-fees`} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-[var(--site-brand)]" checked={p.feeConsent} onChange={(e) => { p.setFeeConsent(e.target.checked); if (e.target.checked) p.setSaveCard(true); }} />
            <span>{t('consentFees', { business: p.business })}</span>
          </label>
        </>
      )}
    </div>
  );
}

export function FeePolicyLines({ policy, locale }: { policy: FeePolicy; locale: string }) {
  const t = useTranslations('payment');
  return (
    <div className="rounded-xl bg-canvas p-3 text-xs text-graphite">
      <p className="font-bold text-ink">{t('feePolicyTitle')}</p>
      <ul className="ms-4 mt-1 list-disc">
        <li>{t('feeWindow', { hours: policy.windowHours })}</li>
        {policy.lateCancel && <li>{t('lateFee', { amount: money(policy.lateCancel, locale) })}</li>}
        {policy.lateCancelPercent ? <li>{t('lateFeePercent', { percent: policy.lateCancelPercent })}</li> : null}
        {policy.noShow && <li>{t('noShowFee', { amount: money(policy.noShow, locale) })}</li>}
        {policy.noShowPercent ? <li>{t('noShowFeePercent', { percent: policy.noShowPercent })}</li> : null}
      </ul>
    </div>
  );
}

function SandboxPay(props: { payment: PaymentInfo; label: string; onDone: (r: PaymentResult) => void; disabled?: boolean; beforePay: () => Promise<string | null> }) {
  const t = useTranslations('payment');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      {err && <p role="alert" className="text-sm font-semibold text-danger">{err}</p>}
      <button
        type="button"
        className="btn btn-primary w-full sm:w-auto"
        disabled={props.disabled || busy}
        aria-busy={busy}
        data-testid="sandbox-pay"
        onClick={async () => {
          setErr(null);
          const consentErr = await props.beforePay();
          if (consentErr) { setErr(consentErr); return; }
          setBusy(true);
          if (!props.payment.id) { setBusy(false); props.onDone({ ok: true }); return; }
          const r = await call<{ payment: { state: string } }>('POST', `/public/payments/${props.payment.id}/sandbox-confirm`, { outcome: 'succeeded' });
          setBusy(false);
          if (!r.ok) props.onDone({ ok: false, message: r.error.message });
          else props.onDone({ ok: r.data.payment.state === 'succeeded', message: r.data.payment.state === 'succeeded' ? undefined : t('errors.generic') });
        }}
      >
        <Icon name="card" size={18} />{t('simulate', { label: props.label })}
      </button>
      <p className="flex items-center gap-1.5 text-xs text-graphite"><span className="rounded-full bg-warning-bg px-2 py-0.5 font-bold text-warning">{t('testMode')}</span>{t('sandboxNote')}</p>
    </div>
  );
}

function Unavailable({ business }: { business: string }) {
  const t = useTranslations('payment');
  return (
    <p role="alert" data-testid="card-unavailable" className="flex items-start gap-2 rounded-2xl bg-warning-bg p-4 text-sm text-warning">
      <Icon name="alert" size={18} />{business ? t('unavailable', { business }) : t('unavailableShort')}
    </p>
  );
}

function brandAppearance(): Appearance {
  if (typeof window === 'undefined') return { theme: 'stripe' };
  const css = getComputedStyle(document.documentElement);
  const brand = css.getPropertyValue('--site-brand').trim();
  return { theme: 'stripe', variables: { ...(brand ? { colorPrimary: brand } : {}), borderRadius: '12px', fontFamily: 'inherit' } };
}

/** Loads Stripe.js for the connected account; offline/blocked → friendly "unavailable" state. */
export function LiveElements({ publishableKey, stripeAccount, clientSecret, business, children }: { publishableKey: string; stripeAccount: string | null; clientSecret: string; business: string; children: ReactNode }) {
  const t = useTranslations('payment');
  const locale = useLocale();
  const [stripe, setStripe] = useState<Stripe | null | undefined>(undefined);
  const [elementFailed, setElementFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void getStripe(publishableKey, stripeAccount, locale).then((s) => { if (alive) setStripe(s); });
    return () => { alive = false; };
  }, [publishableKey, stripeAccount, locale]);
  const options = useMemo(() => ({ clientSecret, appearance: brandAppearance(), locale: locale as never }), [clientSecret, locale]);
  return (
    <div data-testid="payment-element-container" className="space-y-2">
      <p className="text-sm font-bold">{t('cardDetails')}</p>
      {stripe === undefined && <div className="h-28 animate-pulse rounded-2xl bg-canvas" role="status" aria-label={t('loading')}><span className="sr-only">{t('loading')}</span></div>}
      {(stripe === null || elementFailed) && <Unavailable business={business} />}
      {stripe && !elementFailed && (
        <StripeErrorBoundary onError={() => setElementFailed(true)}>
          <Elements stripe={stripe} options={options}>
            <ElementFailureContext.Provider value={() => setElementFailed(true)}>{children}</ElementFailureContext.Provider>
          </Elements>
        </StripeErrorBoundary>
      )}
      <p className="flex items-center gap-1.5 text-xs text-graphite"><Icon name="lock" size={14} />{t('secure', { business: business || 'The business' })}</p>
    </div>
  );
}

const ElementFailureContext = createContext<() => void>(() => {});

/** Stripe.js throws integration errors (bad key, rejected client secret) while rendering Elements: show "unavailable", not a crashed page. */
class StripeErrorBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.warn('[payments] card form failed to load', err); this.props.onError(); }
  render() { return this.state.failed ? null : this.props.children; }
}

function LivePayForm(props: { business: string; label: string; disabled?: boolean; returnUrl?: string; beforePay: () => Promise<string | null>; afterConfirm: () => Promise<PaymentResult>; onDone: (r: PaymentResult) => void }) {
  const t = useTranslations('payment');
  const stripe = useStripe();
  const elements = useElements();
  const failed = useContext(ElementFailureContext);
  const [busy, setBusy] = useState<'idle' | 'paying' | 'confirming'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);

  async function pay() {
    if (!stripe || !elements) return;
    setErr(null);
    const consentErr = await props.beforePay();
    if (consentErr) { setErr(consentErr); return; }
    setBusy('paying');
    const submitted = await elements.submit();
    if (submitted.error) { setBusy('idle'); setErr(submitted.error.message ?? t(paymentErrorKey(submitted.error))); return; }
    const returnUrl = props.returnUrl ? new URL(props.returnUrl, window.location.href).toString() : window.location.href;
    const { error, paymentIntent } = await stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: returnUrl } });
    if (error) {
      setBusy('idle');
      const key = paymentErrorKey(error);
      setErr(key === 'errors.generic' && error.message ? error.message : t(key));
      return;
    }
    if (paymentIntent && ['succeeded', 'processing', 'requires_capture'].includes(paymentIntent.status)) {
      setBusy('confirming');
      const r = await props.afterConfirm();
      setBusy('idle');
      if (r.pending) { setPending(true); return; }
      props.onDone(r);
      return;
    }
    setBusy('idle');
    setErr(t('errors.generic'));
  }

  return (
    <div className="space-y-3">
      <PaymentElement
        options={{ layout: 'tabs', wallets: { applePay: 'auto', googlePay: 'auto' } }}
        onReady={() => setReady(true)}
        onLoadError={() => failed()}
      />
      {err && <p role="alert" className="text-sm font-semibold text-danger">{err}</p>}
      {pending && (
        <div role="status" className="rounded-2xl bg-warning-bg p-3 text-sm text-warning">
          <p>{t('pending')}</p>
          <button type="button" className="btn btn-secondary mt-2" onClick={async () => { setPending(false); setBusy('confirming'); const r = await props.afterConfirm(); setBusy('idle'); if (r.pending) setPending(true); else props.onDone(r); }}>{t('checkAgain')}</button>
        </div>
      )}
      <button type="button" className="btn btn-primary w-full sm:w-auto" disabled={props.disabled || !ready || busy !== 'idle' || pending} aria-busy={busy !== 'idle'} onClick={pay} data-testid="card-pay">
        <Icon name="card" size={18} />{busy === 'paying' ? t('processing') : busy === 'confirming' ? t('confirming', { business: props.business }) : props.label}
      </button>
      <p className="text-xs text-graphite">{t('wallets')}</p>
    </div>
  );
}
