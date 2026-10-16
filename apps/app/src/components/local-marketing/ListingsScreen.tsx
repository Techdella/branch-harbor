'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Field, Icon, Input, Select, Tabs, Textarea, Toggle } from '@bh/ui';
import { LISTING_FIELD_POLICIES, LISTING_FIELDS, type ListingField, type ListingFieldPolicy, type ListingPatch, type SpecialHour, type WeeklyHour } from '@bh/shared';
import { fmtYmd, relativeTime } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { NotAvailable } from '../screens/NotAvailable';
import { Async, Banner, Empty, LoadingBlock, SectionCard } from '../ui/States';
import { listingsApi, settingsApi, type DriftVM, type ListingDetailVM, type ListingRow } from './api';
import { HealthBar, Kpi, KpiRow, LabeledToggle, SyncBadge, useListingValue, weekdayName } from './ui';

type Tab = 'overview' | 'drift' | 'holidays' | 'changes' | 'connections' | 'settings';
const M = 'marketing.listings';

/**
 * Marketing → Listings: one source of truth per location (name, address, phone, hours and holiday hours, categories,
 * description, photos, links) synced to Google, Apple and Bing; drift alerts; HQ field locks; location changes with
 * optional approval; bulk holiday hours and a health score per location.
 */
export function ListingsScreen() {
  const t = useTranslations('lmk.listings');
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const [open, setOpen] = useState<string | null>(params.get('location'));
  if (!app.hasModule(M)) return <NotAvailable />;
  const manage = app.capabilities.has(`${M}:publish`);
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'overview', label: t('tab.overview') }, { key: 'drift', label: t('tab.drift') }, { key: 'changes', label: t('tab.changes') },
    ...(manage ? [{ key: 'holidays' as Tab, label: t('tab.holidays') }, { key: 'connections' as Tab, label: t('tab.connections') }, { key: 'settings' as Tab, label: t('tab.settings') }] : []),
  ];
  return (
    <>
      <PageHeader icon="pin" title={t('title')} description={t('description')} />
      <Tabs items={tabs} value={tab} onChange={(k) => router.replace(`?tab=${k}`, { scroll: false })} />
      {tab === 'overview' && <Overview onOpen={setOpen} />}
      {tab === 'drift' && <DriftList />}
      {tab === 'changes' && <Changes />}
      {tab === 'holidays' && manage && <Holidays />}
      {tab === 'connections' && manage && <Connections />}
      {tab === 'settings' && manage && <PolicySettings />}
      <LocationDrawer locationId={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Overview({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useTranslations('lmk.listings');
  const app = useApp();
  const res = useApi(() => listingsApi.overview(), [app.org.id]);
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <>
          <KpiRow>
            <Kpi label={t('kpi.health')} value={d.totals.averageHealth ?? '—'} sub={t('kpi.healthSub', { n: d.totals.locations })} testId="kpi-health" />
            <Kpi label={t('kpi.synced')} value={`${d.totals.synced}/${d.totals.connected}`} sub={t('kpi.syncedSub')} />
            <Kpi label={t('kpi.drift')} value={d.totals.openDrifts} sub={t('kpi.driftSub')} />
            <Kpi label={t('kpi.pending')} value={d.totals.pendingChanges} sub={t('kpi.pendingSub')} />
          </KpiRow>
          {d.totals.openDrifts > 0 && <Banner tone="warning" title={t('driftBanner.title', { n: d.totals.openDrifts })}>{t('driftBanner.body')}</Banner>}
          <SectionCard title={t('locations')}>
            <DataTable<ListingRow>
              rows={d.items}
              rowKey={(r) => r.locationId}
              onRowClick={(r) => onOpen(r.locationId)}
              rowLabel={(r) => r.name}
              empty={<Empty icon="pin" title={t('emptyLocations')} />}
              columns={[
                { key: 'n', header: t('col.location'), render: (r) => <span><strong>{r.name}</strong><span className="block text-xs text-stone">{r.city}</span></span> },
                { key: 'h', header: t('col.health'), render: (r) => <HealthBar score={r.health.score} compact /> },
                { key: 'p', header: t('col.directories'), render: (r) => <span className="flex flex-wrap gap-1">{r.providers.map((p) => <SyncBadge key={p.provider} provider={p.provider} status={p.status} mode={p.mode} />)}</span> },
                { key: 'd', header: t('col.drift'), align: 'right', render: (r) => (r.openDrifts ? <Badge tone="warning" icon="alert">{r.openDrifts}</Badge> : <span className="text-stone">0</span>) },
                { key: 'c', header: t('col.pending'), align: 'right', render: (r) => <span className="tabular">{r.pendingChanges}</span> },
                { key: 'x', header: t('col.holidays'), render: (r) => (r.missingHolidayDates.length ? <Badge tone="warning">{t('missingHolidays', { n: r.missingHolidayDates.length })}</Badge> : <Badge tone="success" icon="check">{t('holidaysOk')}</Badge>) },
              ]}
            />
          </SectionCard>
        </>
      )}
    </Async>
  );
}

/* ------------------------------ Location drawer ------------------------------ */

function LocationDrawer({ locationId, onClose }: { locationId: string | null; onClose: () => void }) {
  const t = useTranslations('lmk.listings');
  const res = useApi(() => (locationId ? listingsApi.detail(locationId) : Promise.resolve(null)), [locationId], !!locationId);
  return (
    <Drawer open={!!locationId} onClose={onClose} title={res.data?.location.name ?? t('drawerTitle')} kicker={t('drawerKicker')}>
      {locationId && (
        <Async res={res} loading={<LoadingBlock variant="detail" />}>
          {(d) => (d ? <LocationDetail d={d} onChanged={() => res.reload()} /> : null)}
        </Async>
      )}
    </Drawer>
  );
}

function LocationDetail({ d, onChanged }: { d: ListingDetailVM; onChanged: () => void }) {
  const t = useTranslations('lmk.listings');
  const locale = useLocale();
  const push = useMutation((_a, id: string) => listingsApi.push(id));
  const check = useMutation((_a, id: string) => listingsApi.check(id));
  const sim = useMutation((_a, syncId: string) => listingsApi.simulateEdit(syncId, { hours: [{ day: 1, opens: '10:00', closes: '16:00' }], phone: '+1 555 0100 999' }));
  const sandboxSync = d.providers.find((p) => p.mode === 'sandbox' && p.syncId && p.status !== 'not_connected');
  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={t('healthTitle')} aside={<HealthBar score={d.health.score} />}>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {d.health.checks.map((c) => (
            <li key={c.key} className="flex items-center gap-2 text-sm"><Icon name={c.ok ? 'check-circle' : 'alert'} size={16} className={c.ok ? 'text-success' : 'text-warning'} />{t(`check.${c.key}`)}</li>
          ))}
        </ul>
        {d.missingHolidayDates.length > 0 && <p className="mt-2 text-xs text-stone">{t('missingDates', { dates: d.missingHolidayDates.map((x) => fmtYmd(x, locale, { day: 'numeric', month: 'short' })).join(', ') })}</p>}
      </SectionCard>
      <SectionCard title={t('directories')}>
        <ul className="flex flex-col gap-2">
          {d.providers.map((p) => (
            <li key={p.provider} className="flex flex-wrap items-center gap-2 text-sm">
              <SyncBadge provider={p.provider} status={p.status} mode={p.mode} />
              {p.lastPushedAt && <span className="text-xs text-stone">{t('pushedAgo', { when: relativeTime(p.lastPushedAt, locale) })}</span>}
              {p.lastError && <span className="text-xs text-danger">{p.lastError}</span>}
            </li>
          ))}
        </ul>
        {d.canEdit && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon="send" loading={push.pending} onClick={async () => { if (await push.run(d.location.id)) onChanged(); }}>{t('pushNow')}</Button>
            <Button size="sm" variant="secondary" icon="refresh" loading={check.pending} onClick={async () => { if (await check.run(d.location.id)) onChanged(); }}>{t('checkNow')}</Button>
            {sandboxSync && <Button size="sm" variant="ghost" icon="edit" loading={sim.pending} onClick={async () => { if (await sim.run(sandboxSync.syncId!)) onChanged(); }}>{t('simulateEdit', { provider: t(`provider.${sandboxSync.provider}`) })}</Button>}
          </div>
        )}
        {(push.error || check.error || sim.error) && <Banner tone="danger" live="assertive">{(push.error ?? check.error ?? sim.error)!.message}</Banner>}
      </SectionCard>
      {d.drifts.length > 0 && <SectionCard title={t('driftTitle')}><DriftRows items={d.drifts} canResolve={d.canManage} onDone={onChanged} /></SectionCard>}
      <ListingForm d={d} onSaved={onChanged} />
      {d.changes.length > 0 && (
        <SectionCard title={t('changesTitle')}>
          <ul className="flex flex-col gap-2 text-sm">
            {d.changes.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2"><Badge tone={c.status === 'pending' ? 'warning' : c.status === 'approved' ? 'success' : 'danger'}>{t(`changeStatus.${c.status}`)}</Badge>{c.fields.map((f) => t(`field.${f}`)).join(', ')}<span className="text-xs text-stone">{relativeTime(c.createdAt, locale)}</span></li>)}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}

const DAYS = [1, 2, 3, 4, 5, 6, 0];

function ListingForm({ d, onSaved }: { d: ListingDetailVM; onSaved: () => void }) {
  const t = useTranslations('lmk.listings');
  const locale = useLocale();
  const l = d.listing;
  const [name, setName] = useState(l.name);
  const [phone, setPhone] = useState(l.phone ?? '');
  const [website, setWebsite] = useState(l.websiteUrl ?? '');
  const [booking, setBooking] = useState(l.bookingUrl ?? '');
  const [category, setCategory] = useState(l.categories.primary ?? '');
  const [description, setDescription] = useState(l.description ?? '');
  const [hours, setHours] = useState<WeeklyHour[]>(l.hours);
  const [special, setSpecial] = useState<SpecialHour[]>(l.specialHours);
  const [note, setNote] = useState('');
  const save = useMutation((_a, patch: ListingPatch & { note?: string | null }) => listingsApi.update(d.location.id, patch));
  const [result, setResult] = useState<{ applied: string[]; pendingApproval: string[] } | null>(null);
  useEffect(() => { setResult(null); }, [d.location.id]);
  const editable = (f: ListingField) => d.canManage || (d.canEdit && d.policy[f] !== 'hq');
  const lockNote = (f: ListingField) => (!d.canManage && d.policy[f] === 'hq' ? t('locked') : !d.canManage && d.policy[f] === 'location_approval' ? t('needsApproval') : undefined);

  const patch = (): ListingPatch => {
    const p: ListingPatch = {};
    if (editable('name') && name !== l.name) p.name = name;
    if (editable('phone') && phone !== (l.phone ?? '')) p.phone = phone || null;
    if (editable('websiteUrl') && website !== (l.websiteUrl ?? '')) p.websiteUrl = website || null;
    if (editable('bookingUrl') && booking !== (l.bookingUrl ?? '')) p.bookingUrl = booking || null;
    if (editable('categories') && category !== (l.categories.primary ?? '')) p.categories = { primary: category || null, additional: l.categories.additional };
    if (editable('description') && description !== (l.description ?? '')) p.description = description || null;
    if (editable('hours') && JSON.stringify(hours) !== JSON.stringify(l.hours)) p.hours = hours;
    if (editable('specialHours') && JSON.stringify(special) !== JSON.stringify(l.specialHours)) p.specialHours = special;
    return p;
  };
  const dayRow = (day: number) => hours.find((h) => h.day === day);
  const setDay = (day: number, v: WeeklyHour | null) => setHours((hs) => [...hs.filter((h) => h.day !== day), ...(v ? [v] : [])].sort((a, b) => a.day - b.day));

  return (
    <SectionCard title={t('editTitle')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('field.name')} hint={lockNote('name')}>{(f) => <Input id={f.id} value={name} disabled={!editable('name')} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t('field.phone')} hint={lockNote('phone')}>{(f) => <Input id={f.id} value={phone} disabled={!editable('phone')} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field label={t('field.websiteUrl')} hint={lockNote('websiteUrl')}>{(f) => <Input id={f.id} value={website} disabled={!editable('websiteUrl')} onChange={(e) => setWebsite(e.target.value)} />}</Field>
        <Field label={t('field.bookingUrl')} hint={lockNote('bookingUrl')}>{(f) => <Input id={f.id} value={booking} disabled={!editable('bookingUrl')} onChange={(e) => setBooking(e.target.value)} />}</Field>
        <Field label={t('field.categories')} hint={lockNote('categories')}>{(f) => <Input id={f.id} value={category} disabled={!editable('categories')} onChange={(e) => setCategory(e.target.value)} />}</Field>
      </div>
      <div className="mt-3">
        <Field label={t('field.description')} hint={lockNote('description') ?? t('descriptionHint', { n: description.length })}>{(f) => <Textarea id={f.id} rows={3} maxLength={750} value={description} disabled={!editable('description')} onChange={(e) => setDescription(e.target.value)} />}</Field>
      </div>
      <fieldset className="mt-4" disabled={!editable('hours')}>
        <legend className="text-sm font-bold">{t('field.hours')}{lockNote('hours') ? ` · ${lockNote('hours')}` : ''}</legend>
        <div className="mt-2 grid gap-1.5">
          {DAYS.map((day) => {
            const row = dayRow(day);
            return (
              <div key={day} className="grid grid-cols-[90px_auto_1fr_1fr] items-center gap-2 text-sm">
                <span className="font-semibold">{weekdayName(day, locale, 'long')}</span>
                <Toggle checked={!!row} onChange={(v) => setDay(day, v ? { day, opens: '09:00', closes: '17:00' } : null)} label={t('openOn', { day: weekdayName(day, locale, 'long') })} />
                {row ? <Input type="time" aria-label={t('opens')} value={row.opens} onChange={(e) => setDay(day, { ...row, opens: e.target.value })} /> : <span className="text-stone">{t('closed')}</span>}
                {row ? <Input type="time" aria-label={t('closes')} value={row.closes} onChange={(e) => setDay(day, { ...row, closes: e.target.value })} /> : <span />}
              </div>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="mt-4" disabled={!editable('specialHours')}>
        <legend className="text-sm font-bold">{t('field.specialHours')}</legend>
        <SpecialHoursEditor value={special} onChange={setSpecial} />
      </fieldset>
      {!d.canManage && Object.keys(patch()).some((f) => d.policy[f as ListingField] === 'location_approval') && (
        <div className="mt-3"><Field label={t('noteForHq')} optional>{(f) => <Input id={f.id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field></div>
      )}
      {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
      {result && (
        <Banner tone={result.pendingApproval.length ? 'info' : 'success'} live="polite" title={result.pendingApproval.length ? t('savedPending') : t('saved')}>
          {result.pendingApproval.length ? t('pendingFields', { fields: result.pendingApproval.map((f) => t(`field.${f}`)).join(', ') }) : d.autoPush ? t('savedPushed') : null}
        </Banner>
      )}
      {d.canEdit && (
        <div className="mt-3 flex gap-2">
          <Button icon="check" loading={save.pending} disabled={!Object.keys(patch()).length} onClick={async () => { const r = await save.run({ ...patch(), note: note || null }); if (r) { setResult(r); setNote(''); onSaved(); } }}>{t('save')}</Button>
        </div>
      )}
    </SectionCard>
  );
}

export function SpecialHoursEditor({ value, onChange }: { value: SpecialHour[]; onChange: (v: SpecialHour[]) => void }) {
  const t = useTranslations('lmk.listings');
  const set = (i: number, v: Partial<SpecialHour>) => onChange(value.map((x, j) => (j === i ? { ...x, ...v } : x)));
  return (
    <div className="mt-2 flex flex-col gap-2">
      {value.map((s, i) => (
        <div key={i} className="grid grid-cols-2 items-center gap-2 text-sm sm:grid-cols-[150px_auto_1fr_1fr_1fr_auto]">
          <Input type="date" aria-label={t('date')} value={s.date} onChange={(e) => set(i, { date: e.target.value })} />
          <Toggle checked={s.closed} onChange={(v) => set(i, v ? { closed: true, opens: null, closes: null } : { closed: false, opens: '10:00', closes: '16:00' })} label={t('closedAllDay')} />
          {!s.closed ? <Input type="time" aria-label={t('opens')} value={s.opens ?? ''} onChange={(e) => set(i, { opens: e.target.value })} /> : <span className="text-stone">{t('closed')}</span>}
          {!s.closed ? <Input type="time" aria-label={t('closes')} value={s.closes ?? ''} onChange={(e) => set(i, { closes: e.target.value })} /> : <span />}
          <Input aria-label={t('label')} placeholder={t('labelPlaceholder')} value={s.label ?? ''} onChange={(e) => set(i, { label: e.target.value || null })} />
          <Button size="sm" variant="ghost" icon="x" aria-label={t('remove')} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div><Button size="sm" variant="secondary" icon="plus" onClick={() => onChange([...value, { date: new Date().toISOString().slice(0, 10), closed: true, label: null }])}>{t('addDate')}</Button></div>
    </div>
  );
}

/* ------------------------------ Drift ------------------------------ */

function DriftRows({ items, canResolve, onDone }: { items: DriftVM[]; canResolve: boolean; onDone: () => void }) {
  const t = useTranslations('lmk.listings');
  const locale = useLocale();
  const value = useListingValue();
  const resolve = useMutation((_a, id: string, action: 'accept' | 'overwrite' | 'dismiss') => listingsApi.resolve(id, action));
  return (
    <ul className="flex flex-col gap-3" data-testid="drift-list">
      {items.map((x) => (
        <li key={x.id} className="rounded-lg border border-line-soft p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="warning" icon="alert">{t(`provider.${x.provider}`)}</Badge>
            <strong>{t(`field.${x.field}`)}</strong>
            {x.locationName && <span className="text-sm text-stone">· {x.locationName}</span>}
            <span className="ms-auto text-xs text-stone">{relativeTime(x.detectedAt, locale)}</span>
          </div>
          <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-[140px_1fr]">
            <dt className="text-stone">{t('ours')}</dt><dd>{value(x.field, x.ourValue)}</dd>
            <dt className="text-stone">{t('theirs', { provider: t(`provider.${x.provider}`) })}</dt><dd className="font-semibold">{value(x.field, x.theirValue)}</dd>
          </dl>
          {canResolve && x.status === 'open' && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" icon="check" loading={resolve.pending} onClick={async () => { if (await resolve.run(x.id, 'accept')) onDone(); }}>{t('accept')}</Button>
              <Button size="sm" variant="secondary" icon="undo" loading={resolve.pending} onClick={async () => { if (await resolve.run(x.id, 'overwrite')) onDone(); }}>{t('overwrite')}</Button>
              <Button size="sm" variant="ghost" onClick={async () => { if (await resolve.run(x.id, 'dismiss')) onDone(); }}>{t('dismiss')}</Button>
            </div>
          )}
        </li>
      ))}
      {resolve.error && <Banner tone="danger" live="assertive">{resolve.error.message}</Banner>}
    </ul>
  );
}

function DriftList() {
  const t = useTranslations('lmk.listings');
  const app = useApp();
  const res = useApi(() => listingsApi.drifts('open'), [app.org.id]);
  return (
    <SectionCard title={t('driftTitle')}>
      <p className="mb-3 text-sm text-stone">{t('driftIntro')}</p>
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(d) => (d.items.length ? <DriftRows items={d.items} canResolve={d.canResolve} onDone={() => res.reload()} /> : <Empty icon="check-circle" title={t('noDrift')} />)}
      </Async>
    </SectionCard>
  );
}

/* ------------------------------ Changes ------------------------------ */

function Changes() {
  const t = useTranslations('lmk.listings');
  const app = useApp();
  const value = useListingValue();
  const res = useApi(() => listingsApi.changes('pending'), [app.org.id]);
  const decide = useMutation((_a, id: string, decision: 'approve' | 'reject') => listingsApi.decide(id, decision));
  return (
    <SectionCard title={t('changesTitle')}>
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(d) => (d.items.length ? (
          <ul className="flex flex-col gap-3">
            {d.items.map((c) => (
              <li key={c.id} className="rounded-lg border border-line-soft p-3">
                <div className="font-semibold">{c.locationName}</div>
                <dl className="mt-1 grid gap-1 text-sm sm:grid-cols-[140px_1fr]">
                  {c.fields.map((f) => [<dt key={`${f}t`} className="text-stone">{t(`field.${f}`)}</dt>, <dd key={`${f}d`}>{value(f, (c.changes as Record<string, unknown>)[f])}</dd>])}
                </dl>
                {c.note && <p className="mt-1 text-sm italic">{c.note}</p>}
                {d.canDecide && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" icon="check" loading={decide.pending} onClick={async () => { if (await decide.run(c.id, 'approve')) res.reload(); }}>{t('approve')}</Button>
                    <Button size="sm" variant="secondary" icon="x" onClick={async () => { if (await decide.run(c.id, 'reject')) res.reload(); }}>{t('reject')}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : <Empty icon="check-circle" title={t('noChanges')} />)}
      </Async>
      {decide.error && <Banner tone="danger" live="assertive">{decide.error.message}</Banner>}
    </SectionCard>
  );
}

/* ------------------------------ Holiday hours ------------------------------ */

function Holidays() {
  const t = useTranslations('lmk.listings');
  const app = useApp();
  const locale = useLocale();
  const sets = useApi(() => listingsApi.holidaySets(), [app.org.id]);
  const [name, setName] = useState('');
  const [entries, setEntries] = useState<SpecialHour[]>([{ date: `${new Date().getFullYear()}-12-25`, closed: true, label: null }]);
  const [picked, setPicked] = useState<string[]>(() => app.locations.map((l) => l.id));
  const [overwrite, setOverwrite] = useState(false);
  const apply = useMutation((_a, b: Parameters<typeof listingsApi.applyHolidays>[0]) => listingsApi.applyHolidays(b));
  const [done, setDone] = useState<{ applied: number; skipped: number; pushed: number } | null>(null);
  const names = useMemo(() => new Map(app.locations.map((l) => [l.id, l.name])), [app.locations]);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <SectionCard title={t('holidays.title')}>
        <p className="mb-3 text-sm text-stone">{t('holidays.intro')}</p>
        <Field label={t('holidays.name')}>{(f) => <Input id={f.id} value={name} placeholder={t('holidays.namePlaceholder')} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="mt-3"><SpecialHoursEditor value={entries} onChange={setEntries} /></div>
        <fieldset className="mt-4">
          <legend className="text-sm font-bold">{t('holidays.locations', { n: picked.length })}</legend>
          <div className="mt-1 flex gap-2"><Button size="sm" variant="ghost" onClick={() => setPicked(app.locations.map((l) => l.id))}>{t('holidays.all')}</Button><Button size="sm" variant="ghost" onClick={() => setPicked([])}>{t('holidays.none')}</Button></div>
          <div className="mt-2 grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
            {app.locations.map((l) => (
              <label key={l.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.id] : p.filter((x) => x !== l.id)))} />{l.name}</label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3"><LabeledToggle checked={overwrite} onChange={setOverwrite} label={t('holidays.overwrite')} /></div>
        {apply.error && <Banner tone="danger" live="assertive">{apply.error.message}</Banner>}
        {done && <Banner tone="success" live="polite" title={t('holidays.done', { applied: done.applied })}>{done.skipped ? t('holidays.skipped', { n: done.skipped }) : t('holidays.pushed', { n: done.pushed })}</Banner>}
        <div className="mt-3"><Button icon="calendar" loading={apply.pending} disabled={!name.trim() || !entries.length || !picked.length} onClick={async () => { const r = await apply.run({ name: name.trim(), entries, locationIds: picked, overwrite }); if (r) { setDone({ applied: r.applied.length, skipped: r.skipped.length, pushed: r.pushed }); sets.reload(); } }}>{t('holidays.apply')}</Button></div>
      </SectionCard>
      <SectionCard title={t('holidays.history')}>
        <Async res={sets} loading={<LoadingBlock variant="table" rows={3} />}>
          {(d) => (d.items.length ? (
            <ul className="flex flex-col gap-3 text-sm">
              {d.items.map((s) => (
                <li key={s.id} className="rounded-lg border border-line-soft p-3">
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-stone">{s.entries.map((e) => `${fmtYmd(e.date, locale, { day: 'numeric', month: 'short', year: 'numeric' })} · ${e.closed ? t('closed') : `${e.opens}–${e.closes}`}`).join(' / ')}</div>
                  <div className="mt-1 text-xs">{t('holidays.appliedTo', { n: s.locationIds.length })}{s.skippedLocationIds.length ? ` · ${t('holidays.keptOwn', { names: s.skippedLocationIds.map((x) => names.get(x) ?? '').join(', ') })}` : ''}</div>
                </li>
              ))}
            </ul>
          ) : <Empty icon="calendar" title={t('holidays.noneYet')} />)}
        </Async>
      </SectionCard>
    </div>
  );
}

/* ------------------------------ Connections ------------------------------ */

function Connections() {
  const t = useTranslations('lmk.listings');
  const app = useApp();
  const res = useApi(() => listingsApi.connections(), [app.org.id]);
  const connect = useMutation((_a, p: 'apple' | 'bing') => listingsApi.connect(p).then((c) => listingsApi.linkAll(c.id)));
  return (
    <Async res={res} loading={<LoadingBlock variant="cards" rows={3} />}>
      {(d) => (
        <div className="grid gap-3 md:grid-cols-3">
          <SectionCard title={t('provider.google')}>
            <p className="text-sm">{d.google.connections.length ? t('googleLinked', { n: d.google.linkedLocations }) : t('googleNone')}</p>
            <p className="mt-2 text-xs text-stone">{t('googleNote')}</p>
            <a className="mt-3 inline-flex items-center gap-1 text-sm font-semibold underline" href="/marketing/reviews?tab=connections">{t('googleManage')}<Icon name="arrow-right" size={14} /></a>
          </SectionCard>
          {(['apple', 'bing'] as const).map((p) => {
            const c = d.items.find((x) => x.provider === p);
            return (
              <SectionCard key={p} title={t(`provider.${p}`)}>
                {c ? <p className="text-sm"><Badge tone={c.mode === 'live' ? 'success' : 'neutral'}>{c.mode === 'live' ? t('live') : t('sandbox')}</Badge> {t('linkedCount', { n: c.linkedLocations })}</p> : <p className="text-sm">{t('notConnected')}</p>}
                <p className="mt-2 text-xs text-stone">{d.configured[p] ? t('platformReady') : t('platformPending')}</p>
                {!c && <Button className="mt-3" size="sm" variant="secondary" icon="plug" loading={connect.pending} onClick={async () => { if (await connect.run(p)) res.reload(); }}>{t('connectSandbox')}</Button>}
              </SectionCard>
            );
          })}
          {connect.error && <Banner tone="danger" live="assertive">{connect.error.message}</Banner>}
        </div>
      )}
    </Async>
  );
}

/* ------------------------------ Field policy ------------------------------ */

function PolicySettings() {
  const t = useTranslations('lmk.listings');
  const res = useApi(() => settingsApi.get(), []);
  const save = useMutation((_a, b: { listingPolicy?: Record<string, ListingFieldPolicy>; autoPush?: boolean }) => settingsApi.save(b as never));
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {(d) => (
        <SectionCard title={t('policy.title')}>
          <p className="mb-3 text-sm text-stone">{t('policy.intro')}</p>
          <div className="grid gap-2">
            {LISTING_FIELDS.map((f) => (
              <div key={f} className="grid grid-cols-[1fr_minmax(0,220px)] items-center gap-2 text-sm">
                <span className="font-semibold">{t(`field.${f}`)}</span>
                <Select aria-label={t(`field.${f}`)} value={d.settings.listingPolicy[f]} disabled={!d.canEdit.listings || save.pending} onChange={async (e) => { if (await save.run({ listingPolicy: { ...d.settings.listingPolicy, [f]: e.target.value as ListingFieldPolicy } })) res.reload(); }}>
                  {LISTING_FIELD_POLICIES.map((p) => <option key={p} value={p}>{t(`policy.${p}`)}</option>)}
                </Select>
              </div>
            ))}
          </div>
          <div className="mt-4"><LabeledToggle checked={d.settings.autoPush} onChange={async (v) => { if (await save.run({ autoPush: v })) res.reload(); }} label={t('policy.autoPush')} /></div>
          {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
        </SectionCard>
      )}
    </Async>
  );
}
