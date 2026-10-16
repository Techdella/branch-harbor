'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Field, Icon, Input, Select, Tabs, Textarea, Toggle } from '@bh/ui';
import { allowedListingTransitions, PROPERTY_TYPES, toMajor, type Currency, type ListingStatus as LS } from '@bh/shared';
import { useRealty, useRealtyMutation } from '@/lib/realty/api';
import type { AreaUnit, ListingDetail, ListingInput, Office, RealtyListing } from '@/lib/realty/types';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty } from '../../ui/States';

/** Real portal feeds and the countries they serve (BranchHarbor API: integrations/realty-portals.ts). */
const PORTALS_BY_COUNTRY: Array<[string, string[]]> = [['rightmove', ['GB']], ['idealista', ['ES', 'PT', 'IT']], ['reso_xml', ['US', 'CA']], ['reaxml', ['AU', 'NZ']]];
import { ApprovalBadge, ListingStatusBadge, Price, RAsync, useRealtyCtx } from './common';

const BOARD: LS[] = ['draft', 'coming_soon', 'active', 'under_offer', 'sold', 'let', 'withdrawn'];

export function ListingsScreen() {
  const t = useTranslations('realty');
  const tOps = useTranslations('ops.realty.listings');
  const ctx = useRealtyCtx();
  const app = useApp();
  const [tab, setTab] = useState<'board' | 'approval' | 'mine'>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const res = useRealty((api) => api.listings(ctx, tab === 'approval' ? { approval: 'pending' } : tab === 'mine' ? { mine: true } : {}), [ctx, tab]);
  const offices = useRealty((api) => api.offices(ctx), [ctx]);
  const canCreate = app.can('operations.write');

  return (
    <>
      <PageHeader icon="house" title={tOps('title')} description={tOps('description')} actions={canCreate ? <Button icon="plus" onClick={() => setCreating(true)}>{t('listings.new')}</Button> : undefined} />
      <Tabs
        items={[{ key: 'board', label: t('listings.board') }, { key: 'approval', label: t('listings.awaitingApproval'), count: res.status === 'ready' && tab === 'approval' ? res.data.length : undefined }, ...(app.role === 'staff' ? [{ key: 'mine' as const, label: t('listings.mine') }] : [])]}
        value={tab}
        onChange={setTab}
      />
      <RAsync res={res} variant="cards" isEmpty={(d) => d.length === 0} empty={<Empty icon="house" title={t('listings.emptyTitle')} body={tab === 'approval' ? t('listings.emptyApproval') : t('listings.emptyBody')} />}>
        {(rows) => (
          <div className="flex gap-3 overflow-x-auto pb-2" role="group" aria-label={t('listings.board')}>
            {BOARD.filter((s) => tab !== 'board' || rows.some((r) => r.status === s) || ['draft', 'active', 'under_offer'].includes(s)).map((s) => {
              const col = rows.filter((r) => r.status === s);
              return (
                <section key={s} className="flex w-[280px] shrink-0 flex-col gap-2 rounded-xl bg-surface p-3" aria-label={t(`status.${s}` as 'status.draft')}>
                  <header className="flex items-center justify-between px-1">
                    <ListingStatusBadge status={s} />
                    <span className="text-xs font-bold text-stone">{col.length}</span>
                  </header>
                  {col.length === 0 && <p className="px-1 py-3 text-xs text-mute">{t('listings.columnEmpty')}</p>}
                  {col.map((l) => <ListingCard key={l.id} l={l} onOpen={() => setOpenId(l.id)} />)}
                </section>
              );
            })}
          </div>
        )}
      </RAsync>
      {openId && <ListingDrawer id={openId} onClose={() => { setOpenId(null); res.reload(); }} />}
      {creating && <NewListingDrawer offices={offices.status === 'ready' ? offices.data : []} onClose={(id) => { setCreating(false); res.reload(); if (id) setOpenId(id); }} />}
    </>
  );
}

function ListingCard({ l, onOpen }: { l: RealtyListing; onOpen: () => void }) {
  const t = useTranslations('realty');
  const locale = useLocale();
  const app = useApp();
  const office = app.locations.find((x) => x.id === l.locationId);
  return (
    <button type="button" onClick={onOpen} className="flex flex-col gap-2 rounded-lg bg-canvas p-2.5 text-start hover:ring-2 hover:ring-ink/10 focus-visible:ring-2">
      {l.photos[0] ? <img src={l.photos[0].url} alt="" className="h-28 w-full rounded-md object-cover" loading="lazy" /> : <div className="flex h-28 items-center justify-center rounded-md bg-surface text-xs text-mute">{t('listings.noPhoto')}</div>}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-bold text-stone">{l.reference}</span>
        <ApprovalBadge status={l.approval.status} />
        {l.fairHousingWarnings.length > 0 && <Badge tone="warning" icon="alert">{t('fairHousing.flag')}</Badge>}
      </div>
      <strong className="line-clamp-2 text-sm leading-snug">{l.title}</strong>
      <div className="text-sm"><Price value={l.price} rentPeriod={l.rentPeriod} /></div>
      <div className="flex flex-wrap gap-x-2.5 text-xs text-stone">
        <span>{l.bedrooms ?? '–'} {t('facts.bedShort')}</span>
        <span>{l.bathrooms ?? '–'} {t('facts.bathShort')}</span>
        <span>{l.area ? `${l.area.value.toLocaleString(locale)} ${l.area.label}` : t('unavailable')}</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-stone">
        <span>{office?.name ?? l.address.city}</span>
        {l.daysOnMarket != null && <span>{t('listings.dom', { count: l.daysOnMarket })}</span>}
      </div>
      {l.counts && (
        <div className="flex gap-2 text-[11px] text-graphite">
          <span className="inline-flex items-center gap-1" title={t('listings.countEnquiries')}><Icon name="mail" size={12} />{l.counts.enquiries}</span>
          <span className="inline-flex items-center gap-1" title={t('listings.countViewings')}><Icon name="key" size={12} />{l.counts.upcomingViewings}</span>
          <span className="inline-flex items-center gap-1" title={l.counts.openOffers == null ? t('offers.restricted') : t('listings.countOffers')}><Icon name={l.counts.openOffers == null ? 'lock' : 'receipt'} size={12} />{l.counts.openOffers ?? '—'}</span>
        </div>
      )}
    </button>
  );
}

function ListingDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('realty');
  const tp = useTranslations('partners');
  const locale = useLocale();
  const ctx = useRealtyCtx();
  const res = useRealty((api) => api.listing(ctx, id), [ctx, id]);
  const [tab, setTab] = useState<'details' | 'edit' | 'activity'>('details');
  const status = useRealtyMutation((api, to: string, note?: string) => api.setStatus(ctx, id, to, { note }));
  const approval = useRealtyMutation((api, d: 'approve' | 'reject', c?: string) => api.decideApproval(ctx, id, d, c));
  const synd = useRealtyMutation((api, portal: string, on: boolean) => api.setSyndication(ctx, id, portal, on));
  const ai = useRealtyMutation((api, instr?: string) => api.aiDescription(ctx, id, instr));
  const aiApply = useRealtyMutation((api, pid: string) => api.aiDecision(ctx, pid, 'apply'));
  const [comment, setComment] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ id: string; headline?: string; description?: string; refusals: string[] } | null>(null);
  const [instr, setInstr] = useState('');
  const l = res.status === 'ready' || res.data ? res.data : undefined;

  return (
    <Drawer open onClose={onClose} title={l?.title ?? t('listings.loading')} kicker={l ? `${l.reference} · ${l.office.name}` : undefined}>
      <RAsync res={res} variant="detail">
        {(l: ListingDetail) => (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <ListingStatusBadge status={l.status} />
              <ApprovalBadge status={l.approval.status} />
              <Badge tone="neutral" icon="shield">{t(`tier.${l.office.tier}` as 'tier.standard')}</Badge>
            </div>
            {notice && <Banner tone="success" live="polite">{notice}</Banner>}
            {l.approval.status === 'pending' && (
              <Banner tone="warning" icon="shield" title={l.approval.requestedStatus ? t('approval.publishRequest', { status: t(`status.${l.approval.requestedStatus}` as 'status.active') }) : t('approval.changeRequest')}>
                {l.approval.pendingChanges && <span>{t('approval.fields', { fields: Object.keys(l.approval.pendingChanges).join(', ') })} </span>}
                {t('approval.liveUnchanged')}
              </Banner>
            )}
            {l.approval.status === 'rejected' && l.approval.comment && <Banner tone="danger" title={t('approval.rejectedTitle')}>{l.approval.comment}</Banner>}
            {l.permissions?.canApprove && l.approval.status === 'pending' && (
              <section className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                <strong className="text-sm">{t('approval.hqCheck')}</strong>
                {l.permissions.isRequester ? <p className="text-xs text-stone">{t('approval.ownRequest')}</p> : (
                  <>
                    <Field label={t('approval.comment')} optional>{(p) => <Textarea {...p} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
                    <div className="flex gap-2">
                      <Button size="sm" icon="check" loading={approval.pending} onClick={async () => { const r = await approval.run('approve', comment || undefined); if (r) { res.setData(r); setNotice(t('approval.approved')); } }}>{t('approval.approve')}</Button>
                      <Button size="sm" variant="secondary" icon="x" loading={approval.pending} onClick={async () => { const r = await approval.run('reject', comment); if (r) { res.setData(r); setNotice(t('approval.rejected')); } }}>{t('approval.reject')}</Button>
                    </div>
                    {approval.error && <Banner tone="danger" live="assertive">{approval.error.message}</Banner>}
                  </>
                )}
              </section>
            )}
            <Tabs items={[{ key: 'details', label: t('listings.details') }, ...(l.permissions?.canEdit ? [{ key: 'edit' as const, label: t('listings.edit') }] : []), { key: 'activity', label: t('listings.activity') }]} value={tab} onChange={setTab} />
            {tab === 'details' && (
              <div className="flex flex-col gap-3 text-sm">
                {l.photos.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto">{l.photos.map((p, i) => <img key={i} src={p.url} alt={p.alt ?? ''} className="h-28 w-40 shrink-0 rounded-md object-cover" />)}</div>
                )}
                <div className="text-lg"><Price value={l.price} rentPeriod={l.rentPeriod} /></div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <dt className="text-stone">{t('facts.type')}</dt><dd>{t(`type.${l.propertyType}` as 'type.house')} · {t(`transaction.${l.transaction}` as 'transaction.sale')}</dd>
                  <dt className="text-stone">{t('facts.bedrooms')}</dt><dd>{l.bedrooms ?? t('unavailable')}</dd>
                  <dt className="text-stone">{t('facts.bathrooms')}</dt><dd>{l.bathrooms ?? t('unavailable')}</dd>
                  <dt className="text-stone">{t('facts.area')}</dt><dd>{l.area ? `${l.area.value.toLocaleString(locale)} ${l.area.label}` : t('unavailable')}</dd>
                  <dt className="text-stone">{t('facts.address')}</dt><dd>{l.addressLines.join(', ')}</dd>
                  <dt className="text-stone">{t('facts.agents')}</dt><dd>{l.agents.map((a) => `${a.name}${a.role === 'lead' ? ` (${t('facts.lead')})` : ''}`).join(', ') || t('facts.noAgent')}</dd>
                  <dt className="text-stone">{t('facts.dom')}</dt><dd>{l.daysOnMarket ?? t('unavailable')}</dd>
                  {l.vendor && <><dt className="text-stone">{t('facts.vendor')}</dt><dd>{l.vendor.restricted ? <Badge tone="neutral" icon="lock">{t('facts.restricted')}</Badge> : `${l.vendor.name}${l.vendor.email ? ` · ${l.vendor.email}` : ''}`}</dd></>}
                </dl>
                {l.description && <p className="whitespace-pre-line text-graphite">{l.description}</p>}
                {l.features.length > 0 && <div className="flex flex-wrap gap-1.5">{l.features.map((f) => <Badge key={f}>{f}</Badge>)}</div>}
                {l.fairHousingWarnings.length > 0 && <Banner tone="warning" icon="alert" title={t('fairHousing.title')}>{t('fairHousing.body', { phrases: l.fairHousingWarnings.map((f) => `“${f.phrase}”`).join(', ') })}</Banner>}
                {[...l.office.disclosures, ...l.disclosures].length > 0 && (
                  <section><h3 className="text-xs font-bold uppercase text-stone">{t('facts.disclosures')}</h3>
                    <ul className="mt-1 flex flex-col gap-1 text-xs">{[...l.office.disclosures, ...l.disclosures].map((d) => <li key={d.key}><strong>{d.label}:</strong> {d.text}</li>)}</ul>
                    <p className="mt-1 text-[11px] text-mute">{t('facts.disclosuresNote')}</p>
                  </section>
                )}
                {l.permissions?.canEdit && l.allowedTransitions.length > 0 && (
                  <section className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                    <strong>{t('listings.changeStatus')}</strong>
                    <div className="flex flex-wrap gap-2">
                      {allowedListingTransitions(l.status, l.transaction).map((to) => (
                        <Button key={to} size="sm" variant={to === 'withdrawn' ? 'secondary' : 'primary'} loading={status.pending} onClick={async () => {
                          const r = await status.run(to);
                          if (r) { res.setData(r.listing); setNotice(r.result === 'pending_approval' ? t('listings.sentForApproval') : t('listings.statusChanged', { status: t(`status.${to}` as 'status.active') }) + (r.cancelledViewings ? ` ${t('listings.viewingsCancelled', { count: r.cancelledViewings })}` : '')); }
                        }}>{t(`action.${to}` as 'action.active')}</Button>
                      ))}
                    </div>
                    {['coming_soon', 'active'].some((s) => l.allowedTransitions.includes(s as LS)) && l.office.tier !== 'flexible' && !l.permissions.canApprove && <p className="text-xs text-stone">{t('listings.approvalHint')}</p>}
                    {status.error && <Banner tone="danger" live="assertive">{status.error.message}</Banner>}
                  </section>
                )}
                {l.permissions?.canEdit && (
                  <section className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                    <div className="flex items-center gap-2"><Icon name="marina" size={16} /><strong>{t('ai.title')}</strong><Badge tone="info">{t('ai.draftsOnly')}</Badge></div>
                    <p className="text-xs text-stone">{t('ai.factsOnly')}</p>
                    <Field label={t('ai.instructions')} optional hint={t('ai.instructionsHint')}>{(p) => <Input {...p} value={instr} onChange={(e) => setInstr(e.target.value)} />}</Field>
                    <Button size="sm" variant="secondary" icon="marina" loading={ai.pending} onClick={async () => { const r = await ai.run(instr); if (r) setDraft(r.proposal ? { id: r.proposal.id, headline: String(r.proposal.output.headline ?? ''), description: String(r.proposal.output.description ?? ''), refusals: r.refusals } : { id: '', refusals: r.refusals }); }} className="self-start">{t('ai.draft')}</Button>
                    {ai.error && <Banner tone={ai.error.code === 'fair_housing_refused' ? 'warning' : 'danger'} live="assertive">{ai.error.message}</Banner>}
                    {draft && (
                      <div className="flex flex-col gap-2 rounded-md bg-surface p-3">
                        {draft.refusals.length > 0 && <p className="text-xs text-warning">{t('ai.refused', { count: draft.refusals.length })}</p>}
                        {draft.id && <><strong>{draft.headline}</strong><p className="whitespace-pre-line text-sm">{draft.description}</p>
                          <div className="flex gap-2"><Button size="sm" icon="check" loading={aiApply.pending} onClick={async () => { const r = await aiApply.run(draft.id); if (r) { setDraft(null); res.reload(); setNotice(t('ai.applied')); } }}>{t('ai.apply')}</Button><Button size="sm" variant="ghost" onClick={() => setDraft(null)}>{t('ai.dismiss')}</Button></div></>}
                        {aiApply.error && <Banner tone="danger">{aiApply.error.message}</Banner>}
                      </div>
                    )}
                  </section>
                )}
                {l.permissions?.canEdit && (
                  <section className="flex flex-col gap-2">
                    <h3 className="text-xs font-bold uppercase text-stone">{t('portals.title')}</h3>
                    <p className="text-xs text-stone">{tp('portals.configureHint')} {tp('portals.removedNote')}</p>
                    {PORTALS_BY_COUNTRY.filter(([, countries]) => countries.includes(l.office.country)).map(([p]) => {
                      const s = l.syndication.find((x) => x.portal === p);
                      return (
                        <div key={p} className="flex flex-col gap-1 rounded-md bg-canvas px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Toggle checked={!!s?.optedIn} label={tp(`portals.names.${p}`)} onChange={async (on) => { const r = await synd.run(p, on); if (r) res.reload(); }} />
                            <span className="text-sm font-semibold">{tp(`portals.names.${p}`)}</span>
                            {s?.optedIn && <Badge tone={s.lastStatus === 'published' ? 'success' : s.lastStatus === 'invalid' || s.lastStatus === 'error' ? 'warning' : 'neutral'}>{tp(`portals.lastStatus.${s.lastStatus}`)}</Badge>}
                            {s?.lastIssues.length ? <Badge tone="warning" icon="alert">{t('portals.issues', { count: s.lastIssues.length })}</Badge> : null}
                          </div>
                          {s?.optedIn && s.lastIssues.length > 0 && <ul className="list-disc ps-5 text-xs text-warning">{s.lastIssues.map((i) => <li key={i}>{i}</li>)}</ul>}
                        </div>
                      );
                    })}
                    {synd.error && <Banner tone="danger">{synd.error.message}</Banner>}
                  </section>
                )}
              </div>
            )}
            {tab === 'edit' && <ListingForm initial={l} onSaved={(d, result) => { res.setData(d); setTab('details'); setNotice(result === 'pending_approval' ? t('listings.changesPending') : t('listings.saved')); }} />}
            {tab === 'activity' && (
              <ol className="flex flex-col gap-2 text-sm">
                {[...l.history].reverse().map((h, i) => (
                  <li key={i} className="flex gap-2"><Icon name="clock" size={14} className="mt-0.5 text-stone" /><div><div>{h.from ? `${t(`status.${h.from}` as 'status.draft')} → ` : ''}{t(`status.${h.to}` as 'status.draft')}{h.note ? ` · ${h.note}` : ''}</div><div className="text-xs text-stone">{fmtDateTime(h.at, l.office.timeZone, locale)} · {relativeTime(h.at, locale)}</div></div></li>
                ))}
              </ol>
            )}
          </div>
        )}
      </RAsync>
    </Drawer>
  );
}

function ListingForm({ initial, onSaved }: { initial: ListingDetail; onSaved: (d: ListingDetail, result: string) => void }) {
  const t = useTranslations('realty');
  const ctx = useRealtyCtx();
  const cur = initial.price.currency as Currency;
  const [f, setF] = useState({
    title: initial.title, description: initial.description ?? '', propertyType: initial.propertyType, price: String(toMajor(initial.price)), bedrooms: initial.bedrooms?.toString() ?? '', bathrooms: initial.bathrooms?.toString() ?? '',
    area: initial.area?.value.toString() ?? '', unit: initial.areaUnit as AreaUnit, features: initial.features.join(', '), photos: initial.photos.map((p) => p.url).join('\n'), tour: initial.virtualTourUrl ?? '', hideStreet: initial.hideStreet,
  });
  const save = useRealtyMutation((api, body: ListingInput) => api.updateListing(ctx, initial.id, body));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  return (
    <form className="flex flex-col gap-3" onSubmit={async (e) => {
      e.preventDefault();
      const r = await save.run({
        title: f.title, description: f.description || null, propertyType: f.propertyType, priceMinor: Math.round(Number(f.price) * (cur === 'JPY' ? 1 : 100)), bedrooms: num(f.bedrooms), bathrooms: num(f.bathrooms),
        area: f.area ? { value: Number(f.area), unit: f.unit } : null, features: f.features.split(',').map((x) => x.trim()).filter(Boolean), photos: f.photos.split('\n').map((x) => x.trim()).filter(Boolean).map((url) => ({ url })),
        virtualTourUrl: f.tour || null, hideStreet: f.hideStreet,
      });
      if (r) onSaved(r.listing, r.result);
    }}>
      {initial.tier !== 'flexible' && ['coming_soon', 'active', 'under_offer'].includes(initial.status) && !initial.permissions?.canApprove && <Banner tone="info" icon="shield">{t('listings.governedEdit')}</Banner>}
      <Field label={t('form.title')}>{(p) => <Input {...p} required maxLength={160} value={f.title} onChange={set('title')} />}</Field>
      <Field label={t('form.description')} hint={t('form.descriptionHint')}>{(p) => <Textarea {...p} rows={5} value={f.description} onChange={set('description')} />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('form.type')}>{(p) => <Select {...p} value={f.propertyType} onChange={set('propertyType')}>{PROPERTY_TYPES.map((x) => <option key={x} value={x}>{t(`type.${x}` as 'type.house')}</option>)}</Select>}</Field>
        <Field label={t('form.price', { currency: cur })} hint={t('form.priceHint')}>{(p) => <Input {...p} inputMode="decimal" required value={f.price} onChange={set('price')} />}</Field>
        <Field label={t('facts.bedrooms')} optional>{(p) => <Input {...p} inputMode="numeric" value={f.bedrooms} onChange={set('bedrooms')} />}</Field>
        <Field label={t('facts.bathrooms')} optional>{(p) => <Input {...p} inputMode="decimal" value={f.bathrooms} onChange={set('bathrooms')} />}</Field>
        <Field label={t('form.area')} optional>{(p) => <Input {...p} inputMode="decimal" value={f.area} onChange={set('area')} />}</Field>
        <Field label={t('form.areaUnit')}>{(p) => <Select {...p} value={f.unit} onChange={set('unit')}><option value="sqft">{t('units.sqft')}</option><option value="sqm">{t('units.sqm')}</option></Select>}</Field>
      </div>
      <Field label={t('form.features')} hint={t('form.featuresHint')} optional>{(p) => <Input {...p} value={f.features} onChange={set('features')} />}</Field>
      <Field label={t('form.photos')} hint={t('form.photosHint')} optional>{(p) => <Textarea {...p} rows={3} value={f.photos} onChange={set('photos')} />}</Field>
      <Field label={t('form.tour')} optional>{(p) => <Input {...p} type="url" value={f.tour} onChange={set('tour')} />}</Field>
      <Toggle checked={f.hideStreet} onChange={(v) => setF((x) => ({ ...x, hideStreet: v }))} label={t('form.hideStreet')} />
      {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
      <Button type="submit" icon="check" loading={save.pending} className="self-start">{t('form.save')}</Button>
    </form>
  );
}

function NewListingDrawer({ offices, onClose }: { offices: Office[]; onClose: (id?: string) => void }) {
  const t = useTranslations('realty');
  const ctx = useRealtyCtx();
  const [f, setF] = useState({ locationId: offices[0]?.locationId ?? '', transaction: 'sale' as 'sale' | 'rent', propertyType: 'house', title: '', price: '', line1: '', city: offices[0]?.city ?? '', postalCode: '', bedrooms: '', bathrooms: '', area: '' });
  const office = useMemo(() => offices.find((o) => o.locationId === f.locationId), [offices, f.locationId]);
  const create = useRealtyMutation((api, body: ListingInput) => api.createListing(ctx, body));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Drawer open onClose={() => onClose()} title={t('listings.new')}>
      {!offices.length ? <Empty icon="house" title={t('listings.noOffices')} /> : (
        <form className="flex flex-col gap-3" onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run({ locationId: f.locationId, transaction: f.transaction, propertyType: f.propertyType, title: f.title, priceMinor: Math.round(Number(f.price) * 100), address: { line1: f.line1, city: f.city, postalCode: f.postalCode || null }, bedrooms: f.bedrooms ? Number(f.bedrooms) : null, bathrooms: f.bathrooms ? Number(f.bathrooms) : null, area: f.area && office ? { value: Number(f.area), unit: office.areaUnit } : null });
          if (r) onClose(r.id);
        }}>
          <Field label={t('form.office')}>{(p) => <Select {...p} value={f.locationId} onChange={set('locationId')}>{offices.map((o) => <option key={o.locationId} value={o.locationId}>{o.name} · {o.currency}</option>)}</Select>}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('form.transaction')}>{(p) => <Select {...p} value={f.transaction} onChange={set('transaction')}><option value="sale">{t('transaction.sale')}</option><option value="rent">{t('transaction.rent')}</option></Select>}</Field>
            <Field label={t('form.type')}>{(p) => <Select {...p} value={f.propertyType} onChange={set('propertyType')}>{PROPERTY_TYPES.map((x) => <option key={x} value={x}>{t(`type.${x}` as 'type.house')}</option>)}</Select>}</Field>
          </div>
          <Field label={t('form.title')}>{(p) => <Input {...p} required value={f.title} onChange={set('title')} />}</Field>
          <Field label={t('form.price', { currency: office?.currency ?? '' })} hint={t('form.priceHint')}>{(p) => <Input {...p} required inputMode="decimal" value={f.price} onChange={set('price')} />}</Field>
          <Field label={t('form.street')}>{(p) => <Input {...p} required value={f.line1} onChange={set('line1')} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('form.city')}>{(p) => <Input {...p} required value={f.city} onChange={set('city')} />}</Field>
            <Field label={t('form.postalCode')} optional>{(p) => <Input {...p} value={f.postalCode} onChange={set('postalCode')} />}</Field>
            <Field label={t('facts.bedrooms')} optional>{(p) => <Input {...p} inputMode="numeric" value={f.bedrooms} onChange={set('bedrooms')} />}</Field>
            <Field label={t('facts.bathrooms')} optional>{(p) => <Input {...p} inputMode="decimal" value={f.bathrooms} onChange={set('bathrooms')} />}</Field>
          </div>
          <Field label={`${t('form.area')} (${office ? t(`units.${office.areaUnit}` as 'units.sqm') : ''})`} optional>{(p) => <Input {...p} inputMode="decimal" value={f.area} onChange={set('area')} />}</Field>
          <p className="text-xs text-stone">{t('listings.newHint')}</p>
          {create.error && <Banner tone="danger" live="assertive">{create.error.message}</Banner>}
          <Button type="submit" icon="plus" loading={create.pending} className="self-start">{t('listings.createDraft')}</Button>
        </form>
      )}
    </Drawer>
  );
}
