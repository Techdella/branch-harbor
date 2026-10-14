import { useState } from 'react';
import { View } from 'react-native';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, MoneyText, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { foodsApi } from '@/features/foods/api';
import { useI18n } from '@/i18n';
import { ApiError } from '@/lib/errors';
import { useApi } from '@/lib/useApi';

/** Signed-in customer: weekly meal plans with skip / undo skip before each week's cut-off. */
export default function MealPlans() {
  const { t, intlLocale } = useI18n();
  const q = useApi(() => foodsApi.mySubscriptions(), []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(intlLocale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('foodsx.mealPlans')} back />
      <DataStatus q={q} />
      {err ? <Banner tone="danger" title={err} /> : null}
      {q.loading ? <SkeletonCard lines={4} /> : null}
      {!q.loading && !q.data?.length ? <EmptyState icon="repeat" title={t('foodsx.mealPlansEmpty')} /> : null}
      {q.data?.map((s) => (
        <Card key={s.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text variant="h3" style={{ flex: 1 }}>{s.planName}</Text>
            <Badge tone={s.status === 'active' ? 'success' : 'warning'} label={t(`foodsx.sstatus.${s.status}`)} />
          </View>
          <Text tone="muted">{s.locationName} · <MoneyText value={s.price} /></Text>
          {s.upcoming.map((w) => (
            <View key={w.weekStart} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}>
              <Text style={{ flex: 1 }} weight={600}>{day(w.fulfilmentDate)}</Text>
              <Badge tone={w.skipped ? 'warning' : 'neutral'} label={w.skipped ? t('foodsx.skipped') : t('foodsx.scheduled')} />
              {w.canChange ? (
                <Button size="sm" variant="secondary" label={w.skipped ? t('foodsx.unskip') : t('foodsx.skip')} loading={busy === s.id + w.weekStart}
                  onPress={async () => { setBusy(s.id + w.weekStart); setErr(null); try { const u = await foodsApi.skipWeek(s.id, w.weekStart, !w.skipped); q.setData((d) => d?.map((x) => (x.id === u.id ? u : x))); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(null); } }} />
              ) : <Text variant="small" tone="muted">{t('foodsx.locked')}</Text>}
            </View>
          ))}
        </Card>
      ))}
    </Screen>
  );
}
