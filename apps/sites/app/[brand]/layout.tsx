import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { CookieSettingsButton } from '@/components/CookieBanner';
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

  // The content area is at least one screen tall, so the footer starts below the fold: content that loads in
  // the browser (menus, carts, accounts) grows the page without pushing a visible footer around (layout shift).
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line-soft bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <a href={links.brand()} className="flex min-w-0 items-center gap-2 font-extrabold tracking-tight">
            {brand.theme.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={brand.theme.logoUrl} alt={brand.name} className="h-9 w-auto max-w-[160px] object-contain" />
            ) : (
              <>
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand text-on-brand" aria-hidden>{brand.name.slice(0, 1)}</span>
                <span className="truncate text-lg">{brand.name}</span>
              </>
            )}
          </a>
          <nav aria-label={brand.name} className="ms-auto flex items-center gap-1">
            {!single && (
              <a href={`${links.brand()}${links.brand().endsWith('/') ? '' : ''}#finder`} className="hidden h-11 items-center gap-1.5 rounded-full px-3 text-sm font-bold hover:bg-canvas sm:flex">
                <Icon name="pin" size={16} />{t('allLocations')}
              </a>
            )}
            <LanguageSwitcher current={locale} available={available} label={t('language')} />
          </nav>
        </div>
      </header>
      <div className="min-h-[calc(100dvh-4rem)]">{children}</div>
      <footer className="mt-16 border-t border-line-soft bg-canvas-raised">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-graphite sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="font-bold text-ink">{brand.name}</span>
            {!single && <a href={`${links.brand()}#finder`} className="inline-flex min-h-11 items-center underline underline-offset-2 sm:min-h-0">{t('allLocations')}</a>}
            {data.pages.filter((p) => p.slug !== 'home').map((p) => (
              <a key={p.slug} href={links.brand(`/pages/${p.slug}`)} className="underline underline-offset-2">{p.title}</a>
            ))}
            <CookieSettingsButton label={t('cookieSettings')} />
          </div>
          {brand.poweredBy && <span className="text-xs text-stone">{t('poweredBy')}</span>}
        </div>
      </footer>
    </>
  );
}
