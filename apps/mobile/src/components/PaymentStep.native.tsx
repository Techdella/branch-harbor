// iOS / Android: Stripe PaymentSheet. The publishable key and the location's connected account (direct charges) come
// from the API per payment; EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY is only a fallback for builds against an older API.
import { useState, type ReactNode } from 'react';
import { initPaymentSheet, initStripe, presentPaymentSheet, StripeProvider } from '@stripe/stripe-react-native';
import { useI18n } from '@/i18n';
import { usePaymentsSandbox } from '@/lib/api';
import { RETURN_URL } from '@/lib/cardPayment.shared';
import { env, paymentsConfigured } from '@/lib/env';
import { Banner } from './Banner';
import { Button } from './Button';
import { SecureNote, type PaymentStepProps } from './PaymentStep.shared';

export type { PaymentStepProps };

const MERCHANT_ID = process.env.EXPO_PUBLIC_STRIPE_MERCHANT_IDENTIFIER || 'merchant.com.branchharbor.app';

function StripePay({ label, createIntent, onPaid, disabled }: PaymentStepProps) {
  const { t } = useI18n();
  const sandbox = usePaymentsSandbox();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const simulate = sandbox;
  return (
    <>
      {error ? <Banner tone="danger" title={t('pay.failed')} body={`${error} ${t('pay.failedBody')}`} /> : null}
      <Button
        label={simulate ? `${label} · ${t('pay.simulate')}` : label}
        size="lg"
        disabled={disabled}
        loading={busy}
        loadingLabel={t('pay.processing')}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            const intent = await createIntent();
            // Sandbox API: the server simulates the provider through the same webhook processor.
            if (intent.sandbox) { await onPaid(undefined); return; }
            const pk = intent.publishableKey || env.stripePublishableKey;
            if (!pk?.startsWith('pk_')) throw new Error(t('pay.unavailable'));
            await initStripe({ publishableKey: pk, ...(intent.stripeAccountId ? { stripeAccountId: intent.stripeAccountId } : {}), merchantIdentifier: MERCHANT_ID, urlScheme: 'branchharbor' });
            const country = intent.merchantCountry ?? 'US';
            const init = await initPaymentSheet({
              merchantDisplayName: intent.merchantDisplayName,
              paymentIntentClientSecret: intent.clientSecret,
              ...(intent.customerId && intent.ephemeralKey ? { customerId: intent.customerId, customerEphemeralKeySecret: intent.ephemeralKey } : {}),
              returnURL: RETURN_URL,
              applePay: { merchantCountryCode: country },
              googlePay: { merchantCountryCode: country, testEnv: pk.startsWith('pk_test_') },
            });
            if (init.error) throw new Error(init.error.localizedMessage ?? init.error.message);
            const res = await presentPaymentSheet();
            if (res.error) {
              if (res.error.code !== 'Canceled') setError(res.error.localizedMessage ?? res.error.message);
              return;
            }
            // The caller waits for the API (signed webhook) before showing the booking/order as paid.
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
  return (
    <>
      <StripePay {...props} />
      <SecureNote />
    </>
  );
}

export function PaymentsProvider({ children }: { children: ReactNode }) {
  // initStripe() is called per payment with the API's key and connected account; the provider only needs a key to mount.
  if (!paymentsConfigured) return <>{children}</>;
  return (
    <StripeProvider publishableKey={env.stripePublishableKey} merchantIdentifier={MERCHANT_ID} urlScheme="branchharbor">
      <>{children}</>
    </StripeProvider>
  );
}
