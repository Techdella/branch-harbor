import { Pressable, View } from 'react-native';
import { MIN_TARGET } from '@/theme';
import { Text } from './Text';

export function SectionHeader({ title, action, onAction, sub }: { title: string; sub?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 8 }}>
      <View style={{ flex: 1 }}>
        <Text variant="h3" accessibilityRole="header">
          {title}
        </Text>
        {sub ? <Text variant="small" tone="muted">{sub}</Text> : null}
      </View>
      {action && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" style={{ minHeight: MIN_TARGET, justifyContent: 'center', paddingHorizontal: 4 }}>
          <Text variant="small" weight={700} style={{ textDecorationLine: 'underline' }}>
            {action}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
