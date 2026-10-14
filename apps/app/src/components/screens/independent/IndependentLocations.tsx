'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { useBusinessMode } from '@/lib/useBusinessMode';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, DeniedState, SectionCard } from '../../ui/States';
import { UpgradeFlow } from './BusinessSettings';

/** /locations for an independent business: there is no directory — point to Settings and explain the upgrade. */
export function IndependentLocations({ adding = false }: { adding?: boolean }) {
  const t = useTranslations('single.locationsPage');
  const app = useApp();
  const mode = useBusinessMode();
  const l = mode.location;
  return (
    <>
      <PageHeader icon="pin" title={adding ? t('addTitle') : t('title')} description={adding ? t('addDescription') : t('description')} scope={false} />
      {!adding && l && (
        <SectionCard title={mode.businessName}>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <div>{[l.address.line1, l.address.city, l.address.region, l.address.postalCode].filter(Boolean).join(', ')}</div>
              <div className="text-stone">{l.timeZone.replace(/_/g, ' ')} · {l.currency}{l.hours ? ` · ${l.hours}` : ''}</div>
            </div>
            <Link href="/settings#business" className="inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-bold">
              <Icon name="settings" size={15} />
              {t('edit')}
            </Link>
          </div>
        </SectionCard>
      )}
      {!adding && <Banner tone="info" icon="store">{t('noDirectory')}</Banner>}
      {app.can('org.manage') ? (
        <SectionCard title={t('upgradeTitle')}>
          <UpgradeFlow />
        </SectionCard>
      ) : (
        <DeniedState permission="org.manage" detail={t('ownerOnly')} />
      )}
    </>
  );
}
