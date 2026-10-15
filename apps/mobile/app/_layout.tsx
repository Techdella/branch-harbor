import { useEffect } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
// Per-weight imports so only the five weights we use are bundled.
import { PlusJakartaSans_400Regular } from '@expo-google-fonts/plus-jakarta-sans/400Regular';
import { PlusJakartaSans_500Medium } from '@expo-google-fonts/plus-jakarta-sans/500Medium';
import { PlusJakartaSans_600SemiBold } from '@expo-google-fonts/plus-jakarta-sans/600SemiBold';
import { PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans/700Bold';
import { PlusJakartaSans_800ExtraBold } from '@expo-google-fonts/plus-jakarta-sans/800ExtraBold';
import { I18nProvider } from '@/i18n';
import { SessionProvider } from '@/lib/session';
import { PaymentsProvider, ToastProvider } from '@/components';
import { color } from '@/theme';
import { env } from '@/lib/env';
import { DemoRibbon } from '@/features/demo/DemoPicker';

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [loaded, error] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });
  const ready = loaded || !!error; // fall back to system font rather than blocking
  useEffect(() => {
    if (ready) void SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  if (!ready) return <View style={{ flex: 1, backgroundColor: color.canvas }} />;

  return (
    <SafeAreaProvider>
      <I18nProvider>
        <SessionProvider>
          <PaymentsProvider>
            <ToastProvider>
              <StatusBar style="dark" />
              {env.demoMode ? <DemoRibbon /> : null}
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />
            </ToastProvider>
          </PaymentsProvider>
        </SessionProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
