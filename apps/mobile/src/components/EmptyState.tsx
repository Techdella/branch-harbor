import { View } from 'react-native';
import { color, pastel, radius } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Empty states explain the next useful action. */
export function EmptyState({ icon = 'info', title, body, action, onAction, bg }: { icon?: IconName; title: string; body?: string; action?: string; onAction?: () => void; bg?: string }) {
  return (
    <View style={{ backgroundColor: color.surface, borderRadius: radius.card, padding: 24, alignItems: 'center', gap: 10 }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: bg ?? pastel.sand, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={24} />
      </View>
      <Text variant="h3" align="center" accessibilityRole="header">
        {title}
      </Text>
      {body ? <Text variant="body" tone="muted" align="center">{body}</Text> : null}
      {action && onAction ? <Button label={action} onPress={onAction} variant="secondary" size="sm" /> : null}
    </View>
  );
}

export function ErrorState({ title, body, retryLabel, onRetry }: { title: string; body?: string; retryLabel: string; onRetry: () => void }) {
  return <EmptyState icon="alert" bg="#FBE4E1" title={title} body={body} action={retryLabel} onAction={onRetry} />;
}
