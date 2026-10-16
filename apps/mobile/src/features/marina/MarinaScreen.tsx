import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import type { AiActionCard, AiBlock } from '@bh/shared';
import { Badge, Button, Card, EmptyState, Icon, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { color, pastel, radius, space, status } from '@/theme';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import { holdsAssistant, marinaApi, type AskResult } from './api';
import { useMT } from './strings';

const SEV: Record<string, 'danger' | 'warning' | 'info'> = { critical: 'danger', warning: 'warning', info: 'info' };

function ActionCardView({ orgId, action }: { orgId: string; action: AiActionCard }) {
  const { t } = useMT();
  const [a, setA] = useState(action);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<AiActionCard>) => {
    setBusy(true);
    try { setA(await fn()); } finally { setBusy(false); }
  };
  return (
    <Card bg={color.surface} style={{ borderWidth: 1.5, borderColor: a.status === 'proposed' ? color.ink : color.line }}>
      <Text variant="label" tone="muted">{t('prepared')}</Text>
      <Text weight={700}>{a.title}</Text>
      {a.summary ? <Text variant="small" tone="muted">{a.summary}</Text> : null}
      {a.fromUntrustedContent && a.status === 'proposed' ? <Badge label={t('untrusted')} tone="warning" /> : null}
      {a.details.slice(0, 5).map((d, i) => <Text key={i} variant="small"><Text variant="small" weight={700}>{d.label}: </Text>{d.value.slice(0, 240)}</Text>)}
      {a.status === 'proposed' ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label={t('confirm')} size="sm" icon="check" loading={busy} onPress={() => run(() => marinaApi.confirm(orgId, a.id))} />
          <Button label={t('cancel')} size="sm" variant="ghost" disabled={busy} onPress={() => run(() => marinaApi.cancel(orgId, a.id))} />
        </View>
      ) : (
        <Badge label={a.status === 'executed' ? t('done') : a.status === 'pending_approval' ? t('pendingApproval') : a.status === 'failed' ? t('failed', { reason: String(a.result?.error ?? '') }) : t('cancelled')} tone={a.status === 'executed' ? 'success' : a.status === 'failed' ? 'danger' : 'neutral'} />
      )}
    </Card>
  );
}

function BlockView({ block }: { block: AiBlock }) {
  const { t } = useMT();
  if (block.type === 'chart') return null;
  const cols = block.columns.filter((c) => c.key !== 'id').slice(0, 3);
  return (
    <View style={{ gap: 4 }}>
      <Text variant="small" weight={700}>{block.title}</Text>
      {block.rows.slice(0, 8).map((r, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8, paddingVertical: 4, borderTopWidth: 1, borderTopColor: color.line }}>
          {cols.map((c) => <Text key={c.key} variant="small" style={{ flex: 1 }} numberOfLines={2}>{c.kind === 'money' && typeof r[c.key] === 'number' && block.currencyKey ? `${(Number(r[c.key]) / 100).toFixed(2)} ${r[block.currencyKey] ?? ''}` : String(r[c.key] ?? '—')}</Text>)}
        </View>
      ))}
      {block.rows.length > 8 ? <Text variant="small" tone="muted">{t('rows', { n: block.rows.length })} · {t('more')}</Text> : null}
    </View>
  );
}

/** The assistant on mobile: today's briefing, a chat that answers from your data, and action cards to confirm. */
export function MarinaScreen({ tabs = true }: { tabs?: boolean }) {
  const { t } = useMT();
  const { me } = useSession();
  const orgId = me?.accountId ?? null;
  const allowed = holdsAssistant(me?.capabilities);
  const briefing = useApi(() => (orgId && allowed ? marinaApi.briefing(orgId) : Promise.resolve(null)), [orgId, allowed]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [conv, setConv] = useState<string | null>(null);
  const [turns, setTurns] = useState<Array<{ q: string; a?: AskResult; error?: string }>>([]);
  const ask = async (text: string) => {
    if (!orgId || !text.trim() || busy) return;
    setQ('');
    setBusy(true);
    setTurns((ts) => [...ts, { q: text }]);
    try {
      const a = await marinaApi.ask(orgId, text, conv);
      setConv(a.conversationId);
      setTurns((ts) => [...ts.slice(0, -1), { q: text, a }]);
    } catch (e) {
      setTurns((ts) => [...ts.slice(0, -1), { q: text, error: (e as Error).message || t('error') }]);
    } finally {
      setBusy(false);
    }
  };
  if (!allowed || !orgId) return <Screen tabs={tabs}><ScreenHeader title={t('title')} back={!tabs} /><EmptyState icon="lock" title={t('noAccess')} /></Screen>;
  return (
    <Screen tabs={tabs} onRefresh={briefing.refresh} refreshing={briefing.refreshing}
      footer={
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: color.surface, borderRadius: radius.pill, padding: 6 }}>
          <TextInput value={q} onChangeText={setQ} placeholder={t('askPlaceholder')} accessibilityLabel={t('askLabel')} onSubmitEditing={() => ask(q)} returnKeyType="send" style={{ flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: space[3], fontSize: 15 }} />
          <Pressable accessibilityRole="button" accessibilityLabel={t('send')} onPress={() => ask(q)} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center', opacity: q.trim() ? 1 : 0.4 }}>
            <Icon name="send" size={18} color={color.surface} />
          </Pressable>
        </View>
      }>
      <ScreenHeader title={t('title')} kicker={t('kicker')} back={!tabs} />
      <Card bg={pastel.lilac}>
        <Text variant="label" tone="muted">{t('briefing')}</Text>
        {briefing.loading && !briefing.data ? <SkeletonCard /> : null}
        {briefing.data?.summary ? <Text>{briefing.data.summary}</Text> : null}
        {briefing.data && !briefing.data.items.length ? <Text tone="muted">{t('nothing')}</Text> : null}
        {(briefing.data?.items ?? []).slice(0, 5).map((i, n) => (
          <View key={n} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <Badge label={i.severity} tone={SEV[i.severity] ?? 'info'} />
            <Text variant="small" style={{ flex: 1 }}>{i.title}</Text>
          </View>
        ))}
      </Card>
      {turns.length === 0 ? (
        <View style={{ gap: 8 }}>
          <Text variant="small" tone="muted">{t('intro')}</Text>
          {(['suggestion1', 'suggestion2', 'suggestion3'] as const).map((k) => <Button key={k} label={t(k)} variant="secondary" size="sm" icon="sparkles" onPress={() => ask(t(k))} />)}
          <Text variant="small" tone="muted">{t('voiceHint')}</Text>
        </View>
      ) : null}
      {turns.map((turn, i) => (
        <View key={i} style={{ gap: 8 }}>
          <View style={{ alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: color.ink, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 }}><Text color={color.surface}>{turn.q}</Text></View>
          <Card>
            {!turn.a && !turn.error ? <Text tone="muted">{t('thinking')}</Text> : null}
            {turn.error ? <Text color={status.danger.fg}>{turn.error}</Text> : null}
            {turn.a ? <Text>{turn.a.text}</Text> : null}
            {turn.a?.blocks.map((b, n) => <BlockView key={n} block={b} />)}
            {turn.a?.citations.length ? <Text variant="small" tone="muted">{t('sources')}: {[...new Set(turn.a.citations.map((c) => c.title))].join(', ')}</Text> : null}
            {turn.a?.notices.some((n) => n.code === 'not_legal_advice') ? <Badge label={t('notLegal')} tone="info" /> : null}
          </Card>
          {turn.a?.actions.map((a) => <ActionCardView key={a.id} orgId={orgId} action={a} />)}
        </View>
      ))}
    </Screen>
  );
}
