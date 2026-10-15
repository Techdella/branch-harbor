import type { Metadata, Viewport } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, getTranslations } from 'next-intl/server';
import { isRtl } from '@bh/shared';
import { getBrandSite } from '@/lib/api';
import { fontFor, fontVariables } from '@/lib/fonts';
import { getRouting, resolveSiteLocale } from '@/lib/site';
import { CookieBanner } from '@/components/CookieBanner';
import { DemoRibbon } from '@/components/DemoRibbon';
import '@bh/ui/site.css';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#141413' },
  ],
};

// Sites carry the client's brand; no BranchHarbor title template. Pages without their own title
// (status, manage and error pages) fall back to the brand name so every document has a <title>.
export async function generateMetadata(): Promise<Metadata> {
  const r = await getRouting();
  let name: string | undefined;
  try {
    if (r.brand) name = (await getBrandSite(r.brand)).brand.name;
  } catch {
    /* unknown brand / API down */
  }
  return { robots: { index: true, follow: true }, title: { default: name ?? 'Website', template: '%s' } };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const r = await getRouting();
  const { locale } = await resolveSiteLocale();
  const t = await getTranslations('common');
  let theme = null;
  try {
    if (r.brand) theme = (await getBrandSite(r.brand)).brand.theme;
  } catch {
    /* Unknown brand or API down: the page itself renders not-found / the friendly error. */
  }
  const style = {
    '--site-brand': theme?.primary ?? '#141414',
    '--site-brand-color': theme?.brandColor ?? '#141414',
    '--site-on-brand': theme?.onPrimary ?? '#FFFFFF',
    '--site-brand-ink': theme?.primaryInk ?? '#141414',
    '--site-font': fontFor(theme?.font),
  } as CSSProperties;

  return (
    <html lang={locale} dir={isRtl(locale) ? 'rtl' : 'ltr'} className={fontVariables} data-scroll-behavior="smooth">
      <body style={style} className="min-h-viewport font-site antialiased">
        <NextIntlClientProvider locale={locale} messages={await getMessages()}>
          <a href="#main" className="sr-only z-[100] rounded-full bg-ink px-5 py-3 text-sm font-bold text-white focus:not-sr-only focus:fixed focus:start-4 focus:top-4">
            {t('skip')}
          </a>
          <DemoRibbon />
          {children}
          <CookieBanner />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
