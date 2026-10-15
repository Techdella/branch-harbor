'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Stripe } from '@stripe/stripe-js';
import { loadStripe } from '@stripe/stripe-js/pure';
import { Badge, Button, Field, Select } from '@bh/ui';
import type { SetupInfo } from '@/lib/billing';
import { Banner } from '../../ui/States';

export type CardResult = { setupIntentId?: string; paymentMethodId?: string };

const stripeCache = new Map<string, Promise<Stripe | null>>();
function getStripe(pk: string, locale: string) {
  const key = `${pk}|${locale}`;
  let p = stripeCache.get(key);
  if (!p) {
    p = loadStripe(pk, { locale: (locale.split('-')[0] ?? 'auto') as 'auto' }).catch(() => null);
    stripeCache.set(key, p);
  }
  return p;
}

/**
 * Card entry for BranchHarbor plan billing (the same Stripe Payment Element pattern as the hosted sites' CardPayment,
 * on the platform account): a SetupIntent saves the card off-session and the API reads its issuing country to check the
 * billing-country lock. In sandbox (API without Stripe keys) the card is simulated: pick the country it was issued in.
 */
export function CardEntry({ setup, country, countries, submitLabel, onCard, disabled }: {
  setup: SetupInfo; country: string; countries: { code: string; name: string }[]; submitLabel: string; disabled?: boolean;
  onCard: (r: CardResult) => Promise<void>;
}) {
  const t = useTranslations('billing.card');
  const locale = useLocale();
  const [cardCountry, setCardCountry] = useState(country);
  const [busy, setBusy] = useState(false);
  const stripe = useMemo(() => (setup.mode === 'live' && setup.publishableKey ? getStripe(setup.publishableKey, locale) : null), [setup.mode, setup.publishableKey, locale]);

  if (setup.mode === 'sandbox') {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-line p-4" data-testid="card-entry" data-mode="sandbox">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-bold">{t('title')}</span>
          <Badge tone="warning" icon="info">{t('sandbox')}</Badge>
        </div>
        <p className="text-xs text-stone">{t('sandboxNote')}</p>
        <Field label={t('issuedIn')}>
          {(p) => (
            <Select id={p.id} value={cardCountry} onChange={(e) => setCardCountry(e.target.value)} data-testid="card-country">
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          variant="signal"
          loading={busy}
          disabled={disabled}
          onClick={async () => {
            setBusy(true);
            try {
              await onCard({ paymentMethodId: `pm_sandbox_card_${cardCountry}_${Math.random().toString(36).slice(2, 10)}` });
            } finally {
              setBusy(false);
            }
          }}
        >
          {submitLabel}
        </Button>
      </div>
    );
  }
  if (!stripe || !setup.clientSecret) return <Banner tone="warning">{t('unavailable')}</Banner>;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line p-4" data-testid="card-entry" data-mode="live">
      <span className="text-sm font-bold">{t('title')}</span>
      <Elements stripe={stripe} options={{ clientSecret: setup.clientSecret, appearance: { theme: 'stripe' } }}>
        <LiveForm submitLabel={submitLabel} disabled={disabled} onCard={onCard} />
      </Elements>
    </div>
  );
}

function LiveForm({ submitLabel, disabled, onCard }: { submitLabel: string; disabled?: boolean; onCard: (r: CardResult) => Promise<void> }) {
  const t = useTranslations('billing.card');
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && <Banner tone="danger" live="assertive">{error}</Banner>}
      <Button
        variant="signal"
        loading={busy}
        disabled={disabled || !stripe || !elements}
        onClick={async () => {
          if (!stripe || !elements) return;
          setBusy(true);
          setError(null);
          try {
            const r = await stripe.confirmSetup({ elements, redirect: 'if_required', confirmParams: { return_url: window.location.href } });
            if (r.error) setError(r.error.message ?? t('failed'));
            else if (r.setupIntent) await onCard({ setupIntentId: r.setupIntent.id });
          } finally {
            setBusy(false);
          }
        }}
      >
        {submitLabel}
      </Button>
    </div>
  );
}
