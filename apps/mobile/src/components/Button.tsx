import { ActivityIndicator, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, MIN_TARGET } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'signal' | 'secondary' | 'soft' | 'danger' | 'ghost';

const V: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: color.ink, fg: color.surface },
  signal: { bg: color.lime, fg: color.ink },
  secondary: { bg: color.surface, fg: color.ink, border: color.ink },
  soft: { bg: color.canvas, fg: color.ink },
  danger: { bg: '#9E1B12', fg: color.surface },
  ghost: { bg: 'transparent', fg: color.ink },
};

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: 'md' | 'sm' | 'lg';
  icon?: IconName;
  iconEnd?: IconName;
  loading?: boolean;
  /** Text shown while loading (e.g. "Waiting for server…"). */
  loadingLabel?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

/** Pill button. Min height 44pt (sm stays ≥ 44 via hitSlop). */
export function Button({ label, onPress, variant = 'primary', size = 'md', icon, iconEnd, loading, loadingLabel, disabled, fullWidth, accessibilityLabel, accessibilityHint, style }: ButtonProps) {
  const v = V[variant];
  const h = size === 'lg' ? 56 : size === 'sm' ? 36 : MIN_TARGET + 4;
  const inactive = disabled || loading;
  return (
    <Pressable
      onPress={inactive ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (loading && loadingLabel ? loadingLabel : label)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      hitSlop={size === 'sm' ? 6 : undefined}
      style={({ pressed }) => [
        {
          minHeight: h,
          paddingHorizontal: size === 'sm' ? 14 : 20,
          paddingVertical: 8,
          borderRadius: radius.pill,
          backgroundColor: v.bg,
          borderWidth: v.border ? 1.5 : 0,
          borderColor: v.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
          alignSelf: fullWidth ? 'stretch' : 'auto',
        },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={v.fg} /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} color={v.fg} /> : null}
      <Text variant={size === 'sm' ? 'small' : 'body'} weight={700} color={v.fg} numberOfLines={2} align="center" style={{ flexShrink: 1 }}>
        {loading && loadingLabel ? loadingLabel : label}
      </Text>
      {iconEnd && !loading ? (
        <View>
          <Icon name={iconEnd} size={16} color={v.fg} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Round icon-only button with an accessible label. */
export function IconButton({ icon, label, onPress, variant = 'soft', size = 44, disabled }: { icon: IconName; label: string; onPress?: () => void; variant?: ButtonVariant; size?: number; disabled?: boolean }) {
  const v = V[variant];
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={Math.max(0, (MIN_TARGET - size) / 2)}
      style={({ pressed }) => ({
        width: size, height: size, borderRadius: size / 2, backgroundColor: v.bg, alignItems: 'center', justifyContent: 'center',
        borderWidth: v.border ? 1.5 : 0, borderColor: v.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      <Icon name={icon} size={Math.round(size * 0.42)} color={v.fg} />
    </Pressable>
  );
}
