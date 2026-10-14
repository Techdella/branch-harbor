import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { MODULE_ICON, MODULE_PATH } from '@/lib/modules';
import { getRouting, loadLocation, makeLinks } from '@/lib/site';

export default async function LocationLayout({ children, params }: { children: ReactNode; params: Promise<{ brand: string; location: string }> }) {
  const { brand, location } = await params;
  const data = await loadLocation(brand, location);
  const links = makeLinks(await getRouting(), brand, { brandPrimaryHost: data.site.brandPrimaryHost });
  const t = await getTranslations();
  const kind = data.module.kind;
  const modPath = MODULE_PATH[kind];
  const extraPages = data.pages.filter((p) => p.slug !== 'home');

  return (
    <>
      <nav aria-label={data.location.name} className="border-b border-line-soft bg-canvas-raised">
        <div className="mx-auto flex max-w-6xl items-center gap-1 overflow-x-auto px-4 py-2 text-sm font-semibold">
          <a href={links.location(location)} className="flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 hover:bg-white">
            <Icon name="pin" size={15} />{data.location.name}
          </a>
          {modPath && (
            <a href={links.location(location, modPath)} className="flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 hover:bg-white">
              <Icon name={MODULE_ICON[kind] ?? 'calendar'} size={15} />{t(`module.${kind}` as 'module.studios')}
            </a>
          )}
          {kind === 'wellness' && (
            <a href={links.location(location, '/packages')} className="flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 hover:bg-white">
              <Icon name="gift" size={15} />{t('wellnessPro.navPackages')}
            </a>
          )}
          {extraPages.map((p) => (
            <a key={p.slug} href={links.location(location, `/${p.slug}`)} className="flex h-10 shrink-0 items-center rounded-full px-3 hover:bg-white">{p.title}</a>
          ))}
          {data.site.locationCount > 1 && (
            <a href={`${links.brand()}#finder`} className="ms-auto flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 hover:bg-white">
              {t('location.otherLocations')}<Icon name="arrow-right" size={15} />
            </a>
          )}
        </div>
      </nav>
      {children}
    </>
  );
}
