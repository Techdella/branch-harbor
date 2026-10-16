'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { TerritoryMap } from '@bh/ui/map';
import type { TerritoryMapConfig } from '@/lib/franchise';

/** Only available territories are named, and the view fits them (taken ones stay as grey shapes). */
const LABELLED = ['available'];

/**
 * "Available territories" on the brand's franchise recruitment section (the franchisor opted in). Available areas are
 * green, taken ones grey when the franchisor shows them. The list below the map is the accessible equivalent and
 * the main interaction on phones; "Ask about it" jumps to the enquiry form.
 */
export function AvailableTerritories({ data, formAnchor }: { data: TerritoryMapConfig; formAnchor: string | null }) {
  const t = useTranslations('franchiseSite');
  const locale = useLocale();
  const [selected, setSelected] = useState<string | null>(null);
  const features = data.territories.features;
  const territories = useMemo(() => features.map((f) => ({ id: f.id, name: f.properties.name, status: f.properties.availability, geometry: f.geometry, centroid: f.properties.centroid })), [features]);
  const available = features.filter((f) => f.properties.availability === 'available');
  const countryName = (c: string) => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(c) ?? c; } catch { return c; } };
  return (
    <section aria-labelledby="territories-h" className="mb-8 flex flex-col gap-4" data-testid="available-territories">
      <div>
        <h3 id="territories-h" className="text-xl font-extrabold tracking-tight">{t('mapTitle')}</h3>
        <p className="mt-1 text-graphite">{t('mapIntro', { count: available.length })}</p>
      </div>
      <TerritoryMap className="h-[320px] w-full sm:h-[420px]" config={data.map} territories={territories} selectedId={selected} onSelect={setSelected} label={t('mapLabel')} outlineNote={t('mapOutline')} fitKey={selected ? `sel:${selected}` : 'all'} labelStatuses={LABELLED} fitStatuses={LABELLED} />
      <p className="flex flex-wrap gap-4 text-sm">
        <span className="flex items-center gap-2"><span aria-hidden="true" className="size-3 rounded-sm bg-[#2E9E5B]" />{t('legendAvailable')}</span>
        {features.some((f) => f.properties.availability === 'taken') && <span className="flex items-center gap-2"><span aria-hidden="true" className="size-3 rounded-sm bg-[#9CA3AF]" />{t('legendTaken')}</span>}
      </p>
      {available.length ? (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label={t('availableList')}>
          {available.map((f) => (
            <li key={f.id} className={`card flex items-center justify-between gap-3 p-3 ${selected === f.id ? 'ring-2 ring-[var(--site-brand)]' : ''}`}>
              <button type="button" className="min-w-0 flex-1 text-start" onClick={() => setSelected(f.id)}>
                <span className="block font-bold">{f.properties.name}</span>
                <span className="block text-sm text-graphite">{[f.properties.region, countryName(f.properties.country)].filter(Boolean).join(', ')}</span>
              </button>
              {formAnchor && <a className="btn btn-secondary shrink-0" href={formAnchor}><Icon name="mail" size={16} />{t('askAbout')}</a>}
            </li>
          ))}
        </ul>
      ) : <p className="text-graphite">{t('noneAvailable')}</p>}
    </section>
  );
}
