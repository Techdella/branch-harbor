import { useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Badge, Button, Card, DataStatus, Screen, ScreenHeader, SkeletonCard, Text, TextField, useToast } from '@/components';
import { realtyApi, type RSlot } from '@/features/realty/api';
import { useRealtyStrings } from '@/features/realty/strings';
import { ApiError } from '@/lib/errors';
import { addDaysKey, fmtDay, fmtMoney, fmtTime, fmtZone, localDateKey } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import { color, radius } from '@/theme';

/** Buyer: listing detail → save → book a viewing from the agents' free slots (office time zone). */
export default function ListingDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { s, intlLocale } = useRealtyStrings();
  const toast = useToast();
  const { me } = useSession();
  const q = useApi(() => realtyApi.listing(id), [id]);
  const tz = q.data?.office.timeZone ?? 'UTC';
  const today = localDateKey(new Date(), tz);
  const [date, setDate] = useState(addDaysKey(today, 1));
  const slotsQ = useApi(() => (q.data ? realtyApi.slots(id, date) : Promise.resolve([] as RSlot[])), [id, date, !!q.data]);
  const [slot, setSlot] = useState<RSlot | null>(null);
  const [name, setName] = useState(me?.user.name ?? '');
  const [email, setEmail] = useState(me?.user.email ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const l = q.data?.listing;

  return (
    <Screen tabs={false} onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={l?.title ?? s('homes')} kicker={q.data?.office.name} back />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {l ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {l.photos.map((p, i) => <Image key={i} source={{ uri: p.url }} style={{ width: 300, height: 200, borderRadius: radius.lg }} accessibilityLabel={`${l.title} ${i + 1}`} />)}
          </ScrollView>
          <Card>
            <Badge label={l.status === 'under_offer' ? s('underOffer') : l.status === 'coming_soon' ? s('comingSoon') : s('available')} tone={l.status === 'under_offer' ? 'warning' : 'success'} />
            <Text variant="h1" tabular>{fmtMoney(l.price as never, intlLocale)} {l.rentPeriod === 'month' ? s('perMonth') : l.rentPeriod === 'week' ? s('perWeek') : ''}</Text>
            <Text>{l.addressLines.join(', ')}</Text>
            <Text tone="muted">{[l.bedrooms != null ? `${l.bedrooms} bd` : null, l.bathrooms != null ? `${l.bathrooms} ba` : null, l.area ? `${l.area.value.toLocaleString(intlLocale)} ${l.area.label}` : s('unavailable'), l.areaAlt ? `≈ ${l.areaAlt.value.toLocaleString(intlLocale)} ${l.areaAlt.label}` : null].filter(Boolean).join(' · ')}</Text>
            {l.description ? <Text>{l.description}</Text> : null}
            {l.features.length ? <Text variant="small">{s('features')}: {l.features.join(' · ')}</Text> : null}
            <Button label={saved ? s('unsave') : s('save')} variant="secondary" icon="heart" onPress={async () => {
              if (me?.guest || !me) { toast(s('signInToSave')); return; }
              try { await realtyApi.setFavourite(l.id, !saved); setSaved(!saved); } catch (e) { toast((e as Error).message); }
            }} />
          </Card>
          {l.disclosures.length ? <Card><Text variant="label">{s('disclosures')}</Text>{l.disclosures.map((d) => <Text key={d.key} variant="small">{d.label}: {d.text}</Text>)}</Card> : null}
          <Card>
            <Text variant="h2">{s('bookViewing')}</Text>
            {done ? <Text weight={700} color={color.ink}>{s('requested')}</Text> : (
              <>
                <Text variant="label">{s('chooseDay')} · {fmtZone(tz, intlLocale)}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {Array.from({ length: 10 }, (_, i) => addDaysKey(today, i + 1)).map((d) => (
                    <Pressable key={d} onPress={() => { setDate(d); setSlot(null); }} accessibilityRole="button" accessibilityState={{ selected: d === date }} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 22, backgroundColor: d === date ? color.ink : color.surface }}>
                      <Text weight={700} color={d === date ? '#fff' : color.ink}>{fmtDay(`${d}T12:00:00Z`, 'UTC', intlLocale)}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
                <Text variant="label">{s('chooseTime')}</Text>
                {slotsQ.loading ? <SkeletonCard /> : (slotsQ.data ?? []).length === 0 ? <Text tone="muted">{s('noSlots')}</Text> : (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {(slotsQ.data ?? []).map((x) => (
                      <Pressable key={x.startsAt} onPress={() => setSlot(x)} accessibilityRole="radio" accessibilityState={{ checked: slot?.startsAt === x.startsAt }} aria-checked={slot?.startsAt === x.startsAt} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 22, backgroundColor: slot?.startsAt === x.startsAt ? color.ink : color.surface }}>
                        <Text weight={700} tabular color={slot?.startsAt === x.startsAt ? '#fff' : color.ink}>{fmtTime(x.startsAt, tz, intlLocale)}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                {slot ? (
                  <View style={{ gap: 8 }}>
                    <TextField label={s('name')} value={name} onChangeText={setName} />
                    <TextField label={s('email')} value={email ?? ''} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
                    <Button label={s('request')} loading={busy} disabled={!name.trim() || !(email ?? '').includes('@')} onPress={async () => {
                      setBusy(true);
                      try { await realtyApi.bookViewing(l.id, slot, { name: name.trim(), email: (email ?? '').trim() }); setDone(true); }
                      catch (e) { if (e instanceof ApiError && e.status === 409) { toast(s('slotTaken')); setSlot(null); void slotsQ.refresh(); } else toast((e as Error).message); }
                      finally { setBusy(false); }
                    }} />
                  </View>
                ) : null}
              </>
            )}
          </Card>
          <Card>
            <Text variant="label">{s('agents')}</Text>
            {q.data!.agents.map((a) => <Text key={a.id}>{a.name}{a.phone ? ` · ${a.phone}` : ''}</Text>)}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
