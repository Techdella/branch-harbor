import type { Metadata, Viewport } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({ subsets: ['latin', 'latin-ext'], weight: ['400', '500', '600', '700', '800'], variable: '--font-jakarta', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'BranchHarbor', template: '%s · BranchHarbor' },
  description: 'One home for every location. Manage your brand together. Run each location with confidence.',
  applicationName: 'BranchHarbor',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F3F2EE' },
    { media: '(prefers-color-scheme: dark)', color: '#141413' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={jakarta.variable} data-scroll-behavior="smooth">
      <body className="min-h-viewport bg-canvas font-sans text-ink antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
