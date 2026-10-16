'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Icon } from '@bh/ui';
import { http } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { IndependentLocations } from './independent/IndependentLocations';
import { EMPTY_LOCATION, LocationWizard, WizardSaveBar, validateLocation, type LocationDraft, type LocationFormOptions } from './LocationWizard';

/** Independent businesses: adding a second location runs the upgrade to a network first. */
export function NewLocationScreen() {
  const app = useApp();
  return app.org.model === 'independent' ? <IndependentLocations adding /> : <NetworkNewLocationScreen />;
}

/** The location as the API returns it after `POST /orgs/:orgId/locations`. */
interface CreatedLocation {
  id: string; name: string; code: string; status: string; publiclyVisible: boolean; timeZone: string; currency: string;
  address: { line1: string; city: string; region?: string; postalCode?: string; country: string };
  brandId: string | null; regionId: string | null; ownerGroupId: string | null; territoryId: string | null; templateId: string | null;
  hours: { summary?: string } | null; industryDetails: Record<string, string | number | boolean>;
}

const locationsApi = {
  options: () => http.get<LocationFormOptions>(`/orgs/${orgId()}/locations/form-options`),
  create: (body: Record<string, unknown>) => http.post<CreatedLocation>(`/orgs/${orgId()}/locations`, body),
};

/** The API body for a draft: ids from the business's own records, nothing published or shown to customers. */
function toBody(d: LocationDraft, o: LocationFormOptions) {
  const main = o.brands.find((b) => b.isDefault)?.id ?? null;
  const brandId = d.brandId && d.brandId !== main ? d.brandId : undefined;
  return {
    name: d.name.trim(), code: d.code.trim(),
    address: { line1: d.line1.trim(), city: d.city.trim(), country: d.country, ...(d.region.trim() ? { region: d.region.trim() } : {}), ...(d.postalCode.trim() ? { postalCode: d.postalCode.trim() } : {}) },
    timeZone: d.timeZone, currency: d.currency,
    ...(d.phone.trim() ? { phone: d.phone.trim() } : {}), ...(d.email.trim() ? { email: d.email.trim() } : {}), ...(d.hours.trim() ? { hours: d.hours.trim() } : {}),
    ...(brandId ? { brandId } : {}), ...(d.templateId ? { templateId: d.templateId } : {}), ...(d.ownerGroupId ? { ownerGroupId: d.ownerGroupId } : {}),
    ...(d.regionId ? { regionId: d.regionId } : {}), ...(d.territoryId ? { territoryId: d.territoryId } : {}),
    ...(d.industry && Object.keys(d.industry).length ? { industryFields: d.industry } : {}),
    status: 'draft',
  };
}

function NetworkNewLocationScreen() {
  const t = useTranslations('wizard');
  const app = useApp();
  const res = useApi(() => locationsApi.options(), [app.org.id], app.can('locations.write'));
  if (!app.can('locations.write')) return <DeniedState permission="locations.write" />;
  return (
    <>
      <PageHeader icon="plus" title={t('title')} description={t('description')} scope={false} actions={<Link href="/locations" className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-sm font-bold"><Icon name="arrow-left" size={16} />{t('backToLocations')}</Link>} />
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(o) => <AddLocation options={o} />}
      </Async>
    </>
  );
}

function AddLocation({ options: o }: { options: LocationFormOptions }) {
  const t = useTranslations('wizard');
  const app = useApp();
  const [draft, setDraft] = useState<LocationDraft>(() => ({
    ...EMPTY_LOCATION, country: o.defaults.country, currency: o.defaults.currency, timeZone: o.defaults.timeZone, ownerGroup: '', template: '',
    brandId: app.brandId && o.brands.some((b) => b.id === app.brandId) ? app.brandId : o.brands.find((b) => b.isDefault)?.id ?? o.brands[0]?.id ?? null,
    regionId: o.organizationWide ? '' : o.regions[0]?.id ?? '', territoryId: !o.organizationWide && !o.regions.length ? o.territories[0]?.id ?? '' : '', industry: {},
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<CreatedLocation | null>(null);
  const save = useMutation((_api, body: Record<string, unknown>) => locationsApi.create(body));
  // Field errors from the API (e.g. a code already in use, industry details out of range) show on their fields.
  useEffect(() => {
    const f = save.error?.fields;
    if (!f) return;
    const known = new Set(['name', 'code', 'line1', 'city', 'timeZone', 'email', 'brandId', 'templateId', 'ownerGroupId', 'regionId', 'territoryId']);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(f)) {
      if (k.startsWith('industryFields.')) out[`ind.${k.slice(15)}`] = v;
      else if (known.has(k)) out[k] = v;
    }
    if (Object.keys(out).length) setErrors(out);
  }, [save.error]);

  const submit = async () => {
    const e = validateLocation(draft, t);
    setErrors(e);
    if (Object.keys(e).length) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const r = await save.run(toBody(draft, o));
    if (r) {
      setCreated(r);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      void app.reloadWorkspace();
    }
  };

  if (created) return <CreatedCard loc={created} options={o} onAnother={() => { setCreated(null); setDraft((d) => ({ ...d, name: '', code: '', line1: '', postalCode: '', phone: '', email: '' })); }} />;
  return (
    <section className="rounded-xl bg-surface p-5 md:p-7">
      {save.error && !Object.keys(errors).length && <div className="mb-4"><Banner tone="danger" live="assertive">{save.error.message}</Banner></div>}
      <LocationWizard value={draft} onChange={setDraft} errors={errors} ownerGroups={[]} options={o} />
      <WizardSaveBar onSave={submit} saving={save.pending} label={t('save')} />
    </section>
  );
}

/** The location just created, with everything it was filed under. */
function CreatedCard({ loc, options: o, onAnother }: { loc: CreatedLocation; options: LocationFormOptions; onAnother: () => void }) {
  const t = useTranslations('wizard');
  const tl = useTranslations('wizard.live');
  const name = <T extends { id: string; name: string }>(list: T[], id: string | null) => (id ? list.find((x) => x.id === id)?.name ?? null : null);
  const brand = name(o.brands, loc.brandId) ?? o.brands.find((b) => b.isDefault)?.name ?? null;
  const fmtDetail = (key: string, v: string | number | boolean) => {
    const f = o.industryFields.find((x) => x.key === key);
    if (typeof v === 'boolean') return v ? tl('yes') : tl('no');
    if (f?.type === 'select') return tl(`industryOption.${key}.${v}` as 'industryOption.surface.grass');
    return String(v);
  };
  const rows: [string, string][] = [
    [tl('code'), loc.code],
    ...(o.brandPicker && brand ? [[tl('brand'), brand] as [string, string]] : []),
    [tl('template'), name(o.templates, loc.templateId) ?? tl('noTemplate')],
    [tl('ownerGroup'), name(o.ownerGroups, loc.ownerGroupId) ?? tl('companyOwned')],
    ...(loc.regionId ? [[tl('networkRegion'), name(o.regions, loc.regionId) ?? ''] as [string, string]] : []),
    ...(loc.territoryId ? [[tl('territory'), name(o.territories, loc.territoryId) ?? ''] as [string, string]] : []),
    [t('address'), [loc.address.line1, loc.address.city, loc.address.region, loc.address.postalCode, loc.address.country].filter(Boolean).join(', ')],
    [t('timeZone'), loc.timeZone.replace(/_/g, ' ')],
    [t('currency'), loc.currency],
    ...(loc.hours?.summary ? [[t('hours'), loc.hours.summary] as [string, string]] : []),
    ...Object.entries(loc.industryDetails ?? {}).map(([k, v]) => [tl(`industryField.${k}` as 'industryField.seats'), fmtDetail(k, v)] as [string, string]),
  ];
  return (
    <div className="flex flex-col gap-4" data-testid="location-created">
      <Banner tone="success" title={t('savedTitle', { name: loc.name })} live="polite">{t('savedBody')}</Banner>
      <SectionCard title={loc.name} aside={<Badge tone="neutral" icon={null}>{tl(`status.${loc.status}` as 'status.draft')}</Badge>}>
        <dl className="grid gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <dt className="text-xs font-bold text-stone">{k}</dt>
              <dd className="font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 flex items-start gap-2 rounded-md bg-canvas p-3.5 text-[13px]">
          <Icon name="eye" size={16} className="mt-0.5 shrink-0" />
          {tl('notVisible')}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/locations" className="inline-flex h-11 items-center gap-1.5 rounded-full bg-ink px-5 text-sm font-bold text-white">{t('backToLocations')}</Link>
          <button type="button" onClick={onAnother} className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-5 text-sm font-bold">
            <Icon name="plus" size={16} />
            {tl('addAnother')}
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
