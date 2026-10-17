import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import type { AiActionCard, AiBlock } from '@bh/shared';
import type { MarinaMood } from '@bh/icons';
import { Badge, Button, Card, Icon, Screen, ScreenHeader, SkeletonCard, Text, MarinaAvatar, MarinaFigure } from '@/components';
import { color, pastel, radius, space, status } from '@/theme';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import { ApiError } from '@/lib/errors';
import { holdsAssistant, marinaApi, type AskResult } from './api';
import { useMT } from './strings';

const SEV: Record<string, 'danger' | 'warning' | 'info'> = { critical: 'danger', warning: 'warning', info: 'info' };

/** Marina asleep (switched off for the organisation, or the month's allowance used up), from an API error code. */
const sleepOf = (code?: string | null): 'off' | 'paused' | null => (code === 'ai_disabled' ? 'off' : code === 'ai_credit_limit' ? 'paused' : null);

/** Marina with a short line in her voice: the figure for welcomes and sleep, the avatar inline. */
function MarinaNote({ mood, title, body, figure }: { mood: MarinaMood; title: string; body?: string; figure?: boolean }) {
  return figure ? (
    <View style={{ alignItems: 'center', gap: 8, paddingVertical: space[2] }} accessible accessibilityRole="summary" accessibilityLabel={[title, body].filter(Boolean).join('. ')}>
      <MarinaFigure width={200} mood={mood} pose={mood === 'sleep' ? 'hold' : 'wave'} />
      <Text variant="h3" align="center">{title}</Text>
      {body ? <Text tone="muted" align="center">{body}</Text> : null}
    </View>
  ) : (
    <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
      <MarinaAvatar size={30} mood={mood} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text weight={700}>{title}</Text>
        {body ? <Text variant="small" tone="muted">{body}</Text> : null}
      </View>
    </View>
  );
}

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
      ) : a.status === 'executed' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#EEF8E4', borderRadius: radius.md, padding: 8 }} accessibilityRole="text">
          <MarinaAvatar size={30} mood="celebrate" />
          <Text variant="small" weight={700} style={{ flex: 1 }}>{t('celebrate')}</Text>
        </View>
      ) : a.status === 'failed' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MarinaAvatar size={26} mood="concerned" />
          <Text variant="small" color={status.danger.fg} style={{ flex: 1 }}>{t('failed', { reason: String(a.result?.error ?? '') })}</Text>
        </View>
      ) : (
        <Badge label={a.status === 'pending_approval' ? t('pendingApproval') : t('cancelled')} tone="neutral" />
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
  const [turns, setTurns] = useState<Array<{ q: string; a?: AskResult; error?: string; code?: string }>>([]);
  const first = me?.user.name.trim().split(/\s+/)[0] ?? '';
  const asleep = sleepOf(turns[turns.length - 1]?.code ?? (briefing.error instanceof ApiError ? briefing.error.code : null));
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
      setTurns((ts) => [...ts.slice(0, -1), { q: text, error: (e as Error).message || t('error'), code: e instanceof ApiError ? e.code : undefined }]);
    } finally {
      setBusy(false);
    }
  };
  if (!allowed || !orgId) {
    return (
      <Screen tabs={tabs}>
        <ScreenHeader title={t('title')} back={!tabs} />
        <Card><MarinaNote figure mood="sleep" title={t('noAccess')} body={t('noAccessBody')} /></Card>
      </Screen>
    );
  }
  return (
    <Screen tabs={tabs} onRefresh={briefing.refresh} refreshing={briefing.refreshing}
      footer={
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', backgroundColor: color.surface, borderRadius: radius.pill, padding: 6 }}>
          <TextInput value={q} onChangeText={setQ} editable={!asleep} placeholder={asleep ? t(asleep === 'off' ? 'sleepOffTitle' : 'sleepPausedTitle') : t('askPlaceholder')} accessibilityLabel={t('askLabel')} onSubmitEditing={() => ask(q)} returnKeyType="send" style={{ flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: space[3], fontSize: 15 }} />
          <Pressable accessibilityRole="button" accessibilityLabel={t('send')} onPress={() => ask(q)} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: color.ink, alignItems: 'center', justifyContent: 'center', opacity: q.trim() ? 1 : 0.4 }}>
            <Icon name="send" size={18} color={color.surface} />
          </Pressable>
        </View>
      }>
      <ScreenHeader title={t('title')} kicker={t('kicker')} back={!tabs} />
      {asleep ? (
        <Card><MarinaNote figure mood="sleep" title={t(asleep === 'off' ? 'sleepOffTitle' : 'sleepPausedTitle')} body={t(asleep === 'off' ? 'sleepOffBody' : 'sleepPausedBody')} /></Card>
      ) : null}
      {!asleep && turns.length === 0 ? (
        <View style={{ alignItems: 'center', gap: 6 }}>
          <MarinaFigure width={190} pose="wave" />
          <Text variant="h3" align="center">{first ? t('hello', { first }) : t('helloAnon')}</Text>
          <Text tone="muted" align="center">{t('intro')}</Text>
        </View>
      ) : null}
      {asleep ? null : <Card bg={pastel.lilac}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MarinaAvatar size={28} mood={!briefing.data ? 'happy' : !briefing.data.items.length ? 'celebrate' : briefing.data.items.some((i) => i.severity === 'critical') ? 'concerned' : 'happy'} />
          <Text variant="label" tone="muted">{t('briefing')}</Text>
        </View>
        {briefing.loading && !briefing.data ? <SkeletonCard /> : null}
        {briefing.data?.summary && briefing.data.items.length ? <Text>{briefing.data.summary}</Text> : null}
        {briefing.data && !briefing.data.items.length ? <View style={{ gap: 2 }}><Text weight={700}>{t('nothingTitle')}</Text><Text tone="muted">{t('nothing')}</Text></View> : null}
        {(briefing.data?.items ?? []).slice(0, 5).map((i, n) => (
          <View key={n} style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
            <Badge label={i.severity} tone={SEV[i.severity] ?? 'info'} />
            <Text variant="small" style={{ flex: 1 }}>{i.title}</Text>
          </View>
        ))}
      </Card>}
      {!asleep && turns.length === 0 ? (
        <View style={{ gap: 8 }}>
          {(['suggestion1', 'suggestion2', 'suggestion3'] as const).map((k) => <Button key={k} label={t(k)} variant="secondary" size="sm" icon="marina" onPress={() => ask(t(k))} />)}
          <Text variant="small" tone="muted">{t('voiceHint')}</Text>
        </View>
      ) : null}
      {turns.map((turn, i) => (
        <View key={i} style={{ gap: 8 }}>
          <View style={{ alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: color.ink, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 }}><Text color={color.surface}>{turn.q}</Text></View>
          <Card>
            <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
              <MarinaAvatar size={26} mood={!turn.a && !turn.error ? 'thinking' : sleepOf(turn.code) ? 'sleep' : turn.error ? 'concerned' : 'happy'} />
              <View style={{ flex: 1, gap: 4 }}>
                {!turn.a && !turn.error ? <Text tone="muted" accessibilityLiveRegion="polite">{t('thinking')}</Text> : null}
                {turn.error && !sleepOf(turn.code) ? <Text color={status.danger.fg}>{turn.error}</Text> : null}
                {turn.error && sleepOf(turn.code) ? <Text tone="muted">{t(sleepOf(turn.code) === 'off' ? 'sleepOffTitle' : 'sleepPausedTitle')}</Text> : null}
                {turn.a ? <Text>{turn.a.text}</Text> : null}
              </View>
            </View>
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
