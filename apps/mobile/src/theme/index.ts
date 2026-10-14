import { color, pastel, status, industry, radius, space, type, control, motion } from '@bh/tokens';

export { color, pastel, status, industry, radius, space, type, control, motion };

/** Plus Jakarta Sans families loaded in app/_layout.tsx. Weight → family (RN can't synthesise weights for custom fonts). */
export const fontFamily = {
  400: 'PlusJakartaSans_400Regular',
  500: 'PlusJakartaSans_500Medium',
  600: 'PlusJakartaSans_600SemiBold',
  700: 'PlusJakartaSans_700Bold',
  800: 'PlusJakartaSans_800ExtraBold',
} as const;
export type FontWeight = keyof typeof fontFamily;

/** Mobile type scale derived from @bh/tokens `type` (web display sizes scaled down for phones). */
export const textVariants = {
  display: { fontSize: 32, lineHeight: 36, weight: 800 as FontWeight, letterSpacing: -0.9 },
  h1: { fontSize: 26, lineHeight: 31, weight: 700 as FontWeight, letterSpacing: -0.6 },
  h2: { fontSize: type.h3.size, lineHeight: 25, weight: 700 as FontWeight, letterSpacing: -0.3 },
  h3: { fontSize: 16, lineHeight: 21, weight: 700 as FontWeight, letterSpacing: -0.1 },
  bodyL: { fontSize: 16, lineHeight: 24, weight: 500 as FontWeight, letterSpacing: 0 },
  body: { fontSize: type.body.size, lineHeight: 21, weight: 500 as FontWeight, letterSpacing: 0 },
  small: { fontSize: 12, lineHeight: 17, weight: 500 as FontWeight, letterSpacing: 0 },
  label: { fontSize: 11, lineHeight: 15, weight: 800 as FontWeight, letterSpacing: 0.8 },
} as const;
export type TextVariant = keyof typeof textVariants;

/** Minimum touch target (iOS HIG 44pt / WCAG 2.2 target size). */
export const MIN_TARGET = control.height;

export const cardShadow = {
  shadowColor: color.ink,
  shadowOpacity: 0.05,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 1,
} as const;
