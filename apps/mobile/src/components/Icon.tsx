import { memo } from 'react';
import { I18nManager, View, type StyleProp, type ViewStyle } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { ICON_PATHS, type IconName } from '@bh/icons';
import { color as tokens } from '@/theme';

export type { IconName };

const DIRECTIONAL = new Set<IconName>(['chevron-right', 'chevron-left', 'arrow-right', 'arrow-left', 'send', 'logout']);

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
  /** Icons are decorative by default; pass a label when the icon alone carries meaning. */
  accessibilityLabel?: string;
}

/** Renders @bh/icons (24×24 inner SVG markup, stroke=currentColor) via SvgXml. Mirrors directional icons in RTL. */
export const Icon = memo(function Icon({ name, size = 20, color = tokens.ink, strokeWidth = 1.9, style, accessibilityLabel }: IconProps) {
  const inner = ICON_PATHS[name] ?? '';
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner.replace(/currentColor/g, color)}</svg>`;
  const flip = I18nManager.isRTL && DIRECTIONAL.has(name);
  return (
    <View
      style={[{ width: size, height: size }, flip && { transform: [{ scaleX: -1 }] }, style]}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
      accessibilityElementsHidden={!accessibilityLabel}
    >
      <SvgXml xml={xml} width={size} height={size} />
    </View>
  );
});
