/** Build-time configuration (EXPO_PUBLIC_* are inlined by Expo at bundle time). */
export const env = {
  apiUrl: (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, ''),
  useMocks: (process.env.EXPO_PUBLIC_USE_MOCKS ?? 'true') !== 'false',
  stripePublishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || '',
  appVersion: '0.1.0',
} as const;

export const paymentsConfigured = env.stripePublishableKey.startsWith('pk_');
