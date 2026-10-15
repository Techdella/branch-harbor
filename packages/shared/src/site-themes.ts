/**
 * Website theme library. A theme is presentation only (typography, palette, shape, layout variants, decoration);
 * page documents never depend on it, so switching theme keeps all content. Brand overrides (logo, colours, fonts
 * from the safe list) apply on top. Every palette is checked for WCAG contrast (see `themeContrastReport`), and each
 * theme carries a dark palette so sites stay legible with `prefers-color-scheme: dark`.
 */

/** Fonts a site may use. Keys map to Google Fonts families (self-hosted by apps/sites via next/font). */
export const SITE_FONT_FAMILIES = {
  system: { family: 'system-ui', kind: 'sans', google: null },
  'plus-jakarta-sans': { family: 'Plus Jakarta Sans', kind: 'sans', google: 'Plus+Jakarta+Sans:wght@400;600;700;800' },
  inter: { family: 'Inter', kind: 'sans', google: 'Inter:wght@400;600;700;800' },
  'work-sans': { family: 'Work Sans', kind: 'sans', google: 'Work+Sans:wght@400;600;700' },
  'source-serif-4': { family: 'Source Serif 4', kind: 'serif', google: 'Source+Serif+4:wght@400;600;700' },
  lora: { family: 'Lora', kind: 'serif', google: 'Lora:wght@400;600;700' },
  merriweather: { family: 'Merriweather', kind: 'serif', google: 'Merriweather:wght@400;700' },
  fraunces: { family: 'Fraunces', kind: 'serif', google: 'Fraunces:wght@400;600;700;800' },
  manrope: { family: 'Manrope', kind: 'sans', google: 'Manrope:wght@400;600;700;800' },
  archivo: { family: 'Archivo', kind: 'sans', google: 'Archivo:wght@400;600;700;800;900' },
  'cormorant-garamond': { family: 'Cormorant Garamond', kind: 'serif', google: 'Cormorant+Garamond:wght@500;600;700' },
  'playfair-display': { family: 'Playfair Display', kind: 'serif', google: 'Playfair+Display:wght@500;600;700;800' },
  'space-grotesk': { family: 'Space Grotesk', kind: 'sans', google: 'Space+Grotesk:wght@400;500;700' },
  'dm-sans': { family: 'DM Sans', kind: 'sans', google: 'DM+Sans:wght@400;500;700' },
  'dm-serif-display': { family: 'DM Serif Display', kind: 'serif', google: 'DM+Serif+Display' },
  nunito: { family: 'Nunito', kind: 'sans', google: 'Nunito:wght@400;600;700;800' },
  oswald: { family: 'Oswald', kind: 'sans', google: 'Oswald:wght@400;500;600;700' },
  karla: { family: 'Karla', kind: 'sans', google: 'Karla:wght@400;600;700' },
} as const;
export type SiteFont = keyof typeof SITE_FONT_FAMILIES;
export const SITE_FONT_KEYS = Object.keys(SITE_FONT_FAMILIES) as SiteFont[];

export interface Palette {
  bg: string;
  surface: string;
  muted: string;
  text: string;
  subtle: string;
  primary: string;
  onPrimary: string;
  /** Links and brand-coloured text: ≥ 4.5:1 on bg, surface and muted. */
  link: string;
  accent: string;
  onAccent: string;
  border: string;
  contrastBg: string;
  onContrast: string;
}

export type ThemeFamily = 'studios' | 'sports' | 'wellness' | 'commerce' | 'foods' | 'realty' | 'hospitality';
export const THEME_FAMILIES: ThemeFamily[] = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty', 'hospitality'];

export interface ThemeDef {
  id: string;
  families: ThemeFamily[];
  fonts: { heading: SiteFont; body: SiteFont };
  light: Palette;
  dark: Palette;
  shape: { radius: number; button: number; image: number };
  layout: {
    hero: 'centered' | 'split' | 'overlay' | 'editorial' | 'banner';
    header: 'bar' | 'centered' | 'boxed' | 'minimal';
    cards: 'flat' | 'outline' | 'raised' | 'tinted';
    headingCase: 'none' | 'upper';
    headingWeight: number;
    headingTracking: string;
    headingScale: number;
    density: 'tight' | 'regular' | 'airy';
    divider: 'none' | 'line' | 'wave' | 'angle';
  };
  decoration: 'none' | 'grain' | 'dots' | 'grid' | 'blobs' | 'stripes';
}

const P = (p: Palette) => p;

export const SITE_THEMES: ThemeDef[] = [
  {
    id: 'classic', families: [...THEME_FAMILIES], fonts: { heading: 'plus-jakarta-sans', body: 'plus-jakarta-sans' },
    light: P({ bg: '#FFFFFF', surface: '#FFFFFF', muted: '#F5F4F0', text: '#141414', subtle: '#4A4A46', primary: '#141414', onPrimary: '#FFFFFF', link: '#141414', accent: '#D7F25C', onAccent: '#141414', border: '#E4E2DB', contrastBg: '#141414', onContrast: '#FFFFFF' }),
    dark: P({ bg: '#141413', surface: '#1E1E1C', muted: '#24241F', text: '#F3F2EE', subtle: '#C4C2BA', primary: '#F3F2EE', onPrimary: '#141414', link: '#F3F2EE', accent: '#D7F25C', onAccent: '#141414', border: '#3A3A35', contrastBg: '#F3F2EE', onContrast: '#141414' }),
    shape: { radius: 24, button: 999, image: 24 },
    layout: { hero: 'split', header: 'bar', cards: 'outline', headingCase: 'none', headingWeight: 800, headingTracking: '-0.02em', headingScale: 1, density: 'regular', divider: 'none' },
    decoration: 'none',
  },
  {
    id: 'sage', families: ['wellness', 'studios', 'hospitality', 'foods'], fonts: { heading: 'fraunces', body: 'manrope' },
    light: P({ bg: '#FBF8F2', surface: '#FFFFFF', muted: '#EEF1E8', text: '#1F2A22', subtle: '#4C5A4F', primary: '#3E5E47', onPrimary: '#FFFFFF', link: '#36533F', accent: '#E7C9A9', onAccent: '#1F2A22', border: '#DDE2D6', contrastBg: '#2A3D30', onContrast: '#F6F3EC' }),
    dark: P({ bg: '#161C17', surface: '#1E2620', muted: '#232D25', text: '#EEF1E8', subtle: '#BAC6BC', primary: '#A9C8B0', onPrimary: '#16201A', link: '#B7D3BD', accent: '#E7C9A9', onAccent: '#1F2A22', border: '#334036', contrastBg: '#EEF1E8', onContrast: '#1F2A22' }),
    shape: { radius: 28, button: 999, image: 32 },
    layout: { hero: 'split', header: 'centered', cards: 'tinted', headingCase: 'none', headingWeight: 600, headingTracking: '-0.01em', headingScale: 1.08, density: 'airy', divider: 'wave' },
    decoration: 'blobs',
  },
  {
    id: 'pulse', families: ['sports', 'studios', 'wellness', 'commerce'], fonts: { heading: 'archivo', body: 'inter' },
    light: P({ bg: '#FFFFFF', surface: '#F7F7F7', muted: '#F0F0EE', text: '#0B0B0B', subtle: '#454545', primary: '#0B0B0B', onPrimary: '#E4FF3A', link: '#0B0B0B', accent: '#E4FF3A', onAccent: '#0B0B0B', border: '#D9D9D6', contrastBg: '#0B0B0B', onContrast: '#FFFFFF' }),
    dark: P({ bg: '#0B0B0B', surface: '#161616', muted: '#1C1C1C', text: '#FAFAFA', subtle: '#BDBDBD', primary: '#E4FF3A', onPrimary: '#0B0B0B', link: '#E4FF3A', accent: '#E4FF3A', onAccent: '#0B0B0B', border: '#333333', contrastBg: '#E4FF3A', onContrast: '#0B0B0B' }),
    shape: { radius: 4, button: 4, image: 0 },
    layout: { hero: 'overlay', header: 'bar', cards: 'flat', headingCase: 'upper', headingWeight: 900, headingTracking: '-0.01em', headingScale: 1.15, density: 'tight', divider: 'angle' },
    decoration: 'stripes',
  },
  {
    id: 'atelier', families: ['commerce', 'hospitality', 'wellness', 'realty', 'foods'], fonts: { heading: 'cormorant-garamond', body: 'work-sans' },
    light: P({ bg: '#FAF7F2', surface: '#FFFFFF', muted: '#F1ECE3', text: '#22201C', subtle: '#57524A', primary: '#22201C', onPrimary: '#FAF7F2', link: '#6B4E2E', accent: '#C9A877', onAccent: '#22201C', border: '#E2DACD', contrastBg: '#22201C', onContrast: '#FAF7F2' }),
    dark: P({ bg: '#181613', surface: '#211E1A', muted: '#26231E', text: '#F2EDE4', subtle: '#C7BFB2', primary: '#E8DCC6', onPrimary: '#22201C', link: '#DCC39A', accent: '#C9A877', onAccent: '#22201C', border: '#3B362F', contrastBg: '#F2EDE4', onContrast: '#22201C' }),
    shape: { radius: 0, button: 0, image: 0 },
    layout: { hero: 'editorial', header: 'centered', cards: 'flat', headingCase: 'none', headingWeight: 600, headingTracking: '0', headingScale: 1.25, density: 'airy', divider: 'line' },
    decoration: 'none',
  },
  {
    id: 'bistro', families: ['foods', 'hospitality', 'commerce'], fonts: { heading: 'playfair-display', body: 'source-serif-4' },
    light: P({ bg: '#FFF8EE', surface: '#FFFFFF', muted: '#FBEBD6', text: '#2B1B14', subtle: '#5E4538', primary: '#B23A2B', onPrimary: '#FFFFFF', link: '#9C2F22', accent: '#F2B544', onAccent: '#2B1B14', border: '#EED9BE', contrastBg: '#2B1B14', onContrast: '#FFF8EE' }),
    dark: P({ bg: '#1A120E', surface: '#241913', muted: '#2B1E17', text: '#FCEFE0', subtle: '#D6C1AE', primary: '#F08A70', onPrimary: '#2B1B14', link: '#F5A28C', accent: '#F2B544', onAccent: '#2B1B14', border: '#45322A', contrastBg: '#FCEFE0', onContrast: '#2B1B14' }),
    shape: { radius: 10, button: 6, image: 10 },
    layout: { hero: 'banner', header: 'centered', cards: 'outline', headingCase: 'none', headingWeight: 700, headingTracking: '0', headingScale: 1.1, density: 'regular', divider: 'line' },
    decoration: 'stripes',
  },
  {
    id: 'market', families: ['foods', 'commerce', 'sports', 'studios', 'realty'], fonts: { heading: 'space-grotesk', body: 'dm-sans' },
    light: P({ bg: '#FFFFFF', surface: '#FFFFFF', muted: '#F2F5FF', text: '#0E1430', subtle: '#3F4766', primary: '#2348D8', onPrimary: '#FFFFFF', link: '#1F3FBF', accent: '#FFCF3F', onAccent: '#0E1430', border: '#DCE2F5', contrastBg: '#0E1430', onContrast: '#FFFFFF' }),
    dark: P({ bg: '#0C1024', surface: '#141A36', muted: '#18203F', text: '#EEF1FF', subtle: '#B9C1E3', primary: '#8FA6FF', onPrimary: '#0C1024', link: '#A6B8FF', accent: '#FFCF3F', onAccent: '#0E1430', border: '#2A345C', contrastBg: '#EEF1FF', onContrast: '#0E1430' }),
    shape: { radius: 14, button: 12, image: 14 },
    layout: { hero: 'split', header: 'bar', cards: 'raised', headingCase: 'none', headingWeight: 700, headingTracking: '-0.03em', headingScale: 1, density: 'regular', divider: 'none' },
    decoration: 'grid',
  },
  {
    id: 'coast', families: ['hospitality', 'wellness', 'realty', 'foods', 'sports'], fonts: { heading: 'dm-serif-display', body: 'nunito' },
    light: P({ bg: '#F7FBFB', surface: '#FFFFFF', muted: '#E6F2F1', text: '#0F2A2E', subtle: '#3D5A5E', primary: '#0E6B6B', onPrimary: '#FFFFFF', link: '#0B5E5E', accent: '#F4D9B0', onAccent: '#0F2A2E', border: '#D3E5E3', contrastBg: '#0F2A2E', onContrast: '#F7FBFB' }),
    dark: P({ bg: '#0C1B1D', surface: '#132629', muted: '#162D30', text: '#E6F2F1', subtle: '#AFC9C7', primary: '#7FD1CC', onPrimary: '#0C1B1D', link: '#8EDAD5', accent: '#F4D9B0', onAccent: '#0F2A2E', border: '#29413F', contrastBg: '#E6F2F1', onContrast: '#0F2A2E' }),
    shape: { radius: 20, button: 999, image: 20 },
    layout: { hero: 'overlay', header: 'minimal', cards: 'raised', headingCase: 'none', headingWeight: 400, headingTracking: '0', headingScale: 1.12, density: 'airy', divider: 'wave' },
    decoration: 'none',
  },
  {
    id: 'estate', families: ['realty', 'hospitality', 'commerce', 'wellness'], fonts: { heading: 'playfair-display', body: 'inter' },
    light: P({ bg: '#FFFFFF', surface: '#FFFFFF', muted: '#F4F1EA', text: '#111827', subtle: '#4B5563', primary: '#14213D', onPrimary: '#FFFFFF', link: '#14213D', accent: '#C8A24A', onAccent: '#14213D', border: '#E5E1D8', contrastBg: '#14213D', onContrast: '#FFFFFF' }),
    dark: P({ bg: '#0D1322', surface: '#141C30', muted: '#18213A', text: '#F3F4F6', subtle: '#C3C8D2', primary: '#E3C77E', onPrimary: '#14213D', link: '#E8CF8F', accent: '#C8A24A', onAccent: '#14213D', border: '#2B3550', contrastBg: '#F3F4F6', onContrast: '#14213D' }),
    shape: { radius: 2, button: 2, image: 2 },
    layout: { hero: 'editorial', header: 'boxed', cards: 'outline', headingCase: 'none', headingWeight: 700, headingTracking: '-0.01em', headingScale: 1.15, density: 'regular', divider: 'line' },
    decoration: 'none',
  },
  {
    id: 'studio', families: ['studios', 'wellness', 'sports', 'commerce'], fonts: { heading: 'oswald', body: 'karla' },
    light: P({ bg: '#FFF9F5', surface: '#FFFFFF', muted: '#F6ECFA', text: '#22142B', subtle: '#56475E', primary: '#6A2C91', onPrimary: '#FFFFFF', link: '#5E2681', accent: '#FFB38A', onAccent: '#22142B', border: '#EADCF0', contrastBg: '#22142B', onContrast: '#FFF9F5' }),
    dark: P({ bg: '#170E1D', surface: '#211628', muted: '#281A31', text: '#F7EEFB', subtle: '#CDBBD6', primary: '#D3A3F2', onPrimary: '#22142B', link: '#DCB3F5', accent: '#FFB38A', onAccent: '#22142B', border: '#3D2C47', contrastBg: '#F7EEFB', onContrast: '#22142B' }),
    shape: { radius: 16, button: 999, image: 16 },
    layout: { hero: 'centered', header: 'bar', cards: 'tinted', headingCase: 'upper', headingWeight: 600, headingTracking: '0.01em', headingScale: 1.1, density: 'regular', divider: 'none' },
    decoration: 'dots',
  },
  {
    id: 'field', families: ['sports', 'studios', 'hospitality'], fonts: { heading: 'oswald', body: 'inter' },
    light: P({ bg: '#FFFFFF', surface: '#FFFFFF', muted: '#EEF5EC', text: '#0E1A10', subtle: '#3E4F41', primary: '#1C6B2E', onPrimary: '#FFFFFF', link: '#195F29', accent: '#FFFFFF', onAccent: '#0E1A10', border: '#D6E4D5', contrastBg: '#0F3D1B', onContrast: '#FFFFFF' }),
    dark: P({ bg: '#0B140D', surface: '#122015', muted: '#152618', text: '#EEF5EC', subtle: '#B6C9B8', primary: '#7FD48F', onPrimary: '#0B140D', link: '#8FDC9D', accent: '#EEF5EC', onAccent: '#0B140D', border: '#294030', contrastBg: '#EEF5EC', onContrast: '#0E1A10' }),
    shape: { radius: 6, button: 6, image: 6 },
    layout: { hero: 'overlay', header: 'bar', cards: 'outline', headingCase: 'upper', headingWeight: 700, headingTracking: '0.02em', headingScale: 1.12, density: 'regular', divider: 'angle' },
    decoration: 'stripes',
  },
  {
    id: 'grove', families: ['wellness', 'foods', 'commerce', 'studios', 'hospitality'], fonts: { heading: 'lora', body: 'nunito' },
    light: P({ bg: '#FAF7EF', surface: '#FFFFFF', muted: '#F0EADB', text: '#2A2618', subtle: '#5B5440', primary: '#6B7A2E', onPrimary: '#FFFFFF', link: '#5A6726', accent: '#A9522C', onAccent: '#FFFFFF', border: '#E3DBC6', contrastBg: '#3A3820', onContrast: '#FAF7EF' }),
    dark: P({ bg: '#18170F', surface: '#212016', muted: '#27251A', text: '#F2EDDC', subtle: '#C9C1A8', primary: '#C5D47E', onPrimary: '#18170F', link: '#CDDB8C', accent: '#E3916A', onAccent: '#18170F', border: '#3B3926', contrastBg: '#F2EDDC', onContrast: '#2A2618' }),
    shape: { radius: 16, button: 12, image: 16 },
    layout: { hero: 'split', header: 'bar', cards: 'tinted', headingCase: 'none', headingWeight: 600, headingTracking: '0', headingScale: 1.05, density: 'regular', divider: 'none' },
    decoration: 'grain',
  },
  {
    id: 'mono', families: [...THEME_FAMILIES], fonts: { heading: 'inter', body: 'inter' },
    light: P({ bg: '#FFFFFF', surface: '#FFFFFF', muted: '#F4F4F4', text: '#000000', subtle: '#4D4D4D', primary: '#000000', onPrimary: '#FFFFFF', link: '#000000', accent: '#FF5B1F', onAccent: '#000000', border: '#E0E0E0', contrastBg: '#000000', onContrast: '#FFFFFF' }),
    dark: P({ bg: '#000000', surface: '#0E0E0E', muted: '#141414', text: '#FFFFFF', subtle: '#BDBDBD', primary: '#FFFFFF', onPrimary: '#000000', link: '#FFFFFF', accent: '#FF7A45', onAccent: '#000000', border: '#2E2E2E', contrastBg: '#FFFFFF', onContrast: '#000000' }),
    shape: { radius: 0, button: 0, image: 0 },
    layout: { hero: 'editorial', header: 'minimal', cards: 'outline', headingCase: 'none', headingWeight: 800, headingTracking: '-0.045em', headingScale: 1.2, density: 'regular', divider: 'line' },
    decoration: 'grid',
  },
  {
    id: 'bloom', families: ['studios', 'wellness', 'commerce', 'foods'], fonts: { heading: 'fraunces', body: 'dm-sans' },
    light: P({ bg: '#FFF7F7', surface: '#FFFFFF', muted: '#FCE8EC', text: '#2D1420', subtle: '#61414F', primary: '#9B2C5A', onPrimary: '#FFFFFF', link: '#8A264F', accent: '#FFD3DC', onAccent: '#2D1420', border: '#F3D5DD', contrastBg: '#4A1530', onContrast: '#FFF7F7' }),
    dark: P({ bg: '#1C0E15', surface: '#26141D', muted: '#2D1823', text: '#FCE8EC', subtle: '#D9BAC6', primary: '#F59BBF', onPrimary: '#2D1420', link: '#F7AECB', accent: '#FFD3DC', onAccent: '#2D1420', border: '#45283A', contrastBg: '#FCE8EC', onContrast: '#2D1420' }),
    shape: { radius: 32, button: 999, image: 40 },
    layout: { hero: 'centered', header: 'centered', cards: 'tinted', headingCase: 'none', headingWeight: 700, headingTracking: '-0.02em', headingScale: 1.12, density: 'airy', divider: 'wave' },
    decoration: 'blobs',
  },
  {
    id: 'nordic', families: [...THEME_FAMILIES], fonts: { heading: 'manrope', body: 'manrope' },
    light: P({ bg: '#F6F8FA', surface: '#FFFFFF', muted: '#EAF0F5', text: '#16202A', subtle: '#4A5866', primary: '#2C5D86', onPrimary: '#FFFFFF', link: '#285478', accent: '#BFD9EE', onAccent: '#16202A', border: '#DCE4EB', contrastBg: '#16202A', onContrast: '#F6F8FA' }),
    dark: P({ bg: '#0F151B', surface: '#161F27', muted: '#1A242E', text: '#EAF0F5', subtle: '#B4C1CD', primary: '#9CC7EA', onPrimary: '#0F151B', link: '#ADD2F0', accent: '#BFD9EE', onAccent: '#16202A', border: '#2B3845', contrastBg: '#EAF0F5', onContrast: '#16202A' }),
    shape: { radius: 12, button: 10, image: 12 },
    layout: { hero: 'centered', header: 'minimal', cards: 'flat', headingCase: 'none', headingWeight: 700, headingTracking: '-0.03em', headingScale: 1, density: 'airy', divider: 'none' },
    decoration: 'none',
  },
  {
    id: 'ember', families: ['foods', 'hospitality', 'sports', 'commerce'], fonts: { heading: 'dm-serif-display', body: 'karla' },
    light: P({ bg: '#FFFBF5', surface: '#FFFFFF', muted: '#FBEFDD', text: '#1D1712', subtle: '#54483D', primary: '#1D1712', onPrimary: '#FFC56B', link: '#8A4B0F', accent: '#FFC56B', onAccent: '#1D1712', border: '#EFDFC9', contrastBg: '#1D1712', onContrast: '#FFC56B' }),
    dark: P({ bg: '#120E0A', surface: '#1C1611', muted: '#221A13', text: '#FBEFDD', subtle: '#D2C1AA', primary: '#FFC56B', onPrimary: '#1D1712', link: '#FFCE85', accent: '#FFC56B', onAccent: '#1D1712', border: '#3A2E23', contrastBg: '#FFC56B', onContrast: '#1D1712' }),
    shape: { radius: 8, button: 999, image: 8 },
    layout: { hero: 'banner', header: 'bar', cards: 'raised', headingCase: 'none', headingWeight: 400, headingTracking: '0', headingScale: 1.2, density: 'regular', divider: 'none' },
    decoration: 'grain',
  },
  {
    id: 'vitality', families: ['sports', 'wellness', 'studios', 'realty'], fonts: { heading: 'manrope', body: 'inter' },
    light: P({ bg: '#FFFFFF', surface: '#FFFFFF', muted: '#E9F6F4', text: '#0D2321', subtle: '#3D5653', primary: '#00756C', onPrimary: '#FFFFFF', link: '#006961', accent: '#FF7A59', onAccent: '#0D2321', border: '#D3E8E5', contrastBg: '#0D2321', onContrast: '#FFFFFF' }),
    dark: P({ bg: '#081514', surface: '#0F201E', muted: '#122624', text: '#E9F6F4', subtle: '#ADC8C4', primary: '#5FD6C9', onPrimary: '#081514', link: '#73DDD1', accent: '#FF8F73', onAccent: '#0D2321', border: '#24403C', contrastBg: '#E9F6F4', onContrast: '#0D2321' }),
    shape: { radius: 18, button: 999, image: 18 },
    layout: { hero: 'split', header: 'bar', cards: 'raised', headingCase: 'none', headingWeight: 800, headingTracking: '-0.035em', headingScale: 1.05, density: 'tight', divider: 'angle' },
    decoration: 'dots',
  },
];

export const DEFAULT_THEME_ID = 'classic';
export const themeById = (id: string | null | undefined): ThemeDef => SITE_THEMES.find((t) => t.id === id) ?? SITE_THEMES[0]!;
export const themesForFamily = (family: string) => SITE_THEMES.filter((t) => (t.families as string[]).includes(family));

// ───────── Contrast ─────────

const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
function mix(hex: string, target: number, t: number): string {
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + target * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/** Darken (toward black) or lighten (toward white) `fg` until it reaches `min` contrast against `bg`. */
export function ensureContrast(fg: string, bg: string, min = 4.5): string {
  if (contrastRatio(fg, bg) >= min) return fg.toUpperCase();
  const target = relativeLuminance(bg) > 0.4 ? 0 : 255;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = mix(fg, target, Math.min(t, 1));
    if (contrastRatio(c, bg) >= min) return c;
  }
  return target === 0 ? '#000000' : '#FFFFFF';
}
const bestOn = (bg: string) => (contrastRatio('#FFFFFF', bg) >= contrastRatio('#111111', bg) ? '#FFFFFF' : '#111111');

/** Pairs that must pass (text 4.5:1; borders/UI not checked). */
export function themeContrastReport(p: Palette): Array<{ pair: string; ratio: number; ok: boolean }> {
  const pairs: Array<[string, string, string]> = [
    ['text/bg', p.text, p.bg], ['text/surface', p.text, p.surface], ['text/muted', p.text, p.muted],
    ['subtle/bg', p.subtle, p.bg], ['subtle/surface', p.subtle, p.surface], ['subtle/muted', p.subtle, p.muted],
    ['onPrimary/primary', p.onPrimary, p.primary], ['link/bg', p.link, p.bg], ['link/surface', p.link, p.surface], ['link/muted', p.link, p.muted],
    ['onAccent/accent', p.onAccent, p.accent], ['onContrast/contrastBg', p.onContrast, p.contrastBg],
  ];
  return pairs.map(([pair, a, b]) => { const ratio = Math.round(contrastRatio(a, b) * 100) / 100; return { pair, ratio, ok: ratio >= 4.5 }; });
}

// ───────── Resolution (theme + brand overrides) ─────────

export interface BrandOverrides {
  /** 'brand' recolours buttons and links with the business's colour; 'theme' uses the theme palette. */
  colorMode?: 'theme' | 'brand';
  primaryColor?: string | null;
  accentColor?: string | null;
  headingFont?: SiteFont | null;
  bodyFont?: SiteFont | null;
}

export interface ResolvedTheme {
  id: string;
  fonts: { heading: SiteFont; body: SiteFont };
  light: Palette;
  dark: Palette;
  shape: ThemeDef['shape'];
  layout: ThemeDef['layout'];
  decoration: ThemeDef['decoration'];
}

function brandPalette(base: Palette, brand: string, dark: boolean): Palette {
  const primary = dark ? ensureContrast(brand, base.bg, 4.5) : ensureContrast(brand, '#FFFFFF', 3);
  const onPrimary = bestOn(primary);
  const fixedPrimary = contrastRatio(onPrimary, primary) >= 4.5 ? primary : ensureContrast(primary, onPrimary, 4.5);
  const link = ensureContrast(ensureContrast(ensureContrast(brand, base.bg), base.surface), base.muted);
  return { ...base, primary: fixedPrimary, onPrimary, link };
}

export function resolveTheme(themeId: string | null | undefined, o: BrandOverrides = {}): ResolvedTheme {
  const t = themeById(themeId);
  let light = { ...t.light };
  let dark = { ...t.dark };
  const valid = (c: string | null | undefined): c is string => !!c && /^#[0-9a-fA-F]{6}$/.test(c);
  if (o.colorMode === 'brand' && valid(o.primaryColor)) {
    light = brandPalette(light, o.primaryColor, false);
    dark = brandPalette(dark, o.primaryColor, true);
  }
  if (valid(o.accentColor)) {
    light = { ...light, accent: o.accentColor.toUpperCase(), onAccent: bestOn(o.accentColor) };
    dark = { ...dark, accent: o.accentColor.toUpperCase(), onAccent: bestOn(o.accentColor) };
  }
  const font = (f: SiteFont | null | undefined, fallback: SiteFont): SiteFont => (f && f in SITE_FONT_FAMILIES ? f : fallback);
  return {
    id: t.id, fonts: { heading: font(o.headingFont, t.fonts.heading), body: font(o.bodyFont, t.fonts.body) },
    light, dark, shape: t.shape, layout: t.layout, decoration: t.decoration,
  };
}

const fontStack = (f: SiteFont) => {
  const def = SITE_FONT_FAMILIES[f];
  if (f === 'system') return 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  return `"${def.family}", ${def.kind === 'serif' ? 'Georgia, "Times New Roman", serif' : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'}`;
};

const paletteVars = (p: Palette) => ({
  '--bhs-bg': p.bg, '--bhs-surface': p.surface, '--bhs-muted': p.muted, '--bhs-text': p.text, '--bhs-subtle': p.subtle,
  '--bhs-primary': p.primary, '--bhs-on-primary': p.onPrimary, '--bhs-link': p.link, '--bhs-accent': p.accent, '--bhs-on-accent': p.onAccent,
  '--bhs-border': p.border, '--bhs-contrast': p.contrastBg, '--bhs-on-contrast': p.onContrast,
});

/**
 * CSS for a resolved theme scoped to `selector`: light palette by default, dark palette under
 * `prefers-color-scheme: dark` (unless the page forces light with `data-scheme="light"`).
 * `fontVar` lets a host map a font key to a self-hosted CSS variable (next/font) instead of the family name.
 */
export function themeCss(r: ResolvedTheme, selector = '.bhs-root', fontVar?: (f: SiteFont) => string | null): string {
  const decl = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');
  const font = (f: SiteFont) => { const v = fontVar?.(f); return v ? `${v}, ${fontStack(f)}` : fontStack(f); };
  const base = {
    ...paletteVars(r.light),
    '--bhs-font-heading': font(r.fonts.heading), '--bhs-font-body': font(r.fonts.body),
    '--bhs-radius': `${r.shape.radius}px`, '--bhs-radius-btn': `${r.shape.button}px`, '--bhs-radius-img': `${r.shape.image}px`,
    '--bhs-heading-weight': String(r.layout.headingWeight), '--bhs-heading-tracking': r.layout.headingTracking,
    '--bhs-heading-case': r.layout.headingCase === 'upper' ? 'uppercase' : 'none', '--bhs-heading-scale': String(r.layout.headingScale),
    '--bhs-gap': r.layout.density === 'tight' ? '3.5rem' : r.layout.density === 'airy' ? '6.5rem' : '5rem',
  };
  return `${selector}{${decl(base)}}@media (prefers-color-scheme: dark){${selector}:not([data-scheme="light"]){${decl(paletteVars(r.dark))}}}${selector}[data-scheme="dark"]{${decl(paletteVars(r.dark))}}`;
}

/** Google Fonts stylesheet URL for the fonts a resolved theme uses (dashboard previews only; sites self-host). */
export function googleFontsHref(fonts: SiteFont[]): string | null {
  const fams = [...new Set(fonts)].map((f) => SITE_FONT_FAMILIES[f]?.google).filter((g): g is NonNullable<typeof g> => !!g);
  return fams.length ? `https://fonts.googleapis.com/css2?${fams.map((g) => `family=${g}`).join('&')}&display=swap` : null;
}
