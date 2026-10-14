import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { money } from '@/lib/format';
import type { ListingCard } from '@/lib/realty';

/** Listing card for search results and office pages. Status is text + icon, never colour alone. */
export async function ListingCardView({ l, href, locale }: { l: ListingCard; href: string; locale: string }) {
  const t = await getTranslations('realty');
  return (
    <article className="card overflow-hidden">
      <a href={href} className="block focus-visible:outline-2">
        {l.photo
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={l.photo.url} alt={l.photo.alt ?? ''} className="h-48 w-full object-cover" loading="lazy" />
          : <div className="grid h-48 place-items-center bg-canvas text-sm text-graphite">{t('listing.noPhoto')}</div>}
        <div className="p-4">
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1">
              <Icon name={l.status === 'under_offer' ? 'receipt' : l.status === 'coming_soon' ? 'clock' : 'check'} size={13} />
              {t(`status.${l.status}`)}
            </span>
            <span className="text-graphite">{t(`transaction.${l.transaction}`)} · {t(`type.${l.propertyType}`)}</span>
          </div>
          <h3 className="mt-2 text-lg font-bold leading-snug">{l.title}</h3>
          <p className="mt-1 text-lg font-extrabold">{money(l.price, locale)}{l.rentPeriod ? <span className="text-sm font-semibold text-graphite"> / {t(`per.${l.rentPeriod}`)}</span> : null}</p>
          <p className="mt-1 text-sm text-graphite">
            {l.bedrooms != null ? t('listing.beds', { count: l.bedrooms }) : t('listing.bedsUnknown')} · {l.bathrooms != null ? t('listing.baths', { count: l.bathrooms }) : t('listing.bathsUnknown')} · {l.area ? `${l.area.value.toLocaleString(locale)} ${l.area.label}` : t('listing.areaUnknown')}
          </p>
          <p className="mt-1 text-sm text-graphite"><bdi>{l.addressLines.join(', ')}</bdi>{l.office ? ` · ${l.office.name}` : ''}</p>
        </div>
      </a>
    </article>
  );
}
