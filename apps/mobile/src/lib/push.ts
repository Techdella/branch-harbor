import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { api } from './api';

/**
 * Push notifications (iOS/Android). After sign-in the app asks for permission once, obtains this device's Expo
 * push token and registers it with POST /v1/me/push-tokens. The server sends order updates, approval requests,
 * cover requests and waitlist promotions through the Expo Push API and honours the user's preferences.
 * The web preview has its own no-op implementation (push.web.ts).
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export type PushRegistration = { status: 'registered'; token: string } | { status: 'denied' | 'unavailable'; reason?: string };

export async function registerForPushNotifications(): Promise<PushRegistration> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'Updates', importance: Notifications.AndroidImportance.DEFAULT });
    }
    const current = await Notifications.getPermissionsAsync();
    let granted = current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (!granted && current.canAskAgain) granted = (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return { status: 'denied' };
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ?? Constants.easConfig?.projectId;
    const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await api.registerPushToken(token);
    return { status: 'registered', token };
  } catch (e) {
    // Simulators, Expo Go without a project id, or no network: the app keeps working without push.
    return { status: 'unavailable', reason: (e as Error).message };
  }
}

/** Map a notification's deep link (branchharbor://staff/cover) to an in-app route. */
function routeFor(data: Record<string, unknown> | undefined): string | null {
  const url = typeof data?.url === 'string' ? data.url : null;
  if (!url) return null;
  const path = url.replace(/^branchharbor:\/\//, '/');
  return path.startsWith('/') ? path : null;
}

/** Registers once per signed-in (non-guest) session and opens the right screen when a notification is tapped. */
export function usePushNotifications(enabled: boolean, userId: string | null) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !userId || done.current === userId) return;
    done.current = userId;
    void registerForPushNotifications();
  }, [enabled, userId]);
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const to = routeFor(r.notification.request.content.data as Record<string, unknown> | undefined);
      if (to) router.push(to as never);
    });
    return () => sub.remove();
  }, []);
}
