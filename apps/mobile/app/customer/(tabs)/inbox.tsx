import { useState } from 'react';
import { View } from 'react-native';
import { DataStatus, EmptyState, Icon, IconButton, Screen, ScreenHeader, SkeletonCard, Text, TextField, useToast, type IconName } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { useLocationScope } from '@/features/customer/useLocationScope';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { relativeAgo } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import type { Message } from '@/lib/types';
import { color, pastel, radius } from '@/theme';

const ICON: Record<NonNullable<Message['kind']>, [IconName, string]> = { reminder: ['calendar', pastel.lilac], offer: ['gift', pastel.butter], message: ['message', pastel.aqua] };

export default function Inbox() {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const { brand, location } = useCatalog();
  const scope = useLocationScope(location, brand?.name);
  const q = useApi(() => (location ? api.messages(location.id) : Promise.resolve([] as Message[])), [location?.id]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | undefined>();

  const send = async () => {
    if (!location || !draft.trim()) return;
    setSending(true);
    setErr(undefined);
    try {
      const m = await api.sendMessage(location.id, draft);
      q.setData((d) => [...(d ?? []), m]);
      setDraft('');
      toast(t('inbox.sent', { location: location.name }));
    } catch (e) {
      setErr((e as ApiError).message); // draft kept intact
    } finally {
      setSending(false);
    }
  };

  const msgs = [...(q.data ?? [])].sort((a, b) => a.at.localeCompare(b.at));

  return (
    <Screen onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader title={t('inbox.title')} scope={scope} />
      <Text variant="small" tone="muted">{location ? t('inbox.with', { location: `${brand?.name ?? ''} ${location.name}` }) : ''}</Text>
      <DataStatus q={q} />
      {q.loading ? <SkeletonCard /> : null}
      {!q.loading && msgs.length === 0 ? <EmptyState icon="message" title={t('inbox.empty')} body={t('inbox.emptySub')} /> : null}
      {msgs.map((m) => {
        const mine = m.from === 'customer';
        const [icon, bg] = ICON[m.kind ?? 'message'];
        return (
          <View key={m.id} accessible accessibilityLabel={`${mine ? t('inbox.you') : m.author}: ${m.body}. ${relativeAgo(m.at, intlLocale)}`} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', alignSelf: mine ? 'flex-end' : 'stretch', maxWidth: mine ? '85%' : '100%' }}>
            {!mine ? (
              <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={icon} size={17} />
              </View>
            ) : null}
            <View style={{ flex: mine ? undefined : 1, backgroundColor: mine ? color.ink : color.surface, borderRadius: radius.md + 2, padding: 12, gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text variant="small" weight={800} tone={mine ? 'inverse' : 'default'}>{mine ? t('inbox.you') : m.kind === 'reminder' ? t('inbox.reminder') : m.kind === 'offer' ? t('inbox.offer') : m.author}</Text>
                <Text variant="small" color={mine ? color.lineSoft : color.stone}>{relativeAgo(m.at, intlLocale)}</Text>
              </View>
              <Text variant="body" tone={mine ? 'inverse' : 'default'}>{m.body}</Text>
            </View>
          </View>
        );
      })}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
        <View style={{ flex: 1 }}>
          <TextField label={t('inbox.label')} placeholder={location ? t('inbox.placeholder', { location: location.name }) : ''} value={draft} onChangeText={setDraft} error={err} multiline onSubmitEditing={send} />
        </View>
        <View style={{ paddingBottom: err ? 24 : 2 }}>
          <IconButton icon="send" label={t('common.send')} variant="primary" size={48} onPress={send} disabled={sending || !draft.trim()} />
        </View>
      </View>
    </Screen>
  );
}
