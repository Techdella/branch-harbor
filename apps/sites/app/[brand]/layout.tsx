import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { SiteHeader, SiteThemeRoot } from '@bh/ui/site';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { CookieSettingsButton } from '@/components/CookieBanner';
import { siteTheme } from '@/components/builder/SiteContent';
import { fontVar } from '@/lib/fonts';
import { getRouting, loadBrand, makeLinks, resolveSiteLocale } from '@/lib/site';

export default async function BrandLayout({ children, params }: { children: ReactNode; params: Promise<{ brand: string }> }) {
  const { brand: slug } = await params;
  const data = await loadBrand(slug);
  const r = await getRouting();
  const links = makeLinks(r, slug, { brandPrimaryHost: data.site.primaryHost });
  const { locale, available } = await resolveSiteLocale();
  const t = await getTranslations('common');
  const { brand } = data;
  // Independent business: one location, so no "All locations" finder links.
  const single = brand.model === 'independent';
  const brandPages = data.pages.filter((p) => p.slug !== 'home' && (p.nav?.show ?? true));
  const nav = [
    ...(!single ? [{ label: t('allLocations'), href: `${links.brand()}#finder` }] : []),
    ...brandPages.map((p) => ({ label: p.nav?.label ?? p.title, href: links.brand(`/pages/${p.slug}`) })),
  ];

  // The website builder theme (presentation only) wraps the whole site: header style, fonts and palette.
  // The content area is at least one screen tall, so the footer starts below the fold: content that loads in
  // the browser (menus, carts, accounts) grows the page without pushing a visible footer around (layout shift).
  return (
    <SiteThemeRoot theme={siteTheme(brand)} fontVar={fontVar}>
      <SiteHeader
        theme={siteTheme(brand)} brandName={brand.name} logoUrl={brand.theme.logoUrl} homeHref={links.brand()} links={nav} navLabel={brand.name}
        extra={<LanguageSwitcher current={locale} available={available} label={t('language')} submitLabel={t('languageSubmit')} />}
      />
      <div className="min-h-[calc(100dvh-4rem)]">{children}</div>
      <footer className="mt-16 border-t border-line-soft bg-canvas-raised">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-graphite sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="font-bold text-ink">{brand.name}</span>
            {!single && <a href={`${links.brand()}#finder`} className="inline-flex min-h-11 items-center underline underline-offset-2 sm:min-h-0">{t('allLocations')}</a>}
            {brandPages.map((p) => (
              <a key={p.slug} href={links.brand(`/pages/${p.slug}`)} className="underline underline-offset-2">{p.nav?.label ?? p.title}</a>
            ))}
            <CookieSettingsButton label={t('cookieSettings')} />
          </div>
          {brand.poweredBy && <span className="text-xs text-stone">{t('poweredBy')}</span>}
        </div>
      </footer>
    </SiteThemeRoot>
  );
}
