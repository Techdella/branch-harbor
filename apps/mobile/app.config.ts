import type { ExpoConfig, ConfigContext } from 'expo/config';
// Mirrors @bh/tokens (color.canvas / color.ink). Config is evaluated in Node, outside Metro,
// so we avoid importing workspace TS source here.
const color = { canvas: '#F3F2EE', ink: '#141414' } as const;

const variant = process.env.APP_VARIANT ?? 'development';
const suffix = variant === 'production' ? '' : `.${variant}`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant === 'production' ? 'BranchHarbor' : `BranchHarbor (${variant})`,
  slug: 'branchharbor',
  scheme: 'branchharbor',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  backgroundColor: color.canvas,
  // Placeholder: no icon assets yet. Add ./assets/icon.png (1024x1024) before store builds.
  ios: {
    bundleIdentifier: `com.branchharbor.app${suffix}`,
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: `com.branchharbor.app${suffix}`,
    adaptiveIcon: { backgroundColor: color.ink },
  },
  web: { bundler: 'metro', output: 'single', backgroundColor: color.canvas, themeColor: color.ink },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-localization',
    'expo-font',
    ['expo-splash-screen', { backgroundColor: color.canvas, dark: { backgroundColor: color.ink } }],
    [
      '@stripe/stripe-react-native',
      { merchantIdentifier: process.env.STRIPE_MERCHANT_IDENTIFIER ?? 'merchant.com.branchharbor.app', enableGooglePay: true },
    ],
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000',
    useMocks: (process.env.EXPO_PUBLIC_USE_MOCKS ?? 'true') !== 'false',
    variant,
  },
});
