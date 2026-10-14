import { Inter, Lora, Merriweather, Plus_Jakarta_Sans, Source_Serif_4, Work_Sans } from 'next/font/google';

/**
 * The safe font list a business can pick for its site (mirrors SITE_FONTS in the API). Only the selected
 * family's files are downloaded by the browser; each exposes a CSS variable.
 */
const jakarta = Plus_Jakarta_Sans({ subsets: ['latin', 'latin-ext'], variable: '--f-jakarta', display: 'swap', preload: false });
const inter = Inter({ subsets: ['latin', 'latin-ext'], variable: '--f-inter', display: 'swap', preload: false });
const work = Work_Sans({ subsets: ['latin', 'latin-ext'], variable: '--f-work', display: 'swap', preload: false });
const sourceSerif = Source_Serif_4({ subsets: ['latin', 'latin-ext'], variable: '--f-source-serif', display: 'swap', preload: false });
const lora = Lora({ subsets: ['latin', 'latin-ext'], variable: '--f-lora', display: 'swap', preload: false });
const merriweather = Merriweather({ subsets: ['latin', 'latin-ext'], weight: ['400', '700'], variable: '--f-merriweather', display: 'swap', preload: false });

export const fontVariables = [jakarta, inter, work, sourceSerif, lora, merriweather].map((f) => f.variable).join(' ');

const FONT_VAR: Record<string, string> = {
  system: 'system-ui',
  'plus-jakarta-sans': 'var(--f-jakarta)',
  inter: 'var(--f-inter)',
  'work-sans': 'var(--f-work)',
  'source-serif-4': 'var(--f-source-serif)',
  lora: 'var(--f-lora)',
  merriweather: 'var(--f-merriweather)',
};

export const fontFor = (key: string | undefined) => FONT_VAR[key ?? 'system'] ?? 'system-ui';
