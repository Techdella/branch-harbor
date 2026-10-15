import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { Noto_Sans_Arabic, Plus_Jakarta_Sans } from 'next/font/google';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { isRtl } from '@bh/shared';
import { routing } from '@/i18n/routing';
import { SITE_URL } from '@/lib/seo';
import { SiteHeader } from '@/components/site/SiteHeader';
import { SiteFooter } from '@/components/site/SiteFooter';
import { ConsentProvider } from '@/components/consent/ConsentProvider';
import { CookieBanner } from '@/components/consent/CookieBanner';
import '../globals.css';

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin', 'latin-ext'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-jakarta',
  display: 'swap',
});

/** Plus Jakarta Sans has no Arabic glyphs. Loaded for every locale but only downloaded when Arabic text is on the page (unicode-range). */
const arabic = Noto_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-arabic',
  display: 'swap',
  preload: false,
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  themeColor: '#F3F2EE',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light',
};

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'meta' });
  return {
    title: { default: t('title'), template: t('titleTemplate') },
    description: t('description'),
    metadataBase: new URL(SITE_URL),
    applicationName: 'BranchHarbor',
    // Pages add canonical/hreflang alternates and OpenGraph/Twitter cards via buildMetadata().
  };
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations('common');

  return (
    <html lang={locale} dir={isRtl(locale) ? 'rtl' : 'ltr'} className={`${jakarta.variable} ${arabic.variable}`} data-scroll-behavior="smooth">
      <body className="min-h-viewport bg-canvas font-sans text-ink antialiased">
        <NextIntlClientProvider>
          <ConsentProvider>
          <a
            href="#main"
            className="sr-only z-[100] rounded-full bg-ink px-5 py-3 text-sm font-bold text-white focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
          >
            {t('skipToContent')}
          </a>
          <div className="edge flex flex-col gap-[var(--edge)]">
            <SiteHeader />
            <main id="main" tabIndex={-1} className="flex flex-col gap-[var(--edge)] outline-none">
              {children}
            </main>
            <SiteFooter />
          </div>
          <CookieBanner />
          </ConsentProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
