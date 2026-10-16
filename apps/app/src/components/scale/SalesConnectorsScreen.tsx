'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select } from '@bh/ui';
import type { SalesConnectorProvider } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { scaleApi, useScale, useScaleAction, type CatalogEntry, type ConnectionVM, type ConnectorLocationVM } from './api';
import { ActionError, ConnectionStatus, VendorMark, useQFmt } from './ui';

/**
 * Network → Connections → Sales connectors. Each location connects its POS or booking system (Square, Toast, Mindbody,
 * Shopify, Lightspeed, Clover) so royalties use real sales; HQ chooses each location's one gross-sales source.
 * Franchise owners see and connect their own locations only.
 */
export function SalesConnectorsScreen() {
  const t = useTranslations('scale');
  const app = useApp();
  const res = useScale(() => scaleApi.connectors(), [app.org.id], app.hasModule('network.sales_connectors'));
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('connected')) setNotice({ tone: 'success', text: t('connectors.connectedNotice') });
    else if (q.get('error')) setNotice({ tone: 'danger', text: t(`connectors.callbackError.${['declined', 'state_expired', 'exchange_failed'].includes(q.get('error')!) ? q.get('error') : 'generic'}` as 'connectors.callbackError.generic') });
  }, [t]);
  if (!app.hasModule('network.sales_connectors')) return <DeniedState />;
  return (
    <>
      <PageHeader icon="plug" title={t('connectors.title')} description={t('connectors.description')} scope={false}
        actions={<Link href="/sales-connectors/reconciliation"><Button variant="secondary" size="sm" icon="scale">{t('recon.title')}</Button></Link>} />
      {notice && <Banner tone={notice.tone} live="polite">{notice.text}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => !d.locations.length} empty={<Empty icon="plug" title={t('connectors.empty')} />}>
        {(d) => (
          <>
            <Catalog items={d.catalog} />
            <div className="flex flex-col gap-3" data-testid="sales-connectors">
              {d.locations.map((l) => <LocationCard key={l.id} l={l} catalog={d.catalog} onChange={res.reload} />)}
            </div>
            <SectionCard title={t('connectors.rulesTitle')}>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-stone">
                <li>{t('connectors.rule1')}</li>
                <li>{t('connectors.rule2')}</li>
                <li>{t('connectors.rule3')}</li>
              </ul>
            </SectionCard>
          </>
        )}
      </Async>
    </>
  );
}

function Catalog({ items }: { items: CatalogEntry[] }) {
  const t = useTranslations('scale');
  return (
    <section aria-label={t('connectors.catalog')} className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))]">
      {items.map((c) => (
        <div key={c.provider} className="flex items-start gap-2.5 rounded-xl bg-surface p-3">
          <VendorMark provider={c.provider} />
          <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <span className="text-[14px] font-bold">{c.name}</span>
            <span className="text-xs text-stone">{t(`flow.${c.flow}`)}</span>
            <Badge tone={c.mode === 'live' ? 'success' : 'neutral'}>{t(`mode.${c.mode}`)}</Badge>
          </span>
        </div>
      ))}
    </section>
  );
}

function SourcePicker({ l, onChange }: { l: ConnectorLocationVM; onChange: () => void }) {
  const t = useTranslations('scale');
  const act = useScaleAction();
  const value = l.source.source === 'connector' ? `connector:${l.source.connectionId}` : l.source.source;
  const [saved, setSaved] = useState<number | null>(null);
  if (!l.can.publish) {
    const c = l.connections.find((x) => x.id === l.source.connectionId);
    return <Badge tone="info" icon="receipt">{l.source.source === 'connector' && c ? t('source.connectorNamed', { name: c.name }) : t(`source.${l.source.source}`)}</Badge>;
  }
  return (
    <div className="flex flex-col gap-1">
      <ActionError error={act.error} />
      <div className="w-64"><Field label={t('source.label')}>{(x) => (
        <Select id={x.id} value={value} disabled={act.pending} onChange={async (e) => {
          const v = e.target.value;
          const body = v.startsWith('connector:') ? { source: 'connector' as const, connectionId: v.slice(10) } : { source: v as 'branchharbor' | 'self_reported' };
          const r = await act.run(() => scaleApi.setSource(l.id, body));
          if (r) { setSaved(r.openStatements); onChange(); }
        }}>
          <option value="branchharbor">{t('source.branchharbor')}</option>
          {l.connections.filter((c) => c.status !== 'disconnected').map((c) => <option key={c.id} value={`connector:${c.id}`}>{t('source.connectorNamed', { name: c.name })}</option>)}
          <option value="self_reported">{t('source.self_reported')}</option>
        </Select>
      )}</Field></div>
      {saved !== null && saved > 0 && <span className="text-xs text-stone">{t('source.recalculate', { count: saved })}</span>}
    </div>
  );
}

function LocationCard({ l, catalog, onChange }: { l: ConnectorLocationVM; catalog: CatalogEntry[]; onChange: () => void }) {
  const t = useTranslations('scale');
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-4" aria-label={l.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-bold">{l.name} <span className="text-xs font-medium text-stone">{l.code} · {l.currency}</span></h2>
          {l.ownerGroupName && <p className="text-xs text-stone">{l.ownerGroupName}</p>}
        </div>
        <SourcePicker l={l} onChange={onChange} />
      </div>
      {l.connections.length ? (
        <ul className="flex flex-col divide-y divide-line-soft">
          {l.connections.map((c) => <ConnectionRow key={c.id} c={c} canEdit={l.can.edit} onChange={onChange} isSource={l.source.connectionId === c.id} />)}
        </ul>
      ) : <p className="text-[13px] text-stone">{l.paymentsEnabled ? t('connectors.noneWithPayments') : t('connectors.none')}</p>}
      {l.can.edit && (adding ? <ConnectForm l={l} catalog={catalog} onDone={() => { setAdding(false); onChange(); }} onCancel={() => setAdding(false)} /> : (
        <div><Button size="sm" variant="secondary" icon="plus" onClick={() => setAdding(true)}>{t('connectors.connect')}</Button></div>
      ))}
    </section>
  );
}

function ConnectionRow({ c, canEdit, onChange, isSource }: { c: ConnectionVM; canEdit: boolean; onChange: () => void; isSource: boolean }) {
  const t = useTranslations('scale');
  const f = useQFmt();
  const act = useScaleAction();
  const [mapping, setMapping] = useState(false);
  const needsLocation = c.status === 'connected' && c.mode === 'live' && ['square', 'shopify', 'lightspeed'].includes(c.provider) && !c.config.externalLocationId;
  const follow = (r: { authorizeUrl: string | null; activationUrl: string | null } | undefined) => {
    if (r?.authorizeUrl) window.location.assign(r.authorizeUrl);
    else onChange();
  };
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <VendorMark provider={c.provider} size={32} />
        <span className="min-w-0">
          <span className="block font-bold">{c.name}{c.externalAccountName && <span className="font-medium text-stone"> · {c.externalAccountName}</span>}</span>
          <span className="block text-xs text-stone">{c.lastSyncAt ? t('connectors.lastSync', { when: f.date(c.lastSyncAt) }) : t('connectors.neverSynced')}</span>
        </span>
        <ConnectionStatus c={c} />
        {isSource && <Badge tone="signal" icon="check">{t('source.isSource')}</Badge>}
        {canEdit && (
          <span className="ml-auto flex flex-wrap gap-1.5">
            {c.status === 'connected' && <Button size="sm" variant="ghost" icon="refresh" loading={act.pending} onClick={async () => { if (await act.run(() => scaleApi.sync(c.id))) onChange(); }}>{t('connectors.resync')}</Button>}
            {['authorization_expired', 'error', 'pending_authorisation'].includes(c.status) && <Button size="sm" variant="secondary" icon="key" onClick={async () => follow(await act.run(() => scaleApi.reconnect(c.id)))}>{t('connectors.reconnect')}</Button>}
            <Button size="sm" variant="ghost" icon="x" onClick={async () => { if (window.confirm(t('connectors.disconnectConfirm', { name: c.name })) && (await act.run(() => scaleApi.disconnect(c.id)))) onChange(); }}>{t('connectors.disconnect')}</Button>
          </span>
        )}
      </div>
      <ActionError error={act.error} />
      {c.lastError && <Banner tone="warning">{c.lastError}</Banner>}
      {c.activationUrl && c.status === 'pending_authorisation' && (
        <Banner tone="info" action={<a className="font-bold underline" href={c.activationUrl} target="_blank" rel="noreferrer">{t('connectors.openActivation')}</a>}>{t('connectors.activationHint')}</Banner>
      )}
      {needsLocation && canEdit && (mapping ? <ExternalLocationPicker c={c} onDone={() => { setMapping(false); onChange(); }} /> : (
        <Banner tone="info" action={<Button size="sm" onClick={() => setMapping(true)}>{t('connectors.chooseLocation')}</Button>}>{t('connectors.chooseLocationHint', { name: c.name })}</Banner>
      ))}
    </li>
  );
}

function ExternalLocationPicker({ c, onDone }: { c: ConnectionVM; onDone: () => void }) {
  const t = useTranslations('scale');
  const res = useScale(() => scaleApi.externalLocations(c.id), [c.id]);
  const act = useScaleAction();
  const [value, setValue] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <ActionError error={act.error} />
      <div className="w-64"><Field label={t('connectors.vendorLocation', { name: c.name })}>{(x) => (
        <Select id={x.id} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">{t('common.choose')}</option>
          {(res.data?.items ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </Select>
      )}</Field></div>
      <Button size="sm" disabled={!value} loading={act.pending} onClick={async () => { if (await act.run(() => scaleApi.configure(c.id, { externalLocationId: value }))) onDone(); }}>{t('common.save')}</Button>
    </div>
  );
}

const CONFIG_FIELDS: Partial<Record<SalesConnectorProvider, Array<{ key: string; kind: 'text' | 'series' }>>> = {
  toast: [{ key: 'restaurantGuid', kind: 'text' }],
  mindbody: [{ key: 'siteId', kind: 'text' }],
  shopify: [{ key: 'shopDomain', kind: 'text' }],
  lightspeed: [{ key: 'series', kind: 'series' }],
};

function ConnectForm({ l, catalog, onDone, onCancel }: { l: ConnectorLocationVM; catalog: CatalogEntry[]; onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('scale');
  const act = useScaleAction();
  const taken = new Set(l.connections.map((c) => c.provider));
  const options = catalog.filter((c) => !taken.has(c.provider));
  const [provider, setProvider] = useState<SalesConnectorProvider>(options[0]?.provider ?? 'square');
  const [config, setConfig] = useState<Record<string, string>>({ series: 'x_series' });
  const meta = catalog.find((c) => c.provider === provider);
  if (!options.length) return <p className="text-[13px] text-stone">{t('connectors.allConnected')}</p>;
  return (
    <form className="flex flex-wrap items-end gap-2 rounded-lg bg-canvas p-3" onSubmit={async (e) => {
      e.preventDefault();
      const cfg = Object.fromEntries(Object.entries(config).filter(([k]) => (CONFIG_FIELDS[provider] ?? []).some((f) => f.key === k)));
      const r = await act.run(() => scaleApi.connect({ locationId: l.id, provider, config: cfg }));
      if (r?.authorizeUrl) window.location.assign(r.authorizeUrl);
      else if (r) onDone();
    }}>
      <div className="w-48"><Field label={t('connectors.system')}>{(x) => (
        <Select id={x.id} value={provider} onChange={(e) => setProvider(e.target.value as SalesConnectorProvider)}>
          {options.map((c) => <option key={c.provider} value={c.provider}>{c.name}</option>)}
        </Select>
      )}</Field></div>
      {(CONFIG_FIELDS[provider] ?? []).map((fd) => (
        <div key={fd.key} className="w-64"><Field label={t(`config.${fd.key}`)} hint={t(`configHint.${fd.key}`)}>{(x) => fd.kind === 'series' ? (
          <Select id={x.id} value={config.series ?? 'x_series'} onChange={(e) => setConfig((c) => ({ ...c, series: e.target.value }))}>
            <option value="x_series">{t('config.xSeries')}</option>
            <option value="k_series">{t('config.kSeries')}</option>
          </Select>
        ) : <Input id={x.id} required value={config[fd.key] ?? ''} onChange={(e) => setConfig((c) => ({ ...c, [fd.key]: e.target.value }))} />}</Field></div>
      ))}
      <Button type="submit" loading={act.pending} icon="plug">{meta?.flow === 'oauth' ? t('connectors.authorise', { name: meta.name }) : t('connectors.connectNamed', { name: meta?.name ?? '' })}</Button>
      <Button type="button" variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      {meta?.mode === 'sandbox' && <p className="w-full text-xs text-stone">{t('connectors.sandboxHint')}</p>}
      <div className="w-full"><ActionError error={act.error} /></div>
    </form>
  );
}

