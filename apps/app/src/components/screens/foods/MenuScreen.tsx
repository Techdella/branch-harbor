'use client';

import Image from 'next/image';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, cx } from '@bh/ui';
import type { MenuField } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { moneyWithCode } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, LoadingBlock } from '../../ui/States';

function Origin({ f }: { f: MenuField }) {
  const t = useTranslations('menu');
  const cls = f.origin === 'local' ? 'bg-lilac' : f.origin === 'hq' ? 'bg-ink text-white' : 'bg-canvas';
  const icon = f.origin === 'local' ? 'edit' : 'lock';
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold', cls)}>
      <Icon name={icon} size={10} />
      {t(`origin.${f.origin}`)}
    </span>
  );
}

export function MenuScreen() {
  const t = useTranslations('menu');
  const tOps = useTranslations('ops.foods.menu');
  const locale = useLocale();
  const app = useApp();
  const locs = app.locations.filter((l) => app.scope.locationIds.includes(l.id));
  const views = [...(app.role === 'hq' ? [{ id: 'hq', label: t('master'), icon: 'building' as const }] : []), ...locs.map((l) => ({ id: l.id, label: l.name, icon: 'pin' as const }))];
  const [view, setView] = useState(views[0]?.id ?? 'hq');
  const v = views.some((x) => x.id === view) ? view : (views[0]?.id ?? 'hq');
  const res = useApi((api) => api.foods.menu(app.ctx, v), [app.role, v]);
  const reset = useMutation((api, itemId: string) => api.foods.resetMenuField(v, itemId, 'price'));
  const [toast, setToast] = useState('');

  return (
    <>
      <PageHeader icon="list" title={tOps('title')} description={tOps('description')} />
      <div role="group" aria-label={t('showAs')} className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[13px] font-semibold text-stone">{t('showAs')}</span>
        {views.map((x) => (
          <button key={x.id} type="button" aria-pressed={v === x.id} onClick={() => setView(x.id)} className={cx('flex h-10 items-center gap-1.5 rounded-full px-4 text-[13px] font-bold', v === x.id ? 'bg-ink text-white' : 'bg-surface')}>
            <Icon name={x.icon} size={14} />
            {x.label}
          </button>
        ))}
      </div>
      {toast && <Banner tone="success" live="polite">{toast}</Banner>}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
        {(items) => (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
            {items.map((m) => (
              <article key={m.id} className="flex flex-col overflow-hidden rounded-lg bg-surface">
                <div className="relative h-[150px] bg-blush">
                  <Image src={m.image} alt="" fill sizes="(max-width: 768px) 100vw, 360px" className="object-cover" />
                  <span className="absolute left-2.5 top-2.5">
                    <Badge tone={m.status === 'published' ? 'success' : m.status === 'draft' ? 'neutral' : 'warning'} className="shadow-card">
                      {t(`status.${m.status}`)}
                    </Badge>
                  </span>
                </div>
                <div className="flex flex-col gap-2 p-4">
                  <h3 className="text-[17px] font-bold">{m.name}</h3>
                  {m.statusNote && (
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-warning">
                      <Icon name="alert" size={12} />
                      {m.statusNote}
                    </p>
                  )}
                  {m.fields.map((f) => (
                    <div key={f.key} className="flex items-center justify-between gap-2 rounded-[14px] bg-canvas-raised px-2.5 py-2 text-[13px]">
                      <span className="text-stone">{f.label}</span>
                      <span className="flex flex-wrap items-center justify-end gap-1.5 text-right">
                        <strong className={cx('tabular', f.key === 'availability' && f.value === 'Sold out' && 'text-danger')}>{f.money ? moneyWithCode(f.money, locale) : f.value}</strong>
                        <Origin f={f} />
                        {f.resettable && (
                          <button
                            type="button"
                            title={t('resetToHq')}
                            aria-label={t('resetPriceOf', { name: m.name })}
                            disabled={reset.pending}
                            onClick={async () => {
                              const r = await reset.run(m.id);
                              if (r) {
                                res.setData(r);
                                setToast(t('resetDone', { name: m.name }));
                              }
                            }}
                            className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-line-soft bg-surface hover:border-ink"
                          >
                            <Icon name="undo" size={12} />
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  <p className="flex items-center gap-1 text-[11px] text-stone">
                    <Icon name="info" size={11} />
                    {t('dietaryNote')}
                  </p>
                </div>
              </article>
            ))}
          </div>
        )}
      </Async>
      {v === 'hq' && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface p-5">
          <div className="min-w-0 flex-1">
            <h2 className="font-bold">{t('publishTitle')}</h2>
            <p className="text-sm text-stone">{t('publishBody')}</p>
          </div>
          <Button variant="secondary" icon="eye" onClick={() => setToast(t('publishPreviewed'))}>
            {t('previewAffected')}
          </Button>
        </div>
      )}
    </>
  );
}
