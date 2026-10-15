'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Input, Select, Tabs, Textarea, type Tone } from '@bh/ui';
import { AD_PLATFORMS, splitBudget } from '@bh/shared';
import { fmtYmd } from '@/lib/format';
import { API_URL } from '@/lib/http/client';
import { useApi, useMutation } from '@/lib/useApi';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { campaignsApi, type AdCampaign } from './api';
import { Chip, toMinor, useCan, useMoney } from './shared';

const STATUS_TONE: Record<string, Tone> = { draft: 'neutral', pending_approval: 'warning', scheduled: 'info', active: 'success', paused: 'warning', completed: 'neutral', rejected: 'danger', archived: 'neutral' };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Paid campaigns: network campaigns HQ runs for all or some locations (budget split per currency), coming-soon
 * campaigns for locations in onboarding with a lead form, course campaigns and a location's own local campaigns
 * (budget approval in the approvals inbox). Results are entered by hand; leads are attributed to campaign and location.
 */
export function CampaignsScreen() {
  const t = useTranslations('comms.campaigns');
  const app = useApp();
  const can = useCan();
  const allowed = can('marketing.ads') || can('marketing.network_campaigns');
  const [kind, setKind] = useState<'all' | AdCampaign['kind']>('all');
  const [creating, setCreating] = useState<null | 'network' | 'coming_soon' | 'course' | 'local'>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useApi(() => campaignsApi.list(), [app.org.id], allowed);
  if (!allowed) return <DeniedState detail={t('denied')} />;
  return (
    <>
      <PageHeader
        icon="target"
        title={t('title')}
        description={t('description')}
        actions={
          <div className="flex flex-wrap gap-2">
            {list.data?.canCreateNetwork && <Button icon="plus" onClick={() => setCreating('network')}>{t('new.network')}</Button>}
            {list.data?.canCreateNetwork && <Button variant="secondary" icon="flag" onClick={() => setCreating('coming_soon')}>{t('new.coming_soon')}</Button>}
            {can('marketing.ads', 'edit') && <Button variant="secondary" icon="megaphone" onClick={() => setCreating('local')}>{t('new.local')}</Button>}
          </div>
        }
      />
      <div role="group" aria-label={t('filter')} className="flex flex-wrap gap-1.5">
        {(['all', 'network', 'coming_soon', 'course', 'local'] as const).map((k) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{t(`kind.${k}`)}</Chip>)}
      </div>
      <Async res={list} loading={<LoadingBlock variant="cards" rows={3} />}>
        {(d) => {
          const items = d.items.filter((c) => kind === 'all' || c.kind === kind);
          if (!items.length) return <Empty icon="target" title={t('empty')} body={t('emptyBody')} />;
          return <div className="grid gap-3 lg:grid-cols-2" data-testid="campaign-list">{items.map((c) => <CampaignCard key={c.id} c={c} onOpen={() => setOpen(c.id)} />)}</div>;
        }}
      </Async>
      {creating && creating !== 'local' && <CreateDrawer kind={creating} onClose={() => setCreating(null)} onCreated={(id) => { setCreating(null); list.reload(); setOpen(id); }} />}
      {creating === 'local' && <LocalDrawer onClose={() => setCreating(null)} onCreated={() => { setCreating(null); list.reload(); }} />}
      {open && <DetailDrawer id={open} onClose={() => setOpen(null)} onChanged={() => list.reload()} />}
    </>
  );
}

function CampaignCard({ c, onOpen }: { c: AdCampaign; onOpen: () => void }) {
  const t = useTranslations('comms.campaigns');
  const locale = useLocale();
  const money = useMoney();
  return (
    <article className="flex flex-col gap-2.5 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral" icon={null}>{t(`kind.${c.kind}`)}</Badge>
        <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{t(`status.${c.status}`)}</Badge>
        {c.startsOn && <span className="ml-auto text-xs text-stone">{fmtYmd(c.startsOn, locale)}{c.endsOn ? ` – ${fmtYmd(c.endsOn, locale)}` : ''}</span>}
      </div>
      <h2 className="text-base font-bold">{c.name}</h2>
      {c.comingSoon && <p className="text-[13px] text-stone">{t('openingOn', { date: fmtYmd(c.comingSoon.openingDate, locale) })} · {c.comingSoon.presaleOffer}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        {c.totals.map((x) => (
          <div key={x.currency} className="contents">
            <dt className="text-stone">{x.currency}</dt>
            <dd className="tabular font-semibold">{t('totals', { budget: money(x.budget, x.currency), spend: money(x.spend, x.currency), leads: x.leads })}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-stone">{t('locationsCount', { count: c.locations.length })}</p>
      <div><Button size="sm" variant="secondary" onClick={onOpen}>{t('open')}</Button></div>
    </article>
  );
}

function CreateDrawer({ kind, onClose, onCreated }: { kind: 'network' | 'coming_soon' | 'course'; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations('comms.campaigns');
  const app = useApp();
  const money = useMoney();
  const onboarding = useApi(() => campaignsApi.comingSoonLocations(), [], kind === 'coming_soon');
  const options = kind === 'coming_soon' ? (onboarding.data?.items ?? []).map((l) => ({ id: l.id, name: l.name, currency: l.currency as string })) : app.locations.map((l) => ({ id: l.id, name: l.name, currency: l.currency as string }));
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [platforms, setPlatforms] = useState<string[]>(['meta']);
  const [startsOn, setStartsOn] = useState(today());
  const [endsOn, setEndsOn] = useState('');
  const [headline, setHeadline] = useState('');
  const [copy, setCopy] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [radius, setRadius] = useState('8');
  const [totals, setTotals] = useState<Record<string, string>>({});
  const [openingDate, setOpeningDate] = useState('');
  const [offer, setOffer] = useState('');
  const picked = options.filter((l) => chosen.includes(l.id));
  const currencies = [...new Set(picked.map((l) => l.currency))].sort();
  const minorTotals = Object.fromEntries(currencies.map((c) => [c, toMinor(totals[c] ?? '', c)]));
  const preview = useMemo(() => splitBudget(picked, Object.fromEntries(Object.entries(minorTotals).filter(([, v]) => v !== null)) as Record<string, number>), [picked, minorTotals]);
  const create = useMutation(() => campaignsApi.create({
    kind, name, platforms, startsOn, endsOn: endsOn || undefined, locationIds: chosen, radiusKm: Number(radius) || 8,
    creative: { headline, body: copy, imageUrl: imageUrl.trim() || null }, budget: { mode: 'split', totals: minorTotals },
    ...(kind === 'coming_soon' ? { comingSoon: { openingDate, presaleOffer: offer, formFields: ['name', 'email', 'phone'] } } : {}),
  }));
  const ready = name.trim() && chosen.length && platforms.length && headline.trim() && copy.trim() && currencies.every((c) => minorTotals[c] !== null) && (kind !== 'coming_soon' || (openingDate && offer.trim()));
  return (
    <Drawer open onClose={onClose} title={t(`new.${kind}`)} kicker={t('new.kicker')}
      footer={<Button loading={create.pending} disabled={!ready} onClick={async () => { const r = await create.run(); if (r) onCreated(r.id); }}>{t('new.create')}</Button>}>
      <div className="flex flex-col gap-4" data-testid="campaign-create">
        <Field label={t('field.name')}>{(f) => <Input id={f.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        {kind === 'coming_soon' && options.length === 0 && onboarding.status === 'ready' && <Banner tone="info">{t('new.noOnboarding')}</Banner>}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-bold">{kind === 'coming_soon' ? t('field.onboardingLocations') : t('field.locations')}</legend>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={chosen.length === options.length && options.length > 0} onChange={(e) => setChosen(e.target.checked ? options.map((l) => l.id) : [])} />{t('field.allLocations')}</label>
          {options.map((l) => (
            <label key={l.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={chosen.includes(l.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, l.id] : chosen.filter((x) => x !== l.id))} />
              {l.name} <span className="text-xs text-stone">{l.currency}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="mb-1 w-full text-[13px] font-bold">{t('field.platforms')}</legend>
          {AD_PLATFORMS.map((p) => <Chip key={p} active={platforms.includes(p)} onClick={() => setPlatforms(platforms.includes(p) ? platforms.filter((x) => x !== p) : [...platforms, p])}>{t(`platform.${p}`)}</Chip>)}
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('field.startsOn')}>{(f) => <Input id={f.id} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}</Field>
          <Field label={t('field.endsOn')} optional>{(f) => <Input id={f.id} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}</Field>
        </div>
        {currencies.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-[13px] font-bold">{t('field.budget')}</legend>
            <p className="text-xs text-stone">{t('field.budgetHint')}</p>
            {currencies.map((c) => (
              <Field key={c} label={t('field.budgetIn', { currency: c })}>{(f) => <Input id={f.id} inputMode="decimal" value={totals[c] ?? ''} onChange={(e) => setTotals({ ...totals, [c]: e.target.value })} />}</Field>
            ))}
            {preview.size > 0 && (
              <ul className="rounded-md bg-canvas px-3 py-2 text-[13px]" aria-label={t('field.split')}>
                {picked.filter((l) => preview.has(l.id)).map((l) => <li key={l.id} className="flex justify-between"><span>{l.name}</span><span className="tabular font-semibold">{money(preview.get(l.id)!.budgetMinor, l.currency)}</span></li>)}
              </ul>
            )}
          </fieldset>
        )}
        <Field label={t('field.radius')} hint={t('field.radiusHint')}>{(f) => <Input id={f.id} inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />}</Field>
        <Field label={t('field.headline')}>{(f) => <Input id={f.id} value={headline} onChange={(e) => setHeadline(e.target.value)} />}</Field>
        <Field label={t('field.copy')}>{(f) => <Textarea id={f.id} rows={3} value={copy} onChange={(e) => setCopy(e.target.value)} />}</Field>
        <Field label={t('field.image')} optional hint={t('field.imageHint')}>{(f) => <Input id={f.id} type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />}</Field>
        {kind === 'coming_soon' && (
          <>
            <Field label={t('field.openingDate')}>{(f) => <Input id={f.id} type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} />}</Field>
            <Field label={t('field.presale')}>{(f) => <Input id={f.id} value={offer} onChange={(e) => setOffer(e.target.value)} />}</Field>
          </>
        )}
        {create.error && <Banner tone="danger" live="assertive">{create.error.message}</Banner>}
      </div>
    </Drawer>
  );
}

function LocalDrawer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const t = useTranslations('comms.campaigns');
  const app = useApp();
  const choices = app.scope.kind === 'all' ? app.locations : app.locations.filter((l) => app.scope.locationIds.includes(l.id));
  const [loc, setLoc] = useState(choices[0]?.id ?? '');
  const location = app.locations.find((l) => l.id === loc);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('14');
  const [startsOn, setStartsOn] = useState(today());
  const [headline, setHeadline] = useState('');
  const [copy, setCopy] = useState('');
  const minor = location ? toMinor(amount, location.currency) : null;
  const create = useMutation(() => campaignsApi.createLocal({ locationId: loc, name, platforms: ['meta'], budgetMinor: minor, currency: location!.currency, startsOn, durationDays: Number(days) || 14, creative: { headline, body: copy } }));
  return (
    <Drawer open onClose={onClose} title={t('new.local')} kicker={t('new.kicker')}
      footer={<Button loading={create.pending} disabled={!location || !name.trim() || !minor || !headline.trim() || !copy.trim()} onClick={async () => { if (await create.run()) onCreated(); }}>{t('new.requestBudget')}</Button>}>
      <div className="flex flex-col gap-4">
        <Banner tone="info">{t('new.localNote')}</Banner>
        <Field label={t('field.location')}>{(f) => <Select id={f.id} value={loc} onChange={(e) => setLoc(e.target.value)}>{choices.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>
        <Field label={t('field.name')}>{(f) => <Input id={f.id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('field.budgetIn', { currency: location?.currency ?? '' })}>{(f) => <Input id={f.id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label={t('field.days')}>{(f) => <Input id={f.id} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />}</Field>
        </div>
        <Field label={t('field.startsOn')}>{(f) => <Input id={f.id} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />}</Field>
        <Field label={t('field.headline')}>{(f) => <Input id={f.id} value={headline} onChange={(e) => setHeadline(e.target.value)} />}</Field>
        <Field label={t('field.copy')}>{(f) => <Textarea id={f.id} rows={3} value={copy} onChange={(e) => setCopy(e.target.value)} />}</Field>
        {create.error && <Banner tone="danger" live="assertive">{create.error.message}</Banner>}
      </div>
    </Drawer>
  );
}

function DetailDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const t = useTranslations('comms.campaigns');
  const can = useCan();
  const money = useMoney();
  const res = useApi(() => campaignsApi.get(id), [id]);
  const status = useMutation((_api, s: string) => campaignsApi.setStatus(id, s));
  const [tab, setTab] = useState<'locations' | 'results'>('locations');
  return (
    <Drawer open onClose={onClose} title={res.data?.name ?? t('detail.title')} kicker={res.data ? t(`kind.${res.data.kind}`) : undefined}>
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(c) => (
          <div className="flex flex-col gap-4" data-testid="campaign-detail">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{t(`status.${c.status}`)}</Badge>
              {c.platforms.map((p) => <Badge key={p} tone="neutral" icon={null}>{t(`platform.${p}`)}</Badge>)}
            </div>
            <div className="rounded-lg bg-canvas p-3 text-sm">
              <p className="font-bold">{c.creative.headline}</p>
              <p>{c.creative.body}</p>
              {c.comingSoon && <p className="mt-1 text-[13px]">{c.comingSoon.presaleOffer}</p>}
            </div>
            {c.leadFormPath && <p className="break-all text-xs text-stone">{t('detail.leadForm')} <span className="font-mono">{`${API_URL}${c.leadFormPath}`}</span></p>}
            {c.status === 'pending_approval' && <Banner tone="warning">{t('detail.awaitingApproval')}</Banner>}
            {(can('marketing.network_campaigns', 'publish') || can('marketing.ads', 'publish')) && !['pending_approval', 'rejected', 'archived', 'completed'].includes(c.status) && (
              <div className="flex flex-wrap gap-2">
                {c.status !== 'active' && <Button size="sm" icon="play" loading={status.pending} onClick={async () => { if (await status.run('active')) { res.reload(); onChanged(); } }}>{t('detail.launch')}</Button>}
                {c.status === 'active' && <Button size="sm" variant="secondary" loading={status.pending} onClick={async () => { if (await status.run('paused')) { res.reload(); onChanged(); } }}>{t('detail.pause')}</Button>}
                <Button size="sm" variant="ghost" loading={status.pending} onClick={async () => { if (await status.run('completed')) { res.reload(); onChanged(); } }}>{t('detail.complete')}</Button>
              </div>
            )}
            {status.error && <Banner tone="danger">{status.error.message}</Banner>}
            <Tabs items={[{ key: 'locations', label: t('detail.byLocation') }, { key: 'results', label: t('detail.enterResults') }]} value={tab} onChange={setTab} />
            {tab === 'locations' && (
              <ul className="flex flex-col gap-2">
                {c.locations.map((l) => (
                  <li key={l.locationId} className="rounded-lg border border-line-soft p-3 text-[13px]">
                    <div className="flex items-center justify-between font-bold"><span>{l.name}</span><span className="tabular">{money(l.budget.amount, l.budget.currency)}</span></div>
                    <div className="text-stone">{t('detail.row', { spend: money(l.spend.amount, l.spend.currency), clicks: l.clicks, leads: l.leads, radius: l.radiusKm })}</div>
                    {l.costPerLead && <div className="text-stone">{t('detail.cpl', { cpl: money(l.costPerLead.amount, l.costPerLead.currency) })}</div>}
                  </li>
                ))}
              </ul>
            )}
            {tab === 'results' && <ResultsForm c={c} onSaved={() => { res.reload(); onChanged(); }} />}
          </div>
        )}
      </Async>
    </Drawer>
  );
}

function ResultsForm({ c, onSaved }: { c: AdCampaign; onSaved: () => void }) {
  const t = useTranslations('comms.campaigns');
  const [loc, setLoc] = useState(c.locations[0]?.locationId ?? '');
  const row = c.locations.find((l) => l.locationId === loc);
  const [day, setDay] = useState(today());
  const [spend, setSpend] = useState('');
  const [clicks, setClicks] = useState('0');
  const [impressions, setImpressions] = useState('0');
  const [saved, setSaved] = useState(false);
  const save = useMutation(() => campaignsApi.results(c.id, { locationId: loc, day, spendMinor: toMinor(spend, row!.budget.currency) ?? 0, currency: row!.budget.currency, clicks: Number(clicks) || 0, impressions: Number(impressions) || 0 }));
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-stone">{t('results.hint')}</p>
      <Field label={t('field.location')}>{(f) => <Select id={f.id} value={loc} onChange={(e) => setLoc(e.target.value)}>{c.locations.map((l) => <option key={l.locationId} value={l.locationId}>{l.name}</option>)}</Select>}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('results.day')}>{(f) => <Input id={f.id} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
        <Field label={t('results.spend', { currency: row?.budget.currency ?? '' })}>{(f) => <Input id={f.id} inputMode="decimal" value={spend} onChange={(e) => setSpend(e.target.value)} />}</Field>
        <Field label={t('results.impressions')}>{(f) => <Input id={f.id} inputMode="numeric" value={impressions} onChange={(e) => setImpressions(e.target.value)} />}</Field>
        <Field label={t('results.clicks')}>{(f) => <Input id={f.id} inputMode="numeric" value={clicks} onChange={(e) => setClicks(e.target.value)} />}</Field>
      </div>
      {save.error && <Banner tone="danger">{save.error.message}</Banner>}
      {saved && <Banner tone="success" live="polite">{t('results.saved')}</Banner>}
      <div><Button disabled={!row || !spend} loading={save.pending} onClick={async () => { if (await save.run()) { setSaved(true); onSaved(); } }}>{t('results.save')}</Button></div>
    </div>
  );
}
