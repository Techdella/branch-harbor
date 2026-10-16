'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@bh/ui';
import { ASSISTANT_NAME } from '@bh/shared';
import { marina } from '@/lib/marina';
import { useErrorText } from '@/lib/useErrorText';
import { ApiError } from '@/lib/errors';
import { APP_LOCALES, APP_LOCALE_LABELS } from '@/i18n/config';
import { PageHeader } from '../shell/PageHeader';
import { SectionCard } from '../ui/States';
import { useMarina } from './MarinaProvider';

const KINDS = ['email', 'social', 'ad', 'website_section', 'coming_soon'] as const;

/** Content studio: brand-voice copy with HQ guardrails, translations into the site locales, brand voice profile. */
export function ContentStudio() {
  const t = useTranslations('marina');
  const locale = useLocale();
  const m = useMarina();
  const errText = useErrorText();
  const [kind, setKind] = useState<(typeof KINDS)[number]>('email');
  const [brief, setBrief] = useState('');
  const [out, setOut] = useState<Awaited<ReturnType<typeof marina.generate>> | null>(null);
  const [targets, setTargets] = useState<string[]>(APP_LOCALES.filter((l) => l !== locale).slice(0, 2));
  const [tr, setTr] = useState<Awaited<ReturnType<typeof marina.translate>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<string | null>(null);
  const go = async <T,>(key: string, fn: () => Promise<T>, then: (v: T) => void) => {
    setBusy(key);
    setError(null);
    try { then(await fn()); } catch (e) { setError(errText(e instanceof ApiError ? e : new ApiError('unknown_error', String(e)))); } finally { setBusy(null); }
  };
  return (
    <>
      <PageHeader icon="edit" title={t('studio.title')} description={t('studio.description', { name: ASSISTANT_NAME })} scope={false}
        actions={m.info?.can.admin ? <Button variant="secondary" icon="marina" loading={busy === 'voice'} onClick={() => go('voice', marina.learnVoice, (r) => setVoice(r.learned ? t('studio.voiceLearned') : (r.reason ?? '')))}>{t('studio.learnVoice')}</Button> : undefined} />
      {voice && <SectionCard><p role="status" className="text-sm">{voice}</p></SectionCard>}
      <div className="grid gap-3 xl:grid-cols-2">
        <SectionCard title={t('studio.write')}>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void go('gen', () => marina.generate({ kind, brief, locale }), (r) => { setOut(r); setTr(null); }); }}>
            <label className="flex flex-col gap-1 text-xs font-bold">{t('studio.kind')}
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="h-10 rounded-sm border border-line-soft bg-surface px-2 text-sm font-normal">
                {KINDS.map((k) => <option key={k} value={k}>{t(`studio.kinds.${k}`)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs font-bold">{t('studio.brief')}
              <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} placeholder={t('studio.briefPlaceholder')} className="rounded-sm border border-line-soft bg-surface p-2 text-sm font-normal" />
            </label>
            <Button type="submit" icon="marina" loading={busy === 'gen'} disabled={brief.trim().length < 3}>{t('studio.generate')}</Button>
          </form>
        </SectionCard>
        <SectionCard title={t('studio.result')}>
          {out ? (
            <div className="flex flex-col gap-3">
              <textarea value={out.text} onChange={(e) => setOut({ ...out, text: e.target.value })} rows={10} className="rounded-sm border border-line-soft bg-surface p-2 text-sm" aria-label={t('studio.result')} />
              {(out.guardrails.bannedFound.length > 0 || out.guardrails.missingDisclaimers.length > 0) && (
                <p className="rounded-md bg-[#FFF1C9] p-2 text-xs text-[#6B4A00]">{t('studio.guardrailsApplied', { removed: out.guardrails.bannedFound.join(', ') || '—', added: out.guardrails.missingDisclaimers.join(' ') || '—' })}</p>
              )}
              {out.sandbox && <p className="text-xs text-stone">{t('sandboxHint')}</p>}
              <fieldset className="flex flex-wrap gap-3 text-xs">
                <legend className="mb-1 font-bold">{t('studio.translateInto')}</legend>
                {APP_LOCALES.filter((l) => l !== locale).map((l) => (
                  <label key={l} className="flex items-center gap-1.5"><input type="checkbox" checked={targets.includes(l)} onChange={(e) => setTargets((ts) => (e.target.checked ? [...ts, l] : ts.filter((x) => x !== l)))} />{APP_LOCALE_LABELS[l]}</label>
                ))}
              </fieldset>
              <Button variant="secondary" icon="globe" loading={busy === 'tr'} disabled={!targets.length} onClick={() => go('tr', () => marina.translate({ text: out.text, targetLocales: targets, sourceLocale: locale }), setTr)}>{t('studio.translate')}</Button>
              {tr && (
                <div className="flex flex-col gap-2">
                  {tr.note && <p className="text-xs text-stone">{tr.note}</p>}
                  {tr.translations.map((x) => (
                    <div key={x.locale} className="rounded-md bg-canvas p-2.5 text-sm"><div className="mb-1 text-[11px] font-bold uppercase text-stone">{APP_LOCALE_LABELS[x.locale as keyof typeof APP_LOCALE_LABELS] ?? x.locale}</div><p className="whitespace-pre-line">{x.text}</p></div>
                  ))}
                </div>
              )}
            </div>
          ) : <p className="text-sm text-stone">{t('studio.empty')}</p>}
        </SectionCard>
      </div>
      {error && <SectionCard><p role="alert" className="text-sm text-danger">{error}</p></SectionCard>}
    </>
  );
}
