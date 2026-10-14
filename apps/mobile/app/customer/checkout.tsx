import { useEffect, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Banner, Card, DataStatus, EmptyState, IconButton, MoneyText, PaymentStep, Screen, ScreenHeader, SkeletonCard, Text, TextField, ListItem } from '@/components';
import { useCart } from '@/features/customer/cart';
import { useCatalog } from '@/features/customer/catalog';
import { useI18n } from '@/i18n';
import { api, guestContact } from '@/lib/api';
import { env } from '@/lib/env';
import { ApiError } from '@/lib/errors';
import { fmtMoney, fmtTime, fmtZone } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { useSession } from '@/lib/session';
import type { FoodOrder } from '@/lib/types';
import { color, pastel } from '@/theme';

export default function Checkout() {
  const { t, intlLocale } = useI18n();
  const { me } = useSession();
  const cart = useCart();
  const { locationById, brand } = useCatalog();
  const loc = cart.locationId ? locationById(cart.locationId) : undefined;
  const linesKey = cart.lines.map((l) => `${l.key}x${l.quantity}`).join('|');
  // Server quote is authoritative for totals and tax (configured per location by the business).
  const quoteQ = useApi(() => (loc && cart.lines.length ? api.quoteOrder(loc.id, cart.toInput()) : Promise.resolve(null)), [loc?.id, linesKey]);
  const [name, setName] = useState(me?.guest ? '' : me?.user.name ?? '');
  const [phone, setPhone] = useState('');
  // Live API: guests need an email for the order receipt (signed-in customers use their account email).
  const needsEmail = !env.useMocks && !!me?.guest;
  const [email, setEmail] = useState('');
  useEffect(() => {
    if (!needsEmail) return;
    void guestContact.get().then((g) => {
      if (!g) return;
      setEmail((v) => v || g.email);
      setName((v) => v || g.name);
      if (g.phone) setPhone((v) => v || g.phone!);
    });
  }, [needsEmail]);
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiErr, setApiErr] = useState<ApiError | null>(null);
  const [order, setOrder] = useState<FoodOrder | null>(null);

  if (!loc || cart.lines.length === 0) {
    return (
      <Screen tabs={false}>
        <ScreenHeader title={t('order.cart')} back />
        <EmptyState icon="cart" title={t('order.emptyCart')} body={t('order.emptyCartSub')} action={t('order.menu')} onAction={() => router.back()} />
      </Screen>
    );
  }

  const quote = quoteQ.data;
  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = t('order.fieldRequired');
    if (!phone.trim()) e.phone = t('order.fieldRequired');
    if (needsEmail && !/\S+@\S+\.\S+/.test(email)) e.email = t('order.fieldRequired');
    if (!cart.slot) e.slot = t('order.chooseTime');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  return (
    <Screen tabs={false}>
      <ScreenHeader title={t('order.cart')} back scope={{ label: `${brand?.name ?? ''} ${loc.name}`, sub: loc.address, icon: 'store' }} />

      {apiErr ? (
        <Banner
          tone="danger"
          title={apiErr.code === 'slot_full' || apiErr.code === 'slot_unavailable' ? t('order.slotTaken') : apiErr.message}
          action={apiErr.code.startsWith('slot') ? t('order.chooseTime') : undefined}
          onAction={() => {
            cart.setSlot(loc.id, null);
            router.back();
          }}
        />
      ) : null}
      {Object.keys(errors).length ? <Banner tone="danger" title={t('order.fixErrors')} body={Object.values(errors).join(' · ')} /> : null}

      <ListItem
        icon="clock"
        iconBg={pastel.blush}
        title={cart.slot ? `${fmtTime(cart.slot.startsAt, loc.timeZone, intlLocale)} ${fmtZone(loc.timeZone, intlLocale)}` : t('order.chooseTime')}
        subtitle={t('order.pickupFrom', { location: loc.name })}
        chevron
        onPress={() => router.back()}
      />
      <ListItem icon="truck" iconBg={pastel.butter} title={t('foodsx.delivery')} chevron onPress={() => router.push('/customer/delivery')} />

      <Card>
        {cart.lines.map((l) => (
          <View key={l.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 }}>
            <View style={{ flex: 1 }}>
              <Text weight={700}>{l.quantity}× {l.name}</Text>
              {l.optionNames.length ? <Text variant="small" tone="muted">{l.optionNames.join(' · ')}</Text> : null}
            </View>
            <IconButton icon="minus" label={`−1 ${l.name}`} size={36} onPress={() => cart.setQty(l.key, l.quantity - 1)} />
            <IconButton icon="plus" label={`+1 ${l.name}`} size={36} onPress={() => cart.setQty(l.key, l.quantity + 1)} />
          </View>
        ))}
        <View style={{ height: 1, backgroundColor: color.lineSoft, marginVertical: 6 }} />
        <DataStatus q={quoteQ} />
        {quoteQ.loading || !quote ? <SkeletonCard lines={3} /> : (
          <View style={{ gap: 6 }}>
            <Row label={t('order.subtotal')} value={<MoneyText value={quote.subtotal} />} />
            {quote.tax && quote.taxLabel ? (
              <Row label={quote.taxInclusive ? t('order.taxIncluded', { label: quote.taxLabel }) : quote.taxLabel} value={<MoneyText value={quote.tax} tone="muted" />} />
            ) : null}
            <Text variant="small" tone="muted">{t('order.taxNote')}</Text>
            <Row label={t('order.total')} bold value={<MoneyText value={quote.total} variant="h3" />} />
          </View>
        )}
      </Card>

      <Card>
        <TextField label={t('order.name')} value={name} onChangeText={setName} error={errors.name} autoComplete="name" textContentType="name" />
        <TextField label={t('order.phone')} value={phone} onChangeText={setPhone} error={errors.phone} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" />
        {needsEmail ? <TextField label={t('order.email')} value={email} onChangeText={setEmail} error={errors.email} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" /> : null}
        <TextField label={t('order.notes')} value={notes} onChangeText={setNotes} multiline hint={t('order.allergyNote')} />
      </Card>

      {quote ? (
        <PaymentStep
          amount={quote.total}
          label={t('order.placeOrder', { amount: fmtMoney(quote.total, intlLocale) })}
          disabled={quoteQ.loading}
          createIntent={async () => {
            if (!validate()) throw new Error(t('order.fixErrors'));
            setApiErr(null);
            try {
              const o = order ?? (await api.placeOrder({ locationId: loc.id, slotId: cart.slot!.id, lines: cart.toInput(), name, phone, email: needsEmail ? email : undefined, notes: notes || undefined }));
              setOrder(o);
              return await api.createPaymentIntent({ kind: 'order', id: o.id });
            } catch (e) {
              if (e instanceof ApiError) {
                setApiErr(e);
                if (e.fields) setErrors(e.fields);
              }
              throw e;
            }
          }}
          onPaid={async (paymentIntentId) => {
            // Simulated path (no Stripe): create the order here if the intent step was skipped.
            let o = order;
            if (!o) {
              if (!validate()) return;
              try {
                o = await api.placeOrder({ locationId: loc.id, slotId: cart.slot!.id, lines: cart.toInput(), name, phone, email: needsEmail ? email : undefined, notes: notes || undefined });
                setOrder(o);
              } catch (e) {
                if (e instanceof ApiError) {
                  setApiErr(e);
                  if (e.fields) setErrors(e.fields);
                }
                return;
              }
            }
            try {
              // Live API in sandbox mode: the server simulates the provider confirming the payment.
              await api.confirmOrderPayment(o.id, paymentIntentId);
            } catch (e) {
              if (e instanceof ApiError) setApiErr(e);
              return;
            }
            cart.clear();
            router.replace(`/customer/orders/${o.id}`);
          }}
        />
      ) : null}
    </Screen>
  );
}

function Row({ label, value, bold }: { label: string; value: ReactNode; bold?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <Text weight={bold ? 800 : 500} style={{ flex: 1 }}>{label}</Text>
      {value}
    </View>
  );
}
