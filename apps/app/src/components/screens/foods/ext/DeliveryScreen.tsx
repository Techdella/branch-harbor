'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, cx } from '@bh/ui';
import type { Delivery, FoodOrderLite } from '@/lib/foods/types';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { fmtTime } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../../ui/States';
import { ErrorLine, Labeled, LocationSelect, Money1, NoLocations, Section, StatusBadge, inputCls, toMinor, useFx, useLocationPick } from './common';

/** Delivery: zones (postcode or radius) with fee and minimum, drivers, dispatch to own drivers or a provider, and live deliveries. */
export function DeliveryScreen() {
  const t = useFx();
  const locale = useLocale();
  const app = useApp();
  const pick = useLocationPick();
  const canWrite = app.can('operations.write');
  const lid = pick.locationId;
  const zones = useFoods((api) => api.zones(lid), [lid], !!lid);
  const drivers = useFoods((api) => api.drivers(lid), [lid], !!lid);
  const toDispatch = useFoods((api) => api.orders({ locationId: lid, channel: 'delivery' }), [lid], !!lid);
  const active = useFoods((api) => api.deliveries(lid), [lid], !!lid);
  const providers = useFoods((api) => api.providers(), []);
  const reloadAll = () => { toDispatch.reload(); active.reload(); };
  const dispatch = useFoodsMutation(async (api, orderId: string, provider: 'own' | 'uber_direct' | 'deliverect', driverId?: string) => { await api.dispatch(orderId, provider, driverId); return true; });
  const status = useFoodsMutation(async (api, id: string, s: 'picked_up' | 'delivered' | 'failed', note?: string) => { await api.deliveryStatus(id, s, note); return true; });
  const advance = useFoodsMutation(async (api, id: string) => { await api.sandboxAdvance(id); return true; });
  const markReady = useFoodsMutation((api, id: string, from: string) => api.transition(id, from === 'accepted' ? 'preparing' : 'ready', { expectedFrom: from }));
  const [driverFor, setDriverFor] = useState<Record<string, string>>({});
  if (!pick.loc) return <NoLocations />;
  const tz = pick.loc.timeZone;
  const dispatched = new Set((active.data ?? []).map((d) => d.orderId));

  return (
    <>
      <PageHeader icon="truck" title={t('delivery.title')} description={t('delivery.description')} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3">
        <LocationSelect pick={pick} />
        {providers.data?.filter((p) => p.key !== 'own').map((p) => <Badge key={p.key} tone={p.mode === 'sandbox' ? 'warning' : 'success'} icon="plug">{p.name}: {t(`delivery.mode.${p.mode}`)}</Badge>)}
        <Button size="sm" variant="ghost" icon="refresh" onClick={reloadAll}>{t('common.refresh')}</Button>
      </div>
      <ErrorLine error={dispatch.error ?? status.error ?? advance.error ?? markReady.error} />
      <div className="grid gap-3 xl:grid-cols-2">
        <Section title={t('delivery.toDispatch')}>
          <Async res={toDispatch} loading={<LoadingBlock variant="table" rows={2} />}>
            {(orders: FoodOrderLite[]) => {
              const list = orders.filter((o) => !dispatched.has(o.id) && ['accepted', 'preparing', 'ready'].includes(o.status));
              if (!list.length) return <p className="text-sm text-stone">{t('delivery.nothingToDispatch')}</p>;
              return (
                <ul className="divide-y divide-line-soft">
                  {list.map((o) => (
                    <li key={o.id} className="flex flex-col gap-2 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong>#{o.orderNumber}</strong><StatusBadge status={o.status} />
                        <span className="text-xs text-stone">{o.fulfilment.zoneName ?? ''} · {o.fulfilment.address?.postalCode ?? ''} · {o.promisedAt ? fmtTime(o.promisedAt, tz, locale) : ''}</span>
                        <span className="ml-auto text-sm"><Money1 m={o.total} /></span>
                      </div>
                      {canWrite && (
                        <div className="flex flex-wrap items-center gap-2">
                          <select aria-label={t('delivery.driver')} value={driverFor[o.id] ?? ''} onChange={(e) => setDriverFor({ ...driverFor, [o.id]: e.target.value })} className={cx(inputCls, 'w-44')}>
                            <option value="">{t('delivery.chooseDriver')}</option>
                            {(drivers.data ?? []).filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                          </select>
                          <Button size="sm" icon="user" disabled={!driverFor[o.id]} loading={dispatch.pending} onClick={async () => { if (await dispatch.run(o.id, 'own', driverFor[o.id])) reloadAll(); }}>{t('delivery.assign')}</Button>
                          <Button size="sm" variant="secondary" icon="plug" loading={dispatch.pending} onClick={async () => { if (await dispatch.run(o.id, 'uber_direct')) reloadAll(); }}>{t('delivery.sendTo', { name: 'Uber Direct' })}</Button>
                          {o.status !== 'ready' && <Button size="sm" variant="ghost" onClick={async () => { await markReady.run(o.id, o.status); reloadAll(); }}>{o.status === 'accepted' ? t('kds.to.preparing') : t('kds.to.ready')}</Button>}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              );
            }}
          </Async>
        </Section>
        <Section title={t('delivery.active')}>
          <Async res={active} loading={<LoadingBlock variant="table" rows={2} />}>
            {(list: Delivery[]) => list.length === 0 ? <p className="text-sm text-stone">{t('delivery.noActive')}</p> : (
              <ul className="divide-y divide-line-soft">
                {list.map((d) => (
                  <li key={d.id} className="flex flex-col gap-2 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>#{d.order.orderNumber}</strong><StatusBadge status={d.status} />
                      <span className="text-xs text-stone">{d.driver?.name ?? t(`delivery.provider.${d.provider}`)}{d.sandbox && ` · ${t('delivery.mode.sandbox')}`}</span>
                      <span className="ml-auto text-xs">{t('delivery.order')}: {t(`status.${d.order.status}`)}</span>
                    </div>
                    <p className="text-xs text-stone">{d.order.address ? `${d.order.address.line1}, ${d.order.address.city} ${d.order.address.postalCode}` : d.order.zoneName}</p>
                    {canWrite && (
                      <div className="flex flex-wrap gap-2">
                        {d.provider === 'own' && ['assigned', 'pending'].includes(d.status) && <Button size="sm" icon="truck" loading={status.pending} onClick={async () => { if (await status.run(d.id, 'picked_up')) reloadAll(); }}>{t('delivery.pickedUp')}</Button>}
                        {d.provider === 'own' && d.status === 'picked_up' && <Button size="sm" icon="check" loading={status.pending} onClick={async () => { if (await status.run(d.id, 'delivered')) reloadAll(); }}>{t('delivery.delivered')}</Button>}
                        {d.sandbox && <Button size="sm" variant="secondary" icon="refresh" loading={advance.pending} onClick={async () => { if (await advance.run(d.id)) reloadAll(); }}>{t('delivery.simulate')}</Button>}
                        <Button size="sm" variant="ghost" icon="alert" onClick={async () => { const note = window.prompt(t('delivery.failReason')); if (note && (await status.run(d.id, 'failed', note))) reloadAll(); }}>{t('delivery.failed')}</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Section>
      </div>
      <Zones locationId={lid} currency={pick.loc.currency} canWrite={canWrite} res={zones} />
      <Section title={t('delivery.drivers')}>
        <Async res={drivers} loading={<LoadingBlock variant="table" rows={2} />}>
          {(list) => <ul className="flex flex-wrap gap-2">{list.map((d) => <li key={d.id} className="rounded-full bg-canvas px-3 py-1.5 text-sm font-semibold">{d.name}{d.phone && <span className="text-stone"> · {d.phone}</span>}{d.userId && <span className="text-stone"> · {t('delivery.linkedApp')}</span>}</li>)}</ul>}
        </Async>
        {canWrite && <NewDriver locationId={lid} onDone={drivers.reload} />}
      </Section>
    </>
  );
}

function NewDriver({ locationId, onDone }: { locationId: string; onDone: () => void }) {
  const t = useFx();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const m = useFoodsMutation((api) => api.createDriver(locationId, { name, phone: phone || undefined }));
  return (
    <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (await m.run()) { setName(''); setPhone(''); onDone(); } }}>
      <Labeled label={t('delivery.driverName')}><input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Labeled>
      <Labeled label={t('delivery.phone')}><input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} /></Labeled>
      <Button type="submit" size="sm" icon="plus" loading={m.pending}>{t('common.add')}</Button>
      <ErrorLine error={m.error} />
    </form>
  );
}

function Zones({ locationId, currency, canWrite, res }: { locationId: string; currency: string; canWrite: boolean; res: ReturnType<typeof useFoods<Awaited<ReturnType<import('@/lib/foods/api').FoodsApi['zones']>>>> }) {
  const t = useFx();
  const [kind, setKind] = useState<'postcode' | 'radius'>('postcode');
  const [form, setForm] = useState({ name: '', postcodes: '', radius: '3000', fee: '', min: '', free: '' });
  const create = useFoodsMutation((api, body: Record<string, unknown>) => api.createZone(locationId, body));
  const toggle = useFoodsMutation((api, id: string, active: boolean) => api.updateZone(id, { active }));
  const remove = useFoodsMutation(async (api, id: string) => { await api.deleteZone(id); return true; });
  return (
    <Section title={t('delivery.zones')}>
      <Async res={res} loading={<LoadingBlock variant="table" rows={2} />}>
        {(z) => (
          <>
            {z.geocoding === 'disabled' && <Banner tone="info" title={t('delivery.geocodingOff')}>{z.location.geo ? t('delivery.geocodingOffBody') : t('delivery.noCoordinates')}</Banner>}
            <div className="overflow-x-auto">
              <table className="mt-2 w-full min-w-[560px] text-sm">
                <thead><tr className="text-left text-xs uppercase text-stone"><th className="p-2">{t('delivery.zone')}</th><th className="p-2">{t('delivery.area')}</th><th className="p-2">{t('delivery.fee')}</th><th className="p-2">{t('delivery.minimum')}</th><th className="p-2">{t('delivery.freeAbove')}</th><th className="p-2" /></tr></thead>
                <tbody>
                  {z.items.map((zone) => (
                    <tr key={zone.id} className="border-t border-line-soft">
                      <td className="p-2 font-bold">{zone.name} {!zone.active && <StatusBadge status="closed" label={t('delivery.paused')} />}</td>
                      <td className="p-2 text-xs">{zone.kind === 'radius' ? t('delivery.radius', { km: ((zone.radiusMeters ?? 0) / 1000).toFixed(1) }) : zone.postcodes.join(', ')}</td>
                      <td className="p-2"><Money1 m={zone.fee} /></td><td className="p-2"><Money1 m={zone.minimumOrder} /></td><td className="p-2">{zone.freeDeliveryAbove ? <Money1 m={zone.freeDeliveryAbove} /> : '—'}</td>
                      <td className="p-2 text-right">{canWrite && <span className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={async () => { await toggle.run(zone.id, !zone.active); res.reload(); }}>{zone.active ? t('delivery.pause') : t('delivery.resume')}</Button><Button size="sm" variant="ghost" icon="x" onClick={async () => { if (await remove.run(zone.id)) res.reload(); }}>{t('common.remove')}</Button></span>}</td>
                    </tr>
                  ))}
                  {!z.items.length && <tr><td colSpan={6} className="p-2 text-stone">{t('delivery.noZones')}</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Async>
      {canWrite && (
        <form className="mt-3 grid gap-2 md:grid-cols-4" onSubmit={async (e) => {
          e.preventDefault();
          const body = { name: form.name, kind, ...(kind === 'radius' ? { radiusMeters: Number(form.radius) } : { postcodes: form.postcodes.split(',').map((x) => x.trim()).filter(Boolean) }), feeMinor: toMinor(form.fee || '0'), minimumOrderMinor: toMinor(form.min || '0'), ...(form.free ? { freeDeliveryAboveMinor: toMinor(form.free) } : {}) };
          if (await create.run(body)) { setForm({ name: '', postcodes: '', radius: '3000', fee: '', min: '', free: '' }); res.reload(); }
        }}>
          <Labeled label={t('delivery.zoneName')}><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label={t('delivery.kind')}><select value={kind} onChange={(e) => setKind(e.target.value as 'radius')} className={inputCls}><option value="postcode">{t('delivery.byPostcode')}</option><option value="radius">{t('delivery.byRadius')}</option></select></Labeled>
          {kind === 'postcode'
            ? <Labeled label={t('delivery.postcodes')} hint={t('delivery.postcodesHint')}><input value={form.postcodes} onChange={(e) => setForm({ ...form, postcodes: e.target.value })} className={inputCls} /></Labeled>
            : <Labeled label={t('delivery.radiusMeters')}><input inputMode="numeric" value={form.radius} onChange={(e) => setForm({ ...form, radius: e.target.value })} className={inputCls} /></Labeled>}
          <Labeled label={`${t('delivery.fee')} (${currency})`}><input inputMode="decimal" value={form.fee} onChange={(e) => setForm({ ...form, fee: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label={`${t('delivery.minimum')} (${currency})`}><input inputMode="decimal" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} className={inputCls} /></Labeled>
          <Labeled label={`${t('delivery.freeAbove')} (${currency})`}><input inputMode="decimal" value={form.free} onChange={(e) => setForm({ ...form, free: e.target.value })} className={inputCls} /></Labeled>
          <div className="flex items-end"><Button type="submit" icon="plus" loading={create.pending}>{t('delivery.addZone')}</Button></div>
        </form>
      )}
      <ErrorLine error={create.error ?? toggle.error ?? remove.error} />
    </Section>
  );
}
