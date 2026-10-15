import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { color, radius, MIN_TARGET } from '@/theme';
import { useI18n } from '@/i18n';
import { IconButton } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface ScopeChip {
  label: string;
  sub?: string;
  icon?: IconName;
  onPress?: () => void;
  hint?: string;
}

/** Title + the active location/scope chip — visible before every consequential action. */
export function ScreenHeader({ title, kicker, scope, back, right }: { title: string; kicker?: string; scope?: ScopeChip; back?: boolean; right?: ReactNode }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 10 }}>
      {(back || right) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          {back ? <IconButton icon="arrow-left" label={t('common.back')} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} variant="secondary" size={44} /> : <View />}
          {right}
        </View>
      )}
      {kicker ? <Text variant="label" tone="muted">{kicker}</Text> : null}
      <Text variant="h1" accessibilityRole="header">
        {title}
      </Text>
      {scope ? <ScopeChipView {...scope} /> : null}
    </View>
  );
}

export function ScopeChipView({ label, sub, icon = 'pin', onPress, hint }: ScopeChip) {
  const content = (
    <>
      <Icon name={icon} size={15} />
      <View style={{ flexShrink: 1 }}>
        <Text variant="small" weight={700} numberOfLines={1}>
          {label}
        </Text>
        {sub ? <Text variant="small" tone="muted" style={{ fontSize: 11, lineHeight: 14 }} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {onPress ? <Icon name="chevron-down" size={14} /> : null}
    </>
  );
  const style = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, alignSelf: 'flex-start' as const, backgroundColor: color.surface, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 6, minHeight: MIN_TARGET, maxWidth: '100%' as const };
  if (!onPress) return <View style={style} accessible accessibilityLabel={[label, sub].filter(Boolean).join(', ')}>{content}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={[label, sub].filter(Boolean).join(', ')} accessibilityHint={hint} style={({ pressed }) => [style, { opacity: pressed ? 0.8 : 1 }]}>
      {content}
    </Pressable>
  );
}
