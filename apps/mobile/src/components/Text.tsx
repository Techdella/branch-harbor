import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { color, fontFamily, textVariants, type FontWeight, type TextVariant } from '@/theme';

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  weight?: FontWeight;
  color?: string;
  tone?: 'default' | 'muted' | 'inverse';
  align?: TextStyle['textAlign'];
  tabular?: boolean;
}

/** Text with Plus Jakarta Sans and the mobile type scale. Scales with Dynamic Type (capped for layout safety). */
export function Text({ variant = 'body', weight, color: c, tone = 'default', align, tabular, style, maxFontSizeMultiplier, ...rest }: AppTextProps) {
  const v = textVariants[variant];
  const w = weight ?? v.weight;
  const fg = c ?? (tone === 'muted' ? color.stone : tone === 'inverse' ? color.surface : color.ink);
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? (variant === 'display' || variant === 'h1' ? 1.4 : 1.8)}
      style={[
        {
          fontFamily: fontFamily[w],
          fontSize: v.fontSize,
          lineHeight: v.lineHeight,
          letterSpacing: v.letterSpacing,
          color: fg,
          textAlign: align ?? 'auto',
          writingDirection: 'auto',
        },
        variant === 'label' && { textTransform: 'uppercase' },
        tabular && { fontVariant: ['tabular-nums'] },
        style,
      ]}
      {...rest}
    />
  );
}
