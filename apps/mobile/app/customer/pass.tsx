import { View } from 'react-native';
import { Badge, Banner, Card, DataStatus, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { studioApi } from '@/features/studios/api';
import { BuyButton, useIsGuest } from '@/features/studios/components';
import { useI18n } from '@/i18n';
import { fmtDay, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { Money } from '@bh/shared';
import { pastel } from '@/theme';

/** Packs & membership: my credits and membership, and what this studio sells (in its own currency). */
export default function Pass() {
  const { t, intlLocale } = useI18n();
  const { location } = useCatalog();
  const guest = useIsGuest();
  const lid = location?.id ?? '';
  const mine = useApi(() => (guest || !lid ? Promise.resolve(null) : studioApi.entitlements(lid)), [lid, guest]);
  const pricing = useApi(() => (lid ? studioApi.pricing(lid) : Promise.resolve(null)), [lid]);
  const m = (x: { amount: number; currency: string }) => fmtMoney(x as Money, intlLocale);
  const refresh = () => { void mine.refresh(); };
  if (!location) return <Screen tabs={false}><SkeletonCard /></Screen>;
  return (
    <Screen tabs={false} onRefresh={mine.refresh} refreshing={mine.refreshing}>
      <ScreenHeader back title={t('studio.passTitle')} scope={{ label: location.name, icon: 'pin' }} />
      {guest ? <Banner tone="info" icon="user" title={t('studio.signInForCredits')} /> : (
        <>
          <DataStatus q={mine} />
          {mine.data ? (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Card bg={pastel.lilac} style={{ flex: 1 }}>
                <Text variant="label">{t('studio.credits')}</Text>
                <Text variant="h1" tabular>{mine.data.credits.available}</Text>
                {mine.data.packs.filter((p) => p.status === 'active').map((p) => <Text key={p.id} variant="small">{p.name}: {t('studio.creditsLeft', { n: p.creditsRemaining })}{p.expiresAt ? ` · ${t('studio.expires', { date: fmtDay(p.expiresAt, location.timeZone, intlLocale) })}` : ''}</Text>)}
              </Card>
              <Card bg={pastel.butter} style={{ flex: 1 }}>
                <Text variant="label">{t('studio.membership')}</Text>
                {mine.data.memberships.length === 0 ? <Text tone="muted">{t('studio.none')}</Text> : mine.data.memberships.map((x) => (
                  <View key={x.id} style={{ gap: 4 }}>
                    <Text weight={700}>{x.name}</Text>
                    <Badge label={t(`studio.state.${x.state}`)} tone={x.state === 'active' ? 'success' : x.state === 'grace' || x.state === 'cancelling' ? 'warning' : 'neutral'} icon={x.state === 'active' ? 'check-circle' : 'info'} />
                    {x.usage?.limit ? <Text variant="small">{t('studio.usage', { used: x.usage.used, limit: x.usage.limit })}</Text> : null}
                  </View>
                ))}
              </Card>
            </View>
          ) : mine.loading ? <SkeletonCard /> : null}
          {mine.data?.fees.length ? <Banner tone="warning" title={t('studio.feesDue', { n: mine.data.fees.length })} /> : null}
        </>
      )}

      <DataStatus q={pricing} />
      {pricing.data && !pricing.data.location.paymentsEnabled ? <Banner tone="warning" title={t('studio.notSellable')} /> : null}
      {pricing.data?.offers.length ? <SectionHeader title={t('studio.offers')} /> : null}
      {pricing.data?.offers.map((o) => (
        <Card key={o.id}>
          <Text variant="h3">{o.name}</Text>
          <Text>{m(o.price)} · {o.credits ? t('studio.creditsValid', { n: o.credits, days: o.validDays }) : t('studio.days', { n: o.validDays })}{o.newCustomersOnly ? ` · ${t('studio.newOnly')}` : ''}</Text>
          {!guest ? <BuyButton locationId={location.id} kind="offer" id={o.id} label={t('studio.getOffer')} onDone={refresh} /> : null}
        </Card>
      ))}
      <SectionHeader title={t('studio.memberships')} />
      {pricing.data?.memberships.map((p) => (
        <Card key={p.id}>
          <Text variant="h3">{p.name}</Text>
          <Text>{m(p.price)} / {t('studio.month')} · {p.classesPerPeriod ? t('studio.perMonth', { n: p.classesPerPeriod }) : t('studio.unlimited')}</Text>
          <Text variant="small" tone="muted">{[p.access, ...p.terms].join(' · ')}</Text>
          {!guest ? <BuyButton locationId={location.id} kind="membership" id={p.id} label={t('studio.join')} onDone={refresh} /> : null}
        </Card>
      ))}
      <SectionHeader title={t('studio.packs')} />
      {pricing.data?.packs.map((p) => (
        <Card key={p.id}>
          <Text variant="h3">{p.name}</Text>
          <Text>{m(p.price)} · {t('studio.creditsValid', { n: p.credits, days: p.validityDays })}</Text>
          <Text variant="small" tone="muted">{p.access}</Text>
          {!guest ? <BuyButton locationId={location.id} kind="pack" id={p.id} label={t('studio.buy')} onDone={refresh} /> : null}
        </Card>
      ))}
      {pricing.data ? (
        <Card>
          <Text weight={700}>{t('studio.policy')}</Text>
          {pricing.data.policy.lines.map((l) => <Text key={l} variant="small" tone="muted">• {l}</Text>)}
        </Card>
      ) : null}
    </Screen>
  );
}
