import { View } from 'react-native';
import type { Money } from '@bh/shared';
import { useI18n } from '@/i18n';
import { env } from '@/lib/env';
import { Banner } from './Banner';
import { Button } from './Button';
import { Text } from './Text';
import { Icon } from './Icon';
import { color } from '@/theme';

export interface PaymentStepProps {
  amount: Money;
  /** Button label, e.g. "Pay CA$28.00 and book". */
  label: string;
  /** Asks the API for a PaymentIntent (client secret) for this booking/order. */
  createIntent: () => Promise<{ clientSecret: string; merchantDisplayName: string; customerId?: string; ephemeralKey?: string }>;
  /** Called after the payment sheet succeeds; the server confirms via signed Stripe webhooks. */
  onPaid: (paymentIntentId?: string) => Promise<void>;
  disabled?: boolean;
  busyLabel?: string;
}

/** Shown when Stripe isn't available: explains clearly and (in dev/mock builds only) offers a simulated payment. */
export function PaymentFallback({ label, onPaid, disabled, busy, setBusy, reason }: PaymentStepProps & { busy: boolean; setBusy: (b: boolean) => void; reason: 'not_configured' | 'web' }) {
  const { t } = useI18n();
  const canSimulate = env.useMocks || __DEV__;
  return (
    <View style={{ gap: 10 }}>
      <Banner tone="info" icon="card" title={reason === 'web' ? t('pay.title') : t('pay.notConfigured')} body={reason === 'web' ? t('pay.webUnsupported') : t('pay.notConfiguredBody')} />
      <Button
        label={canSimulate ? `${label} · ${t('pay.simulate')}` : label}
        size="lg"
        disabled={disabled || !canSimulate}
        loading={busy}
        loadingLabel={t('pay.processing')}
        onPress={async () => {
          setBusy(true);
          try {
            await onPaid(undefined);
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
  );
}

export function SecureNote() {
  const { t } = useI18n();
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <Icon name="lock" size={14} color={color.stone} />
      <Text variant="small" tone="muted" style={{ flex: 1 }}>{t('pay.secure')}</Text>
    </View>
  );
}
