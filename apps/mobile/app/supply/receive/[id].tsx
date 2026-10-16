import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Badge, Banner, Button, Card, DataStatus, IconButton, Screen, ScreenHeader, SectionHeader, SkeletonCard, Text, TextField, ToggleRow } from '@/components';
import { supplyApi, type ReceiveLine } from '@/features/supply/api';
import { useST, type SKey } from '@/features/supply/strings';
import { useOnline } from '@/lib/network';
import { useApi } from '@/lib/useApi';
import { color, status as S } from '@/theme';

const ISSUES = ['short', 'damaged', 'wrong_item', 'quality'] as const;

/** Receive a delivery at the back door: good and damaged packs per line with big steppers, issues, close short. */
export default function ReceiveScreen() {
  const { id, org } = useLocalSearchParams<{ id: string; org: string }>();
  const { t, locale } = useST();
  const online = useOnline();
  const po = useApi(() => supplyApi.order(org!, id!), [id, org]);
  const [rows, setRows] = useState<Record<string, ReceiveLine> | null>(null);
  const [note, setNote] = useState('');
  const [closeShort, setCloseShort] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ restocked: number } | null>(null);
  const p = po.data;
  const open = (p?.lines ?? []).filter((l) => l.received < l.quantity);
  const r = rows ?? Object.fromEntries(open.map((l) => [l.itemId, { itemId: l.itemId, received: l.quantity - l.received, damaged: 0, issue: null, note: '' }]));
  const set = (itemId: string, patch: Partial<ReceiveLine>) => setRows({ ...r, [itemId]: { ...r[itemId]!, ...patch } });
  const short = open.some((l) => (r[l.itemId]?.received ?? 0) < l.quantity - l.received);
  const date = (ymd: string | null) => (ymd ? new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
  return (
    <Screen tabs={false} onRefresh={po.refresh}>
      <ScreenHeader title={p ? t('receiveTitle', { number: p.number }) : t('receive')} kicker={p ? t('from', { supplier: p.supplierName ?? '' }) : undefined} back />
      <DataStatus q={po} />
      {po.loading && !p ? <SkeletonCard /> : null}
      {done ? (
        <Card bg={S.success.bg}>
          <Text variant="h3">{t('received')}</Text>
          {done.restocked ? <Text>{t('restocked', { n: done.restocked })}</Text> : null}
          <Button label={t('back')} icon="arrow-left" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : p ? (
        <>
          <Card>
            <Text weight={700}>{p.locationName}</Text>
            <Text variant="small" tone="muted">{t('expected', { date: date(p.expectedDeliveryDate) })}{p.supplierReference ? ` · ${p.supplierReference}` : ''}</Text>
            {p.notes ? <Text variant="small">{p.notes}</Text> : null}
          </Card>
          {!open.length ? <Banner tone="success" title={t('allReceived')} /> : null}
          {open.map((l) => {
            const row = r[l.itemId]!;
            const outstanding = l.quantity - l.received;
            const flagged = row.received < outstanding || row.damaged > 0;
            return (
              <Card key={l.itemId} style={{ borderWidth: 1.5, borderColor: flagged ? S.warning.border : color.lineSoft }}>
                <Text weight={700}>{l.name}</Text>
                <Text variant="small" tone="muted">{l.packLabel} · {t('expecting', { n: outstanding })}</Text>
                <Stepper label={t('good')} value={row.received} onChange={(v) => set(l.itemId, { received: v })} />
                <Stepper label={t('damaged')} value={row.damaged} onChange={(v) => set(l.itemId, { damaged: v })} />
                {flagged ? (
                  <View style={{ gap: 8 }}>
                    <Text variant="small" weight={700}>{t('issue')}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {ISSUES.map((k) => (
                        <Pressable key={k} onPress={() => set(l.itemId, { issue: row.issue === k ? null : k })} accessibilityRole="button" accessibilityState={{ selected: row.issue === k }} accessibilityLabel={t(k as SKey)}
                          style={{ minHeight: 40, paddingHorizontal: 14, borderRadius: 20, justifyContent: 'center', backgroundColor: row.issue === k ? color.ink : color.canvas }}>
                          <Text weight={700} color={row.issue === k ? color.surface : color.ink}>{t(k as SKey)}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <TextField label={t('note')} placeholder={t('notePlaceholder')} value={row.note} onChangeText={(v) => set(l.itemId, { note: v })} />
                  </View>
                ) : null}
              </Card>
            );
          })}
          {open.length ? (
            <>
              <SectionHeader title={t('confirm')} />
              <TextField label={t('deliveryNote')} value={note} onChangeText={setNote} multiline />
              {short ? <ToggleRow label={t('closeShort')} sub={t('closeShortSub')} value={closeShort} onChange={setCloseShort} /> : null}
              {err ? <Banner tone="danger" title={err} /> : null}
              {!online ? <Text variant="small" tone="muted">{t('needsConnection')}</Text> : null}
              <Button label={t('confirm')} icon="check" variant="signal" size="lg" disabled={!online} loading={busy} onPress={async () => {
                setBusy(true); setErr(null);
                try {
                  const out = await supplyApi.receive(org!, p.id, open.map((l) => r[l.itemId]!), note, closeShort);
                  setDone({ restocked: out.inventory.length });
                } catch (e) { setErr(e instanceof Error ? e.message : t('error')); } finally { setBusy(false); }
              }} />
            </>
          ) : null}
          {p.packs.damaged ? <Badge label={`${t('damaged')}: ${p.packs.damaged}`} tone="danger" /> : null}
        </>
      ) : null}
    </Screen>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const { t } = useST();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text weight={700} style={{ flex: 1 }}>{label}</Text>
      <IconButton icon="minus" label={t('less', { label })} disabled={value <= 0} onPress={() => onChange(Math.max(0, value - 1))} size={48} />
      <Text variant="h2" tabular style={{ minWidth: 40, textAlign: 'center' }}>{String(value)}</Text>
      <IconButton icon="plus" label={t('more', { label })} onPress={() => onChange(value + 1)} size={48} />
    </View>
  );
}
