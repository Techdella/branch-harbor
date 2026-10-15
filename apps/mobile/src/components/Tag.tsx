import { Pressable, View } from 'react-native';
import { color, radius, MIN_TARGET } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Pastel chip. With onPress it's a selectable chip (radio-like via `selected`); `tab` when it sits in a tablist. */
export function Tag({ label, bg, icon, selected, onPress, disabled, sub, accessibilityLabel, tab }: { label: string; bg?: string; icon?: IconName; selected?: boolean; onPress?: () => void; disabled?: boolean; sub?: string; accessibilityLabel?: string; tab?: boolean }) {
  const fg = selected ? color.surface : color.ink;
  const content = (
    <>
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      <View style={{ alignItems: 'center' }}>
        <Text variant="small" weight={700} color={fg}>
          {label}
        </Text>
        {sub ? (
          <Text variant="small" weight={600} color={selected ? color.lineSoft : color.stone} style={{ fontSize: 11 }}>
            {sub}
          </Text>
        ) : null}
      </View>
    </>
  );
  const style = {
    flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'center' as const, gap: 6, borderRadius: radius.pill,
    paddingHorizontal: 12, paddingVertical: 6, backgroundColor: selected ? color.ink : bg ?? color.surface,
    borderWidth: selected || bg ? 0 : 1, borderColor: color.lineSoft, opacity: disabled ? 0.45 : 1,
  };
  if (!onPress) return <View style={[style, { alignSelf: 'flex-start' }]}>{content}</View>;
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole={tab ? 'tab' : 'button'}
      accessibilityLabel={accessibilityLabel ?? (sub ? `${label}, ${sub}` : label)}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      aria-selected={tab ? !!selected : undefined}
      style={({ pressed }) => [style, { minHeight: MIN_TARGET, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 }]}
    >
      {content}
    </Pressable>
  );
}
