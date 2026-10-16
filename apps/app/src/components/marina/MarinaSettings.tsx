'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Icon } from '@bh/ui';
import { AI_ACTION_RISKS, AI_TOOL_AREAS, ASSISTANT_NAME } from '@bh/shared';
import { fileToBase64, marina, type OrgAiSettings, type UsageView } from '@/lib/marina';
import { useErrorText } from '@/lib/useErrorText';
import { ApiError } from '@/lib/errors';
import { SectionCard } from '../ui/States';

/** Settings → assistant: monthly usage, organisation controls (AI admins), guardrails and the knowledge base. */
export function MarinaSettingsCard() {
  const t = useTranslations('marina');
  const errText = useErrorText();
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [s, setS] = useState<OrgAiSettings | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [kb, setKb] = useState<Awaited<ReturnType<typeof marina.knowledge>> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    marina.usage().then(setUsage).catch(() => {});
    marina.settings().then((r) => { setS(r.settings); setCanEdit(r.canEdit); }).catch(() => {});
    marina.knowledge().then(setKb).catch(() => {});
  }, []);
  const save = async (patch: Partial<OrgAiSettings>) => {
    if (!s) return;
    setS({ ...s, ...patch });
    try { setS((await marina.saveSettings(patch)).settings); setMsg(t('saved')); } catch (e) { setMsg(errText(e as ApiError)); }
  };
  const pct = usage ? Math.min(100, Math.round((usage.credits / Math.max(1, usage.allowance)) * 100)) : 0;
  return (
    <SectionCard title={t('settings.title', { name: ASSISTANT_NAME })} aside={<Icon name="sparkles" size={16} />}>
      <div className="flex flex-col gap-5" data-testid="marina-settings">
        {usage && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between text-sm"><strong>{t('settings.usage')}</strong><span className="text-stone">{t('settings.usageOf', { used: Math.round(usage.credits), allowance: usage.allowance, month: usage.month })}</span></div>
            <div className="h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className={usage.state === 'ok' ? 'h-full bg-ink' : 'h-full bg-[#C9A227]'} style={{ width: `${pct}%` }} /></div>
            <p className="text-xs text-stone">{t(`settings.state.${usage.state}`, { limit: usage.fairUseLimit })} {t('settings.creditExplainer')}</p>
            {usage.byFeature.length > 0 && (
              <table className="text-xs"><tbody>{usage.byFeature.map((f) => <tr key={f.feature}><td className="py-0.5 pr-4">{t.has(`feature.${f.feature}`) ? t(`feature.${f.feature}`) : f.feature}</td><td className="pr-4 text-right tabular-nums">{f.requests}</td><td className="text-right tabular-nums">{Math.round(f.credits * 100) / 100}</td></tr>)}</tbody></table>
            )}
          </div>
        )}
        {s && (
          <fieldset disabled={!canEdit} className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-bold">{t('settings.controls')}</legend>
            {!canEdit && <p className="text-xs text-stone">{t('settings.adminOnly')}</p>}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.enabled} onChange={(e) => save({ enabled: e.target.checked })} />{t('settings.enabled', { name: ASSISTANT_NAME })}</label>
            <div className="text-xs"><div className="mb-1 font-bold">{t('settings.areas')}</div>
              <div className="flex flex-wrap gap-3">{AI_TOOL_AREAS.filter((a) => a !== 'general').map((a) => {
                const on = !s.allowedAreas || s.allowedAreas.includes(a);
                return <label key={a} className="flex items-center gap-1.5"><input type="checkbox" checked={on} onChange={(e) => { const cur = s.allowedAreas ?? [...AI_TOOL_AREAS]; save({ allowedAreas: e.target.checked ? [...new Set([...cur, a])] : cur.filter((x) => x !== a) }); }} />{t(`area.${a}`)}</label>;
              })}</div>
            </div>
            <div className="text-xs"><div className="mb-1 font-bold">{t('settings.approval')}</div>
              <div className="flex flex-wrap gap-3">{AI_ACTION_RISKS.map((r) => <label key={r} className="flex items-center gap-1.5"><input type="checkbox" checked={s.approvalRequiredFor.includes(r)} onChange={(e) => save({ approvalRequiredFor: e.target.checked ? [...s.approvalRequiredFor, r] : s.approvalRequiredFor.filter((x) => x !== r) })} />{t(`risk.${r}`)}</label>)}</div>
            </div>
            <label className="flex max-w-xs flex-col gap-1 text-xs font-bold">{t('settings.retention')}
              <select value={s.retentionDays} onChange={(e) => save({ retentionDays: Number(e.target.value) })} className="h-9 rounded-sm border border-line-soft bg-surface px-2 font-normal">{[30, 90, 180, 365, 730].map((d) => <option key={d} value={d}>{t('settings.days', { days: d })}</option>)}</select>
            </label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.helpdeskAutoAnswer} onChange={(e) => save({ helpdeskAutoAnswer: e.target.checked })} />{t('settings.autoAnswer')}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!s.helpdeskAutoAnswer} checked={s.helpdeskAutoResolve} onChange={(e) => save({ helpdeskAutoResolve: e.target.checked })} />{t('settings.autoResolve')}</label>
            <label className="flex flex-col gap-1 text-xs font-bold">{t('settings.banned')}
              <textarea rows={2} defaultValue={s.guardrails.bannedClaims.join('\n')} onBlur={(e) => save({ guardrails: { ...s.guardrails, bannedClaims: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) } })} className="rounded-sm border border-line-soft bg-surface p-2 font-normal" />
            </label>
            <label className="flex flex-col gap-1 text-xs font-bold">{t('settings.disclaimers')}
              <textarea rows={2} defaultValue={s.guardrails.requiredDisclaimers.join('\n')} onBlur={(e) => save({ guardrails: { ...s.guardrails, requiredDisclaimers: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) } })} className="rounded-sm border border-line-soft bg-surface p-2 font-normal" />
            </label>
            {s.brandVoice.tone && <p className="text-xs text-stone">{t('settings.voice', { tone: s.brandVoice.tone, count: s.brandVoice.learnedFrom })}</p>}
          </fieldset>
        )}
        {kb && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-sm">{t('settings.knowledge')}</strong>
              {kb.canManage && (
                <span className="flex gap-2">
                  <input ref={fileRef} type="file" accept=".pdf,.docx,.md,.txt" className="sr-only" onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setBusy(true);
                    try { await marina.uploadKnowledge({ fileName: file.name, mimeType: file.type || 'text/markdown', dataBase64: await fileToBase64(file) }); setKb(await marina.knowledge()); } catch (err) { setMsg(errText(err as ApiError)); } finally { setBusy(false); e.target.value = ''; }
                  }} />
                  <Button size="sm" variant="secondary" icon="plus" loading={busy} onClick={() => fileRef.current?.click()}>{t('settings.upload')}</Button>
                  <Button size="sm" variant="ghost" icon="refresh" onClick={async () => { await marina.syncKnowledge(); setKb(await marina.knowledge()); }}>{t('settings.sync')}</Button>
                </span>
              )}
            </div>
            <p className="text-xs text-stone">{t('settings.knowledgeHint')}</p>
            <ul className="flex flex-col gap-1 text-xs">
              {kb.items.slice(0, 30).map((k) => (
                <li key={k.id} className="flex items-center gap-2 rounded-sm bg-canvas px-2.5 py-1.5">
                  <Icon name="file" size={12} /><span className="flex-1 truncate">{k.title}</span><span className="text-stone">{t(`source.${k.sourceType}`)} · {t('settings.chunks', { count: k.chunkCount })}</span>
                  {kb.canManage && k.sourceType === 'upload' && <button type="button" aria-label={t('settings.remove')} onClick={async () => { await marina.deleteKnowledge(k.id); setKb(await marina.knowledge()); }}><Icon name="x" size={12} /></button>}
                </li>
              ))}
              {!kb.items.length && <li className="text-stone">{t('settings.noKnowledge')}</li>}
            </ul>
          </div>
        )}
        <p className="text-xs text-stone">{t('settings.privacy', { name: ASSISTANT_NAME })}</p>
        {msg && <p role="status" className="text-xs">{msg}</p>}
      </div>
    </SectionCard>
  );
}
