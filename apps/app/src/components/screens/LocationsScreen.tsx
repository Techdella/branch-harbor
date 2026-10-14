'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, DataTable, Drawer, Icon, OriginTag, Tabs, cx } from '@bh/ui';
import type { Location } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { cityOfZone, countryName, fmtTime, zoneLabel } from '@/lib/format';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, DeniedState, Empty, LoadingBlock } from '../ui/States';

function useNow(ms = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(h);
  }, [ms]);
  return now;
}

export function LocationsScreen() {
  const t = useTranslations('locations');
  const locale = useLocale();
  const app = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const now = useNow();
  const res = useApi((api) => api.locations(app.ctx), [app.industry, app.role, app.scopeId]);
  const openId = params.get('open');
  const setOpen = (id: string | null) => router.replace(id ? `?open=${id}` : '?', { scroll: false });
  const org = app.org;
  const ownerName = (id: string) => org.ownerGroups.find((g) => g.id === id)?.name ?? id;
  const regionName = (id: string) => org.regions.find((r) => r.id === id)?.name ?? id;

  if (!app.can('locations.read')) return <DeniedState permission="locations.read" detail={t('denied')} />;

  return (
    <>
      <PageHeader
        icon="pin"
        title={t('title')}
        actions={
          app.can('locations.write') ? (
            <Link href="/locations/new" className="inline-flex h-11 items-center gap-2 rounded-full bg-ink px-5 text-sm font-bold text-white">
              <Icon name="plus" size={16} />
              {t('add')}
            </Link>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs items={[{ key: 'cards', label: t('cards') }, { key: 'table', label: t('table') }]} value={view} onChange={(v) => setView(v as 'cards' | 'table')} />
        <span className="text-xs text-stone">{t('localTimeNote')}</span>
      </div>
      <Async res={res} loading={<LoadingBlock variant="cards" rows={6} />} isEmpty={(d) => d.length === 0} empty={<Empty icon="pin" title={t('emptyTitle')} body={t('emptyBody')} action={<Link href="/locations/new" className="text-sm font-bold underline">{t('add')}</Link>} />}>
        {(locs) =>
          view === 'cards' ? (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr))]">
              {locs.map((l) => (
                <button key={l.id} type="button" onClick={() => setOpen(l.id)} className={cx('flex flex-col gap-2.5 rounded-lg border-[1.5px] bg-surface p-4 text-left', openId === l.id ? 'border-ink' : 'border-transparent hover:border-line')}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md" style={{ background: l.pastel }}>
                      <Icon name="pin" size={19} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-bold">{l.name}</div>
                      <div className="truncate text-xs text-stone">
                        {countryName(l.address.country, locale)} · {l.currency} · {cityOfZone(l.timeZone)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="tabular text-sm font-bold">{fmtTime(now.toISOString(), l.timeZone, locale)}</div>
                      <div className="text-[10px] text-stone">{zoneLabel(l.timeZone, locale, now)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <span className="rounded-full bg-canvas px-2.5 py-1 text-[11px] font-bold">{ownerName(l.ownerGroupId)}</span>
                    <Badge tone={l.sync === 'ok' ? 'success' : 'warning'}>{l.sync === 'ok' ? t('synced') : t('attention')}</Badge>
                    <Badge tone={l.site === 'live' ? 'success' : 'neutral'} icon={l.site === 'live' ? 'globe' : 'eye'}>
                      {l.site === 'live' ? t('siteLive') : t('siteUnpublished')}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
              <DataTable<Location>
                rows={locs}
                rowKey={(l) => l.id}
                onRowClick={(l) => setOpen(l.id)}
                columns={[
                  { key: 'name', header: t('col.name'), render: (l) => <span className="font-bold">{l.name}</span> },
                  { key: 'code', header: t('col.code'), render: (l) => l.code },
                  { key: 'country', header: t('col.country'), render: (l) => countryName(l.address.country, locale) },
                  { key: 'region', header: t('col.region'), render: (l) => regionName(l.regionId) },
                  { key: 'currency', header: t('col.currency'), render: (l) => l.currency },
                  { key: 'tz', header: t('col.timeZone'), render: (l) => `${l.timeZone.replace(/_/g, ' ')}` },
                  { key: 'now', header: t('col.localTime'), render: (l) => `${fmtTime(now.toISOString(), l.timeZone, locale)} ${zoneLabel(l.timeZone, locale, now)}` },
                  { key: 'site', header: t('col.site'), render: (l) => <Badge tone={l.site === 'live' ? 'success' : 'neutral'}>{l.site === 'live' ? t('siteLive') : t('siteUnpublished')}</Badge> },
                ]}
              />
            </section>
          )
        }
      </Async>
      {res.status === 'ready' && (
        <LocationDrawer l={res.data.find((l) => l.id === openId)} onClose={() => setOpen(null)} ownerName={ownerName} regionName={regionName} />
      )}
    </>
  );
}

function LocationDrawer({ l, onClose, ownerName, regionName }: { l?: Location; onClose: () => void; ownerName: (id: string) => string; regionName: (id: string) => string }) {
  const t = useTranslations('locations');
  const locale = useLocale();
  const app = useApp();
  if (!l) return null;
  const rows: [string, string, 'hq' | 'local' | 'locked' | 'approval'][] = [
    [t('field.template'), l.template, 'hq'],
    [t('field.timeZone'), `${l.timeZone.replace(/_/g, ' ')} (${zoneLabel(l.timeZone, locale)})`, 'local'],
    [t('field.currency'), l.currency, 'local'],
    [t('field.language'), l.locale, 'local'],
    [t('field.ownerGroup'), ownerName(l.ownerGroupId), 'hq'],
    [t('field.region'), regionName(l.regionId), 'hq'],
    [t('field.hours'), l.hours, 'local'],
    [t('field.offer'), t('field.offerValue'), 'approval'],
    [t('field.brand'), t('field.brandValue'), 'locked'],
  ];
  return (
    <Drawer
      open
      onClose={onClose}
      kicker={t('drawerKicker')}
      title={l.name}
      footer={
        <div className="flex flex-wrap gap-2">
          <Link href="/websites" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-[13px] font-bold text-white">
            <Icon name="globe" size={14} />
            {t('editWebsite')}
          </Link>
          <a href={`/locations?open=${l.id}`} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-4 text-[13px] font-bold">
            <Icon name="link" size={14} />
            {t('shareLink')}
          </a>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md bg-canvas p-3 text-[13px]">
          <div className="font-bold">{l.address.line1}</div>
          <div>
            {l.address.city}
            {l.address.region && `, ${l.address.region}`} · {countryName(l.address.country, locale)}
          </div>
          <div className="mt-1 text-stone">
            {l.code} · {l.phone}
          </div>
        </div>
        <h3 className="text-[13px] font-bold">{t('inheritedVsLocal')}</h3>
        <ul className="flex flex-col gap-1.5">
          {rows.map(([k, v, o]) => (
            <li key={k} className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] bg-canvas-raised px-3 py-2.5 text-[13px]">
              <span className="text-stone">{k}</span>
              <span className="flex items-center gap-1.5 text-right">
                <strong>{v}</strong>
                <OriginTag origin={o} />
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs leading-normal text-stone">{t('noAutoPublish')}</p>
        {!app.can('locations.write') && <p className="text-xs text-stone">{t('readOnly')}</p>}
        <Button variant="secondary" size="sm" onClick={onClose} className="self-start md:hidden">
          {t('close')}
        </Button>
      </div>
    </Drawer>
  );
}
