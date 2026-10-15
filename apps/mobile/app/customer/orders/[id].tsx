import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, Card, DataStatus, Icon, MoneyText, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { useCart } from '@/features/customer/cart';
import { useState } from 'react';
import { orderStatusCopy } from '@/features/customer/orderStatus';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fmtTime, fmtZone } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { color, pastel, radius, status as S } from '@/theme';

export default function OrderStatus() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, intlLocale } = useI18n();
  const { locationById, brand } = useCatalog();
  const q = useApi(() => api.order(String(id)), [id], { pollMs: 4000 });
  const cart = useCart();
  const [reorderMsg, setReorderMsg] = useState<string | null>(null);
  const o = q.data;
  const loc = o ? locationById(o.locationId) : undefined;

  if (!o || !loc) return <Screen tabs={false}><ScreenHeader title="" back /><DataStatus q={q} /><SkeletonCard lines={5} /></Screen>;

  const pickup = `${fmtTime(o.pickupAt, loc.timeZone, intlLocale)} ${fmtZone(loc.timeZone, intlLocale)}`;
  const c = orderStatusCopy(o, t, pickup, `${brand?.name ?? ''} ${loc.name}`.trim());
  const steps = [t('order.stepSent'), t('order.stepAccepted'), t('order.stepPreparing'), t('order.stepReady')];
  const s = S[c.tone];

  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('order.orderNo', { number: o.number })} back scope={{ label: `${brand?.name ?? ''} ${loc.name}`, sub: loc.address, icon: 'store' }} />
      <DataStatus q={q} />

      <View accessibilityRole="summary" accessibilityLiveRegion="polite" style={{ backgroundColor: s.bg, borderColor: s.border, borderWidth: 1.5, borderRadius: radius.card, padding: 18, gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={c.icon} size={22} color={s.fg} />
          </View>
          <Text variant="h2" color={s.fg} style={{ flex: 1 }}>{c.title}</Text>
        </View>
        <Text color={s.fg}>{c.body}</Text>
      </View>

      {c.step >= 0 ? (
        <Card>
          {steps.map((label, i) => {
            const done = i <= c.step;
            return (
              <View key={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 40 }} accessible accessibilityLabel={`${label}: ${done ? t('common.done') : t('common.pending')}`}>
                <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: done ? color.lime : color.canvas, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={done ? 'check' : 'clock'} size={15} />
                </View>
                <Text weight={i === c.step ? 800 : 500} style={{ flex: 1 }}>{label}</Text>
              </View>
            );
          })}
        </Card>
      ) : null}

      <Card bg={pastel.sand}>
        <Text variant="label" tone="muted">{t('order.pickupFrom', { location: loc.name })}</Text>
        <Text variant="h3">{pickup}</Text>
        <Text variant="small" tone="muted">{loc.address}</Text>
      </Card>

      <Card>
        {o.lines.map((l, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text weight={700}>{l.quantity}× {l.name}</Text>
              {l.options.length ? <Text variant="small" tone="muted">{l.options.join(' · ')}</Text> : null}
            </View>
            <MoneyText value={l.lineTotal} />
          </View>
        ))}
        <View style={{ height: 1, backgroundColor: color.lineSoft }} />
        {o.tax && o.taxLabel ? (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text tone="muted">{o.taxInclusive ? t('order.taxIncluded', { label: o.taxLabel }) : o.taxLabel}</Text>
            <MoneyText value={o.tax} tone="muted" />
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text weight={800}>{t('order.total')}</Text>
          <MoneyText value={o.total} variant="h3" />
        </View>
        <Text variant="small" tone="muted">{t('order.taxNote')}</Text>
      </Card>
      {reorderMsg ? <Text variant="small" tone="muted">{reorderMsg}</Text> : null}
      <Button label={t('foodsx.reorder')} icon="repeat" onPress={async () => {
        // Re-price against today's menu: unavailable items or options are skipped and reported, never silently added.
        const menu = await api.menu(o.locationId);
        let added = 0; let missing = 0;
        for (const l of o.lines) {
          const it = menu.find((x) => x.id === l.itemId && !x.soldOut);
          const opts = it ? it.modifierGroups.flatMap((g) => g.options).filter((op) => l.options.includes(op.name) && !op.soldOut) : [];
          if (!it || opts.length !== l.options.length) { missing++; continue; }
          cart.add(o.locationId, { itemId: it.id, name: it.name, quantity: l.quantity, optionIds: opts.map((x) => x.id), optionNames: opts.map((x) => x.name), unitPrice: { amount: it.price.amount + opts.reduce((a, x) => a + x.price.amount, 0), currency: it.price.currency } });
          added += l.quantity;
        }
        setReorderMsg([t('foodsx.reorderAdded', { count: added }), missing ? t('foodsx.reorderMissing', { count: missing }) : ''].filter(Boolean).join(' '));
        if (added) router.push('/customer/order');
      }} />
      <Button label={t('common.done')} variant="secondary" onPress={() => router.replace('/customer/home')} />
    </Screen>
  );
}
