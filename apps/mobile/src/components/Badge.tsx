import { View } from 'react-native';
import { status as S, radius } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type Tone = keyof typeof S;
const DEFAULT_ICON: Record<Tone, IconName> = { success: 'check-circle', warning: 'alert', danger: 'alert', info: 'info', neutral: 'clock' };

/** Status = text + icon (never colour alone). */
export function Badge({ label, tone = 'neutral', icon }: { label: string; tone?: Tone; icon?: IconName }) {
  const s = S[tone];
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: s.bg, borderColor: s.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3 }}
    >
      <Icon name={icon ?? DEFAULT_ICON[tone]} size={13} color={s.fg} strokeWidth={2.2} />
      <Text variant="small" weight={700} color={s.fg}>
        {label}
      </Text>
    </View>
  );
}
