import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, useToast } from '@/components';
import { realtyApi, type RViewing } from '@/features/realty/api';
import { useRealtyStrings } from '@/features/realty/strings';
import { fmtMoney, fmtTime, fmtZone, relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

/** Agent: today's viewings (office time zone), confirm, log feedback; new enquiries (mine + office pool); offers awaiting a response. */
export default function AgentDay() {
  const { s, dict, intlLocale } = useRealtyStrings();
  const toast = useToast();
  const q = useApi(() => realtyApi.myDay(), [], { pollMs: 60_000 });
  const [fb, setFb] = useState<{ id: string; interest: string; rating: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<unknown>, msg?: string) => {
    setBusy(id);
    try { await fn(); if (msg) toast(msg); await q.refresh(); } catch (e) { toast((e as Error).message); } finally { setBusy(null); }
  };
  const vs = q.data?.viewings ?? [];
  const row = (v: RViewing) => {
    const tz = v.timeZone ?? 'UTC';
    const past = new Date(v.startsAt) <= new Date();
    return (
      <Card key={v.id}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Text variant="h2" tabular>{fmtTime(v.startsAt, tz, intlLocale)} {fmtZone(tz, intlLocale)}</Text>
          <Badge label={v.status} tone={v.status === 'confirmed' ? 'success' : v.status === 'completed' ? 'neutral' : 'warning'} />
        </View>
        <Text weight={700}>{v.listing?.title}</Text>
        <Text tone="muted">{v.contact.name}{v.contact.phone ? ` · ${v.contact.phone}` : ''}</Text>
        {v.status === 'requested' ? <Button label={s('confirm')} icon="check" loading={busy === v.id} onPress={() => act(v.id, () => realtyApi.confirm(v.id))} /> : null}
        {past && v.status === 'confirmed' && fb?.id !== v.id ? <Button label={s('logFeedback')} variant="secondary" icon="message" onPress={() => setFb({ id: v.id, interest: 'medium', rating: 4 })} /> : null}
        {fb?.id === v.id ? (
          <View style={{ gap: 8 }}>
            <Text variant="label">{s('interest')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {['none', 'low', 'medium', 'high'].map((x) => (
                <Pressable key={x} onPress={() => setFb({ ...fb, interest: x })} accessibilityRole="radio" accessibilityState={{ checked: fb.interest === x }} aria-checked={fb.interest === x} style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 22, backgroundColor: fb.interest === x ? color.ink : color.canvas }}>
                  <Text weight={700} color={fb.interest === x ? '#fff' : color.ink}>{dict.interestLevels[x]}</Text>
                </Pressable>
              ))}
            </View>
            <Text variant="label">{s('rating')}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable key={n} onPress={() => setFb({ ...fb, rating: n })} accessibilityRole="radio" accessibilityLabel={`${n}`} accessibilityState={{ checked: fb.rating === n }} aria-checked={fb.rating === n} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: fb.rating === n ? color.ink : color.canvas }}>
                  <Text weight={700} color={fb.rating === n ? '#fff' : color.ink}>{n}</Text>
                </Pressable>
              ))}
            </View>
            <Button label={s('saveFeedback')} loading={busy === v.id} onPress={() => act(v.id, async () => { await realtyApi.feedback(v.id, fb.interest, fb.rating); setFb(null); }, s('feedbackSaved'))} />
          </View>
        ) : null}
      </Card>
    );
  };
  return (
    <Screen tabs={false} onRefresh={() => void q.refresh()} refreshing={q.refreshing}>
      <ScreenHeader title={s('agentTitle')} back />
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {q.data?.note ? <EmptyState icon="user" title={s('noAgent')} /> : null}
      <SectionHeader title={s('today')} />
      {!q.loading && !vs.length ? <EmptyState icon="calendar" title={s('noToday')} /> : null}
      {vs.map(row)}
      <SectionHeader title={s('newEnquiries')} />
      {!q.loading && !(q.data?.enquiries ?? []).length ? <EmptyState icon="mail" title={s('noEnquiries')} /> : null}
      {(q.data?.enquiries ?? []).map((e) => (
        <Card key={e.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <Text weight={800}>{e.name}</Text>
            <Badge label={e.assignedToMe ? s('mine') : s('pool')} tone={e.assignedToMe ? 'info' : 'warning'} />
          </View>
          <Text variant="small" tone="muted">{e.kind} · {e.source} · {relativeAgo(e.createdAt, intlLocale)}{e.listingTitle ? ` · ${e.listingTitle}` : ''}</Text>
          {e.message ? <Text>{e.message}</Text> : null}
          {e.email || e.phone ? <Text variant="small">{[e.email, e.phone].filter(Boolean).join(' · ')}</Text> : null}
          {!e.assignedToMe ? <Button label={s('claim')} variant="secondary" loading={busy === e.id} onPress={() => act(e.id, () => realtyApi.claim(e.id))} /> : null}
        </Card>
      ))}
      {(q.data?.offers ?? []).length ? <SectionHeader title={s('offersWaiting')} /> : null}
      {(q.data?.offers ?? []).map((o) => (
        <Card key={o.id}><Text weight={700}>{o.listing.title}</Text><Text tabular>{o.buyerName} · {fmtMoney(o.amount as never, intlLocale)}</Text></Card>
      ))}
    </Screen>
  );
}
