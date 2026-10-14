import { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Avatar, Button, Card, Icon, ConfirmSheet, DataStatus, ListItem, Screen, ScreenHeader, SectionHeader, SkeletonCard, Tag, Text, ToggleRow, useToast } from '@/components';
import { useCatalog } from '@/features/customer/catalog';
import { APP_LOCALES, APP_LOCALE_LABELS, useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/errors';
import { env } from '@/lib/env';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/useApi';
import type { Channel, Preferences } from '@/lib/types';
import { color, pastel } from '@/theme';

const CHANNELS: { key: Channel; icon: 'bell' | 'mail' | 'phone' }[] = [
  { key: 'push', icon: 'bell' },
  { key: 'email', icon: 'mail' },
  { key: 'sms', icon: 'phone' },
];

export default function Profile() {
  const { t, locale, setLocale } = useI18n();
  const toast = useToast();
  const { me, signOut, setExperience } = useSession();
  const { brand, location } = useCatalog();
  const q = useApi(() => api.preferences(), []);
  const [req, setReq] = useState<'export' | 'delete' | null>(null);
  const [reqErr, setReqErr] = useState<string | null>(null);
  const brandName = brand?.name ?? '';

  const save = async (next: Preferences) => {
    const prev = q.data;
    q.setData(() => next); // optimistic, reverted on failure
    try {
      await api.savePreferences(next);
    } catch (e) {
      q.setData(() => prev);
      toast((e as ApiError).message);
    }
  };

  return (
    <Screen>
      <ScreenHeader title={t('profile.title')} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar name={me?.user.name ?? 'Guest'} uri={me?.user.avatar} size={60} />
        <View style={{ flex: 1 }}>
          <Text variant="h2">{me?.user.name}</Text>
          {location ? <Text variant="small" tone="muted">{t('profile.homeLocation', { location: `${brandName} ${location.name}` })}</Text> : null}
          {me?.user.email ? <Text variant="small" tone="muted">{me.user.email}</Text> : null}
        </View>
      </View>

      <SectionHeader title={t('profile.language')} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityRole="radiogroup">
        {APP_LOCALES.map((l) => (
          <Tag
            key={l}
            label={APP_LOCALE_LABELS[l]}
            selected={l === locale}
            onPress={() => {
              setLocale(l);
              if (q.data) void save({ ...q.data, locale: l });
            }}
          />
        ))}
      </View>

      <SectionHeader title={t('profile.notifications')} sub={t('profile.notificationsSub', { brand: brandName })} />
      <DataStatus q={q} />
      {q.loading || !q.data ? <SkeletonCard lines={4} /> : (
        CHANNELS.map(({ key, icon }) => (
          <Card key={key} padding={12}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: pastel.aqua, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={icon} size={17} />
              </View>
              <Text variant="h3" accessibilityRole="header">{t(`profile.${key}`)}</Text>
            </View>
            {(['reminders', 'marketing'] as const).map((kind) => (
              <ToggleRow
                key={kind}
                label={`${t(`profile.${kind}`)}`}
                sub={t(`profile.${key}`)}
                value={q.data!.channels[key][kind]}
                onChange={(v) => save({ ...q.data!, channels: { ...q.data!.channels, [key]: { ...q.data!.channels[key], [kind]: v } } })}
              />
            ))}
          </Card>
        ))
      )}

      <ListItem icon="trophy" iconBg={pastel.lime} title={t('sports.guardianEntry')} chevron onPress={() => router.push('/sports/guardian')} />
      <SectionHeader title={t('profile.privacy')} />
      <ListItem icon="download" iconBg={pastel.sage} title={t('profile.exportData')} chevron onPress={() => { setReqErr(null); setReq('export'); }} />
      <ListItem icon="shield" iconBg={pastel.blush} title={t('profile.deleteData')} chevron onPress={() => { setReqErr(null); setReq('delete'); }} />

      {me && me.experiences.length > 1 ? (
        <Button label={t('profile.switchExperience')} variant="secondary" icon="users" onPress={() => { setExperience(null); router.replace('/'); }} />
      ) : null}
      <Button label={t('profile.signOut')} variant="soft" icon="logout" onPress={async () => { await signOut(); router.replace('/'); }} />
      <Text variant="small" tone="muted" align="center">
        {t('profile.version', { version: env.appVersion, mode: env.useMocks ? t('profile.mocks') : t('profile.live') })}
      </Text>

      <ConfirmSheet
        visible={!!req}
        title={req === 'delete' ? t('profile.deleteData') : t('profile.exportData')}
        body={req === 'delete' ? t('profile.deleteConfirm', { brand: brandName }) : t('profile.exportConfirm', { brand: brandName })}
        confirmLabel={t('common.confirm')}
        confirmVariant={req === 'delete' ? 'danger' : 'primary'}
        error={reqErr}
        onCancel={() => setReq(null)}
        onConfirm={async () => {
          try {
            const r = await api.dataRequest(req!);
            setReq(null);
            toast(t('profile.requestSent', { ref: r.reference }));
          } catch (e) {
            setReqErr((e as ApiError).message);
          }
        }}
      />
    </Screen>
  );
}
