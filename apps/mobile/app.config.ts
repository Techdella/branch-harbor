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
  // Generated from the harbour mark by scripts/generate-assets.mjs (pnpm --filter @bh/mobile assets).
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: `com.branchharbor.app${suffix}`,
    supportsTablet: true,
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: `com.branchharbor.app${suffix}`,
    // Resize the window for the soft keyboard so focused fields and sticky footers stay visible.
    softwareKeyboardLayoutMode: 'resize',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', monochromeImage: './assets/adaptive-icon-monochrome.png', backgroundColor: color.ink },
  },
  web: { bundler: 'metro', output: 'single', backgroundColor: color.canvas, themeColor: color.ink, favicon: './assets/favicon.png' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-localization',
    'expo-font',
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 120, resizeMode: 'contain', backgroundColor: color.canvas, dark: { image: './assets/splash-icon.png', backgroundColor: color.ink } }],
    ['expo-notifications', { icon: './assets/notification-icon.png', color: '#D6F26B', defaultChannel: 'default' }],
    // Audits and compliance documents: photos of checklist items, evidence of fixes and certificates.
    ['expo-image-picker', { cameraPermission: 'BranchHarbor uses the camera for audit photos, evidence of fixes and compliance documents.', photosPermission: 'BranchHarbor attaches photos you choose to audits and compliance documents.' }],
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
