import { useState } from 'react';
import { View } from 'react-native';
import { useI18n } from '@/i18n';
import { updateCard } from '@/lib/cardPayment';
import { http } from '@/lib/http';
import { useApi } from '@/lib/useApi';
import { Banner } from './Banner';
import { Button } from './Button';
import { Card } from './Card';
import { Text } from './Text';

interface CardOnFile { card: { brand: string | null; last4: string | null; expMonth: number | null; expYear: number | null; sandbox: boolean } | null; purposes: string[]; config: { merchantDisplayName: string; mode: 'live' | 'sandbox' } }

/**
 * Saved card at a location for signed-in customers: shows the card on file and adds/updates it with a SetupIntent in
 * PaymentSheet (iOS/Android; sandbox: simulated). The new card becomes the default for renewals and agreed fees, and a
 * failed renewal is retried with it by the server after Stripe's signed webhook.
 */
export function SavedCard({ locationId }: { locationId: string }) {
  const { t } = useI18n();
  const q = useApi(() => http<CardOnFile>('GET', `/me/payment-methods?locationId=${locationId}`), [locationId]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const d = q.data;
  const business = d?.config.merchantDisplayName ?? '';
  return (
    <Card>
      <Text weight={700}>{t('pay.savedCard')}</Text>
      <Text tone="muted">{d?.card ? t('pay.cardOnFile', { brand: (d.card.brand ?? 'card').toUpperCase(), last4: d.card.last4 ?? '••••' }) : t('pay.noCard')}</Text>
      {msg ? <Banner tone={msg.ok ? 'success' : 'danger'} title={msg.text} /> : null}
      <View style={{ gap: 6 }}>
        <Text variant="small" tone="muted">{t('pay.updateConsent', { business })}</Text>
        <Button
          size="sm"
          label={d?.card ? t('pay.updateCard') : t('pay.addCard')}
          icon="card"
          loading={busy}
          onPress={async () => {
            setBusy(true);
            setMsg(null);
            try {
              const r = await updateCard(locationId, t('pay.updateConsent', { business }), t);
              if (r.ok) { setMsg({ ok: true, text: t('pay.cardSaved') }); setTimeout(() => void q.refresh(), 1500); }
              else if (!r.cancelled) setMsg({ ok: false, text: r.message });
            } catch (e) {
              setMsg({ ok: false, text: (e as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        />
      </View>
    </Card>
  );
}
