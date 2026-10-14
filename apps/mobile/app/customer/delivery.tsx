import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Banner, Button, Card, EmptyState, MoneyText, Screen, ScreenHeader, Text, TextField } from '@/components';
import { useCart } from '@/features/customer/cart';
import { useCatalog } from '@/features/customer/catalog';
import { foodsApi, type DeliveryQuote } from '@/features/foods/api';
import { useI18n } from '@/i18n';
import { ApiError } from '@/lib/errors';
import { fmtMoney, fmtTime, fmtZone } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import { color, radius } from '@/theme';

/** Delivery checkout for the current cart: address → zone/minimum/fee check → delivery time → server quote → place. */
export default function DeliveryCheckout() {
  const { t, intlLocale } = useI18n();
  const { me } = useSession();
  const cart = useCart();
  const { locationById } = useCatalog();
  const loc = cart.locationId ? locationById(cart.locationId) : undefined;
  const slots = useApi(() => (loc ? foodsApi.deliverySlots(loc.id) : Promise.resolve([])), [loc?.id]);
  const [addr, setAddr] = useState({ line1: '', city: '', postalCode: '' });
  const [slotId, setSlotId] = useState<string | null>(null);
  const [name, setName] = useState(me?.guest ? '' : me?.user.name ?? '');
  const [email, setEmail] = useState(me?.guest ? '' : me?.user.email ?? '');
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  if (!loc || !cart.lines.length) return <Screen tabs={false}><ScreenHeader title={t('foodsx.deliveryTitle')} back /><EmptyState icon="cart" title={t('order.emptyCart')} /></Screen>;
  const body = () => ({ slotId: slotId!, address: addr, lines: cart.toInput() });
  return (
    <Screen tabs={false}>
      <ScreenHeader title={t('foodsx.deliveryTitle')} back scope={{ label: loc.name, sub: loc.address, icon: 'store' }} />
      {err ? <Banner tone="danger" title={err} /> : null}
      {done ? <Banner tone="success" title={done} action={t('common.done')} onAction={() => { cart.clear(); router.replace('/customer/home'); }} /> : null}
      <Card>
        <TextField label={t('foodsx.address')} value={addr.line1} onChangeText={(v) => { setAddr({ ...addr, line1: v }); setQuote(null); }} autoComplete="street-address" />
        <TextField label={t('foodsx.city')} value={addr.city} onChangeText={(v) => { setAddr({ ...addr, city: v }); setQuote(null); }} />
        <TextField label={t('foodsx.postcode')} value={addr.postalCode} onChangeText={(v) => { setAddr({ ...addr, postalCode: v }); setQuote(null); }} autoComplete="postal-code" />
      </Card>
      <Text weight={700}>{t('foodsx.chooseSlot')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {(slots.data ?? []).filter((s) => s.available).slice(0, 12).map((s) => (
          <Pressable key={s.id} accessibilityRole="button" accessibilityState={{ selected: slotId === s.id }} onPress={() => { setSlotId(s.id); setQuote(null); }}
            style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: slotId === s.id ? color.ink : color.surface }}>
            <Text weight={700} color={slotId === s.id ? color.surface : color.ink}>{fmtTime(s.startsAt, loc.timeZone, intlLocale)}</Text>
          </Pressable>
        ))}
      </View>
      <Text variant="small" tone="muted">{fmtZone(loc.timeZone, intlLocale)}</Text>
      <Button label={t('foodsx.getQuote')} variant="secondary" disabled={!slotId || !addr.line1 || !addr.postalCode} loading={busy && !quote}
        onPress={async () => { setBusy(true); setErr(null); try { setQuote(await foodsApi.deliveryQuote(loc.id, body())); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); } }} />
      {quote ? (
        <Card>
          <Row label={t('order.subtotal')} value={<MoneyText value={quote.subtotal} />} />
          {quote.deliveryFee ? <Row label={t('foodsx.deliveryFee')} value={<MoneyText value={quote.deliveryFee} />} /> : null}
          {quote.tax ? <Row label={t('order.tax')} value={<MoneyText value={quote.tax} tone="muted" />} /> : null}
          <Row label={t('order.total')} value={<MoneyText value={quote.total} variant="h3" />} />
          {quote.zone ? <Text variant="small" tone="muted">{quote.zone.name} · {t('foodsx.minimum', { amount: fmtMoney(quote.zone.minimumOrder, intlLocale) })}</Text> : null}
          <TextField label={t('order.name')} value={name} onChangeText={setName} autoComplete="name" />
          <TextField label={t('foodsx.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
          <Button label={t('foodsx.place', { amount: fmtMoney(quote.total, intlLocale) })} disabled={!name.trim() || !/\S+@\S+\.\S+/.test(email) || !!done} loading={busy}
            onPress={async () => { setBusy(true); setErr(null); try { const r = await foodsApi.placeDelivery(loc.id, { ...body(), name, email, expectedTotalMinor: quote.total.amount }); setDone(t('foodsx.placed', { number: r.orderNumber })); } catch (e) { setErr((e as ApiError).message); } finally { setBusy(false); } }} />
        </Card>
      ) : null}
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text>{label}</Text>{value}</View>;
}
