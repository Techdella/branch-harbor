'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Banner, DeniedState } from '../ui/States';
import { EMPTY_LOCATION, LocationWizard, WizardSaveBar, validateLocation, type LocationDraft } from './LocationWizard';

export function NewLocationScreen() {
  const t = useTranslations('wizard');
  const app = useApp();
  const [draft, setDraft] = useState<LocationDraft>(EMPTY_LOCATION);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!app.can('locations.write')) return <DeniedState permission="locations.write" />;
  const save = async () => {
    const e = validateLocation(draft, t);
    setErrors(e);
    if (Object.keys(e).length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
    setSaved(true);
  };
  return (
    <>
      <PageHeader icon="plus" title={t('title')} description={t('description')} scope={false} actions={<Link href="/locations" className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-sm font-bold"><Icon name="arrow-left" size={16} />{t('backToLocations')}</Link>} />
      {saved ? (
        <Banner tone="success" title={t('savedTitle', { name: draft.name })} live="polite" action={<Link href="/locations" className="text-sm font-bold underline">{t('backToLocations')}</Link>}>
          {t('savedBody')}
        </Banner>
      ) : (
        <section className="rounded-xl bg-surface p-5 md:p-7">
          <LocationWizard value={draft} onChange={setDraft} errors={errors} ownerGroups={app.org.ownerGroups.map((g) => g.name)} />
          <WizardSaveBar onSave={save} saving={saving} label={t('save')} />
        </section>
      )}
    </>
  );
}
