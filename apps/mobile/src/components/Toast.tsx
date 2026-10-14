import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, radius } from '@/theme';
import { announce } from '@/lib/motion';
import { Icon } from './Icon';
import { Text } from './Text';

const Ctx = createContext<(msg: string) => void>(() => {});

/** Lime status toast (role=status, announced to screen readers). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const show = useCallback((m: string) => {
    setMsg(m);
    announce(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(''), 3200);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      {msg ? (
        <View pointerEvents="none" style={{ position: 'absolute', top: insets.top + 8, left: 16, right: 16, alignItems: 'center' }}>
          <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ maxWidth: 520, width: '100%', backgroundColor: color.lime, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
            <Icon name="check-circle" size={18} />
            <Text variant="body" weight={700} style={{ flex: 1 }}>{msg}</Text>
          </View>
        </View>
      ) : null}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
