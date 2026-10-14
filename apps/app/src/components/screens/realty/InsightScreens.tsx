'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Drawer, Icon } from '@bh/ui';
import type { Currency } from '@bh/shared';
import { useRealty, useRealtyMutation } from '@/lib/realty/api';
import type { VolumeRow } from '@/lib/realty/types';
import { fmtNumber, money, relativeTime } from '@/lib/format';
import { PageHeader } from '../../shell/PageHeader';
import { Banner, Empty } from '../../ui/States';
import { RAsync, Stat, useRealtyCtx } from './common';

function Volumes({ rows }: { rows: VolumeRow[] }) {
  const t = useTranslations('realty');
  const locale = useLocale();
  if (!rows.length) return <span className="text-stone">{t('pulse.noneClosed')}</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((r) => <li key={r.currency} className="tabular-nums"><strong>{money({ amount: r.volumeMinor, currency: r.currency as Currency }, locale)}</strong> <span className="text-xs text-stone">· {t('pulse.deals', { count: r.count })}</span></li>)}
    </ul>
  );
}

/** Network/office pulse: listings, days on market, funnel and volume per currency (never combined). */
export function PulseScreen() {
  const t = useTranslations('realty');
  const tOps = useTranslations('ops.realty.pulse');
  const locale = useLocale();
  const ctx = useRealtyCtx();
  const res = useRealty((api) => api.reports(ctx), [ctx]);
  return (
    <>
      <PageHeader icon="grid" title={tOps('title')} description={tOps('description')} />
      <RAsync res={res} variant="cards" isEmpty={(d) => !d.network} empty={<Empty icon="chart" title={t('pulse.emptyTitle')} body={t('pulse.emptyBody')} />}>
        {(r) => r.network && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label={t('pulse.active')} value={fmtNumber(r.network.listings.active, locale)} sub={t('pulse.activeSub', { underOffer: r.network.listings.underOffer, comingSoon: r.network.listings.comingSoon })} icon={<Icon name="house" size={14} />} />
              <Stat label={t('pulse.dom')} value={r.network.daysOnMarket.liveMedian ?? t('unavailable')} sub={t('pulse.domSub', { count: r.network.daysOnMarket.liveCount })} icon={<Icon name="clock" size={14} />} />
              <Stat label={t('pulse.funnel')} value={`${r.network.funnel.enquiries} → ${r.network.funnel.viewings} → ${r.network.funnel.offers}`} sub={t('pulse.funnelSub')} icon={<Icon name="trending" size={14} />} />
              <Stat label={t('pulse.awaitingApproval')} value={r.network.listings.awaitingApproval} sub={t('pulse.awaitingSub')} icon={<Icon name="shield" size={14} />} />
            </div>
            <section className="rounded-xl bg-surface p-4">
              <h2 className="mb-2 text-sm font-bold">{t('pulse.volume')}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><div className="text-xs font-semibold text-stone">{t('pulse.sold')}</div><Volumes rows={r.network.sold} /></div>
                <div><div className="text-xs font-semibold text-stone">{t('pulse.let')}</div><Volumes rows={r.network.let} /></div>
              </div>
              <p className="mt-2 text-xs text-stone">{t('pulse.combined')}</p>
            </section>
            <section className="overflow-x-auto rounded-xl bg-surface p-4">
              <table className="w-full min-w-[720px] text-sm">
                <caption className="mb-2 text-start text-sm font-bold">{t('pulse.byOffice')}</caption>
                <thead><tr className="text-start text-xs text-stone"><th className="py-1 text-start">{t('pulse.office')}</th><th className="text-end">{t('pulse.active')}</th><th className="text-end">{t('pulse.domShort')}</th><th className="text-end">{t('pulse.enquiries')}</th><th className="text-end">{t('pulse.viewings')}</th><th className="text-end">{t('pulse.offers')}</th><th className="text-end">{t('pulse.conversion')}</th><th className="text-end">{t('pulse.sold')}</th></tr></thead>
                <tbody>
                  {r.locations.map((o) => (
                    <tr key={o.locationId} className="border-t border-line-soft">
                      <td className="py-2"><strong>{o.name}</strong> <span className="text-xs text-stone">{o.country} · {o.currency}</span></td>
                      <td className="text-end tabular-nums">{o.listings.active + o.listings.underOffer}</td>
                      <td className="text-end tabular-nums">{o.daysOnMarket.liveMedian ?? <span className="text-stone">{t('unavailable')}</span>}</td>
                      <td className="text-end tabular-nums">{o.funnel.enquiries}</td>
                      <td className="text-end tabular-nums">{o.funnel.viewings}</td>
                      <td className="text-end tabular-nums">{o.funnel.offers}</td>
                      <td className="text-end tabular-nums">{o.funnel.enquiryToViewing != null ? `${o.funnel.enquiryToViewing}%` : <span className="text-stone">{t('unavailable')}</span>}</td>
                      <td className="text-end"><Volumes rows={o.sold} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-stone">{r.definitions?.daysOnMarket} {r.definitions?.funnel} {t('pulse.privacy')}</p>
              {r.generatedAt && <p className="text-xs text-mute">{t('pulse.freshness', { when: relativeTime(r.generatedAt, locale), source: r.source ?? '' })}</p>}
            </section>
          </div>
        )}
      </RAsync>
    </>
  );
}

/** Portal feeds: per-office status (not configured / sandbox / live), validation errors per listing, preview and export. */
export function PortalsScreen() {
  const t = useTranslations('realty');
  const tp = useTranslations('partners');
  const tOps = useTranslations('ops.realty.portals');
  const locale = useLocale();
  const ctx = useRealtyCtx();
  const res = useRealty((api) => api.portals(ctx), [ctx]);
  const rows = useRealty((api) => api.syndicationListings(ctx), [ctx]);
  const [preview, setPreview] = useState<string | null>(null);
  const exp = useRealtyMutation((api, p: string) => api.exportFeed(ctx, p));
  const [result, setResult] = useState<string | null>(null);
  const tone = (s: string) => (s === 'live' ? 'success' : s === 'sandbox' ? 'warning' : s === 'error' ? 'danger' : s === 'awaiting_portal' ? 'info' : 'neutral') as 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  const failing = (rows.data ?? []).filter((r) => r.issues.length || r.lastStatus === 'error' || r.lastStatus === 'invalid');
  return (
    <>
      <PageHeader icon="plug" title={tOps('title')} description={tp('descriptionRealty')} />
      <Banner tone="info" icon="lock" title={tp('status.sandbox')} action={<Link className="text-xs font-bold underline" href="/connections">{tp('portals.openConnections')}</Link>}>{tp('sandboxBanner')} {tp('portals.configureHint')}</Banner>
      {result && <Banner tone="success" live="polite">{result}</Banner>}
      {exp.error && <Banner tone="danger" live="assertive">{exp.error.message}</Banner>}
      <section className="rounded-xl bg-surface p-4" aria-labelledby="portal-errors">
        <h2 id="portal-errors" className="mb-2 text-sm font-bold">{tp('portals.errorsTitle')}</h2>
        <RAsync res={rows} variant="table">
          {() => failing.length === 0 ? <p className="text-sm text-stone">{tp('portals.errorsEmpty')}</p> : (
            <ul className="flex flex-col gap-2 text-sm" data-testid="portal-errors">
              {failing.map((r) => (
                <li key={`${r.listingId}-${r.portal}`} className="rounded-md bg-warning-bg px-3 py-2 text-warning">
                  <div className="flex flex-wrap items-center gap-2"><strong>{r.reference}</strong><span>{r.title}</span><Badge tone="neutral">{tp(`portals.names.${r.portal}`)}</Badge><Badge tone="warning">{tp(`portals.lastStatus.${r.lastStatus}`)}</Badge></div>
                  <ul className="mt-1 list-disc ps-5 text-xs">{(r.issues.length ? r.issues : r.lastIssues).map((i) => <li key={i}>{i}</li>)}</ul>
                </li>
              ))}
            </ul>
          )}
        </RAsync>
      </section>
      <RAsync res={res} variant="cards">
        {(portals) => (
          <div className="grid gap-3 md:grid-cols-2">
            {portals.map((p) => (
              <section key={p.id} className="flex flex-col gap-2 rounded-xl bg-surface p-4 text-sm" data-testid={`portal-${p.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="flex-1">{p.name}</strong>
                  <Badge tone={p.live ? 'success' : 'warning'} icon={p.live ? 'check-circle' : 'lock'}>{p.live ? tp('status.live') : t('portals.sandbox')}</Badge>
                  <Badge tone="neutral">{p.format.toUpperCase()}</Badge>
                </div>
                <p className="text-xs text-stone">{p.description} · {p.countries.join(', ')} · {tp(`portals.delivery.${p.delivery}`)}</p>
                <p className="text-xs">{t('portals.optedIn', { count: p.optedInListings })}{p.invalidListings ? ` · ${t('portals.issues', { count: p.invalidListings })}` : ''} · {p.lastExportedAt ? t('portals.lastExport', { when: relativeTime(p.lastExportedAt, locale) }) : t('portals.neverExported')}</p>
                <div>
                  <h3 className="text-xs font-bold uppercase text-stone">{tp('portals.statusTitle')}</h3>
                  {p.offices.length === 0 ? <p className="text-xs text-stone">{tp('portals.noOffices')}</p> : (
                    <ul className="mt-1 flex flex-col gap-1">
                      {p.offices.map((o) => (
                        <li key={o.locationId} className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold">{o.name}</span>
                          <Badge tone={tone(o.status)}>{tp(`status.${o.status}`)}</Badge>
                          <span className="text-stone">{o.lastPush ? tp('portals.lastPush', { action: o.lastPush.action.replace('_', ' '), status: o.lastPush.status, when: relativeTime(o.lastPush.at, locale) }) : o.statusReason}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" icon="eye" onClick={() => setPreview(p.id)}>{t('portals.preview')}</Button>
                  <Button size="sm" variant="secondary" icon="refresh" loading={exp.pending} onClick={async () => {
                    const r = await exp.run(p.id);
                    if (r) { setResult(tp('portals.exported', { ok: r.results.filter((x) => ['published', 'sandbox_exported', 'removed', 'sandbox_removed'].includes(x.status)).length, invalid: r.results.filter((x) => x.status === 'invalid' || x.status === 'error').length, transmitted: r.transmitted ? 'true' : 'false' })); res.reload(); rows.reload(); }
                  }}>{p.live ? tp('portals.export') : tp('portals.exportSandbox')}</Button>
                </div>
              </section>
            ))}
          </div>
        )}
      </RAsync>
      {preview && <FeedDrawer portal={preview} onClose={() => setPreview(null)} />}
    </>
  );
}

function FeedDrawer({ portal, onClose }: { portal: string; onClose: () => void }) {
  const t = useTranslations('realty');
  const ctx = useRealtyCtx();
  const res = useRealty((api) => api.feed(ctx, portal), [ctx, portal]);
  return (
    <Drawer open onClose={onClose} title={t('portals.previewTitle')}>
      <RAsync res={res} variant="detail">
        {(f) => (
          <div className="flex flex-col gap-3 text-sm">
            <Banner tone={f.mode === 'live' ? 'success' : 'info'} icon="lock">{f.notice}</Banner>
            <p>{t('portals.included', { count: f.included.length })}</p>
            {f.excluded.length > 0 && (
              <ul className="flex flex-col gap-1 text-xs">{f.excluded.map((x) => <li key={x.listingId}><strong>{x.reference}</strong>: {x.issues.join('; ')}</li>)}</ul>
            )}
            <pre className="max-h-[50vh] overflow-auto rounded-md bg-canvas p-3 text-[11px] leading-snug">{f.content}</pre>
          </div>
        )}
      </RAsync>
    </Drawer>
  );
}
