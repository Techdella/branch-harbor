import { useState } from 'react';
import { Linking, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Banner, Button, Card, Text } from '@/components';
import { useI18n } from '@/i18n';
import { policyLines } from './policy';
import { usePaymentsSandbox } from '@/lib/api';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { useApi } from '@/lib/useApi';
import { useSession } from '@/lib/session';
import { studioApi, type OccupancyRow, type PayWith } from './api';

export const useIsGuest = () => {
  const { me } = useSession();
  return !me || !!me.guest;
};

/** Buy a pack / membership / offer / online class: server price → (sandbox) payment → issued. */
export function BuyButton({ locationId, kind, id, label, onDone }: { locationId: string; kind: 'pack' | 'membership' | 'offer' | 'online'; id: string; label: string; onDone: () => void }) {
  const { t } = useI18n();
  const sandbox = usePaymentsSandbox();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <View style={{ gap: 6 }}>
      <Button label={label} size="sm" loading={busy} loadingLabel={t('pay.processing')} onPress={async () => {
        setBusy(true);
        setMsg(null);
        try {
          const r = await studioApi.buy(locationId, kind, id);
          if (r.payment) {
            if (!(r.payment.sandbox && (sandbox || env.useMocks || __DEV__))) { setMsg({ ok: false, text: t('studio.cardNotAvailable') }); return; }
            await studioApi.confirmSandbox(r.payment.id);
            for (let i = 0; i < 10; i++) { if ((await studioApi.purchaseStatus(r.purchase.id)).status === 'paid') break; await new Promise((x) => setTimeout(x, 700)); }
          }
          setMsg({ ok: true, text: t('studio.purchased') });
          onDone();
        } catch (e) {
          setMsg({ ok: false, text: (e as ApiError).message });
        } finally {
          setBusy(false);
        }
      }} />
      {msg ? <Text variant="small" color={msg.ok ? '#1E6B3A' : '#9E1B12'} accessibilityLiveRegion="polite">{msg.text}</Text> : null}
    </View>
  );
}

/** On the class screen: book with a membership or pack credit (signed-in customers), plus the cancellation policy. */
export function MemberBookCard({ occurrenceId, full, onBooked, beforeBook }: { occurrenceId: string; full: boolean; onBooked: () => void; beforeBook?: () => Promise<void> }) {
  const { t, intlLocale } = useI18n();
  const guest = useIsGuest();
  const q = useApi(() => (guest ? Promise.resolve(null) : studioApi.options(occurrenceId)), [occurrenceId, guest]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const o = q.data;
  if (guest) return <Banner tone="info" icon="user" title={t('studio.signInForCredits')} />;
  if (!o) return null;
  const choices: Array<{ key: string; label: string; payWith: PayWith; usable: boolean; reason: string | null }> = [
    ...o.memberships.map((m) => ({ key: m.id, label: m.usage?.limit ? `${m.name} · ${t('studio.usage', { used: m.usage.used, limit: m.usage.limit })}` : m.name, payWith: { kind: 'membership' as const, membershipId: m.id }, usable: m.usable, reason: m.reason })),
    ...o.credits.map((c) => ({ key: c.id, label: `${c.name} · ${t('studio.creditsLeft', { n: c.creditsRemaining })}`, payWith: { kind: 'credit' as const, packId: c.id }, usable: c.usable, reason: c.reason })),
  ];
  return (
    <Card>
      <Text variant="h3">{t('studio.bookWith')}</Text>
      {choices.length === 0 ? <Text tone="muted">{t('studio.noEntitlements')}</Text> : choices.map((c) => (
        <View key={c.key} style={{ gap: 4 }}>
          <Text weight={700}>{c.label}</Text>
          {c.usable ? (
            <Button label={full ? t('studio.joinWaitlistWith') : t('studio.bookWithThis')} size="sm" loading={busy} onPress={async () => {
              setBusy(true);
              setErr(null);
              try {
                // A seat held for card payment is released first, so the member booking isn't a duplicate.
                await beforeBook?.();
                await studioApi.book(occurrenceId, c.payWith, full);
                onBooked();
              } catch (e) {
                setErr((e as ApiError).code === 'duplicate_booking' ? t('studio.duplicate') : (e as ApiError).message);
              } finally {
                setBusy(false);
              }
            }} />
          ) : <Text variant="small" tone="muted">{t('studio.notUsable', { reason: c.reason ?? '' })}</Text>}
        </View>
      ))}
      {err ? <Text variant="small" color="#9E1B12" accessibilityRole="alert">{err}</Text> : null}
      <Text variant="small" weight={700}>{t('studio.policy')}</Text>
      {policyLines(o.policy, t, intlLocale).map((l) => <Text key={l} variant="small" tone="muted">• {l}</Text>)}
      <Button label={t('studio.getCredits')} variant="ghost" size="sm" onPress={() => router.push('/customer/pass')} />
    </Card>
  );
}

/** Owner pulse: forward occupancy (next 7 days) per studio location. */
export function StudioOccupancy() {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => studioApi.occupancy(), []);
  if (!q.data?.length) return null;
  return (
    <Card>
      <Text variant="h3">{t('studio.next7')}</Text>
      {q.data.map((r: OccupancyRow) => (
        <View key={r.locationId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1 }}>{r.locationName}</Text>
          <Text variant="small" tone="muted">{t('studio.classesN', { n: r.classes })}</Text>
          {r.occupancyPct === null ? <Badge label={t('common.unavailable')} /> : <Text weight={700} tabular>{new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 1 }).format(r.occupancyPct)}%</Text>}
        </View>
      ))}
      <Text variant="small" tone="muted">{t('studio.occupancyDef')}</Text>
    </Card>
  );
}

export const openUrl = (url: string) => Linking.openURL(url);
