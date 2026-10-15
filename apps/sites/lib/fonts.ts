import {
  Archivo, Cormorant_Garamond, DM_Sans, DM_Serif_Display, Fraunces, Inter, Karla, Lora, Manrope, Merriweather, Nunito, Oswald, Playfair_Display,
  Plus_Jakarta_Sans, Source_Serif_4, Space_Grotesk, Work_Sans,
} from 'next/font/google';
import type { SiteFont } from '@bh/shared';

/**
 * The safe font list a business can pick for its site (SITE_FONT_FAMILIES in @bh/shared; the website builder themes
 * use the same list). Fonts are self-hosted by next/font; only the families a page actually uses are downloaded by
 * the browser (preload off). Each exposes a CSS variable.
 */
const opts = { subsets: ['latin', 'latin-ext'] as ('latin' | 'latin-ext')[], display: 'swap' as const, preload: false };
const jakarta = Plus_Jakarta_Sans({ ...opts, variable: '--f-jakarta' });
const inter = Inter({ ...opts, variable: '--f-inter' });
const work = Work_Sans({ ...opts, variable: '--f-work' });
const sourceSerif = Source_Serif_4({ ...opts, variable: '--f-source-serif' });
const lora = Lora({ ...opts, variable: '--f-lora' });
const merriweather = Merriweather({ ...opts, weight: ['400', '700'], variable: '--f-merriweather' });
const fraunces = Fraunces({ ...opts, variable: '--f-fraunces' });
const manrope = Manrope({ ...opts, variable: '--f-manrope' });
const archivo = Archivo({ ...opts, variable: '--f-archivo' });
const cormorant = Cormorant_Garamond({ ...opts, weight: ['500', '600', '700'], variable: '--f-cormorant' });
const playfair = Playfair_Display({ ...opts, variable: '--f-playfair' });
const spaceGrotesk = Space_Grotesk({ ...opts, variable: '--f-space-grotesk' });
const dmSans = DM_Sans({ ...opts, variable: '--f-dm-sans' });
const dmSerif = DM_Serif_Display({ ...opts, weight: '400', variable: '--f-dm-serif' });
const nunito = Nunito({ ...opts, variable: '--f-nunito' });
const oswald = Oswald({ ...opts, variable: '--f-oswald' });
const karla = Karla({ ...opts, variable: '--f-karla' });

export const fontVariables = [jakarta, inter, work, sourceSerif, lora, merriweather, fraunces, manrope, archivo, cormorant, playfair, spaceGrotesk, dmSans, dmSerif, nunito, oswald, karla].map((f) => f.variable).join(' ');

const FONT_VAR: Record<SiteFont, string> = {
  system: 'system-ui',
  'plus-jakarta-sans': 'var(--f-jakarta)',
  inter: 'var(--f-inter)',
  'work-sans': 'var(--f-work)',
  'source-serif-4': 'var(--f-source-serif)',
  lora: 'var(--f-lora)',
  merriweather: 'var(--f-merriweather)',
  fraunces: 'var(--f-fraunces)',
  manrope: 'var(--f-manrope)',
  archivo: 'var(--f-archivo)',
  'cormorant-garamond': 'var(--f-cormorant)',
  'playfair-display': 'var(--f-playfair)',
  'space-grotesk': 'var(--f-space-grotesk)',
  'dm-sans': 'var(--f-dm-sans)',
  'dm-serif-display': 'var(--f-dm-serif)',
  nunito: 'var(--f-nunito)',
  oswald: 'var(--f-oswald)',
  karla: 'var(--f-karla)',
};

export const fontFor = (key: string | undefined) => FONT_VAR[(key ?? 'system') as SiteFont] ?? 'system-ui';
/** For the website builder renderer: self-hosted variable for a font key (null = use the family stack). */
export const fontVar = (key: SiteFont): string | null => (key === 'system' ? null : FONT_VAR[key] ?? null);
