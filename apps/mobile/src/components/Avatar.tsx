import { Image, View } from 'react-native';
import { color, pastel } from '@/theme';
import { Text } from './Text';

const BG = [pastel.lilac, pastel.butter, pastel.aqua, pastel.blush, pastel.sage];

export function Avatar({ name, uri, size = 40 }: { name: string; uri?: string; size?: number }) {
  const initials = name.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const bg = BG[(name.charCodeAt(0) || 0) % BG.length];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}
    >
      {uri ? <Image source={{ uri }} style={{ width: size, height: size }} /> : <Text variant="small" weight={800} color={color.ink} style={{ fontSize: size * 0.36 }}>{initials}</Text>}
    </View>
  );
}
