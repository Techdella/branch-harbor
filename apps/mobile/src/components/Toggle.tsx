import { Pressable, View } from 'react-native';
import { color, radius, space, MIN_TARGET } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Accessible switch row (role=switch, checked state announced; track also shows an on/off glyph). */
export function ToggleRow({ label, sub, value, onChange, icon, disabled }: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void; icon?: IconName; disabled?: boolean }) {
  return (
    <Pressable
      onPress={disabled ? undefined : () => onChange(!value)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={sub}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: MIN_TARGET + 8, paddingVertical: 6, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 })}
    >
      {icon ? <Icon name={icon} size={18} /> : null}
      <View style={{ flex: 1 }}>
        <Text variant="body" weight={600}>{label}</Text>
        {sub ? <Text variant="small" tone="muted">{sub}</Text> : null}
      </View>
      <View style={{ width: 46, height: 28, borderRadius: radius.pill, backgroundColor: value ? color.ink : color.line, justifyContent: 'center', paddingHorizontal: 3, alignItems: value ? 'flex-end' : 'flex-start' }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: color.surface, alignItems: 'center', justifyContent: 'center' }}>
          {value ? <Icon name="check" size={12} strokeWidth={2.6} /> : null}
        </View>
      </View>
    </Pressable>
  );
}
