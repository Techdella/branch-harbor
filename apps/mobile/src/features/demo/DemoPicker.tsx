import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Card, Icon, Text } from '@/components';
import { useI18n } from '@/i18n';
import { liveApi, type DemoOrg } from '@/lib/live';
import { useSession } from '@/lib/session';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color } from '@/theme';

/** Demo build only (EXPO_PUBLIC_DEMO_MODE + API DEMO_MODE): every demo account by business and role, one tap signs in. */
export function DemoPicker() {
  const { t } = useI18n();
  const { demoSignIn } = useSession();
  const [orgs, setOrgs] = useState<DemoOrg[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    liveApi.demoAccounts().then(setOrgs, () => setFailed(true));
  }, []);
  return (
    <Card>
      <Text variant="h3" accessibilityRole="header">{t('demo.pickerTitle')}</Text>
      <Text variant="small" tone="muted">{t('demo.pickerBody')}</Text>
      {failed ? <Banner tone="danger" title={t('demo.pickerFailed')} /> : null}
      {(orgs ?? []).map((o) => (
        <View key={o.id} style={{ gap: 6, marginTop: 6 }}>
          <Text variant="label" tone="muted">{o.name}</Text>
          {o.accounts.map((a) => (
            <Card
              key={a.email}
              padding={12}
              bg={color.canvas}
              accessibilityLabel={`${a.name}. ${a.roles.map((r) => r.roleName).join(', ')}`}
              onPress={async () => {
                if (busy) return;
                setBusy(a.email);
                try {
                  await demoSignIn(a.email);
                } catch {
                  setFailed(true);
                } finally {
                  setBusy(null);
                }
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text weight={700}>{a.name}</Text>
                  <Text variant="small" tone="muted">{a.roles.map((r) => (r.scope ? `${r.roleName} · ${r.scope}` : r.roleName)).join(', ')}</Text>
                </View>
                {busy === a.email ? <Text variant="small">{t('demo.signingIn')}</Text> : <Icon name="chevron-right" size={16} />}
              </View>
            </Card>
          ))}
        </View>
      ))}
    </Card>
  );
}

/** Demo build only: a slim ribbon so nobody mistakes the demo for a real business account. */
export function DemoRibbon() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="text" style={{ backgroundColor: color.ink, paddingTop: insets.top + 4, paddingBottom: 4, paddingHorizontal: 12, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 }}>
      <View style={{ backgroundColor: color.lime, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
        <Text variant="small" weight={800}>{t('demo.ribbon')}</Text>
      </View>
      <Text variant="small" tone="inverse" numberOfLines={1} style={{ flexShrink: 1 }}>{t('demo.ribbonNote')}</Text>
    </View>
  );
}
