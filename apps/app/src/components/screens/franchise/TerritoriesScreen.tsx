'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Field, Input, Select, Toggle, type Tone } from '@bh/ui';
import { TERRITORY_STATUSES } from '@bh/shared';
import { franchiseApi, useFranchise, useFranchiseAction, type Territory } from '@/lib/franchise/api';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty, SectionCard } from '../../ui/States';
import { FAsync, LiveOnly, useFmt } from './common';

const TONE: Record<Territory['status'], Tone> = { available: 'success', reserved: 'warning', sold: 'neutral', unavailable: 'danger' };

export function TerritoriesScreen() {
  return <LiveOnly><Territories /></LiveOnly>;
}

function Territories() {
  const t = useTranslations('franchise');
  const f = useFmt();
  const app = useApp();
  const res = useFranchise(() => franchiseApi.territories(), [app.org.id]);
  const act = useFranchiseAction();
  const canEdit = app.can('franchise.pipeline.edit');
  const [v, setV] = useState({ name: '', country: 'US', region: '', showOnSite: true });
  const settings = useFranchise(() => franchiseApi.settings(), [app.org.id]);
  return (
    <>
      <PageHeader icon="map" title={t('territories.title')} description={t('territories.description')} scope={false} />
      {act.error && <Banner tone="danger">{act.error.message}</Banner>}
      {settings.data && (
        <SectionCard title={t('territories.formTitle')}>
          <div className="flex flex-wrap items-center gap-3">
            {canEdit
              ? <Toggle checked={settings.data.enquiryFormEnabled} onChange={async (b) => { const r = await act.run(() => franchiseApi.saveSettings({ enquiryFormEnabled: b })); if (r) settings.setData({ ...settings.data!, enquiryFormEnabled: r.enquiryFormEnabled }); }} label={t('territories.formToggle')} />
              : <Badge tone={settings.data.enquiryFormEnabled ? 'success' : 'neutral'}>{settings.data.enquiryFormEnabled ? t('territories.formOn') : t('territories.formOff')}</Badge>}
          </div>
          <p className="mt-2 text-xs text-stone">{t('territories.formHint', { brand: settings.data.brandSlug })}</p>
        </SectionCard>
      )}
      {canEdit && (
        <SectionCard title={t('territories.add')}>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1"><Field label={t('territories.name')}>{(x) => <Input id={x.id} value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />}</Field></div>
            <div className="w-24"><Field label={t('prospect.country')}>{(x) => <Input id={x.id} maxLength={2} value={v.country} onChange={(e) => setV((s) => ({ ...s, country: e.target.value.toUpperCase() }))} />}</Field></div>
            <div className="w-28"><Field label={t('prospect.region')} optional>{(x) => <Input id={x.id} maxLength={6} value={v.region} onChange={(e) => setV((s) => ({ ...s, region: e.target.value.toUpperCase() }))} />}</Field></div>
            <Toggle checked={v.showOnSite} onChange={(b) => setV((s) => ({ ...s, showOnSite: b }))} label={t('territories.showOnSite')} />
            <Button icon="plus" disabled={!v.name || v.country.length !== 2} loading={act.pending} onClick={async () => {
              if (await act.run(() => franchiseApi.createTerritory({ name: v.name, country: v.country, region: v.region || null, showOnSite: v.showOnSite }))) { setV((s) => ({ ...s, name: '' })); res.reload(); }
            }}>{t('territories.addButton')}</Button>
          </div>
        </SectionCard>
      )}
      <FAsync res={res} variant="table">
        {(items) => items.length ? (
          <div className="rounded-xl bg-surface p-2">
            <DataTable<Territory>
              rows={items}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.name}
              columns={[
                { key: 'name', header: t('territories.name'), render: (r) => <span className="font-bold">{r.name}</span> },
                { key: 'where', header: t('territories.where'), render: (r) => <span>{f.place(r.country, r.region)} <span className="text-stone">({r.jurisdiction})</span></span> },
                { key: 'status', header: t('territories.status'), render: (r) => canEdit ? (
                  <Select aria-label={t('territories.statusOf', { name: r.name })} value={r.status} onChange={async (e) => { if (await act.run(() => franchiseApi.updateTerritory(r.id, { status: e.target.value }))) res.reload(); }} className="h-9 w-40">
                    {TERRITORY_STATUSES.map((s) => <option key={s} value={s}>{t(`territoryStatus.${s}`)}</option>)}
                  </Select>
                ) : <Badge tone={TONE[r.status]}>{t(`territoryStatus.${r.status}`)}</Badge> },
                { key: 'site', header: t('territories.onSite'), render: (r) => (r.showOnSite ? t('common.yes') : t('common.no')) },
                { key: 'prospects', header: t('territories.prospects'), align: 'right', render: (r) => r.activeProspects },
              ]}
            />
          </div>
        ) : <Empty icon="map" title={t('territories.empty')} />}
      </FAsync>
    </>
  );
}
