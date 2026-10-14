import { View } from 'react-native';
import { status as S, radius } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';
import type { Tone } from './Badge';

const ICON: Record<Tone, IconName> = { success: 'check-circle', warning: 'wifi-off', danger: 'alert', info: 'info', neutral: 'info' };

/** Inline notice. Errors use role "alert" so screen readers announce them. */
export function Banner({ tone = 'info', title, body, icon, action, onAction }: { tone?: Tone; title: string; body?: string; icon?: IconName; action?: string; onAction?: () => void }) {
  const s = S[tone];
  return (
    <View
      accessibilityRole={tone === 'danger' || tone === 'warning' ? 'alert' : 'summary'}
      accessibilityLiveRegion="polite"
      style={{ backgroundColor: s.bg, borderColor: s.border, borderWidth: 1, borderRadius: radius.md, padding: 12, gap: 8 }}
    >
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <Icon name={icon ?? ICON[tone]} size={18} color={s.fg} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" weight={700} color={s.fg}>
            {title}
          </Text>
          {body ? <Text variant="small" color={s.fg}>{body}</Text> : null}
        </View>
      </View>
      {action && onAction ? <Button label={action} onPress={onAction} size="sm" variant="secondary" style={{ alignSelf: 'flex-start' }} /> : null}
    </View>
  );
}
