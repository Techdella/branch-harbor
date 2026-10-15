/** Build-time configuration (EXPO_PUBLIC_* are inlined by Expo at bundle time). */
export const env = {
  apiUrl: (process.env.EXPO_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, ''),
  /** Demo build only (demo site / prospects): "Demo environment" ribbon and the demo account picker on sign-in. */
  demoMode: process.env.EXPO_PUBLIC_DEMO_MODE === 'true',
  stripePublishableKey: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || '',
  /** Organisation slugs whose public locations make up the customer catalogue (the white-label brands this build serves). */
  brandSlugs: String(process.env.EXPO_PUBLIC_BRAND_SLUGS || 'stillwater-yoga,maple-and-ember,lumen-pilates').split(',').map((s) => s.trim()).filter(Boolean),
  /** Organisation slug of the wellness brand shown in the customer wellness screens. */
  wellnessSlug: process.env.EXPO_PUBLIC_WELLNESS_SLUG || 'harbourline-wellness',
  appVersion: '0.1.0',
} as const;

export const paymentsConfigured = env.stripePublishableKey.startsWith('pk_');
