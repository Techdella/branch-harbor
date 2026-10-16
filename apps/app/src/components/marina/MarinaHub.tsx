'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Icon, cx } from '@bh/ui';
import { ASSISTANT_NAME, BRIEFING_SECTIONS, type AiActionCard, type BriefingItem } from '@bh/shared';
import { marina, type Briefing, type Insight } from '@/lib/marina';
import { useErrorText } from '@/lib/useErrorText';
import { ApiError } from '@/lib/errors';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { LoadingBlock, SectionCard } from '../ui/States';
import { ActionCard } from './ActionCard';
import { useFormatters } from './Blocks';
import { MarinaMark } from './MarinaPanel';
import { useMarina } from './MarinaProvider';

const SEV: Record<string, string> = { critical: 'bg-[#FCE3E1] text-[#8A1F17]', warning: 'bg-[#FFF1C9] text-[#6B4A00]', info: 'bg-[#E4EEFF] text-[#1D3F7A]' };

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const reload = () => fn().then((d) => { setData(d); setError(null); }).catch((e) => setError(e instanceof ApiError ? e : new ApiError('unknown_error', String(e))));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { data, error, reload, setData };
}

function BriefingList({ items, compact }: { items: BriefingItem[]; compact?: boolean }) {
  const t = useTranslations('marina');
  if (!items.length) return <p className="text-sm text-stone">{t('briefing.nothing')}</p>;
  return (
    <ul className="flex flex-col gap-2" data-testid="marina-briefing-items">
      {items.slice(0, compact ? 4 : 50).map((i, n) => (
        <li key={n} className="flex items-start gap-2.5 rounded-md bg-canvas px-3 py-2.5">
          <span className={cx('mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase', SEV[i.severity])}>{t(`severity.${i.severity}`)}</span>
          <div className="min-w-0 flex-1">
            {i.link ? <Link href={i.link} className="text-[13px] font-bold hover:underline">{i.title}</Link> : <span className="text-[13px] font-bold">{i.title}</span>}
            {!compact && i.detail && <p className="mt-0.5 text-xs text-stone">{i.detail}</p>}
            {!compact && i.suggestion && <p className="mt-0.5 flex items-start gap-1 text-xs text-ink"><Icon name="arrow-right" size={12} className="mt-0.5 shrink-0" />{i.suggestion}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The home card on every workspace home: today's briefing, insights and a quick question. */
export function MarinaHomeCard() {
  const t = useTranslations('marina');
  const m = useMarina();
  const app = useApp();
  const briefing = useLoad(() => marina.briefing(), [app.org.id]);
  const insights = useLoad(() => marina.insights(), [app.org.id]);
  const [q, setQ] = useState('');
  if (!m.available) return null;
  return (
    <section aria-label={t('home.title', { name: ASSISTANT_NAME })} className="flex flex-col gap-4 rounded-xl bg-[linear-gradient(135deg,#EEF3FD,#F3EEFC_55%,#ECF7F4)] p-5 md:p-6" data-testid="marina-home">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <MarinaMark size={40} />
          <div>
            <h2 className="text-lg font-bold">{t('home.title', { name: ASSISTANT_NAME })}</h2>
            <p className="text-xs text-stone">{t('home.subtitle')}</p>
          </div>
        </div>
        <Link href="/marina" className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3.5 py-2 text-xs font-bold hover:bg-canvas">{t('home.open', { name: ASSISTANT_NAME })}<Icon name="arrow-right" size={12} /></Link>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-2.5 rounded-lg bg-surface p-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-stone">{t('briefing.today')}</div>
          {briefing.data ? (
            <>
              {briefing.data.summary && <p className="text-sm">{briefing.data.summary}</p>}
              <BriefingList items={briefing.data.items} compact />
            </>
          ) : briefing.error ? <p className="text-sm text-stone">{briefing.error.message}</p> : <LoadingBlock variant="table" rows={3} />}
        </div>
        <div className="flex flex-col gap-2.5 rounded-lg bg-surface p-4">
          <div className="text-[11px] font-bold uppercase tracking-[0.06em] text-stone">{t('insights.title')}</div>
          {insights.data ? (insights.data.length ? (
            <ul className="flex flex-col gap-1.5">
              {insights.data.slice(0, 3).map((i) => (
                <li key={i.id}><Link href={`/marina?insight=${i.id}`} className="flex items-start gap-2 text-[13px] hover:underline"><span className={cx('mt-1 h-2 w-2 shrink-0 rounded-full', i.severity === 'critical' ? 'bg-danger' : i.severity === 'warning' ? 'bg-[#C9A227]' : 'bg-[#2E6FD8]')} />{i.title}</Link></li>
              ))}
            </ul>
          ) : <p className="text-sm text-stone">{t('insights.none')}</p>) : <LoadingBlock variant="table" rows={2} />}
          <form className="mt-auto flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { m.ask(q); setQ(''); } }}>
            <label className="flex-1"><span className="sr-only">{t('askLabel', { name: ASSISTANT_NAME })}</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('askPlaceholder', { name: ASSISTANT_NAME })} className="h-10 w-full rounded-full bg-canvas px-4 text-sm outline-none" />
            </label>
            <button type="submit" aria-label={t('send')} className="flex h-10 w-10 items-center justify-center rounded-full bg-ink text-white"><Icon name="send" size={14} /></button>
          </form>
        </div>
      </div>
    </section>
  );
}

function InsightCard({ insight, onDone }: { insight: Insight; onDone: () => void }) {
  const t = useTranslations('marina');
  const errText = useErrorText();
  const [card, setCard] = useState<AiActionCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <article className="flex flex-col gap-2.5 rounded-lg border border-line-soft bg-surface p-4" data-testid="marina-insight">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase', SEV[insight.severity])}>{t(`severity.${insight.severity}`)}</span>
        <span className="text-[11px] font-semibold text-stone">{t.has(`insightKind.${insight.kind}`) ? t(`insightKind.${insight.kind}`) : insight.kind}</span>
      </div>
      <h3 className="text-[15px] font-bold">{insight.title}</h3>
      <p className="text-sm text-graphite">{insight.explanation}</p>
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-fit text-xs font-bold underline" aria-expanded={open}>{open ? t('insights.hideEvidence') : t('insights.showEvidence')}</button>
      {open && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-canvas p-3 text-xs">
          {insight.evidence.map((e, i) => <div key={i} className="contents"><dt className="font-bold">{e.label}</dt><dd>{e.value}</dd></div>)}
        </dl>
      )}
      {card ? <ActionCard action={card} onChange={(a) => a.status !== 'proposed' && onDone()} /> : (
        <div className="flex flex-wrap gap-2">
          {insight.suggestedActions.map((a) => (
            <Button key={a.index} size="sm" variant="secondary" icon="marina" onClick={async () => { try { setCard(await marina.actOnInsight(insight.id, a.index)); } catch (e) { setError(errText(e as ApiError)); } }}>{a.label}</Button>
          ))}
          <Button size="sm" variant="ghost" onClick={async () => { await marina.dismissInsight(insight.id); onDone(); }}>{t('insights.dismiss')}</Button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </article>
  );
}

function BriefingSettings() {
  const t = useTranslations('marina');
  const prefs = useLoad(() => marina.prefs(), []);
  const [saved, setSaved] = useState(false);
  if (!prefs.data) return null;
  const p = prefs.data;
  const save = async (patch: Record<string, unknown>) => {
    prefs.setData({ ...p, ...patch } as typeof p);
    await marina.savePrefs(patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <details className="rounded-lg bg-canvas p-3 text-sm">
      <summary className="cursor-pointer font-bold">{t('briefing.settings')}</summary>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-bold">{t('briefing.frequency')}
          <select value={p.briefingFrequency} onChange={(e) => save({ briefingFrequency: e.target.value })} className="h-9 rounded-sm border border-line-soft bg-surface px-2 font-normal">
            {(['daily', 'weekly', 'off'] as const).map((f) => <option key={f} value={f}>{t(`briefing.freq.${f}`)}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-bold">{t('briefing.hour')}
          <select value={p.briefingHour} onChange={(e) => save({ briefingHour: Number(e.target.value) })} className="h-9 rounded-sm border border-line-soft bg-surface px-2 font-normal">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, '0')}:00`}</option>)}
          </select>
        </label>
        <div className="flex flex-col gap-1.5 text-xs">
          <label className="flex items-center gap-2"><input type="checkbox" checked={p.briefingInApp} onChange={(e) => save({ briefingInApp: e.target.checked })} />{t('briefing.inApp')}</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={p.briefingEmail} onChange={(e) => save({ briefingEmail: e.target.checked })} />{t('briefing.email')}</label>
        </div>
      </div>
      <fieldset className="mt-3 flex flex-wrap gap-3 text-xs">
        <legend className="mb-1 font-bold">{t('briefing.sections')}</legend>
        {BRIEFING_SECTIONS.map((s) => {
          const on = !p.sections.length || p.sections.includes(s);
          return (
            <label key={s} className="flex items-center gap-1.5"><input type="checkbox" checked={on} onChange={(e) => {
              const cur = p.sections.length ? p.sections : [...BRIEFING_SECTIONS];
              save({ sections: e.target.checked ? [...new Set([...cur, s])] : cur.filter((x) => x !== s) });
            }} />{t(`briefing.section.${s}`)}</label>
          );
        })}
      </fieldset>
      {saved && <p role="status" className="mt-2 text-xs text-success">{t('saved')}</p>}
    </details>
  );
}

function SetupAssistant() {
  const t = useTranslations('marina');
  const errText = useErrorText();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Awaited<ReturnType<typeof marina.setup>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <SectionCard title={t('setup.title', { name: ASSISTANT_NAME })}>
      <p className="mb-3 text-sm text-stone">{t('setup.body')}</p>
      <form className="flex flex-col gap-2 md:flex-row" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { setRes(await marina.setup(msg)); } catch (err) { setError(errText(err as ApiError)); } finally { setBusy(false); } }}>
        <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={t('setup.placeholder')} className="h-11 flex-1 rounded-full bg-canvas px-4 text-sm outline-none" aria-label={t('setup.title', { name: ASSISTANT_NAME })} />
        <Button type="submit" icon="marina" loading={busy} disabled={msg.trim().length < 5}>{t('setup.plan')}</Button>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {res && (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-sm font-semibold">{res.plan.summary}</p>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md bg-canvas p-3 text-xs">
              <div className="mb-1 font-bold">{t('setup.team')}</div>
              <ul className="flex flex-col gap-1">{res.plan.team.map((r) => <li key={r.role}><strong>{r.count} × {r.role.replace(/_/g, ' ')}</strong>: {r.why}</li>)}</ul>
            </div>
            {res.plan.theme && <div className="rounded-md bg-canvas p-3 text-xs"><div className="mb-1 font-bold">{t('setup.theme')}</div>{res.plan.theme.id}: {res.plan.theme.why}</div>}
          </div>
          {res.actions.map((a) => <ActionCard key={a.id} action={a} />)}
        </div>
      )}
    </SectionCard>
  );
}

/** /marina: briefing, insights feed, actions to confirm or approve, tasks and tools. */
export function MarinaHub() {
  const t = useTranslations('marina');
  const m = useMarina();
  const f = useFormatters();
  const app = useApp();
  const briefing = useLoad<Briefing>(() => marina.briefing(), [app.org.id]);
  const insights = useLoad(() => marina.insights(), [app.org.id]);
  const actions = useLoad(() => marina.actions(), [app.org.id]);
  const tasks = useLoad(() => marina.tasks(), [app.org.id]);
  const [refreshing, setRefreshing] = useState(false);
  const admin = !!m.info?.can.admin;
  return (
    <>
      <PageHeader icon="marina" title={ASSISTANT_NAME} description={t('hub.description', { name: ASSISTANT_NAME })} scope={false}
        actions={<>
          <Button variant="secondary" icon="marina" onClick={() => app.setAiOpen(true)}>{t('hub.ask', { name: ASSISTANT_NAME })}</Button>
          <Link href="/marina/visit-brief" className="inline-flex h-11 items-center gap-2 rounded-full bg-canvas px-4 text-sm font-bold"><Icon name="pin" size={15} />{t('visit.title')}</Link>
          <Link href="/marina/studio" className="inline-flex h-11 items-center gap-2 rounded-full bg-canvas px-4 text-sm font-bold"><Icon name="edit" size={15} />{t('studio.title')}</Link>
        </>} />
      <div className="grid gap-3 xl:grid-cols-[1.3fr_1fr]">
        <SectionCard title={t('briefing.today')} aside={<Button size="sm" variant="ghost" icon="refresh" loading={refreshing} onClick={async () => { setRefreshing(true); briefing.setData(await marina.briefing(true)); setRefreshing(false); }}>{t('briefing.refresh')}</Button>}>
          <div className="flex flex-col gap-3" data-testid="marina-briefing">
            {briefing.data ? (
              <>
                {briefing.data.summary && <p className="text-[15px]">{briefing.data.summary}</p>}
                <BriefingList items={briefing.data.items} />
                <p className="text-[11px] text-stone">{t('briefing.prepared', { when: f.date(briefing.data.createdAt) })}</p>
              </>
            ) : briefing.error ? <p className="text-sm text-stone">{briefing.error.message}</p> : <LoadingBlock variant="table" rows={4} />}
            <BriefingSettings />
          </div>
        </SectionCard>
        <div className="flex flex-col gap-3">
          {actions.data && (actions.data.mine.length > 0 || actions.data.toApprove.length > 0) && (
            <SectionCard title={t('hub.actions')}>
              <div className="flex flex-col gap-2.5">
                {actions.data.toApprove.map((a) => <ActionCard key={a.id} action={a} approver onChange={() => actions.reload()} />)}
                {actions.data.mine.map((a) => <ActionCard key={a.id} action={a} onChange={() => tasks.reload()} />)}
              </div>
            </SectionCard>
          )}
          <SectionCard title={t('hub.tasks')}>
            {tasks.data?.length ? (
              <ul className="flex flex-col gap-1.5">
                {tasks.data.map((x) => (
                  <li key={x.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" aria-label={t('hub.done')} onChange={async () => { await marina.completeTask(x.id); tasks.reload(); }} />
                    {x.link ? <Link href={x.link} className="flex-1 hover:underline">{x.title}</Link> : <span className="flex-1">{x.title}</span>}
                    <span className="text-[11px] text-stone">{f.date(x.dueAt ?? x.remindAt)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-stone">{t('hub.noTasks', { name: ASSISTANT_NAME })}</p>}
          </SectionCard>
        </div>
      </div>
      <SectionCard title={t('insights.title')} aside={admin ? <Button size="sm" variant="ghost" icon="refresh" onClick={async () => { await marina.runInsights(); insights.reload(); }}>{t('insights.run')}</Button> : undefined}>
        <div className="grid gap-3 md:grid-cols-2" data-testid="marina-insights">
          {insights.data ? (insights.data.length ? insights.data.map((i) => <InsightCard key={i.id} insight={i} onDone={() => insights.reload()} />) : <p className="text-sm text-stone">{t('insights.none')}</p>) : <LoadingBlock variant="cards" rows={2} />}
        </div>
      </SectionCard>
      {admin && <SetupAssistant />}
    </>
  );
}
