'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Icon, Tabs } from '@bh/ui';
import { useStudio, useStudioMutation } from '@/lib/studios/api';
import type { MemberRow, MembershipVM } from '@/lib/studios/types';
import { fmtDay, relativeTime } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, DeniedState, Empty, LoadingBlock } from '../../ui/States';
import { ErrorLine, Labeled, MembershipBadge, Stat, StudioAsync, fmtMoney, inputCls } from './shared';

type Filter = 'all' | 'members' | 'pack_holders' | 'grace' | 'none';

/** Members: searchable, with packs, membership state, attendance and consent. Staff actions are audited server-side. */
export function MembersScreen() {
  const t = useTranslations('studiosFull.members');
  const locale = useLocale();
  const app = useApp();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const locIds = app.scope.locationIds;
  const single = locIds.length === 1 ? locIds[0] : undefined;
  useEffect(() => { const h = setTimeout(() => { setSearch(q); setOffset(0); }, 300); return () => clearTimeout(h); }, [q]);
  const res = useStudio((api) => api.members({ search, filter, locationId: single, offset }), [search, filter, offset, single, app.role], app.can('customers.read'));
  if (!app.can('customers.read')) return <DeniedState permission="customers.read" />;
  const consent = (v: boolean | null) => (v === null ? t('consent.unknown') : v ? t('consent.yes') : t('consent.no'));

  return (
    <>
      <PageHeader icon="users" title={t('title')} description={t('description')} />
      <section className="flex flex-col gap-3 rounded-xl bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-11 min-w-0 flex-1 items-center sm:min-w-[240px] gap-2 rounded-full border border-line-soft px-3">
            <Icon name="search" size={15} />
            <span className="sr-only">{t('search')}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchPlaceholder')} className="w-full bg-transparent text-sm focus:outline-none" />
          </label>
          <Tabs items={(['all', 'members', 'pack_holders', 'grace', 'none'] as const).map((k) => ({ key: k, label: t(`filter.${k}`) }))} value={filter} onChange={(k) => { setFilter(k); setOffset(0); }} />
        </div>
        <StudioAsync res={res} loading={<LoadingBlock variant="table" />} isEmpty={(d) => d.items.length === 0} empty={<Empty icon="users" title={t('emptyTitle')} body={t('emptyBody')} />}>
          {(d) => (
            <>
              <DataTable<MemberRow>
                rows={d.items}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpen(r.id)}
                columns={[
                  { key: 'name', header: t('col.name'), render: (r) => <span><strong className="block">{r.name}</strong><span className="text-xs text-stone">{r.email ?? t('noEmail')}</span></span> },
                  { key: 'home', header: t('col.home'), render: (r) => r.homeLocation?.name ?? '—' },
                  { key: 'membership', header: t('col.membership'), render: (r) => (r.membership ? <span className="flex flex-col items-start gap-0.5"><MembershipBadge state={r.membership.state} /><span className="text-xs text-stone">{r.membership.name}</span></span> : <span className="text-stone">{t('none')}</span>) },
                  { key: 'credits', header: t('col.credits'), align: 'right', render: (r) => (r.packs.count ? <span>{r.packs.credits}{r.packs.nextExpiry && <span className="block text-[11px] text-stone">{t('expires', { date: fmtDay(r.packs.nextExpiry, 'UTC', locale) })}</span>}</span> : '—') },
                  { key: 'att', header: t('col.attendance'), align: 'right', render: (r) => <span>{r.attendance.attended}{r.attendance.noShows > 0 && <span className="block text-[11px] text-warning">{t('noShows', { n: r.attendance.noShows })}</span>}</span> },
                  { key: 'last', header: t('col.lastVisit'), render: (r) => (r.attendance.lastVisit ? relativeTime(r.attendance.lastVisit, locale) : t('never')) },
                  { key: 'consent', header: t('col.consent'), render: (r) => <span className="text-xs">{t('emailShort')}: {consent(r.consent.marketingEmail)} · {t('smsShort')}: {consent(r.consent.marketingSms)}</span> },
                ]}
              />
              <div className="flex items-center justify-between text-xs text-stone">
                <span>{t('showing', { from: d.total ? offset + 1 : 0, to: Math.min(d.total, offset + d.items.length), total: d.total })}</span>
                <span className="flex gap-1.5">
                  <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>{t('prev')}</Button>
                  <Button size="sm" variant="ghost" disabled={offset + 25 >= d.total} onClick={() => setOffset(offset + 25)}>{t('next')}</Button>
                </span>
              </div>
            </>
          )}
        </StudioAsync>
      </section>
      <Drawer open={!!open} onClose={() => setOpen(null)} kicker={t('detail')} title={res.data?.items.find((m) => m.id === open)?.name ?? ''}>
        {open && <MemberDetailPanel key={open} id={open} onChanged={() => res.reload()} />}
      </Drawer>
    </>
  );
}

function MemberDetailPanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const t = useTranslations('studiosFull.members');
  const ta = useTranslations('autoPay');
  const locale = useLocale();
  const app = useApp();
  const res = useStudio((api) => api.member(id), [id]);
  const [msg, setMsg] = useState<string | null>(null);
  const act = useStudioMutation(async (api, fn: (a: typeof api) => Promise<unknown>) => fn(api));
  const run = async (fn: Parameters<typeof act.run>[0], done: string) => { if ((await act.run(fn)) !== undefined) { setMsg(done); res.reload(); onChanged(); } };
  const [credits, setCredits] = useState({ n: '1', reason: '' });
  const [sale, setSale] = useState('');
  const products = useStudio(async (api) => ({ packs: await api.packProducts(), plans: await api.membershipPlans() }), [], app.can('operations.write'));
  const canWrite = app.can('customers.write');

  return (
    <StudioAsync res={res} loading={<LoadingBlock variant="detail" />}>
      {(m) => {
        const loc = app.locations.find((l) => l.id === m.locationId);
        const tz = loc?.timeZone ?? 'UTC';
        return (
          <div className="flex flex-col gap-4 text-sm">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label={t('attended')} value={m.attendance.attended} pastel="#E9DDF8" />
              <Stat label={t('upcoming')} value={m.attendance.upcoming} />
              <Stat label={t('noShowsLabel')} value={m.attendance.noShows} />
              <Stat label={t('lateCancels')} value={m.attendance.lateCancels} />
            </div>
            <p className="text-xs text-stone">{[m.email, m.phone, loc?.name].filter(Boolean).join(' · ')}</p>
            {msg && <Banner tone="success" live="polite">{msg}</Banner>}
            <ErrorLine message={act.error?.message} />

            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('membershipH')}</h3>
              {m.memberships.length === 0 ? <p className="text-stone">{t('noMembership')}</p> : m.memberships.map((ms: MembershipVM) => (
                <article key={ms.id} className="mb-2 flex flex-col gap-1.5 rounded-md bg-canvas p-3">
                  <div className="flex flex-wrap items-center gap-2"><strong>{ms.name}</strong><MembershipBadge state={ms.state} />{ms.price && <span className="ml-auto tabular">{fmtMoney(ms.price.amount, ms.price.currency, locale)}{ms.price.interval ? ` / ${t('month')}` : ''}</span>}</div>
                  <div className="text-xs text-graphite">
                    {ms.classesPerPeriod ? t('usage', { used: ms.usage?.used ?? 0, limit: ms.classesPerPeriod }) : t('unlimited')} · {t(`access.${ms.accessPolicy}`)}
                    {ms.currentPeriodEnd && ` · ${t('renews', { date: fmtDay(ms.currentPeriodEnd, tz, locale) })}`}
                    {` · ${t(`billing.${ms.billing}`)}`}
                  </div>
                  {ms.state === 'grace' && ms.graceUntil && <Banner tone="warning">{t('graceNote', { date: fmtDay(ms.graceUntil, tz, locale), n: ms.failedAttempts })}</Banner>}
                  {ms.state === 'suspended' && <Banner tone="danger">{t('suspendedNote')}</Banner>}
                  {ms.state === 'paused' && ms.pausedUntil && <Banner tone="info">{t('pausedNote', { date: fmtDay(ms.pausedUntil, tz, locale) })}</Banner>}
                  {ms.state === 'cancelling' && ms.cancelAt && <Banner tone="warning">{t('cancellingNote', { date: fmtDay(ms.cancelAt, tz, locale) })}</Banner>}
                  {ms.invoices && ms.invoices.length > 0 && (
                    <ul className="text-xs">
                      {ms.invoices.slice(-4).map((i) => <li key={i.id} className="flex gap-2"><span className="w-28">{fmtDay(i.periodStart, tz, locale)}</span><span className="tabular">{fmtMoney(i.amount.amount, i.amount.currency, locale)}</span><Badge tone={i.status === 'paid' ? 'success' : i.status === 'failed' ? 'danger' : 'neutral'} icon={i.status === 'paid' ? 'check' : i.status === 'failed' ? 'x' : 'clock'}>{t(`invoice.${i.status}`)}</Badge>{i.failureReason && <span className="text-stone">{i.failureReason}</span>}</li>)}
                    </ul>
                  )}
                  {canWrite && !['cancelled', 'ended'].includes(ms.state) && (
                    <div className="flex flex-wrap gap-1.5">
                      {ms.state === 'paused' ? <Button size="sm" variant="secondary" onClick={() => run((a) => a.resumeMembership(ms.id), t('resumed'))}>{t('resume')}</Button>
                        : ['active', 'grace'].includes(ms.state) && ms.recurring && <Button size="sm" variant="secondary" onClick={() => run((a) => a.pauseMembership(ms.id, new Date(Date.now() + 60_000).toISOString(), new Date(Date.now() + 14 * 86400_000).toISOString()), t('paused'))}>{t('pause14')}</Button>}
                      {ms.state !== 'cancelling' && <Button size="sm" variant="ghost" onClick={() => run((a) => a.cancelMembership(ms.id, false), t('cancelRequested'))}>{t('cancelNotice')}</Button>}
                      {ms.billing === 'sandbox' && <Button size="sm" variant="ghost" onClick={() => run((a) => a.sandboxRenewal(ms.id, ms.state === 'grace' || ms.state === 'suspended' ? 'succeeded' : 'failed'), t('renewalSimulated'))}>{ms.state === 'grace' || ms.state === 'suspended' ? t('simulatePaid') : t('simulateFailed')}</Button>}
                    </div>
                  )}
                </article>
              ))}
            </section>

            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('packsH')}</h3>
              {m.packs.length === 0 ? <p className="text-stone">{t('noPacks')}</p> : (
                <ul className="flex flex-col gap-1">
                  {m.packs.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas px-3 py-2 text-xs">
                      <strong className="text-sm">{p.name}</strong>
                      <span className="tabular">{t('creditsLeft', { left: p.creditsRemaining, total: p.creditsTotal })}</span>
                      <Badge tone={p.status === 'active' ? 'success' : 'neutral'} icon={p.status === 'active' ? 'check-circle' : p.status === 'expired' ? 'clock' : 'x'}>{t(`packStatus.${p.status}`)}</Badge>
                      {p.expiresAt && <span className="text-stone">{t('expires', { date: fmtDay(p.expiresAt, tz, locale) })}</span>}
                      <span className="text-stone">{t(`access.${p.transferPolicy}`)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && m.locationId && (
                <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run((a) => a.grantCredits(m.id, { locationId: m.locationId!, credits: Number(credits.n), reason: credits.reason }), t('creditsAdded')); }}>
                  <Labeled label={t('compCredits')}><input type="number" min={1} max={50} className={`${inputCls} w-24`} value={credits.n} onChange={(e) => setCredits({ ...credits, n: e.target.value })} /></Labeled>
                  <Labeled label={t('reason')}><input required minLength={3} className={inputCls} value={credits.reason} onChange={(e) => setCredits({ ...credits, reason: e.target.value })} /></Labeled>
                  <Button size="sm" type="submit" icon="plus">{t('add')}</Button>
                </form>
              )}
              {canWrite && m.locationId && products.data && (
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <Labeled label={t('sell')}>
                    <select className={inputCls} value={sale} onChange={(e) => setSale(e.target.value)}>
                      <option value="">{t('choose')}</option>
                      {products.data.packs.filter((p) => p.status === 'active' && p.prices[loc?.currency ?? ''] !== undefined).map((p) => <option key={p.id} value={`pack:${p.id}`}>{p.name} · {fmtMoney(p.prices[loc!.currency]!, loc!.currency, locale)}</option>)}
                      {products.data.plans.filter((p) => p.status === 'active' && p.prices[loc?.currency ?? ''] !== undefined).map((p) => <option key={p.id} value={`membership:${p.id}`}>{p.name} · {fmtMoney(p.prices[loc!.currency]!, loc!.currency, locale)} / {t('month')}</option>)}
                    </select>
                  </Labeled>
                  <Button size="sm" icon="card" disabled={!sale} onClick={() => run(async (a) => {
                    const [kind, productId] = sale.split(':') as ['pack' | 'membership', string];
                    const r = await a.sell(m.id, { locationId: m.locationId!, kind, productId });
                    if (r.paymentId && r.sandbox) await a.confirmSandboxPayment(r.paymentId);
                    return r;
                  }, t('sold'))}>{t('sellSandbox')}</Button>
                </div>
              )}
            </section>

            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('feesH')}</h3>
              {m.fees.length === 0 ? <p className="text-stone">{t('noFees')}</p> : m.fees.map((f) => (
                <div key={f.id} className="flex flex-wrap items-center gap-2 border-b border-canvas py-1.5 text-xs">
                  <span className="w-32">{t(`feeKind.${f.kind}`)}</span><span className="tabular">{fmtMoney(f.amount.amount, f.amount.currency, locale)}</span>
                  <Badge tone={f.status === 'due' ? 'warning' : f.status === 'paid' ? 'success' : 'neutral'} icon={f.status === 'due' ? 'alert' : 'check'}>{t(`feeStatus.${f.status}`)}</Badge>
                  {f.waiveReason && <span className="text-stone">{f.waiveReason}</span>}
                  {f.autoCharge && <Badge tone={f.autoCharge.state === 'failed' ? 'danger' : f.autoCharge.state === 'succeeded' ? 'success' : 'warning'} icon={null}>{ta('autoBadge', { state: ta(`state_${f.autoCharge.state}` as 'state_failed') })}</Badge>}
                  {f.autoCharge?.failureMessage && <span className="text-danger">{f.autoCharge.failureMessage}</span>}
                  {canWrite && f.status === 'due' && <Button size="sm" variant="ghost" onClick={() => run((a) => a.waiveFee(f.id, 'Waived by staff'), t('waived'))}>{t('waive')}</Button>}
                </div>
              ))}
            </section>

            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('historyH')}</h3>
              <ul className="text-xs">
                {m.bookings.slice(0, 12).map((b) => (
                  <li key={b.id} className="flex flex-wrap gap-2 border-b border-canvas py-1.5">
                    <span className="w-40 tabular">{fmtDay(b.startsAt, b.timeZone, locale)}</span><span className="flex-1">{b.className} · {b.locationName}</span>
                    <span>{t(`bookingStatus.${b.status}`)}{b.lateCancel ? ` · ${t('late')}` : ''}</span><span className="text-stone">{t(`method.${b.paymentMethod}`)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-1.5 text-[13px] font-bold">{t('consentH')}</h3>
              {m.consents.length === 0 ? <p className="text-stone">{t('noConsent')}</p> : (
                <ul className="text-xs">{m.consents.map((c, i) => <li key={i} className="flex gap-2 py-0.5"><span className="w-40">{c.purpose}</span><Badge tone={c.granted ? 'success' : 'neutral'} icon={c.granted ? 'check' : 'x'}>{c.granted ? t('consent.yes') : t('consent.no')}</Badge><span className="text-stone">{c.source} · v{c.version} · {relativeTime(c.recordedAt, locale)}</span></li>)}</ul>
              )}
            </section>
          </div>
        );
      }}
    </StudioAsync>
  );
}
