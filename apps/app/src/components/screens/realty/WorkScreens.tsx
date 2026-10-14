'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Badge, Button, Drawer, Field, Input, Select, Tabs, Textarea, Toggle, type Tone } from '@bh/ui';
import type { IconName } from '@bh/icons';
import { useRealty, useRealtyMutation } from '@/lib/realty/api';
import type { Enquiry, Offer, Viewing } from '@/lib/realty/types';
import { fmtDay, fmtTime, money, relativeTime, zoneLabel } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty } from '../../ui/States';
import { RAsync, useRealtyCtx } from './common';

const ENQ_TONE: Record<Enquiry['status'], [Tone, IconName]> = { new: ['info', 'bell'], contacted: ['neutral', 'phone'], viewing_booked: ['success', 'key'], offer_made: ['warning', 'receipt'], closed: ['neutral', 'check'], lost: ['neutral', 'minus'] };

// ───────── Enquiries ─────────
export function EnquiriesScreen() {
  const t = useTranslations('realty');
  const tOps = useTranslations('ops.realty.enquiries');
  const locale = useLocale();
  const ctx = useRealtyCtx();
  const app = useApp();
  const [view, setView] = useState<'all' | 'mine' | 'pool'>(app.role === 'staff' ? 'mine' : 'all');
  const res = useRealty((api) => api.enquiries(ctx, view), [ctx, view]);
  const me = useRealty((api) => api.me(ctx), [ctx]);
  const agents = useRealty((api) => api.agents(ctx), [ctx]);
  const assign = useRealtyMutation((api, id: string, agentId: string | null) => api.assignEnquiry(ctx, id, agentId));
  const setStatus = useRealtyMutation((api, id: string, s: Enquiry['status']) => api.enquiryStatus(ctx, id, s));
  const myAgent = me.status === 'ready' ? me.data.agents[0] : undefined;
  const manager = me.status === 'ready' && (me.data.clients === 'all' || me.data.clients.length > 0);
  const err = assign.error ?? setStatus.error;

  return (
    <>
      <PageHeader icon="mail" title={tOps('title')} description={tOps('description')} />
      <Tabs items={[{ key: 'all', label: t('enquiries.all') }, { key: 'mine', label: t('enquiries.mine') }, { key: 'pool', label: t('enquiries.pool') }]} value={view} onChange={setView} />
      {err && <Banner tone="danger" live="assertive">{err.message}</Banner>}
      <RAsync res={res} isEmpty={(d) => d.length === 0} empty={<Empty icon="mail" title={t('enquiries.emptyTitle')} body={t('enquiries.emptyBody')} />}>
        {(rows) => (
          <ul className="flex flex-col gap-2">
            {rows.map((e) => {
              const [tone, icon] = ENQ_TONE[e.status];
              const mine = !!myAgent && e.assignedAgentId === myAgent.id;
              return (
                <li key={e.id} className="flex flex-col gap-2 rounded-xl bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Avatar name={e.name} size={34} />
                    <div className="min-w-0 flex-1">
                      <strong>{e.name}</strong> <span className="text-xs text-stone">· {t(`kind.${e.kind}` as 'kind.buyer')} · {t(`source.${e.source}` as 'source.website')} · {relativeTime(e.createdAt, locale)}</span>
                      <div className="text-xs text-stone">{e.listing ? `${e.listing.reference} · ${e.listing.title}` : t('enquiries.noListing')}</div>
                    </div>
                    <Badge tone={tone} icon={icon}>{t(`enquiryStatus.${e.status}` as 'enquiryStatus.new')}</Badge>
                  </div>
                  {e.message && <p className="rounded-md bg-canvas px-3 py-2 text-sm">{e.message}</p>}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={e.assignedAgentId ? 'neutral' : 'warning'} icon={e.assignedAgentId ? 'user' : 'users'}>{e.assignedAgentId ? t('enquiries.assignedTo', { name: e.agentName ?? '—' }) : t('enquiries.inPool')}</Badge>
                    <span className="text-stone">{t(`routing.${e.routedBy}` as 'routing.listing_agent')}</span>
                    {(e.email || e.phone) && <span className="text-stone">{[e.email, e.phone].filter(Boolean).join(' · ')}</span>}
                    <span className="ms-auto flex flex-wrap gap-1.5">
                      {!e.assignedAgentId && myAgent && <Button size="sm" variant="secondary" icon="user" loading={assign.pending} onClick={async () => { if (await assign.run(e.id, myAgent.id)) res.reload(); }}>{t('enquiries.claim')}</Button>}
                      {manager && agents.status === 'ready' && (
                        <Select aria-label={t('enquiries.reassign')} className="h-9 w-44 text-xs" value={e.assignedAgentId ?? ''} onChange={async (ev) => { if (await assign.run(e.id, ev.target.value || null)) res.reload(); }}>
                          <option value="">{t('enquiries.toPool')}</option>
                          {agents.data.filter((a) => a.locationId === e.locationId && a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </Select>
                      )}
                      {(mine || manager) && e.status === 'new' && <Button size="sm" icon="phone" loading={setStatus.pending} onClick={async () => { if (await setStatus.run(e.id, 'contacted')) res.reload(); }}>{t('enquiries.markContacted')}</Button>}
                      {(mine || manager) && !['closed', 'lost'].includes(e.status) && <Button size="sm" variant="ghost" onClick={async () => { if (await setStatus.run(e.id, 'lost')) res.reload(); }}>{t('enquiries.markLost')}</Button>}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </RAsync>
      <p className="text-xs text-stone">{t('enquiries.privacy')}</p>
    </>
  );
}

// ───────── Viewings ─────────
const V_TONE: Record<Viewing['status'], [Tone, IconName]> = { requested: ['warning', 'clock'], confirmed: ['success', 'check'], completed: ['neutral', 'check-circle'], no_show: ['danger', 'x'], cancelled: ['neutral', 'minus'] };

export function ViewingsScreen() {
  const t = useTranslations('realty');
  const tOps = useTranslations('ops.realty.viewings');
  const locale = useLocale();
  const ctx = useRealtyCtx();
  const [range, setRange] = useState<'upcoming' | 'past'>('upcoming');
  const span = useMemo(() => {
    const n = Date.now();
    return range === 'upcoming' ? { from: new Date(n - 3 * 3600_000).toISOString(), to: new Date(n + 14 * 86400_000).toISOString() } : { from: new Date(n - 14 * 86400_000).toISOString(), to: new Date(n).toISOString() };
  }, [range]);
  const res = useRealty((api) => api.viewings(ctx, span.from, span.to), [ctx, span]);
  const confirm = useRealtyMutation((api, id: string) => api.confirmViewing(ctx, id));
  const cancel = useRealtyMutation((api, id: string) => api.cancelViewing(ctx, id));
  const [fb, setFb] = useState<Viewing | null>(null);
  const err = confirm.error ?? cancel.error;

  return (
    <>
      <PageHeader icon="key" title={tOps('title')} description={tOps('description')} />
      <Tabs items={[{ key: 'upcoming', label: t('viewings.upcoming') }, { key: 'past', label: t('viewings.past') }]} value={range} onChange={setRange} />
      {err && <Banner tone="danger" live="assertive">{err.message}</Banner>}
      <RAsync res={res} variant="calendar" isEmpty={(d) => d.length === 0} empty={<Empty icon="key" title={t('viewings.emptyTitle')} body={t('viewings.emptyBody')} />}>
        {(rows) => {
          const days = [...new Set(rows.map((v) => `${v.timeZone}|${fmtDay(v.startsAt, v.timeZone ?? 'UTC', locale)}`))];
          return (
            <div className="flex flex-col gap-3">
              {(range === 'past' ? [...days].reverse() : days).map((d) => {
                const [tz, label] = d.split('|') as [string, string];
                const items = rows.filter((v) => `${v.timeZone}|${fmtDay(v.startsAt, v.timeZone ?? 'UTC', locale)}` === d);
                return (
                  <section key={d} className="rounded-xl bg-surface p-4">
                    <h2 className="mb-2 text-sm font-bold">{label} <span className="font-normal text-stone">· {zoneLabel(tz, locale)}</span></h2>
                    <ul className="flex flex-col gap-2">
                      {items.map((v) => {
                        const [tone, icon] = V_TONE[v.status];
                        const own = v.contact.email !== null || v.mine;
                        return (
                          <li key={v.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-canvas px-3 py-2.5 text-sm">
                            <span className="w-14 font-bold tabular-nums">{fmtTime(v.startsAt, v.timeZone ?? 'UTC', locale)}</span>
                            <div className="min-w-0 flex-1">
                              <strong>{v.listing?.title ?? t('viewings.viewing')}</strong>
                              <div className="text-xs text-stone">{v.contact.name} · {v.agentName}{v.officeName ? ` · ${v.officeName}` : ''}</div>
                              {v.feedback && <div className="text-xs text-graphite">{t('viewings.feedbackLine', { interest: v.feedback.interestLevel ? t(`interest.${v.feedback.interestLevel}` as 'interest.high') : '—', rating: v.feedback.rating ?? '—' })}{v.feedback.notes ? ` · ${v.feedback.notes}` : ''}</div>}
                            </div>
                            <Badge tone={tone} icon={icon}>{t(`viewingStatus.${v.status}` as 'viewingStatus.requested')}</Badge>
                            {own && v.status === 'requested' && <Button size="sm" icon="check" loading={confirm.pending} onClick={async () => { if (await confirm.run(v.id)) res.reload(); }}>{t('viewings.confirm')}</Button>}
                            {own && ['requested', 'confirmed'].includes(v.status) && new Date(v.startsAt) > new Date() && <Button size="sm" variant="ghost" onClick={async () => { if (await cancel.run(v.id)) res.reload(); }}>{t('viewings.cancel')}</Button>}
                            {own && ['confirmed', 'requested'].includes(v.status) && new Date(v.startsAt) <= new Date() && <Button size="sm" variant="secondary" icon="edit" onClick={() => setFb(v)}>{t('viewings.logFeedback')}</Button>}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          );
        }}
      </RAsync>
      {fb && <FeedbackDrawer v={fb} onClose={(saved) => { setFb(null); if (saved) res.reload(); }} />}
    </>
  );
}

function FeedbackDrawer({ v, onClose }: { v: Viewing; onClose: (saved: boolean) => void }) {
  const t = useTranslations('realty');
  const ctx = useRealtyCtx();
  const [f, setF] = useState({ outcome: 'completed' as 'completed' | 'no_show', interestLevel: 'medium', rating: '4', notes: '' });
  const save = useRealtyMutation((api) => api.viewingFeedback(ctx, v.id, { outcome: f.outcome, interestLevel: f.outcome === 'completed' ? f.interestLevel : undefined, rating: f.outcome === 'completed' ? Number(f.rating) : undefined, notes: f.notes || undefined }));
  return (
    <Drawer open onClose={() => onClose(false)} title={t('viewings.logFeedback')} kicker={v.listing?.title}>
      <form className="flex flex-col gap-3" onSubmit={async (e) => { e.preventDefault(); if (await save.run()) onClose(true); }}>
        <Field label={t('viewings.outcome')}>{(p) => <Select {...p} value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value as 'completed' })}><option value="completed">{t('viewingStatus.completed')}</option><option value="no_show">{t('viewingStatus.no_show')}</option></Select>}</Field>
        {f.outcome === 'completed' && <>
          <Field label={t('viewings.interest')}>{(p) => <Select {...p} value={f.interestLevel} onChange={(e) => setF({ ...f, interestLevel: e.target.value })}>{['none', 'low', 'medium', 'high'].map((x) => <option key={x} value={x}>{t(`interest.${x}` as 'interest.high')}</option>)}</Select>}</Field>
          <Field label={t('viewings.rating')}>{(p) => <Select {...p} value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value })}>{[1, 2, 3, 4, 5].map((x) => <option key={x} value={x}>{x}</option>)}</Select>}</Field>
          <Field label={t('viewings.notes')} hint={t('viewings.notesHint')} optional>{(p) => <Textarea {...p} rows={4} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
        </>}
        {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
        <Button type="submit" icon="check" loading={save.pending} className="self-start">{t('viewings.saveFeedback')}</Button>
      </form>
    </Drawer>
  );
}

// ───────── Offers ─────────
const O_TONE: Record<Offer['status'], [Tone, IconName]> = { submitted: ['info', 'receipt'], countered: ['warning', 'refresh'], accepted: ['success', 'check'], rejected: ['neutral', 'x'], withdrawn: ['neutral', 'minus'] };

export function OffersScreen() {
  const t = useTranslations('realty');
  const tOps = useTranslations('ops.realty.offers');
  const locale = useLocale();
  const ctx = useRealtyCtx();
  const res = useRealty((api) => api.offers(ctx), [ctx]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader icon="receipt" title={tOps('title')} description={tOps('description')} />
      <Banner tone="neutral" icon="lock">{t('offers.visibility')}</Banner>
      <RAsync res={res} isEmpty={(d) => d.length === 0} empty={<Empty icon="receipt" title={t('offers.emptyTitle')} body={t('offers.emptyBody')} />}>
        {(rows) => (
          <ul className="flex flex-col gap-2">
            {rows.map((o) => {
              const [tone, icon] = O_TONE[o.status];
              return (
                <li key={o.id}>
                  <button type="button" onClick={() => setOpen(o.id)} className="flex w-full flex-wrap items-center gap-3 rounded-xl bg-surface p-4 text-start hover:ring-2 hover:ring-ink/10">
                    <div className="min-w-0 flex-1">
                      <strong>{o.listing?.title}</strong> <span className="text-xs text-stone">{o.listing?.reference}</span>
                      <div className="text-xs text-stone">{t('offers.buyer', { name: o.buyerName })}{o.submittedByAgentName ? ` · ${t('offers.via', { name: o.submittedByAgentName })}` : ''} · {relativeTime(o.updatedAt, locale)}</div>
                    </div>
                    <div className="text-end">
                      <div className="font-bold tabular-nums">{money(o.amount, locale)}</div>
                      {o.listing && <div className="text-xs text-stone">{t('offers.asking', { price: money(o.listing.price, locale) })}</div>}
                    </div>
                    <Badge tone={tone} icon={icon}>{t(`offerStatus.${o.status}` as 'offerStatus.submitted')}</Badge>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </RAsync>
      {open && <OfferDrawer id={open} onClose={() => { setOpen(null); res.reload(); }} />}
    </>
  );
}

function OfferDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useTranslations('realty');
  const locale = useLocale();
  const ctx = useRealtyCtx();
  const res = useRealty((api) => api.offer(ctx, id), [ctx, id]);
  const act = useRealtyMutation((api, action: string, amountMinor?: number, note?: string) => api.offerAction(ctx, id, { action, amountMinor, note }));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  return (
    <Drawer open onClose={onClose} title={t('offers.title')}>
      <RAsync res={res} variant="detail">
        {(o) => (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="text-2xl font-bold tabular-nums">{money(o.amount, locale)}</span><Badge tone={O_TONE[o.status][0]} icon={O_TONE[o.status][1]}>{t(`offerStatus.${o.status}` as 'offerStatus.submitted')}</Badge></div>
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-stone">{t('offers.buyerLabel')}</dt><dd>{o.buyerName}</dd>
              {o.deposit && <><dt className="text-stone">{t('offers.deposit')}</dt><dd>{money(o.deposit, locale)}</dd></>}
              <dt className="text-stone">{t('offers.conditions')}</dt><dd>{o.conditions.join(' · ') || '—'}</dd>
              {o.expiresAt && <><dt className="text-stone">{t('offers.expires')}</dt><dd>{relativeTime(o.expiresAt, locale)}</dd></>}
            </dl>
            {['submitted', 'countered', 'accepted'].includes(o.status) && (
              <section className="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                <div className="grid grid-cols-2 gap-2">
                  <Field label={t('offers.amount', { currency: o.amount.currency })} optional>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
                  <Field label={t('offers.note')} optional>{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(['counter', 'revise', 'accept', 'reject', 'withdraw', 'note'] as const).filter((a) => (o.status === 'accepted' ? a === 'withdraw' || a === 'note' : o.status === 'countered' ? a !== 'counter' : a !== 'revise')).map((a) => (
                    <Button key={a} size="sm" variant={a === 'accept' ? 'primary' : 'secondary'} loading={act.pending} onClick={async () => {
                      const r = await act.run(a, amount ? Math.round(Number(amount) * 100) : undefined, note || undefined);
                      if (r) { res.setData(r); setAmount(''); setNote(''); }
                    }}>{t(`offerAction.${a}` as 'offerAction.accept')}</Button>
                  ))}
                </div>
                <p className="text-xs text-stone">{t('offers.sides')}</p>
                {act.error && <Banner tone="danger" live="assertive">{act.error.message}</Banner>}
              </section>
            )}
            <section>
              <h3 className="mb-1 text-xs font-bold uppercase text-stone">{t('offers.trail')}</h3>
              <ol className="flex flex-col gap-1.5">
                {(o.events ?? []).map((e) => <li key={e.id} className="text-xs"><strong>{t(`offerEvent.${e.action}` as 'offerEvent.submitted')}</strong> · {t(`party.${e.party}` as 'party.buyer')}{e.amount ? ` · ${money(e.amount, locale)}` : ''}{e.note ? ` · ${e.note}` : ''} <span className="text-stone">· {relativeTime(e.at, locale)}</span></li>)}
              </ol>
            </section>
          </div>
        )}
      </RAsync>
    </Drawer>
  );
}

// ───────── Agents & office settings ─────────
export function AgentsScreen() {
  const t = useTranslations('realty');
  const tOps = useTranslations('ops.realty.agents');
  const ctx = useRealtyCtx();
  const res = useRealty((api) => api.agents(ctx), [ctx]);
  const offices = useRealty((api) => api.offices(ctx), [ctx]);
  const upd = useRealtyMutation((api, id: string, acceptsLeads: boolean) => api.updateAgent(ctx, id, { acceptsLeads }));
  const saveOffice = useRealtyMutation((api, id: string, body: Record<string, unknown>) => api.saveOffice(ctx, id, body));
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return (
    <>
      <PageHeader icon="users" title={tOps('title')} description={tOps('description')} />
      {(upd.error ?? saveOffice.error) && <Banner tone="danger" live="assertive">{(upd.error ?? saveOffice.error)!.message}</Banner>}
      <RAsync res={offices} variant="cards">
        {(os) => (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {os.map((o) => (
              <section key={o.locationId} className="flex flex-col gap-2 rounded-xl bg-surface p-4 text-sm">
                <div className="flex items-center justify-between"><strong>{o.name}</strong><Badge tone="neutral">{o.currency}</Badge></div>
                <label className="flex items-center justify-between gap-2">{t('office.tier')}
                  <Select className="h-9 w-40" value={o.tier} onChange={async (e) => { if (await saveOffice.run(o.locationId, { tier: e.target.value })) offices.reload(); }}>{['managed', 'standard', 'flexible'].map((x) => <option key={x} value={x}>{t(`tier.${x}` as 'tier.standard')}</option>)}</Select></label>
                <label className="flex items-center justify-between gap-2">{t('office.areaUnit')}
                  <Select className="h-9 w-40" value={o.areaUnit} onChange={async (e) => { if (await saveOffice.run(o.locationId, { areaUnit: e.target.value })) offices.reload(); }}><option value="sqft">{t('units.sqft')}</option><option value="sqm">{t('units.sqm')}</option></Select></label>
                <label className="flex items-center justify-between gap-2">{t('office.routing')}
                  <Select className="h-9 w-40" value={o.leadRouting} onChange={async (e) => { if (await saveOffice.run(o.locationId, { leadRouting: e.target.value })) offices.reload(); }}>{['listing_agent', 'round_robin', 'office_pool'].map((x) => <option key={x} value={x}>{t(`routingMode.${x}` as 'routingMode.round_robin')}</option>)}</Select></label>
                <p className="text-xs text-stone">{t(`tierHelp.${o.tier}` as 'tierHelp.standard')}</p>
              </section>
            ))}
          </div>
        )}
      </RAsync>
      <RAsync res={res} isEmpty={(d) => d.length === 0} empty={<Empty icon="users" title={t('agents.emptyTitle')} />}>
        {(rows) => (
          <ul className="grid gap-2 md:grid-cols-2">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 rounded-xl bg-surface p-4 text-sm">
                <div className="flex items-center gap-3">
                  {a.photoUrl ? <img src={a.photoUrl} alt="" className="h-10 w-10 rounded-full object-cover" /> : <Avatar name={a.name} size={40} />}
                  <div className="min-w-0 flex-1"><strong>{a.name}</strong>{a.isMe && <Badge tone="signal" className="ms-1.5">{t('agents.you')}</Badge>}<div className="text-xs text-stone">{a.title ?? ''}{a.licenceNumber ? ` · ${a.licenceNumber}` : ''}</div></div>
                  {!a.active && <Badge tone="neutral" icon="minus">{t('agents.inactive')}</Badge>}
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-graphite">
                  <span>{t('agents.liveListings', { count: a.workload.liveListings })}</span>·<span>{t('agents.openEnquiries', { count: a.workload.openEnquiries })}</span>·<span>{t('agents.upcomingViewings', { count: a.workload.upcomingViewings })}</span>
                </div>
                <div className="text-xs text-stone">{a.availability.length ? [...new Set(a.availability.map((w) => `${w.start}–${w.end}`))].join(', ') + ' · ' + a.availability.map((w) => t(`weekday.${WD[w.weekday]}` as 'weekday.mon')).join(' ') : t('agents.noAvailability')}</div>
                <Toggle checked={a.acceptsLeads} label={t('agents.acceptsLeads')} onChange={async (v) => { if (await upd.run(a.id, v)) res.reload(); }} />
              </li>
            ))}
          </ul>
        )}
      </RAsync>
    </>
  );
}

