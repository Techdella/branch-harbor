import { useState } from 'react';
import { ActivityIndicator, Platform, View } from 'react-native';
import { Redirect } from 'expo-router';
import { SvgXml } from 'react-native-svg';
import { logoSvg } from '@bh/icons';
import { Button, Card, Icon, Screen, Text, TextField, Banner, type IconName } from '@/components';
import { useI18n } from '@/i18n';
import { useSession } from '@/lib/session';
import { ApiError } from '@/lib/errors';
import { env } from '@/lib/env';
import type { Experience } from '@/lib/types';
import { color, pastel } from '@/theme';

const EXPERIENCES: { key: Experience; icon: IconName; bg: string }[] = [
  { key: 'customer', icon: 'user', bg: pastel.lilac },
  { key: 'staff', icon: 'users', bg: pastel.butter },
  { key: 'owner', icon: 'building', bg: pastel.aqua },
];

export default function Entry() {
  const { status, me, experience, setExperience, signIn, continueAsGuest } = useSession();
  const { t } = useI18n();
  const [email, setEmail] = useState('hana@example.com');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'signin' | 'guest' | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: color.canvas }}>
        <ActivityIndicator color={color.ink} accessibilityLabel={t('common.loading')} />
      </View>
    );
  }

  if (status === 'ready' && experience) {
    return <Redirect href={experience === 'customer' ? '/customer/home' : experience === 'staff' ? '/staff/today' : '/owner/pulse'} />;
  }

  const logo = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }} accessible accessibilityRole="header" accessibilityLabel={t('common.appName')}>
      <SvgXml xml={logoSvg({ size: 40 })} width={40} height={40} />
      <Text variant="h2">{t('common.appName')}</Text>
    </View>
  );

  if (status === 'ready' && me) {
    return (
      <Screen tabs={false}>
        {logo}
        <Text variant="h1" accessibilityRole="header">{t('welcome.chooseExperience')}</Text>
        <Text tone="muted">{t('welcome.signedInAs', { name: me.user.name })}</Text>
        {EXPERIENCES.filter((e) => me.experiences.includes(e.key)).map((e) => (
          <Card key={e.key} bg={e.bg} onPress={() => setExperience(e.key)} accessibilityLabel={`${t(`welcome.${e.key}`)}. ${t(`welcome.${e.key}Sub`)}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={e.icon} size={22} />
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="h3">{t(`welcome.${e.key}`)}</Text>
                <Text variant="small" color={color.graphite}>{t(`welcome.${e.key}Sub`)}</Text>
              </View>
              <Icon name="chevron-right" size={18} />
            </View>
          </Card>
        ))}
        <Banner tone="info" title={t('common.sampleData')} body={t('welcome.demoNote')} />
      </Screen>
    );
  }

  const fields = err?.fields ?? {};
  return (
    <Screen tabs={false}>
      {logo}
      <View style={{ backgroundColor: color.ink, borderRadius: 28, padding: 22, gap: 10 }}>
        <View style={{ width: 36, height: 6, borderRadius: 3, backgroundColor: color.lime }} />
        <Text variant="display" tone="inverse">{t('welcome.tagline')}</Text>
        <Text variant="body" color="#C9C9C3">{t('welcome.sub')}</Text>
      </View>
      <Card>
        <TextField label={t('welcome.email')} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" error={fields.email} />
        <TextField label={t('welcome.password')} value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" error={fields.password} hint={env.useMocks ? t('welcome.demoPassword') : undefined} />
        {err && !err.fields ? <Banner tone="danger" title={err.code === 'invalid_credentials' ? t('welcome.signInError') : err.message} /> : null}
        <Button
          label={t('welcome.signIn')}
          size="lg"
          loading={busy === 'signin'}
          onPress={async () => {
            setBusy('signin');
            setErr(null);
            try {
              await signIn(email.trim(), password);
            } catch (e) {
              setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
            } finally {
              setBusy(null);
            }
          }}
        />
        <Button
          label={t('welcome.guest')}
          variant="secondary"
          size="lg"
          loading={busy === 'guest'}
          onPress={async () => {
            setBusy('guest');
            try {
              await continueAsGuest();
            } catch (e) {
              setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
            } finally {
              setBusy(null);
            }
          }}
        />
      </Card>
      <Text variant="small" tone="muted" align="center">
        {Platform.OS === 'web' ? `${t('welcome.webPreview')} · ` : ''}{env.useMocks ? t('common.sampleData') : env.apiUrl}
      </Text>
    </Screen>
  );
}
