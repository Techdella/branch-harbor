import type { ReactNode } from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { color, radius, space } from '@/theme';

export interface CardProps {
  children: ReactNode;
  bg?: string;
  padding?: number;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  dark?: boolean;
}

/** White rounded card on the warm canvas. Pastel `bg` softens; `dark` is the ink feature card. */
export function Card({ children, bg, padding = space[4], onPress, accessibilityLabel, accessibilityHint, style, dark }: CardProps) {
  const base: ViewStyle = { backgroundColor: dark ? color.ink : bg ?? color.surface, borderRadius: radius.card, padding, gap: space[2] };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [base, { opacity: pressed ? 0.9 : 1 }, style]}
    >
      {children}
    </Pressable>
  );
}
