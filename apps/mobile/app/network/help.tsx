import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Banner, Button, Card, DataStatus, Screen, ScreenHeader, SectionHeader, Text, TextField } from '@/components';
import { netApi } from '@/features/network/api';
import { useNT, type NKey } from '@/features/network/strings';
import { useNetOrg } from '@/features/network/useNetOrg';
import { relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { color } from '@/theme';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

/** Raise a ticket to HQ from the phone and follow your tickets. */
export default function HelpScreen() {
  const { t, locale } = useNT();
  const { org } = useNetOrg();
  const ov = useApi(() => (org ? netApi.helpOverview(org.id) : Promise.resolve(null)), [org?.id]);
  const tickets = useApi(() => (org ? netApi.tickets(org.id) : Promise.resolve([])), [org?.id]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('normal');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chip = (active: boolean, label: string, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="radio" accessibilityState={{ checked: active }} onPress={onPress} style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 999, borderWidth: 1.5, borderColor: active ? color.ink : color.line, backgroundColor: active ? color.ink : color.surface }}>
      <Text variant="small" weight={700} color={active ? color.surface : color.ink}>{label}</Text>
    </Pressable>
  );
  return (
    <Screen tabs={false} onRefresh={tickets.refresh} refreshing={tickets.refreshing}>
      <ScreenHeader title={t('help')} back />
      <DataStatus q={ov} />
      <Card>
        <Text variant="h3">{t('raise')}</Text>
        <TextField label={t('subject')} value={subject} onChangeText={setSubject} maxLength={200} />
        <TextField label={t('details')} value={body} onChangeText={setBody} multiline numberOfLines={4} style={{ minHeight: 96, textAlignVertical: 'top' }} />
        <Text variant="small" weight={700}>{t('priority')}</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup">{PRIORITIES.map((p) => chip(priority === p, t(p), () => setPriority(p)))}</View>
        {(ov.data?.categories.length ?? 0) > 0 ? (
          <>
            <Text variant="small" weight={700}>{t('category')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup">
              {chip(categoryId === null, t('anyCategory'), () => setCategoryId(null))}
              {ov.data!.categories.map((c) => chip(categoryId === c.id, c.name, () => setCategoryId(c.id)))}
            </View>
          </>
        ) : null}
        {err ? <Banner tone="danger" title={err} /> : null}
        {sent ? <Banner tone="success" title={t('sent')} /> : null}
        <Button label={t('send')} icon="send" loading={busy} disabled={subject.trim().length < 3 || !body.trim()} onPress={async () => {
          if (!org) return;
          setBusy(true); setErr(null); setSent(false);
          try {
            await netApi.raise(org.id, { subject: subject.trim(), body: body.trim(), priority, categoryId, locationId: ov.data?.myLocations.length === 1 ? ov.data.myLocations[0]!.id : null });
            setSubject(''); setBody(''); setSent(true); await tickets.refresh();
          } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
        }} />
      </Card>
      <SectionHeader title={t('myTickets')} />
      {!tickets.loading && !(tickets.data ?? []).length ? <Text tone="muted">{t('noTickets')}</Text> : null}
      {(tickets.data ?? []).map((tk) => (
        <Card key={tk.id}>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Text variant="small" tone="muted">{`#${tk.number}`}</Text>
            <Badge label={t((tk.status === 'open' ? 'open_' : tk.status) as NKey)} tone={tk.status === 'resolved' || tk.status === 'closed' ? 'success' : tk.status === 'pending' ? 'info' : 'warning'} />
            <Badge label={t(tk.priority as NKey)} tone={tk.priority === 'urgent' ? 'danger' : 'neutral'} />
          </View>
          <Text weight={700}>{tk.subject}</Text>
          <Text variant="small" tone="muted">{relativeAgo(tk.updatedAt, locale)}</Text>
        </Card>
      ))}
    </Screen>
  );
}
