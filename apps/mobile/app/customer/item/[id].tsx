import { useMemo, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Badge, Button, Card, Icon, IconButton, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { useCart } from '@/features/customer/cart';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { ModifierGroup } from '@/lib/types';
import { color, radius, status, MIN_TARGET } from '@/theme';

export default function ItemScreen() {
  const { id, locationId } = useLocalSearchParams<{ id: string; locationId: string }>();
  const { t, intlLocale } = useI18n();
  const cart = useCart();
  const menuQ = useApi(() => api.menu(String(locationId)), [locationId]);
  const item = menuQ.data?.find((m) => m.id === id);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [showErrors, setShowErrors] = useState(false);

  const unit = useMemo(() => {
    if (!item) return null;
    const opts = item.modifierGroups.flatMap((g) => g.options).filter((o) => Object.values(sel).flat().includes(o.id));
    return { amount: item.price.amount + opts.reduce((a, o) => a + o.price.amount, 0), currency: item.price.currency };
  }, [item, sel]);

  if (!item || !unit) return <Screen tabs={false}><ScreenHeader title="" back /><SkeletonCard lines={5} /></Screen>;

  const missing = item.modifierGroups.filter((g) => (sel[g.id]?.length ?? 0) < g.min);
  const toggle = (g: ModifierGroup, optId: string) => {
    setSel((prev) => {
      const cur = prev[g.id] ?? [];
      if (g.max === 1) return { ...prev, [g.id]: [optId] };
      if (cur.includes(optId)) return { ...prev, [g.id]: cur.filter((x) => x !== optId) };
      if (cur.length >= g.max) return prev;
      return { ...prev, [g.id]: [...cur, optId] };
    });
  };

  return (
    <Screen tabs={false} footer={
      <Button
        size="lg"
        label={t('order.addToCart', { amount: fmtMoney({ ...unit, amount: unit.amount * qty }, intlLocale) })}
        onPress={() => {
          if (missing.length) return setShowErrors(true);
          const optionIds = Object.values(sel).flat();
          const optionNames = item.modifierGroups.flatMap((g) => g.options).filter((o) => optionIds.includes(o.id)).map((o) => o.name);
          cart.add(String(locationId), { itemId: item.id, name: item.name, quantity: qty, optionIds, optionNames, unitPrice: unit });
          router.back();
        }}
      />
    }>
      <ScreenHeader title={item.name} back />
      <Image source={{ uri: item.image }} style={{ width: '100%', height: 180, borderRadius: radius.xl }} accessibilityIgnoresInvertColors />
      <Text tone="muted">{item.description}</Text>
      {item.dietary.length ? <Text variant="small" tone="muted">{item.dietary.join(' · ')}</Text> : null}

      {item.modifierGroups.map((g) => {
        const bad = showErrors && (sel[g.id]?.length ?? 0) < g.min;
        return (
          <Card key={g.id} style={bad ? { borderWidth: 2, borderColor: status.danger.fg } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="h3" style={{ flex: 1 }} accessibilityRole="header">{g.name}</Text>
              <Badge label={g.min > 0 ? (g.max === 1 ? t('order.chooseOne') : t('order.required')) : t('order.optional')} tone={bad ? 'danger' : g.min > 0 ? 'info' : 'neutral'} icon={g.min > 0 ? 'info' : 'plus'} />
            </View>
            {g.options.map((o) => {
              const on = sel[g.id]?.includes(o.id) ?? false;
              return (
                <Pressable
                  key={o.id}
                  disabled={o.soldOut}
                  onPress={() => toggle(g, o.id)}
                  accessibilityRole={g.max === 1 ? 'radio' : 'checkbox'}
                  accessibilityState={{ checked: on, disabled: !!o.soldOut }}
                  accessibilityLabel={`${o.name}${o.price.amount ? `, +${fmtMoney(o.price, intlLocale)}` : ''}${o.soldOut ? `, ${t('order.soldOut')}` : ''}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: MIN_TARGET + 4, opacity: o.soldOut ? 0.45 : 1 }}
                >
                  <View style={{ width: 24, height: 24, borderRadius: g.max === 1 ? 12 : 7, borderWidth: 2, borderColor: color.ink, backgroundColor: on ? color.ink : color.surface, alignItems: 'center', justifyContent: 'center' }}>
                    {on ? <Icon name="check" size={14} color={color.surface} strokeWidth={2.8} /> : null}
                  </View>
                  <Text style={{ flex: 1 }} weight={600}>{o.name}{o.soldOut ? ` · ${t('order.soldOut')}` : ''}</Text>
                  {o.price.amount ? <Text variant="small" tone="muted" tabular>+{fmtMoney(o.price, intlLocale)}</Text> : null}
                </Pressable>
              );
            })}
            {bad ? <Text variant="small" weight={700} color={status.danger.fg} accessibilityRole="alert">{t('order.fieldRequired')}</Text> : null}
          </Card>
        );
      })}

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
        <IconButton icon="minus" label={`−1 ${item.name}`} onPress={() => setQty((q) => Math.max(1, q - 1))} disabled={qty <= 1} variant="secondary" />
        <Text variant="h2" tabular accessibilityLiveRegion="polite">{qty}</Text>
        <IconButton icon="plus" label={`+1 ${item.name}`} onPress={() => setQty((q) => Math.min(20, q + 1))} variant="secondary" />
      </View>
    </Screen>
  );
}
