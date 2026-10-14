import { TextInput, View, type TextInputProps } from 'react-native';
import { color, fontFamily, radius, status } from '@/theme';
import { Text } from './Text';

/** Labelled input; errors appear next to the field and keep the entered value. */
export function TextField({ label, error, hint, ...rest }: { label: string; error?: string; hint?: string } & TextInputProps) {
  return (
    <View style={{ gap: 6 }}>
      <Text variant="small" weight={700}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={error ?? hint}
        placeholderTextColor={color.mute}
        style={{
          minHeight: 48, borderRadius: radius.sm, backgroundColor: color.surface, borderWidth: 1.5, borderColor: error ? status.danger.fg : color.lineSoft,
          paddingHorizontal: 14, paddingVertical: 10, fontFamily: fontFamily[500], fontSize: 15, color: color.ink, textAlign: 'auto',
        }}
        {...rest}
      />
      {error ? (
        <Text variant="small" weight={700} color={status.danger.fg} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? <Text variant="small" tone="muted">{hint}</Text> : null}
    </View>
  );
}
