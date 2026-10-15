import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space } from '@/theme';

/**
 * Scrollable screen on the warm canvas. Leaves room for the floating tab bar when `tabs`.
 * Safe-area aware (notch, home indicator, landscape side insets) and keyboard aware: iOS lifts the content
 * and the sticky footer above the keyboard; Android resizes the window (`softwareKeyboardLayoutMode`).
 * Content is capped at 720pt and centred so tablets and landscape phones don't stretch lines.
 */
export function Screen({ children, onRefresh, refreshing = false, tabs = true, footer, contentStyle, bg }: {
  children: ReactNode; onRefresh?: () => void; refreshing?: boolean; tabs?: boolean; footer?: ReactNode; contentStyle?: StyleProp<ViewStyle>; bg?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: bg ?? color.canvas }}>
      <ScrollView
        contentInsetAdjustmentBehavior="never"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.ink} /> : undefined}
        contentContainerStyle={[
          { paddingTop: insets.top + space[3], paddingLeft: space[4] + insets.left, paddingRight: space[4] + insets.right, paddingBottom: (tabs ? 110 : 32) + insets.bottom + (footer ? 72 : 0), gap: space[4], width: '100%', maxWidth: 720, alignSelf: 'center' },
          contentStyle,
        ]}
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={{ position: 'absolute', left: space[4], right: space[4], bottom: (tabs ? 92 : 16) + insets.bottom, maxWidth: 688, alignSelf: 'center', width: '100%' }}>{footer}</View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
