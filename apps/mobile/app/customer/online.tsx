import { useState } from 'react';
import { View } from 'react-native';
import { Badge, Banner, Button, Card, DataStatus, EmptyState, Screen, ScreenHeader, SkeletonCard, Text } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { studioApi } from '@/features/studios/api';
import { BuyButton, openUrl, useIsGuest } from '@/features/studios/components';
import { useI18n } from '@/i18n';
import { ApiError } from '@/lib/errors';
import { fmtDateTime } from '@/lib/format';
import { useApi } from '@/lib/useApi';
import { codedLines } from '@/features/studios/text';

/** Online classes: livestream registration and recordings. The join link is revealed only by the server, only to entitled customers. */
export default function Online() {
  const { t, intlLocale } = useI18n();
  const { location } = useCatalog();
  const guest = useIsGuest();
  const lid = location?.id ?? '';
  const q = useApi(() => (guest || !lid ? Promise.resolve([]) : studioApi.online(lid)), [lid, guest]);
  const [msg, setMsg] = useState<Record<string, string>>({});
  if (!location) return <Screen tabs={false}><SkeletonCard /></Screen>;
  return (
    <Screen tabs={false} onRefresh={q.refresh} refreshing={q.refreshing}>
      <ScreenHeader back title={t('studio.onlineTitle')} scope={{ label: location.name, icon: 'pin' }} />
      {guest ? <Banner tone="info" icon="user" title={t('studio.signInForOnline')} /> : null}
      <DataStatus q={q} />
      {!guest && q.data && q.data.length === 0 ? <EmptyState icon="video" title={t('studio.noOnline')} /> : null}
      {(q.data ?? []).map((c) => (
        <Card key={c.id}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text variant="h3" style={{ flex: 1 }}>{c.title}</Text>
            <Badge label={c.kind === 'livestream' ? t('studio.live') : t('studio.recording')} icon={c.kind === 'livestream' ? 'video' : 'play'} />
          </View>
          <Text variant="small" tone="muted">{[c.instructorName, c.startsAt ? fmtDateTime(c.startsAt, location.timeZone, intlLocale) : null, c.durationMinutes ? `${c.durationMinutes} min` : null].filter(Boolean).join(' · ')}</Text>
          <Text variant="small">{codedLines(c.rules, c.ruleCodes, 'onlineRule', t).join(' · ')}</Text>
          {c.access?.access ? (
            c.access.needsRegistration && !c.access.registered ? (
              <Button label={t('studio.register')} size="sm" onPress={async () => { try { await studioApi.register(c.id, location.id); await q.refresh(); } catch (e) { setMsg({ ...msg, [c.id]: (e as ApiError).message }); } }} />
            ) : (
              <Button label={c.kind === 'livestream' ? t('studio.join') : t('studio.watch')} size="sm" icon="play" onPress={async () => { try { const r = await studioApi.join(c.id, location.id); setMsg({ ...msg, [c.id]: t('studio.opening') }); await openUrl(r.url); } catch (e) { setMsg({ ...msg, [c.id]: (e as ApiError).message }); } }} />
            )
          ) : c.access?.purchasable ? (
            <BuyButton locationId={location.id} kind="online" id={c.id} label={t('studio.buy')} onDone={() => void q.refresh()} />
          ) : c.access ? <Text variant="small" tone="muted">{codedLines(c.access.reasons, c.access.reasonCodes, 'onlineReason', t).join(' · ')}</Text> : null}
          {msg[c.id] ? <Text variant="small" accessibilityLiveRegion="polite">{msg[c.id]}</Text> : null}
        </Card>
      ))}
    </Screen>
  );
}
