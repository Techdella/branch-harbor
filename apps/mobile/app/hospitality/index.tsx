import { useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text, TextField, ToggleRow, useToast } from '@/components';
import { hospApi, hospitalityLive, type HBooked, type HProperty, type HRate, type HRoomType } from '@/features/hospitality/api';
import { useHospStrings } from '@/features/hospitality/strings';
import { useI18n } from '@/i18n';
import { payPayment } from '@/lib/cardPayment';
import { addDaysKey, fmtMoney } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Guest: choose a property → dates and guests → room and rate → details → deposit → confirmation (manage in My stays). */
export default function BookStayScreen() {
  const { s, intlLocale } = useHospStrings();
  const { t } = useI18n();
  const toast = useToast();
  const props = useApi(() => (hospitalityLive ? hospApi.properties() : Promise.resolve([] as HProperty[])), []);
  const [p, setP] = useState<HProperty | null>(null);
  const [q, setQ] = useState({ arrival: '', departure: '', adults: '2' });
  const [rooms, setRooms] = useState<HRoomType[] | null>(null);
  const [pick, setPick] = useState<{ rt: HRoomType; rate: HRate } | null>(null);
  const [guest, setGuest] = useState({ name: '', email: '', consent: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<HBooked | null>(null);

  const choose = (x: HProperty) => { setP(x); setRooms(null); setPick(null); setQ({ arrival: x.today, departure: addDaysKey(x.today, 2), adults: '2' }); };
  const search = async () => {
    if (!p || !DATE.test(q.arrival) || !DATE.test(q.departure) || q.departure <= q.arrival) { toast(s('dates')); return; }
    setBusy(true);
    try { setRooms(await hospApi.availability(p.locationId, { arrival: q.arrival, departure: q.departure, adults: Math.max(1, Number(q.adults) || 1) })); setPick(null); } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const book = async () => {
    if (!p || !pick || !pick.rate.total) return;
    setBusy(true);
    try {
      const adults = Math.max(1, Number(q.adults) || 1);
      const dorm = pick.rt.kind === 'dorm';
      const r = await hospApi.book(p.locationId, { arrival: q.arrival, departure: q.departure, roomTypeId: pick.rt.roomTypeId, ratePlanId: pick.rate.ratePlanId, adults, units: dorm ? adults : 1, dorm, guest: { name: guest.name.trim(), email: guest.email.trim() }, consentEmail: guest.consent, expectedTotalMinor: pick.rate.total.amount });
      if (r.payment) {
        const paid = await payPayment(r.payment, t);
        if (!paid.ok) { toast(paid.message); setBusy(false); return; }
      }
      setDone(r);
    } catch (e) { toast((e as Error).message); } finally { setBusy(false); }
  };
  const policy = (r: HRate) => (r.policy.nonRefundable ? s('nonRefundable') : r.policy.freeUntilHours != null ? s('freeUntil', { h: r.policy.freeUntilHours }) : '');

  if (!hospitalityLive) return <Screen tabs={false}><ScreenHeader title={s('stays')} back /><EmptyState icon="plug" title={s('liveOnly')} body={s('liveOnlyBody')} /></Screen>;
  if (done) {
    return (
      <Screen tabs={false}>
        <ScreenHeader title={s('stays')} back />
        <Banner tone="success" icon="check" title={s('confirmed', { code: done.reservation.code })} body={s('total', { amount: fmtMoney(done.reservation.total as never, intlLocale) })} />
        <Button label={s('myStays')} icon="calendar" onPress={() => router.replace('/hospitality/stays')} />
      </Screen>
    );
  }
  return (
    <Screen tabs={false} onRefresh={() => void props.refresh()} refreshing={props.refreshing}>
      <ScreenHeader title={s('stays')} kicker={s('staysKicker')} back right={<Button label={s('myStays')} variant="secondary" size="sm" icon="calendar" onPress={() => router.push('/hospitality/stays')} />} />
      <DataStatus q={props} />
      {props.loading ? <SkeletonCard /> : null}
      {!p ? (
        <>
          <Text variant="h2">{s('properties')}</Text>
          {(props.data ?? []).map((x) => (
            <Card key={x.locationId} onPress={() => choose(x)} accessibilityLabel={x.name}>
              {x.photos[0] ? <Image source={{ uri: x.photos[0].url }} style={{ width: '100%', height: 140, borderRadius: 12 }} accessibilityIgnoresInvertColors /> : null}
              <Text variant="h3">{x.name}</Text>
              <Text tone="muted">{x.city} · {x.currency}</Text>
            </Card>
          ))}
        </>
      ) : (
        <>
          <Pressable onPress={() => setP(null)} accessibilityRole="button"><Text weight={700}>{p.name} · {p.city}</Text></Pressable>
          <Card>
            <TextField label={s('arrival')} value={q.arrival} onChangeText={(v) => setQ({ ...q, arrival: v })} autoCapitalize="none" />
            <TextField label={s('departure')} value={q.departure} onChangeText={(v) => setQ({ ...q, departure: v })} autoCapitalize="none" />
            <TextField label={s('adults')} value={q.adults} onChangeText={(v) => setQ({ ...q, adults: v.replace(/\D/g, '') })} keyboardType="number-pad" />
            <Button label={s('search')} icon="search" loading={busy && !pick} onPress={search} />
          </Card>
          {rooms && rooms.every((r) => !r.rates.some((x) => x.ok) || r.available < r.unitsNeeded) ? <EmptyState icon="bed" title={s('noRooms')} /> : null}
          {(rooms ?? []).map((rt) => (
            <Card key={rt.roomTypeId}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text variant="h3" style={{ flex: 1 }}>{rt.name}</Text>
                <Badge label={rt.available < rt.unitsNeeded ? s('soldOut') : s('left', { n: rt.available })} tone={rt.available < rt.unitsNeeded ? 'danger' : 'neutral'} />
              </View>
              {rt.rates.filter((r) => r.ok && r.total).map((r) => (
                <Pressable key={r.ratePlanId} disabled={rt.available < rt.unitsNeeded} onPress={() => setPick({ rt, rate: r })} accessibilityRole="radio" accessibilityState={{ checked: pick?.rate.ratePlanId === r.ratePlanId && pick.rt.roomTypeId === rt.roomTypeId }} style={{ padding: 10, borderRadius: 12, minHeight: 44, backgroundColor: pick?.rate.ratePlanId === r.ratePlanId && pick.rt.roomTypeId === rt.roomTypeId ? color.lime : color.canvas, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <Text weight={700} style={{ flex: 1 }}>{r.name}</Text>
                    <Text weight={800} tabular>{fmtMoney(r.total as never, intlLocale)}</Text>
                  </View>
                  {r.includesBreakfast ? <Text variant="small">{s('breakfast')}</Text> : null}
                  <Text variant="small" tone="muted">{policy(r)}</Text>
                </Pressable>
              ))}
            </Card>
          ))}
          {pick ? (
            <Card>
              <TextField label={s('name')} value={guest.name} onChangeText={(v) => setGuest({ ...guest, name: v })} autoComplete="name" />
              <TextField label={s('email')} value={guest.email} onChangeText={(v) => setGuest({ ...guest, email: v })} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
              <ToggleRow label={s('consentEmail')} value={guest.consent} onChange={(v) => setGuest({ ...guest, consent: v })} />
              <Text weight={700}>{pick.rate.deposit && pick.rate.deposit.amount > 0 ? s('payDeposit', { amount: fmtMoney(pick.rate.deposit as never, intlLocale) }) : s('depositNone')}</Text>
              <Button label={pick.rate.deposit && pick.rate.deposit.amount > 0 ? s('payDeposit', { amount: fmtMoney(pick.rate.deposit as never, intlLocale) }) : s('book')} size="lg" loading={busy} disabled={!guest.name.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)} onPress={book} />
            </Card>
          ) : null}
        </>
      )}
    </Screen>
  );
}
