'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Badge, Button, Toggle } from '@bh/ui';
import type { EffectiveItem } from '@/lib/foods/types';
import { useFoods, useFoodsMutation } from '@/lib/foods/useFoods';
import { fmtTime } from '@/lib/format';
import { useApp } from '../../../shell/AppContext';
import { PageHeader } from '../../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../../ui/States';
import { ErrorLine, LocationSelect, Money1, NoLocations, Section, useFx, useLocationPick } from './common';

/** Per-location sold-out for items and modifier options. "Until close" resets automatically at closing time. */
export function AvailabilityScreen() {
  const t = useFx();
  const locale = useLocale();
  const app = useApp();
  const pick = useLocationPick();
  const [untilClose, setUntilClose] = useState(true);
  const res = useFoods((api) => api.locationMenu(pick.locationId), [pick.locationId], !!pick.locationId);
  const item = useFoodsMutation(async (api, id: string, so: boolean) => { await api.setItemSoldOut(pick.locationId, id, so, untilClose); return true; });
  const mod = useFoodsMutation(async (api, id: string, so: boolean) => { await api.setModifierSoldOut(pick.locationId, id, so, untilClose); return true; });
  const [toast, setToast] = useState('');
  const canWrite = app.can('operations.write');
  if (!pick.loc) return <NoLocations />;
  const tz = pick.loc.timeZone;
  const flip = async (kind: 'item' | 'mod', id: string, name: string, so: boolean) => {
    const ok = kind === 'item' ? await item.run(id, so) : await mod.run(id, so);
    if (ok) { setToast(so ? t('avail.markedOut', { name }) : t('avail.markedBack', { name })); res.reload(); }
  };
  const Row = ({ i }: { i: EffectiveItem }) => {
    const so = i.unavailableCode === 'sold_out';
    return (
      <li className="flex flex-col gap-2 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-bold">{i.name} <span className="font-normal text-stone">· <Money1 m={i.price} /></span></div>
            <div className="flex flex-wrap gap-2 text-xs text-stone">
              {so && <Badge tone="danger" icon="x">{i.soldOutSource === 'ingredient' ? t('avail.soldOutIngredient') : i.soldOutUntil ? t('avail.soldOutUntil', { time: fmtTime(i.soldOutUntil, tz, locale) }) : t('avail.soldOut')}</Badge>}
              {!so && i.unavailableReason && <span>{i.unavailableReason}</span>}
              <span>{i.allergenInfo.status === 'declared' ? t('avail.allergens', { list: i.allergenInfo.items.map((a) => a.label).join(', ') || t('avail.noneDeclared') }) : t('avail.allergensNotProvided')}</span>
            </div>
          </div>
          {i.soldOutSource !== 'ingredient' && i.unavailableCode !== 'no_price' && (
            <span className="flex items-center gap-2 text-[13px] font-semibold">{so ? t('avail.soldOut') : t('avail.available')}
              <Toggle checked={!so} label={t('avail.toggle', { name: i.name })} onChange={(v) => canWrite && flip('item', i.id, i.name, !v)} />
            </span>
          )}
        </div>
        {i.modifierGroups.length > 0 && (
          <div className="flex flex-wrap gap-2 pl-3">
            {i.modifierGroups.flatMap((g) => g.modifiers.map((m) => (
              <span key={m.id} className="flex items-center gap-1.5 rounded-full bg-canvas px-2 py-1 text-xs font-semibold">
                {g.name}: {m.name}{m.soldOut && ` (${t('avail.soldOut')})`}
                <Toggle checked={!m.soldOut} label={t('avail.toggle', { name: `${g.name} ${m.name}` })} onChange={(v) => canWrite && flip('mod', m.id, m.name, !v)} />
              </span>
            )))}
          </div>
        )}
      </li>
    );
  };
  return (
    <>
      <PageHeader icon="sliders" title={t('avail.title')} description={t('avail.description')} />
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface px-4 py-3">
        <LocationSelect pick={pick} />
        <span className="flex items-center gap-2 text-[13px] font-semibold">{t('avail.untilClose')}<Toggle checked={untilClose} onChange={setUntilClose} label={t('avail.untilClose')} /></span>
        <Button size="sm" variant="ghost" icon="refresh" onClick={res.reload}>{t('common.refresh')}</Button>
      </div>
      {!canWrite && <Banner tone="neutral" icon="lock">{t('common.readOnly')}</Banner>}
      {toast && <Banner tone="success" live="polite">{toast}</Banner>}
      <ErrorLine error={item.error ?? mod.error} />
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(m) => (
          <>
            {[...new Set(m.items.map((i) => i.category))].map((c) => (
              <Section key={c} title={c}><ul className="divide-y divide-line-soft">{m.items.filter((i) => i.category === c).map((i) => <Row key={i.id} i={i} />)}</ul></Section>
            ))}
          </>
        )}
      </Async>
    </>
  );
}
