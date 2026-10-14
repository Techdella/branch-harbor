import { useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, ListItem, MoneyText, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, TextField, type Tone } from '@/components';
import { commerce, type ShopProduct, type ShopStore, type ShopVariant } from '@/features/commerce/api';
import { useCt } from '@/features/commerce/strings';
import { fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

type Line = { variantId: string; name: string; quantity: number };
const BAND: Record<ShopVariant['availability'], { key: string; tone: Tone }> = { in_stock: { key: 'inStock', tone: 'success' }, low_stock: { key: 'lowStock', tone: 'warning' }, out_of_stock: { key: 'outOfStock', tone: 'danger' }, backorder: { key: 'backorder', tone: 'warning' }, not_stocked: { key: 'notHere', tone: 'neutral' } };

/** Customer shop: pick a store, browse with that store's stock, add to cart, check out for pickup, pay, track. */
export default function Shop() {
  const { ct, intlLocale } = useCt();
  const stores = useApi(() => commerce.stores(), []);
  const [store, setStore] = useState<ShopStore | null>(null);
  const cur = store ?? stores.data?.[0] ?? null;
  const sf = useApi(() => (cur ? commerce.storefront(cur) : Promise.resolve(null)), [cur?.id]);
  const products = useApi(() => (cur ? commerce.products(cur, intlLocale) : Promise.resolve([] as ShopProduct[])), [cur?.id, intlLocale]);
  const mine = useApi(() => commerce.myOrders(), []);
  const [cart, setCart] = useState<Line[]>([]);
  const [checkingOut, setCheckingOut] = useState(false);
  const [contact, setContact] = useState({ name: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const count = cart.reduce((a, l) => a + l.quantity, 0);
  const total = cart.reduce((a, l) => a + (products.data?.flatMap((p) => p.variants).find((v) => v.id === l.variantId)?.price?.amount ?? 0) * l.quantity, 0);
  const currency = cur?.currency ?? 'USD';

  async function place() {
    if (!cur) return;
    setBusy(true); setErr(null);
    try {
      const lines = cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
      const q = await commerce.quote(cur, lines);
      if (!q.ok) { setErr(q.issues[0]?.message ?? 'Unavailable'); return; }
      const r = await commerce.checkout(cur, lines, contact, q.total.amount);
      if (r.payment) await commerce.pay(r.payment, r.order.id).catch((e: Error) => setErr(e.message));
      setCart([]); setCheckingOut(false); mine.refresh();
      router.push({ pathname: '/shop/order', params: { id: r.order.id } });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Screen tabs={false} onRefresh={products.refresh} refreshing={products.refreshing} footer={count > 0 && !checkingOut ? <Button label={`${ct('cart', { n: count })} · ${fmtMoney({ amount: total, currency: currency as never }, intlLocale)}`} icon="cart" fullWidth onPress={() => setCheckingOut(true)} /> : undefined}>
      <ScreenHeader title={ct('shopTitle')} back scope={cur ? { label: cur.name, sub: ct('stockAt', { store: cur.name }), icon: 'store' } : undefined} />
      <DataStatus q={stores} />
      {(stores.data?.length ?? 0) > 1 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {stores.data!.map((s) => <Button key={s.id} size="sm" variant={cur?.id === s.id ? 'primary' : 'soft'} label={`${s.city} · ${s.currency}`} onPress={() => { setStore(s); setCart([]); }} />)}
        </View>
      )}
      {sf.data?.checkout.mode === 'external' ? (
        <Banner tone="info" title={ct('external', { provider: sf.data.checkout.provider ?? '' })} action={sf.data.checkout.url ? ct('openExternal') : undefined} onAction={() => sf.data?.checkout.url && Linking.openURL(sf.data.checkout.url)} />
      ) : null}
      {checkingOut && cur ? (
        <Card>
          <Text variant="h3">{ct('checkout', { store: cur.name })}</Text>
          {cart.map((l) => <Text key={l.variantId}>{l.quantity} × {l.name}</Text>)}
          <TextField label={ct('name')} value={contact.name} onChangeText={(v) => setContact({ ...contact, name: v })} autoComplete="name" />
          <TextField label={ct('email')} value={contact.email} onChangeText={(v) => setContact({ ...contact, email: v })} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
          <Text variant="small" tone="muted">{ct('held')} {sf.data?.sandboxPayments ? ct('testMode') : ''}</Text>
          {err ? <Banner tone="danger" title={err} /> : null}
          <Button label={ct('placeOrder', { amount: fmtMoney({ amount: total, currency: currency as never }, intlLocale) })} loading={busy} disabled={!contact.name || !/\S+@\S+\.\S+/.test(contact.email)} onPress={place} />
          <Button label="←" variant="ghost" onPress={() => setCheckingOut(false)} />
        </Card>
      ) : null}
      {products.loading ? <><SkeletonCard /><SkeletonCard /></> : null}
      {(products.data ?? []).map((p) => (
        <Card key={p.id}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {p.image ? <Image source={{ uri: p.image }} style={{ width: 72, height: 72, borderRadius: 12, backgroundColor: color.canvas }} accessibilityIgnoresInvertColors /> : null}
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="h3">{p.name}</Text>
              {p.description ? <Text variant="small" tone="muted" numberOfLines={2}>{p.description}</Text> : null}
            </View>
          </View>
          {p.variants.filter((v) => v.availability !== 'not_stocked').map((v) => (
            <View key={v.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1 }}>{v.name}</Text>
              <MoneyText value={v.price} weight={700} />
              <Badge label={ct(BAND[v.availability].key)} tone={BAND[v.availability].tone} />
              {sf.data?.checkout.mode === 'native' && ['in_stock', 'low_stock', 'backorder'].includes(v.availability) ? (
                <Button size="sm" variant="soft" label={ct('add')} accessibilityLabel={`${ct('add')} ${p.name} ${v.name}`} onPress={() => setCart((c) => (c.some((l) => l.variantId === v.id) ? c.map((l) => (l.variantId === v.id ? { ...l, quantity: l.quantity + 1 } : l)) : [...c, { variantId: v.id, name: `${p.name} — ${v.name}`, quantity: 1 }]))} />
              ) : null}
            </View>
          ))}
        </Card>
      ))}
      <SectionHeader title={ct('myOrders')} />
      {(mine.data ?? []).length === 0 ? <EmptyState icon="receipt" title={ct('noOrders')} /> : null}
      {(mine.data ?? []).map((o) => <ListItem key={o.id} icon="receipt" title={ct('order', { number: o.number })} subtitle={`${o.locationName ?? ''} · ${ct(`fs.${o.fulfilmentStatus}`)}`} meta={fmtMoney(o.total as never, intlLocale)} chevron onPress={() => router.push({ pathname: '/shop/order', params: { id: o.id } })} />)}
    </Screen>
  );
}
