// iOS / Android: Stripe PaymentSheet integration point. Gated on EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY.
import { useState, type ReactNode } from 'react';
import { StripeProvider, useStripe } from '@stripe/stripe-react-native';
import { useI18n } from '@/i18n';
import { env, paymentsConfigured } from '@/lib/env';
import { Banner } from './Banner';
import { Button } from './Button';
import { PaymentFallback, SecureNote, type PaymentStepProps } from './PaymentStep.shared';

export type { PaymentStepProps };

function StripePay({ amount: _amount, label, createIntent, onPaid, disabled }: PaymentStepProps) {
  const { t } = useI18n();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error ? <Banner tone="danger" title={t('pay.failed')} body={`${error} ${t('pay.failedBody')}`} /> : null}
      <Button
        label={label}
        size="lg"
        disabled={disabled}
        loading={busy}
        loadingLabel={t('pay.processing')}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            const intent = await createIntent();
            const init = await initPaymentSheet({
              merchantDisplayName: intent.merchantDisplayName,
              paymentIntentClientSecret: intent.clientSecret,
              customerId: intent.customerId,
              customerEphemeralKeySecret: intent.ephemeralKey,
              returnURL: 'branchharbor://stripe-redirect',
            });
            if (init.error) throw new Error(init.error.message);
            const res = await presentPaymentSheet();
            if (res.error) {
              if (res.error.code !== 'Canceled') setError(res.error.message);
              return;
            }
            await onPaid(intent.clientSecret.split('_secret_')[0]);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

export function PaymentStep(props: PaymentStepProps) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      {paymentsConfigured ? <StripePay {...props} /> : <PaymentFallback {...props} busy={busy} setBusy={setBusy} reason="not_configured" />}
      <SecureNote />
    </>
  );
}

export function PaymentsProvider({ children }: { children: ReactNode }) {
  if (!paymentsConfigured) return <>{children}</>;
  return (
    <StripeProvider publishableKey={env.stripePublishableKey} merchantIdentifier="merchant.com.branchharbor.app" urlScheme="branchharbor">
      <>{children}</>
    </StripeProvider>
  );
}
