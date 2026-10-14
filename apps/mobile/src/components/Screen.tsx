import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@/theme';

/** Scrollable screen on the warm canvas. Leaves room for the floating tab bar when `tabs`. */
export function Screen({ children, onRefresh, refreshing = false, tabs = true, footer, contentStyle, bg }: {
  children: ReactNode; onRefresh?: () => void; refreshing?: boolean; tabs?: boolean; footer?: ReactNode; contentStyle?: StyleProp<ViewStyle>; bg?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: bg ?? color.canvas }}>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.ink} /> : undefined}
        contentContainerStyle={[
          { paddingTop: insets.top + space[3], paddingHorizontal: space[4], paddingBottom: (tabs ? 110 : 32) + insets.bottom + (footer ? 72 : 0), gap: space[4], width: '100%', maxWidth: 720, alignSelf: 'center' },
          contentStyle,
        ]}
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={{ position: 'absolute', left: space[4], right: space[4], bottom: (tabs ? 92 : 16) + insets.bottom, maxWidth: 688, alignSelf: 'center', width: '100%' }}>{footer}</View>
      ) : null}
    </View>
  );
}
