'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Textarea, Toggle, cx } from '@bh/ui';
import { TerritoryMap, STATUS_COLORS } from '@bh/ui/map';
import { TERRITORY_EXCLUSIVITY, TERRITORY_STATUSES, type Position, type TerritoryGeometry } from '@bh/shared';
import { franchiseApi, useFranchise } from '@/lib/franchise/api';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { download, fdevApi, useAction, useLoad, type Overlap, type TerritoryListVM, type TerritoryVM } from './api';
import { ActionError, Bar, COUNTRY_RE, KeyValue, TerritoryStatus, useFmt } from './ui';

type Panel = { kind: 'detail'; id: string } | { kind: 'new' } | { kind: 'none' };

/**
 * Sales → Territories: the territory map. Territories are drawn on the map or built from postcodes, coloured by
 * status (which follows the pipeline and agreements), checked for overlaps against the exclusivity rules, enriched
 * with demographics and scored; HQ exports Item 12 descriptions and GeoJSON and can publish the available ones.
 */
export function TerritoryMapScreen() {
  const t = useTranslations('fdev');
  const app = useApp();
  const res = useLoad(() => fdevApi.territories(), [app.org.id]);
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [filter, setFilter] = useState<string>('all');
  const [draft, setDraft] = useState<Position[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [fitKey, setFitKey] = useState('initial');
  const act = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const d = res.data;
  const items = useMemo(() => (d?.items ?? []).filter((x) => filter === 'all' || x.status === filter), [d, filter]);
  const selected = panel.kind === 'detail' ? d?.items.find((x) => x.id === panel.id) ?? null : null;
  const points = useMemo(() => d?.locations ?? [], [d]);

  if (app.org.model === 'independent') return <Banner tone="neutral" icon="info">{t('networkOnly')}</Banner>;
  if (res.status === 'error') return <><PageHeader icon="map" title={t('territories.title')} scope={false} /><Banner tone="danger">{res.error.message}</Banner></>;
  if (!d) return <><PageHeader icon="map" title={t('territories.title')} scope={false} /><LoadingBlock variant="detail" /></>;

  const counts = Object.fromEntries(TERRITORY_STATUSES.map((s) => [s, d.items.filter((x) => x.status === s).length]));
  const conflicts = d.items.filter((x) => x.overlaps.some((o) => o.conflict)).length;
  const drift = d.items.filter((x) => x.derivedStatus !== x.status).length;

  const onImport = async (f: File) => {
    setImportMsg(null);
    let json: unknown;
    try { json = JSON.parse(await f.text()); } catch { setImportMsg(t('territories.importInvalid')); return; }
    const r = await act.run(() => fdevApi.importGeoJson(json, d!.homeCountry));
    if (r) { setImportMsg(t('territories.importDone', { created: r.created, updated: r.updated, skipped: r.skipped.length })); res.reload(); setFitKey(`import-${Date.now()}`); }
  };

  return (
    <>
      <PageHeader icon="map" title={t('territories.title')} description={t('territories.description')} scope={false}
        actions={(
          <span className="flex flex-wrap gap-2">
            {d.can.export && <Button variant="ghost" size="sm" icon="download" onClick={() => void download('/territories/export.geojson', 'territories.geojson')}>{t('territories.exportGeoJson')}</Button>}
            {d.can.export && <Button variant="ghost" size="sm" icon="file" onClick={() => void download('/territories/item12.csv', 'territories-item12.csv')}>{t('territories.exportItem12')}</Button>}
            {d.can.edit && <Button variant="ghost" size="sm" icon="layers" onClick={() => fileRef.current?.click()}>{t('territories.importGeoJson')}</Button>}
            {d.can.edit && <Button variant="secondary" size="sm" icon="plus" onClick={() => { setPanel({ kind: 'new' }); setDraft([]); setDrawing(true); }}>{t('territories.new')}</Button>}
          </span>
        )} />
      <input ref={fileRef} type="file" accept=".geojson,.json,application/geo+json,application/json" className="hidden" aria-label={t('territories.importGeoJson')} onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImport(f); e.target.value = ''; }} />
      <ActionError error={act.error} />
      {importMsg && <Banner tone="info" icon="info">{importMsg}</Banner>}
      {drift > 0 && d.can.edit && (
        <Banner tone="warning" icon="refresh" action={<Button size="sm" variant="secondary" loading={act.pending} onClick={async () => { if (await act.run(() => fdevApi.syncStatus())) res.reload(); }}>{t('territories.syncAll')}</Button>}>
          {t('territories.drift', { count: drift })}
        </Banner>
      )}
      {conflicts > 0 && <Banner tone="danger" icon="alert">{t('territories.conflicts', { count: conflicts })}</Banner>}

      <section className="flex flex-wrap items-center gap-1.5" aria-label={t('territories.filter')}>
        {(['all', ...TERRITORY_STATUSES] as string[]).map((s) => (
          <button key={s} type="button" aria-pressed={filter === s} onClick={() => { setFilter(s); setFitKey(`f-${s}`); }} className={cx('flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold', filter === s ? 'bg-ink text-white' : 'bg-surface')}>
            {s !== 'all' && <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLORS[s] }} />}
            {s === 'all' ? t('territories.all') : t(`territoryStatus.${s}` as 'territoryStatus.available')}
            <span className="tabular opacity-70">{s === 'all' ? d.items.length : counts[s]}</span>
          </button>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-2">
          <TerritoryMap
            className="h-[420px] w-full lg:h-[600px]"
            config={d.map}
            territories={items}
            points={points}
            selectedId={selected?.id ?? null}
            onSelect={(id) => { setPanel({ kind: 'detail', id }); setDrawing(false); }}
            drawing={drawing}
            draft={draft}
            onDraftChange={setDraft}
            fitKey={fitKey}
            label={t('territories.mapLabel')}
            outlineNote={t('territories.outlineNote')}
          />
          <p className="text-xs text-stone">{drawing ? t('territories.drawHint') : t('territories.mapHint')}</p>
        </div>
        <aside className="flex flex-col gap-3" aria-label={t('territories.panel')}>
          {panel.kind === 'new' && d.can.edit && (
            <NewTerritory d={d} draft={draft} setDraft={setDraft} drawing={drawing} setDrawing={setDrawing}
              onCancel={() => { setPanel({ kind: 'none' }); setDraft([]); setDrawing(false); }}
              onCreated={(x) => { setDraft([]); setDrawing(false); res.reload(); setPanel({ kind: 'detail', id: x.id }); }} />
          )}
          {selected && <Detail x={selected} d={d} onChanged={res.reload} onDeleted={() => { setPanel({ kind: 'none' }); res.reload(); }} />}
          {panel.kind === 'none' && <Legend d={d} />}
          <PublicMapCard d={d} onSaved={res.reload} />
        </aside>
      </div>

      <TerritoryTable items={items} onOpen={(id) => { setPanel({ kind: 'detail', id }); setDrawing(false); setFitKey(`sel:${id}`); }} />
    </>
  );
}

function Legend({ d }: { d: TerritoryListVM }) {
  const t = useTranslations('fdev');
  return (
    <SectionCard title={t('territories.legend')}>
      <ul className="grid grid-cols-2 gap-2 text-[13px]">
        {TERRITORY_STATUSES.map((s) => <li key={s} className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-3 rounded-sm" style={{ background: STATUS_COLORS[s] }} />{t(`territoryStatus.${s}` as 'territoryStatus.available')}</li>)}
      </ul>
      <p className="mt-3 text-xs text-stone">{t('territories.legendHint')}</p>
      {!d.demographics.census && <p className="mt-2 text-xs text-stone">{t('territories.demographicsSandbox')}</p>}
    </SectionCard>
  );
}

function OverlapList({ overlaps }: { overlaps: Overlap[] }) {
  const t = useTranslations('fdev');
  if (!overlaps.length) return <p className="text-[13px] text-stone">{t('territories.noOverlaps')}</p>;
  return (
    <ul className="flex flex-col gap-1.5" data-testid="overlaps">
      {overlaps.map((o) => (
        <li key={o.id} className={cx('rounded-md px-3 py-2 text-[13px]', o.conflict ? 'bg-[#F8D6D8]' : 'bg-canvas')}>
          <strong>{o.name}</strong> · {t(`territoryStatus.${o.status}` as 'territoryStatus.available')}
          <span className="block text-xs">{o.by.map((b) => t(`territories.overlapBy.${b}`)).join(' · ')}{o.sharedPostcodes.length ? `: ${o.sharedPostcodes.join(', ')}` : ''}</span>
          {o.conflict && <span className="block text-xs font-bold text-danger">{t('territories.conflictRule')}</span>}
        </li>
      ))}
    </ul>
  );
}

function NewTerritory({ d, draft, setDraft, drawing, setDrawing, onCancel, onCreated }: { d: TerritoryListVM; draft: Position[]; setDraft: (p: Position[]) => void; drawing: boolean; setDrawing: (b: boolean) => void; onCancel: () => void; onCreated: (x: TerritoryVM) => void }) {
  const t = useTranslations('fdev');
  const app = useApp();
  const act = useAction();
  const [mode, setMode] = useState<'draw' | 'postcodes'>('draw');
  const [v, setV] = useState({ name: '', country: d.homeCountry, region: '', exclusivity: 'exclusive', postcodes: '', description: '', showOnSite: true });
  const [overlaps, setOverlaps] = useState<Overlap[]>([]);
  const geometry: TerritoryGeometry | null = mode === 'draw' && draft.length >= 3 ? { type: 'Polygon', coordinates: [[...draft, draft[0]!]] } : null;
  const postcodes = mode === 'postcodes' ? v.postcodes.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean) : [];
  useEffect(() => {
    if (!geometry && !postcodes.length) { setOverlaps([]); return; }
    const h = setTimeout(() => { void fdevApi.checkTerritory({ geometry, postcodes, exclusivity: v.exclusivity }).then((r) => setOverlaps(r.overlaps)).catch(() => {}); }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(geometry), v.postcodes, v.exclusivity, mode]);
  const ok = v.name.trim() && COUNTRY_RE.test(v.country) && (geometry || postcodes.length);
  void d;
  return (
    <SectionCard title={t('territories.new')}>
      <div className="flex flex-col gap-3">
        <div role="tablist" className="inline-flex gap-1 rounded-full bg-canvas p-1">
          {(['draw', 'postcodes'] as const).map((m) => (
            <button key={m} role="tab" type="button" aria-selected={mode === m} onClick={() => { setMode(m); setDrawing(m === 'draw'); }} className={cx('h-9 flex-1 rounded-full px-3 text-[13px] font-bold', mode === m ? 'bg-ink text-white' : '')}>{t(`territories.mode.${m}`)}</button>
          ))}
        </div>
        <Field label={t('territories.name')}>{(x) => <Input id={x.id} value={v.name} onChange={(e) => setV((s) => ({ ...s, name: e.target.value }))} />}</Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('territories.country')}>{(x) => <Input id={x.id} maxLength={2} value={v.country} onChange={(e) => setV((s) => ({ ...s, country: e.target.value.toUpperCase() }))} />}</Field>
          <Field label={t('territories.region')} optional>{(x) => <Input id={x.id} maxLength={6} value={v.region} onChange={(e) => setV((s) => ({ ...s, region: e.target.value.toUpperCase() }))} />}</Field>
        </div>
        <Field label={t('territories.exclusivity')} hint={t(`exclusivityHint.${v.exclusivity}` as 'exclusivityHint.exclusive')}>{(x) => (
          <Select id={x.id} value={v.exclusivity} onChange={(e) => setV((s) => ({ ...s, exclusivity: e.target.value }))}>
            {TERRITORY_EXCLUSIVITY.map((k) => <option key={k} value={k}>{t(`exclusivity.${k}`)}</option>)}
          </Select>
        )}</Field>
        {mode === 'draw' ? (
          <div className="rounded-md bg-canvas p-3 text-[13px]">
            <p>{draft.length ? t('territories.points', { count: draft.length }) : t('territories.drawStart')}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant={drawing ? 'primary' : 'secondary'} icon="edit" onClick={() => setDrawing(!drawing)}>{drawing ? t('territories.drawing') : t('territories.draw')}</Button>
              <Button size="sm" variant="ghost" icon="undo" disabled={!draft.length} onClick={() => setDraft(draft.slice(0, -1))}>{t('territories.undo')}</Button>
              <Button size="sm" variant="ghost" icon="x" disabled={!draft.length} onClick={() => setDraft([])}>{t('territories.clear')}</Button>
            </div>
          </div>
        ) : (
          <Field label={t('territories.postcodes')} hint={t('territories.postcodesHint')}>{(x) => <Textarea id={x.id} rows={4} value={v.postcodes} onChange={(e) => setV((s) => ({ ...s, postcodes: e.target.value }))} />}</Field>
        )}
        <Field label={t('territories.descriptionField')} optional>{(x) => <Textarea id={x.id} rows={2} value={v.description} onChange={(e) => setV((s) => ({ ...s, description: e.target.value }))} />}</Field>
        <label className="flex items-center gap-2 text-[13px]"><Toggle checked={v.showOnSite} onChange={(b) => setV((s) => ({ ...s, showOnSite: b }))} label={t('territories.showOnSite')} /><span aria-hidden="true">{t('territories.showOnSite')}</span></label>
        <div>
          <h4 className="mb-1.5 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('territories.overlaps')}</h4>
          <OverlapList overlaps={overlaps} />
        </div>
        <ActionError error={act.error} />
        <div className="flex gap-2">
          <Button icon="check" disabled={!ok || overlaps.some((o) => o.conflict)} loading={act.pending} onClick={async () => {
            const r = await act.run(() => fdevApi.createTerritory({ name: v.name.trim(), country: v.country, region: v.region || null, exclusivity: v.exclusivity, description: v.description || null, showOnSite: v.showOnSite, ...(mode === 'draw' ? { geometry } : { postcodesText: v.postcodes }) }));
            if (r) onCreated(r);
          }}>{t('territories.save')}</Button>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </div>
    </SectionCard>
  );
}

function Detail({ x, d, onChanged, onDeleted }: { x: TerritoryVM; d: TerritoryListVM; onChanged: () => void; onDeleted: () => void }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  const act = useAction();
  const dm = x.demographics;
  return (
    <SectionCard title={x.name} aside={<TerritoryStatus status={x.status} />}>
      <div className="flex flex-col gap-3" data-testid="territory-detail">
        {x.derivedStatus !== x.status && (
          <Banner tone="warning" icon="refresh" action={d.can.edit ? <Button size="sm" variant="secondary" onClick={async () => { if (await act.run(() => fdevApi.syncStatus([x.id]))) onChanged(); }}>{t('territories.apply')}</Button> : undefined}>
            {t('territories.derived', { status: t(`territoryStatus.${x.derivedStatus}` as 'territoryStatus.available') })}
          </Banner>
        )}
        <KeyValue items={[
          [t('territories.where'), `${x.region ? `${x.region}, ` : ''}${x.country} (${x.jurisdiction})`],
          [t('territories.exclusivity'), t(`exclusivity.${x.exclusivity}`)],
          ...(x.areaKm2 !== null ? [[t('territories.area'), t('territories.km2', { value: f.num(x.areaKm2) })] as [string, string]] : []),
          ...(x.postcodes.length ? [[t('territories.postcodes'), x.postcodes.slice(0, 12).join(', ') + (x.postcodes.length > 12 ? ` +${x.postcodes.length - 12}` : '')] as [string, string]] : []),
          ...(x.ownerGroupName ? [[t('territories.owner'), x.ownerGroupName] as [string, string]] : []),
        ]} />
        {x.description && <p className="text-[13px] text-graphite">{x.description}</p>}

        <div>
          <h4 className="mb-1.5 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('territories.deals')}</h4>
          {x.links && (x.links.prospects.length || x.links.agreement || x.links.openLocations.length) ? (
            <ul className="flex flex-col gap-1 text-[13px]">
              {x.links.prospects.map((p) => <li key={p.id}><a className="font-bold underline" href={`/franchise/prospect?id=${p.id}`}>{p.name}</a> · {t('territories.prospectStage')}</li>)}
              {x.links.agreement && <li>{t('territories.agreementLink', { owner: x.links.agreement.ownerGroupName ?? '—', end: f.date(x.links.agreement.endDate) })}</li>}
              {x.links.project && <li>{t('territories.projectLink', { status: t(`status.${x.links.project.status}` as 'status.active') })}</li>}
              {x.links.openLocations.map((l) => <li key={l.id}>{t('territories.openLocation', { name: l.name })}</li>)}
            </ul>
          ) : <p className="text-[13px] text-stone">{t('territories.noDeals')}</p>}
        </div>

        <div>
          <h4 className="mb-1.5 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('territories.overlaps')}</h4>
          <OverlapList overlaps={x.overlaps} />
        </div>

        <div className="rounded-md bg-canvas p-3" data-testid="demographics">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t('territories.demographics')}</h4>
            {dm && <Badge tone={dm.sandbox ? 'warning' : 'success'}>{dm.sandbox ? t('territories.sample') : t(`territories.source.${dm.source}` as 'territories.source.us_census_acs5')}</Badge>}
          </div>
          {dm ? (
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div><div className="tabular text-[18px] font-extrabold">{f.num(dm.population)}</div><div className="text-[11px] text-stone">{t('territories.population')}</div></div>
              <div><div className="tabular text-[18px] font-extrabold">{f.num(dm.households)}</div><div className="text-[11px] text-stone">{t('territories.households')}</div></div>
              <div><div className="tabular text-[18px] font-extrabold">{f.money(dm.medianHouseholdIncomeMinor, dm.currency)}</div><div className="text-[11px] text-stone">{t('territories.income')}</div></div>
            </div>
          ) : <p className="mt-1 text-[13px] text-stone">{t('territories.noDemographics')}</p>}
          {x.score !== null && (
            <div className="mt-3">
              <div className="flex items-baseline justify-between"><span className="text-[13px] font-bold">{t('territories.score')}</span><span className="tabular text-[22px] font-extrabold">{x.score}<span className="text-xs font-medium text-stone">/100</span></span></div>
              <ul className="mt-1 flex flex-col gap-1">
                {(x.scoreParts ?? []).map((p) => (
                  <li key={p.key} className="grid grid-cols-[110px_1fr_36px] items-center gap-2 text-xs">
                    <span>{t(`territories.part.${p.key}`)}</span>
                    {p.value === null ? <span className="text-stone">{t('territories.noData')}</span> : <Bar value={p.value} label={`${t(`territories.part.${p.key}`)} ${Math.round(p.value * 100)}%`} />}
                    <span className="tabular text-end text-stone">{p.weight}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.can.edit && <Button className="mt-2" size="sm" variant="secondary" icon="refresh" loading={act.pending} onClick={async () => { if (await act.run(() => fdevApi.refreshDemographics(x.id))) onChanged(); }}>{dm ? t('territories.refresh') : t('territories.fetch')}</Button>}
        </div>

        {d.can.edit && (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('territories.status')}>{(fx) => (
              <Select id={fx.id} value={x.status} onChange={async (e) => { if (await act.run(() => fdevApi.updateTerritory(x.id, { status: e.target.value }))) onChanged(); }}>
                {TERRITORY_STATUSES.map((s) => <option key={s} value={s}>{t(`territoryStatus.${s}` as 'territoryStatus.available')}</option>)}
              </Select>
            )}</Field>
            <Field label={t('territories.exclusivity')}>{(fx) => (
              <Select id={fx.id} value={x.exclusivity} onChange={async (e) => { if (await act.run(() => fdevApi.updateTerritory(x.id, { exclusivity: e.target.value }))) onChanged(); }}>
                {TERRITORY_EXCLUSIVITY.map((k) => <option key={k} value={k}>{t(`exclusivity.${k}`)}</option>)}
              </Select>
            )}</Field>
            {d.scopeTerritories.length > 0 && (
              <div className="col-span-2"><Field label={t('territories.subNetwork')} hint={t('territories.subNetworkHint')}>{(fx) => (
                <Select id={fx.id} value={x.scopeTerritoryId ?? ''} onChange={async (e) => { if (await act.run(() => fdevApi.updateTerritory(x.id, { scopeTerritoryId: e.target.value || null }))) onChanged(); }}>
                  <option value="">{t('territories.noSubNetwork')}</option>
                  {d.scopeTerritories.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </Select>
              )}</Field></div>
            )}
            <label className="col-span-2 flex items-center gap-2 text-[13px]"><Toggle checked={x.showOnSite} onChange={async (b) => { if (await act.run(() => fdevApi.updateTerritory(x.id, { showOnSite: b }))) onChanged(); }} label={t('territories.showOnSite')} /><span aria-hidden="true">{t('territories.showOnSite')}</span></label>
          </div>
        )}
        <ActionError error={act.error} />
        <div className="flex flex-wrap gap-2">
          {d.can.export && <Button size="sm" variant="ghost" icon="download" onClick={() => void download(`/territories/${x.id}/item12.pdf`, `territory-${x.name.toLowerCase().replace(/[^\w-]+/g, '-')}.pdf`)}>{t('territories.item12Pdf')}</Button>}
          {d.can.edit && !x.links?.agreement && !x.links?.prospects.length && !x.ownerGroupId && <Button size="sm" variant="ghost" icon="x" onClick={async () => { if (await act.run(() => fdevApi.deleteTerritory(x.id))) onDeleted(); }}>{t('territories.delete')}</Button>}
        </div>
      </div>
    </SectionCard>
  );
}

function PublicMapCard({ d, onSaved }: { d: TerritoryListVM; onSaved: () => void }) {
  const t = useTranslations('fdev');
  const tf = useTranslations('franchise');
  const act = useAction();
  const settings = useFranchise(() => franchiseApi.settings(), []);
  return (
    <SectionCard title={t('territories.publicTitle')}>
      <div className="flex flex-col gap-2 text-[13px]">
        {d.can.publish ? (
          <>
            <label className="flex items-center gap-2"><Toggle checked={d.settings.publicMap} onChange={async (b) => { if (await act.run(() => fdevApi.territorySettings({ publicMap: b }))) onSaved(); }} label={t('territories.publicToggle')} /><span aria-hidden="true">{t('territories.publicToggle')}</span></label>
            <label className="flex items-center gap-2"><Toggle checked={d.settings.showTaken} onChange={async (b) => { if (await act.run(() => fdevApi.territorySettings({ showTaken: b }))) onSaved(); }} label={t('territories.showTaken')} /><span aria-hidden="true">{t('territories.showTaken')}</span></label>
          </>
        ) : <Badge tone={d.settings.publicMap ? 'success' : 'neutral'}>{d.settings.publicMap ? t('territories.publicOn') : t('territories.publicOff')}</Badge>}
        {settings.data && (
          settings.data.canEdit
            ? <label className="flex items-center gap-2"><Toggle checked={settings.data.enquiryFormEnabled} onChange={async (b) => { const r = await act.run(() => franchiseApi.saveSettings({ enquiryFormEnabled: b })); if (r) settings.setData({ ...settings.data!, enquiryFormEnabled: r.enquiryFormEnabled }); }} label={tf('territories.formToggle')} /><span aria-hidden="true">{tf('territories.formToggle')}</span></label>
            : null
        )}
        <p className="text-xs text-stone">{t('territories.publicHint', { brand: d.brandSlug })}</p>
        <ActionError error={act.error} />
      </div>
    </SectionCard>
  );
}

function TerritoryTable({ items, onOpen }: { items: TerritoryVM[]; onOpen: (id: string) => void }) {
  const t = useTranslations('fdev');
  const f = useFmt();
  if (!items.length) return <Empty icon="map" title={t('territories.empty')} body={t('territories.emptyBody')} />;
  return (
    <section className="overflow-x-auto rounded-xl bg-surface p-3.5" data-testid="territory-table">
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-line-soft text-left">
            {[t('territories.name'), t('territories.status'), t('territories.exclusivity'), t('territories.area'), t('territories.population'), t('territories.score'), t('territories.overlaps')].map((h) => <th key={h} scope="col" className="px-3 py-3 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.id} className="border-b border-line-soft last:border-0">
              <td className="px-3 py-2.5"><button type="button" className="text-start font-bold underline-offset-2 hover:underline" onClick={() => onOpen(x.id)}>{x.name}</button><span className="block text-xs text-stone">{x.jurisdiction}</span></td>
              <td className="px-3 py-2.5"><TerritoryStatus status={x.status} /></td>
              <td className="px-3 py-2.5">{t(`exclusivity.${x.exclusivity}`)}</td>
              <td className="tabular px-3 py-2.5">{x.areaKm2 !== null ? t('territories.km2', { value: f.num(x.areaKm2) }) : t('territories.postcodeCount', { count: x.postcodes.length })}</td>
              <td className="tabular px-3 py-2.5">{x.demographics ? f.num(x.demographics.population) : '—'}</td>
              <td className="tabular px-3 py-2.5 font-bold">{x.score ?? '—'}</td>
              <td className="px-3 py-2.5">{x.overlaps.length ? <Badge tone={x.overlaps.some((o) => o.conflict) ? 'danger' : 'warning'}>{t('territories.overlapCount', { count: x.overlaps.length })}</Badge> : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
