'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Input, Select, Toggle, cx } from '@bh/ui';
import { LAUNCH_STEPS } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, LoadingBlock, SectionCard } from '../ui/States';
import { readUpload, scaleApi, useScale, useScaleAction, type LaunchRowVM, type LaunchVM } from './api';
import { ActionError, Progress, Tiles, useQFmt } from './ui';

/**
 * Network → Bulk launch: "launch your first 10 location sites in a day". A spreadsheet creates the locations from the
 * brand template with their sites (published or drafts), listings data and staff invitations; the progress board
 * follows every location step by step, and failed ones can be retried.
 */
export function LaunchScreen() {
  const t = useTranslations('scale');
  const app = useApp();
  const allowed = app.hasModule('network.bulk_launch');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useScale(() => scaleApi.launches(), [app.org.id], allowed);
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('id'); if (id) setOpenId(id); }, []);
  if (!allowed) return <DeniedState />;
  return (
    <>
      <PageHeader icon="zap" title={t('launch.title')} description={t('launch.description')} scope={false}
        actions={openId ? <Button variant="ghost" size="sm" icon="arrow-left" onClick={() => { setOpenId(null); list.reload(); }}>{t('launch.allLaunches')}</Button> : undefined} />
      {openId ? <Board id={openId} /> : (
        <Async res={list} loading={<LoadingBlock variant="detail" />}>
          {(d) => (
            <>
              {(d.can.edit || d.can.publish) && <NewLaunch templates={d.templates} canPublish={d.can.publish} onStarted={(l) => setOpenId(l.id)} />}
              <SectionCard title={t('launch.recent')}>
                {!d.items.length ? <p className="text-[13px] text-stone">{t('launch.none')}</p> : (
                  <ul className="flex flex-col divide-y divide-line-soft">
                    {d.items.map((l) => (
                      <li key={l.id} className="flex flex-wrap items-center gap-3 py-2.5">
                        <button type="button" className="font-bold underline-offset-2 hover:underline" onClick={() => setOpenId(l.id)}>{l.name}</button>
                        <LaunchStatus l={l} />
                        <span className="w-40"><Progress done={l.done} failed={l.failed} total={l.total} label={t('launch.progressOf', { name: l.name })} /></span>
                        <span className="text-xs text-stone">{t('launch.counts', { done: l.done, total: l.total })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </>
          )}
        </Async>
      )}
    </>
  );
}

function LaunchStatus({ l }: { l: Pick<LaunchVM, 'status'> }) {
  const t = useTranslations('scale');
  const tone = { queued: 'info', running: 'warning', completed: 'success', completed_with_errors: 'danger' } as const;
  return <Badge tone={tone[l.status]}>{t(`launchStatus.${l.status}`)}</Badge>;
}

function NewLaunch({ templates, canPublish, onStarted }: { templates: Array<{ id: string; name: string }>; canPublish: boolean; onStarted: (l: LaunchVM) => void }) {
  const t = useTranslations('scale');
  const act = useScaleAction();
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [siteMode, setSiteMode] = useState<'publish' | 'draft'>(canPublish ? 'publish' : 'draft');
  const [status, setStatus] = useState('opening_soon');
  const [invite, setInvite] = useState(true);
  const [parsed, setParsed] = useState<{ rows: LaunchRowVM[]; bad: Map<number, string[]> } | null>(null);
  const good = parsed ? parsed.rows.filter((_, i) => !parsed.bad.has(i + 1)) : [];
  return (
    <SectionCard title={t('launch.new')}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          <div className="w-64"><Field label={t('launch.name')}>{(x) => <Input id={x.id} value={name} placeholder={t('launch.namePlaceholder')} onChange={(e) => setName(e.target.value)} />}</Field></div>
          <div className="w-56"><Field label={t('launch.template')}>{(x) => (
            <Select id={x.id} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {!templates.length && <option value="">{t('launch.noTemplate')}</option>}
              {templates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
            </Select>
          )}</Field></div>
          <div className="w-48"><Field label={t('launch.sites')}>{(x) => (
            <Select id={x.id} value={siteMode} onChange={(e) => setSiteMode(e.target.value as 'publish' | 'draft')}>
              {canPublish && <option value="publish">{t('launch.sitePublish')}</option>}
              <option value="draft">{t('launch.siteDraft')}</option>
            </Select>
          )}</Field></div>
          <div className="w-48"><Field label={t('launch.locationStatus')}>{(x) => (
            <Select id={x.id} value={status} onChange={(e) => setStatus(e.target.value)}>
              {['onboarding', 'opening_soon', 'operating'].map((s) => <option key={s} value={s}>{t(`locStatus.${s}` as 'locStatus.onboarding')}</option>)}
            </Select>
          )}</Field></div>
          <label className="flex items-center gap-3 self-end pb-2 text-[13px]"><Toggle checked={invite} label={t('launch.inviteStaff')} onChange={setInvite} />{t('launch.inviteStaff')}</label>
        </div>
        <div className="w-80"><Field label={t('launch.sheet')} hint={t('launch.sheetHint')}>{(x) => (
          <input id={x.id} type="file" accept=".csv,.xlsx" className="block w-full text-sm file:mr-3 file:rounded-full file:border-0 file:bg-ink file:px-4 file:py-2 file:text-white" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const up = await readUpload(file);
            const r = await act.run(() => scaleApi.parseLaunch({ filename: up.filename, dataBase64: up.dataBase64 }));
            if (r) setParsed({ rows: r.rows, bad: new Map(r.errors.map((x) => [x.row, x.errors.map((y) => `${y.field}: ${y.message}`)])) });
          }} />
        )}</Field></div>
        <ActionError error={act.error} />
        {parsed && (
          <>
            {parsed.bad.size > 0 && <Banner tone="warning">{t('launch.rowsWithErrors', { count: parsed.bad.size })}</Banner>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="launch-rows">
                <thead>
                  <tr className="border-b border-line-soft text-left text-xs font-extrabold uppercase tracking-[0.06em] text-stone">
                    <th scope="col" className="px-2 py-2">{t('launch.col.location')}</th>
                    <th scope="col" className="px-2 py-2">{t('launch.col.city')}</th>
                    <th scope="col" className="px-2 py-2">{t('launch.col.zone')}</th>
                    <th scope="col" className="px-2 py-2">{t('launch.col.staff')}</th>
                    <th scope="col" className="px-2 py-2">{t('launch.col.check')}</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((r, i) => {
                    const errs = parsed.bad.get(i + 1);
                    const staff = [r.manager_email, ...(r.staff_emails ?? '').split(/[,;\s]+/)].filter(Boolean).length;
                    return (
                      <tr key={i} className={cx('border-b border-line-soft last:border-0', errs && 'bg-danger-bg/40')}>
                        <td className="px-2 py-2"><strong>{r.name}</strong> <span className="text-xs text-stone">{r.code}</span></td>
                        <td className="px-2 py-2">{r.city}, {r.country}</td>
                        <td className="px-2 py-2 text-stone">{r.time_zone} · {r.currency}</td>
                        <td className="tabular px-2 py-2">{staff}</td>
                        <td className="px-2 py-2">{errs ? <span className="text-danger">{errs.join(' · ')}</span> : <Badge tone="success" icon="check">{t('launch.ready')}</Badge>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div>
              <Button icon="zap" disabled={!good.length || !name.trim()} loading={act.pending} onClick={async () => {
                const l = await act.run(() => scaleApi.startLaunch({ name: name.trim(), templateId: templateId || null, siteMode, locationStatus: status, inviteStaff: invite, rows: good }));
                if (l) onStarted(l);
              }}>{t('launch.start', { count: good.length })}</Button>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}

type Column = 'queued' | (typeof LAUNCH_STEPS)[number] | 'done' | 'failed';
const COLUMNS: Column[] = ['queued', ...LAUNCH_STEPS, 'done', 'failed'];

function Board({ id }: { id: string }) {
  const t = useTranslations('scale');
  const f = useQFmt();
  const [tick, setTick] = useState(0);
  const res = useScale(() => scaleApi.launch(id), [id, tick]);
  const act = useScaleAction();
  const l = res.data;
  const busy = !l || l.status === 'queued' || l.status === 'running';
  useEffect(() => {
    if (!busy) return;
    const h = setTimeout(() => setTick((x) => x + 1), 1200);
    return () => clearTimeout(h);
  }, [busy, tick]);
  if (!l) return <LoadingBlock variant="detail" />;
  const columnOf = (it: NonNullable<LaunchVM['items']>[number]): Column => {
    if (it.status === 'done') return 'done';
    if (it.status === 'failed') return 'failed';
    if (it.status === 'queued') return 'queued';
    return (LAUNCH_STEPS.find((s) => it.steps[s]?.status !== 'done' && it.steps[s]?.status !== 'skipped') ?? 'done') as Column;
  };
  const items = l.items ?? [];
  return (
    <>
      <section className="flex flex-col gap-3 rounded-xl bg-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[20px] font-bold">{l.name}</h2>
          <LaunchStatus l={l} />
          <Badge tone="neutral">{l.siteMode === 'publish' ? t('launch.sitePublish') : t('launch.siteDraft')}</Badge>
          {l.finishedAt && <span className="text-xs text-stone">{t('launch.finished', { when: f.date(l.finishedAt) })}</span>}
          {l.failed > 0 && !busy && <Button size="sm" variant="secondary" icon="refresh" className="ml-auto" loading={act.pending} onClick={async () => { if (await act.run(() => scaleApi.retryLaunch(l.id))) setTick((x) => x + 1); }}>{t('launch.retry', { count: l.failed })}</Button>}
        </div>
        <Progress done={l.done} failed={l.failed} total={l.total} label={t('launch.progressOf', { name: l.name })} />
        <ActionError error={act.error} />
      </section>
      <Tiles items={[
        { label: t('launch.tiles.locations'), value: l.total },
        { label: t('launch.tiles.live'), value: l.done },
        { label: t('launch.tiles.inProgress'), value: l.total - l.done - l.failed },
        { label: t('launch.tiles.failed'), value: l.failed, tone: l.failed ? 'danger' : undefined },
        { label: t('launch.tiles.invitations'), value: items.reduce((a, i) => a + i.invitations, 0) },
      ]} />
      <section aria-label={t('launch.board')} className="grid gap-2 overflow-x-auto [grid-template-columns:repeat(7,minmax(140px,1fr))]" data-testid="launch-board">
        {COLUMNS.map((col) => {
          const cards = items.filter((it) => columnOf(it) === col);
          return (
            <div key={col} className={cx('flex min-h-[160px] flex-col gap-2 rounded-xl p-2.5', col === 'done' ? 'bg-lime/30' : col === 'failed' ? 'bg-danger-bg/50' : 'bg-surface')}>
              <h3 className="flex items-center justify-between px-1 text-xs font-extrabold uppercase tracking-[0.06em] text-stone">{t(`launch.col.${col}` as 'launch.col.queued')}<span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] text-ink">{cards.length}</span></h3>
              {cards.map((it) => (
                <article key={it.id} className="flex flex-col gap-1.5 rounded-lg bg-white p-2.5 shadow-sm">
                  <span className="text-[13px] font-bold leading-tight">{it.name}</span>
                  <span className="text-[11px] text-stone">{it.code}</span>
                  <span className="flex gap-1" aria-label={t('launch.stepsOf', { name: it.name })}>
                    {LAUNCH_STEPS.map((s) => {
                      const st = it.steps[s]?.status ?? 'pending';
                      return <span key={s} title={`${t(`launch.col.${s}` as 'launch.col.location')}: ${t(`stepStatus.${st}` as 'stepStatus.done')}`} className={cx('h-1.5 flex-1 rounded-full', st === 'done' ? 'bg-ink' : st === 'skipped' ? 'bg-line' : st === 'failed' ? 'bg-danger' : st === 'running' ? 'bg-warning' : 'bg-canvas')} />;
                    })}
                  </span>
                  {it.error && <span className="text-[11px] text-danger">{it.error}</span>}
                  {it.status === 'done' && <span className="text-[11px] text-stone">{t('launch.cardDone', { invites: it.invitations })}</span>}
                </article>
              ))}
            </div>
          );
        })}
      </section>
    </>
  );
}
