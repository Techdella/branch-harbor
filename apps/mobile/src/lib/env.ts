/** Build-time configuration (EXPO_PUBLIC_* are inlined by Expo at bundle time). */
export const env = {
  apiUrl: (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, ''),
  useMocks: (process.env.EXPO_PUBLIC_USE_MOCKS ?? 'true') !== 'false',
  stripePublishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || '',
  /** Live mode: organisation slugs whose public locations make up the customer catalogue (white-label brands). */
  brandSlugs: String(process.env.EXPO_PUBLIC_BRAND_SLUGS || 'stillwater-yoga,maple-and-ember,lumen-pilates').split(',').map((s) => s.trim()).filter(Boolean),
  /** Live mode: organisation slug of the wellness brand shown in the customer wellness screens. */
  wellnessSlug: process.env.EXPO_PUBLIC_WELLNESS_SLUG || 'harbourline-wellness',
  appVersion: '0.1.0',
} as const;

export const paymentsConfigured = env.stripePublishableKey.startsWith('pk_');
