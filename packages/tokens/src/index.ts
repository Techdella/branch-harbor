/**
 * BranchHarbor design tokens — single source of truth for web (CSS variables in theme.css)
 * and native (import these objects directly). Keep both files in sync.
 *
 * Brand rules (from the brand sheet):
 * - Ink carries text and actions. Lime is the signal: one highlight per view, never used for text.
 * - Pastels identify industries and soften cards. They are not status colours.
 * - Status is always communicated with text + icon, never colour alone.
 */

export const color = {
  ink: '#141414',
  ink2: '#2A2A2A',
  graphite: '#3E3E3A',
  stone: '#5D5D58', // secondary text, 6.6:1 on white
  mute: '#6B6B65', // tertiary text / placeholders, 4.8:1 on canvas (was #9C9C96, 2.7:1)
  line: '#D8D6CF',
  lineSoft: '#E4E2DC',
  canvas: '#F3F2EE', // app + marketing background
  canvasRaised: '#F8F7F3',
  surface: '#FFFFFF',
  lime: '#D6F26B', // signal — max one per view, never text
  limeSoft: '#E2F5A6',
  sage: '#5E7D68', // links/hover, white text 4.8:1
  sageDeep: '#2F6B3A',
  focus: '#2867AA',
} as const;

/** Dark scheme (apps/app + apps/sites via theme-dark.css). Neutrals invert; lime and pastels are unchanged. */
export const darkColor = {
  ink: '#F3F2EE',
  ink2: '#E2E1DC',
  graphite: '#CFCEC8',
  stone: '#B4B3AC',
  mute: '#8F8E88',
  line: '#3D3D39',
  lineSoft: '#2E2E2B',
  canvas: '#141413',
  canvasRaised: '#1A1A18',
  surface: '#1F1F1D',
  lime: '#D6F26B',
  limeSoft: '#E2F5A6',
  sage: '#9CC2A8',
  sageDeep: '#A6D4AE',
  focus: '#8AB8EE',
} as const;

export const pastel = {
  lilac: '#E9DDF8',
  lime: '#E2F5A6',
  sage: '#D4E6D9',
  butter: '#F7EDA8',
  blush: '#F8D6D8',
  aqua: '#CDEEEE',
  sand: '#EFE3D3',
} as const;

/** Status colours — always paired with a label and icon. */
export const status = {
  success: { bg: '#F1F8E0', fg: '#2F6B3A', border: '#C9E39A' },
  warning: { bg: '#FFF3C9', fg: '#5A4300', border: '#F0D97A' },
  danger: { bg: '#FBE4E1', fg: '#9E1B12', border: '#F2B8B0' },
  info: { bg: '#E6F0F8', fg: '#1F4E80', border: '#B8D2EA' },
  neutral: { bg: '#EEEDE8', fg: '#3E3E3A', border: '#D8D6CF' },
} as const;

export type IndustryKey = 'studios' | 'sports' | 'wellness' | 'commerce' | 'foods' | 'realty';

export const industry: Record<IndustryKey, { label: string; pastel: string; accent: string; icon: string }> = {
  studios: { label: 'Studios', pastel: pastel.lilac, accent: '#7460A8', icon: 'lotus' },
  sports: { label: 'Sports', pastel: pastel.lime, accent: '#2867AA', icon: 'trophy' },
  wellness: { label: 'Health & Wellness', pastel: pastel.sage, accent: '#56836C', icon: 'stethoscope' },
  commerce: { label: 'Commerce', pastel: pastel.butter, accent: '#A66C26', icon: 'bag' },
  foods: { label: 'Foods', pastel: pastel.blush, accent: '#B9543D', icon: 'utensils' },
  realty: { label: 'Real Estate', pastel: pastel.aqua, accent: '#2C7A7B', icon: 'house' },
};

export const radius = { xs: 8, sm: 12, md: 16, card: 20, lg: 24, xl: 28, xxl: 36, pill: 999 } as const;

/** 4px base scale. */
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64, 20: 80 } as const;

export const font = {
  sans: "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

export const type = {
  display: { size: 72, weight: 800, tracking: -0.05, lineHeight: 0.95 },
  h1: { size: 40, weight: 700, tracking: -0.035, lineHeight: 1.05 },
  h2: { size: 26, weight: 700, tracking: -0.025, lineHeight: 1.15 },
  h3: { size: 20, weight: 700, tracking: -0.015, lineHeight: 1.25 },
  bodyL: { size: 18, weight: 500, tracking: 0, lineHeight: 1.55 },
  body: { size: 14, weight: 500, tracking: 0, lineHeight: 1.5 },
  label: { size: 12, weight: 800, tracking: 0.08, lineHeight: 1.3 },
} as const;

export const shadow = {
  card: '0 1px 2px rgba(20,20,20,.04), 0 4px 16px rgba(20,20,20,.04)',
  pop: '0 8px 32px rgba(20,20,20,.12)',
} as const;

export const control = { height: 44, heightSm: 36 } as const;

export const motion = { fast: 120, base: 200, slow: 320, easing: 'cubic-bezier(.2,.8,.2,1)' } as const;

export const breakpoints = { sm: 360, md: 768, lg: 1024, xl: 1440 } as const;

export const tokens = { color, pastel, status, industry, radius, space, font, type, shadow, control, motion, breakpoints };
export default tokens;
