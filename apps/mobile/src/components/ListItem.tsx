import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { color, radius, space, MIN_TARGET } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface ListItemProps {
  title: string;
  subtitle?: string;
  meta?: string;
  icon?: IconName;
  iconBg?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  bg?: string;
}

export function ListItem({ title, subtitle, meta, icon, iconBg, leading, trailing, chevron, onPress, accessibilityLabel, accessibilityHint, bg }: ListItemProps) {
  const body = (
    <>
      {leading ?? (icon ? (
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: iconBg ?? color.canvas, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={18} />
        </View>
      ) : null)}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline' }}>
          <Text variant="body" weight={700} style={{ flex: 1 }}>
            {title}
          </Text>
          {meta ? <Text variant="small" tone="muted">{meta}</Text> : null}
        </View>
        {subtitle ? <Text variant="small" tone="muted">{subtitle}</Text> : null}
      </View>
      {trailing}
      {chevron ? <Icon name="chevron-right" size={16} color={color.stone} /> : null}
    </>
  );
  const style = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: space[3], backgroundColor: bg ?? color.surface, borderRadius: radius.md + 2, padding: space[3], minHeight: MIN_TARGET + 12 };
  if (!onPress) return <View style={style} accessible={!!accessibilityLabel} accessibilityLabel={accessibilityLabel}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [title, subtitle, meta].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [style, { opacity: pressed ? 0.85 : 1 }]}
    >
      {body}
    </Pressable>
  );
}
