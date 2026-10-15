import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text, TextField, useToast } from '@/components';
import { realtyApi, type RFilters } from '@/features/realty/api';
import { ListingRow } from '@/features/realty/ListingRow';
import { useRealtyStrings } from '@/features/realty/strings';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

/** Buyer: property search (sale/rent, bedrooms), save search with consent-based alerts. */
export default function RealtySearch() {
  const { s } = useRealtyStrings();
  const toast = useToast();
  const [f, setF] = useState<RFilters>({});
  const q = useApi(() => realtyApi.search(f), [JSON.stringify(f)]);
  const [saving, setSaving] = useState(false);
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const chip = (label: string, on: boolean, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 22, backgroundColor: on ? color.ink : color.surface }}>
      <Text weight={700} color={on ? '#fff' : color.ink}>{label}</Text>
    </Pressable>
  );
  return (
    <Screen tabs={false} onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={s('homes')} kicker={s('homesKicker')} back right={<Button label={s('saved')} variant="secondary" size="sm" icon="heart" onPress={() => router.push('/realty/saved')} />} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {chip(s('any'), !f.transaction, () => setF({ ...f, transaction: undefined }))}
        {chip(s('buy'), f.transaction === 'sale', () => setF({ ...f, transaction: 'sale' }))}
        {chip(s('rent'), f.transaction === 'rent', () => setF({ ...f, transaction: 'rent' }))}
        {[1, 2, 3].map((n) => chip(s('beds', { n }), f.minBeds === n, () => setF({ ...f, minBeds: f.minBeds === n ? undefined : n })))}
      </View>
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {!q.loading && (q.data ?? []).length === 0 ? <EmptyState icon="home" title={s('none')} /> : null}
      {(q.data ?? []).length > 0 ? <Text variant="small" tone="muted">{s('results', { n: q.data!.length })}</Text> : null}
      {(q.data ?? []).map((l) => <ListingRow key={l.id} l={l} />)}
      <Card>
        <Text variant="h3">{s('saveSearch')}</Text>
        <TextField label={s('email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <Pressable onPress={() => setConsent(!consent)} accessibilityRole="checkbox" accessibilityState={{ checked: consent }} aria-checked={consent} style={{ flexDirection: 'row', gap: 10, minHeight: 44, alignItems: 'center' }}>
          <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: color.ink, backgroundColor: consent ? color.ink : 'transparent' }} />
          <Text variant="small" style={{ flex: 1 }}>{s('saveSearchConsent')}</Text>
        </Pressable>
        <Text variant="small" tone="muted">{s('fairHousing')}</Text>
        <Button label={s('saveSearch')} loading={saving} disabled={!email.includes('@')} onPress={async () => {
          setSaving(true);
          try { const r = await realtyApi.saveSearch(email.trim(), f, consent) as { alerts: string }; toast(r.alerts === 'off' ? s('saveNoAlerts') : s('saveDone')); } catch (e) { toast((e as Error).message); } finally { setSaving(false); }
        }} />
      </Card>
    </Screen>
  );
}
