import { Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { color, radius } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Floating ink pill tab bar from the prototypes: lime marks the active tab (the single signal), label shown when active. */
export function TabBar({ state, descriptors, navigation, icons }: BottomTabBarProps & { icons: Record<string, IconName> }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const routes = state.routes.filter((r) => {
    const o = descriptors[r.key]?.options as { href?: string | null; tabBarItemStyle?: { display?: string } } | undefined;
    return o?.href !== null && o?.tabBarItemStyle?.display !== 'none';
  });
  // Small phones with many tabs (staff: up to 7): the active label only shows when it fits, so the bar never
  // overflows; the tab keeps its accessible name either way.
  const barWidth = Math.min(width - 24 - insets.left - insets.right, 520) - 12;
  const tabMin = Math.min(routes.length > 5 ? 44 : 48, Math.floor(barWidth / Math.max(routes.length, 1)));
  const labelFits = (label: string) => barWidth - (routes.length - 1) * tabMin >= tabMin + 6 + label.length * 7.5;
  return (
    <View
      accessibilityRole="tablist"
      style={{ position: 'absolute', left: 12 + insets.left, right: 12 + insets.right, bottom: Math.max(insets.bottom, 12), alignItems: 'center' }}
    >
      <View style={{ width: '100%', maxWidth: 520, minHeight: 66, backgroundColor: color.ink, borderRadius: radius.pill, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 6, paddingVertical: 8 }}>
        {routes.map((route) => {
          const d = descriptors[route.key];
          const opts = (d?.options ?? {}) as { title?: string; tabBarBadge?: number | string };
          const focused = state.routes[state.index]?.key === route.key;
          const label = opts.title ?? route.name;
          const icon = icons[route.name] ?? 'grid';
          const badge = opts.tabBarBadge;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={badge ? `${label}, ${badge}` : label}
              onPress={() => {
                const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!focused && !e.defaultPrevented) navigation.navigate(route.name, route.params);
              }}
              style={{ minHeight: 50, minWidth: tabMin, flexShrink: 1, paddingHorizontal: routes.length > 5 ? 8 : 12, borderRadius: radius.pill, backgroundColor: focused ? color.lime : 'transparent', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <Icon name={icon} size={19} color={focused ? color.ink : color.surface} />
              {focused && labelFits(label) ? (
                <Text variant="small" weight={800} color={color.ink} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                  {label}
                </Text>
              ) : null}
              {badge && !focused ? (
                <View style={{ position: 'absolute', top: 4, right: 4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: color.lime, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}>
                  <Text variant="small" weight={800} style={{ fontSize: 10, lineHeight: 12 }} maxFontSizeMultiplier={1.2}>
                    {String(badge)}
                  </Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
