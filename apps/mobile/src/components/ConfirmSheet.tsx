import { useEffect, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import { color, radius } from '@/theme';
import { useI18n } from '@/i18n';
import { useReducedMotion } from '@/lib/motion';
import { Button, type ButtonVariant } from './Button';
import { Text } from './Text';
import { TextField } from './TextField';

export interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  /** Consequence preview: what will happen, to what, where, and for how much. */
  body?: string;
  children?: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  onConfirm: (reason?: string) => Promise<void> | void;
  onCancel: () => void;
  withReason?: string;
  error?: string | null;
}

/** Accessible bottom-sheet dialog for consequential actions. Waits for the server before closing. */
export function ConfirmSheet({ visible, title, body, children, confirmLabel, confirmVariant = 'primary', onConfirm, onCancel, withReason, error }: ConfirmSheetProps) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (visible) {
      setBusy(false);
      setReason('');
    }
  }, [visible]);
  return (
    <Modal visible={visible} transparent animationType={reduced ? 'none' : 'slide'} onRequestClose={onCancel} accessibilityViewIsModal>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(20,20,20,0.45)' }} onPress={busy ? undefined : onCancel} accessibilityLabel={t('common.close')} accessibilityRole="button" />
        <View accessibilityViewIsModal style={{ backgroundColor: color.canvasRaised, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: 20, paddingBottom: 36, gap: 14, maxWidth: 640, width: '100%', alignSelf: 'center' }}>
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: color.line }} />
          <Text variant="h2" accessibilityRole="header">{title}</Text>
          {body ? <Text variant="body" color={color.graphite}>{body}</Text> : null}
          {children}
          {withReason ? <TextField label={withReason} value={reason} onChangeText={setReason} multiline /> : null}
          {error ? <Text variant="small" weight={700} color="#9E1B12" accessibilityRole="alert">{error}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button label={t('common.cancel')} variant="soft" onPress={onCancel} disabled={busy} style={{ flex: 1 }} />
            <Button
              label={confirmLabel}
              variant={confirmVariant}
              loading={busy}
              loadingLabel={t('staff.waitingServer')}
              style={{ flex: 1 }}
              onPress={async () => {
                setBusy(true);
                try {
                  await onConfirm(reason.trim() || undefined);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
