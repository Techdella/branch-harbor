import { getTranslations } from 'next-intl/server';
import { Icon } from '@bh/ui';
import { providerName } from '@/lib/modules';
import type { LocationSite } from '@/lib/types';

/** Shown instead of native booking/checkout when a connected system is authoritative. */
export async function ExternalNotice({ data }: { data: LocationSite }) {
  const t = await getTranslations('location');
  const name = providerName(data.module.externalProvider);
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
      <p>{t('externalNote', { provider: name })}</p>
      {data.module.externalUrl
        ? <a href={data.module.externalUrl} className="btn btn-primary" rel="noopener">{t('externalCta', { provider: name })}<Icon name="arrow-up-right" size={16} /></a>
        : <span className="text-sm text-graphite">{t('externalNoLink')}</span>}
    </div>
  );
}
