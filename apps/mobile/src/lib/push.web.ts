/** Web preview: browsers are not registered for Expo push; everything else works the same. */
export type PushRegistration = { status: 'registered'; token: string } | { status: 'denied' | 'unavailable'; reason?: string };

export async function registerForPushNotifications(): Promise<PushRegistration> {
  return { status: 'unavailable', reason: 'Push notifications are available in the iOS and Android apps.' };
}

export function usePushNotifications(_enabled: boolean, _userId: string | null) {
  /* no-op on web */
}
