'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Icon } from '@bh/ui';
import { call } from '@/lib/client';
import { ErrorSummary } from '@/components/forms';
import type { ValidationView } from '@/lib/franchise';

/** One validator: their intro, their own booking link if they have one, otherwise a "propose times" form. */
export function ValidationCall({ token, c }: { token: string; c: ValidationView['calls'][number] }) {
  const t = useTranslations('franchiseSite');
  const locale = useLocale();
  const [times, setTimes] = useState('');
  const [sent, setSent] = useState<string | null>(c.proposedTimes);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = `times-${c.id}`;
  return (
    <article className="card flex flex-col gap-3 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-full bg-canvas"><Icon name="user" /></span>
        <div className="min-w-0">
          <h2 className="font-bold">{c.validator.firstName}</h2>
          <p className="text-sm text-graphite">{[c.validator.location, c.validator.city].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      {c.validator.bio && <p className="text-graphite">{c.validator.bio}</p>}
      {c.status === 'completed' ? (
        <p className="flex items-center gap-2 font-bold text-success"><Icon name="check-circle" size={18} />{t('validationDone')}</p>
      ) : c.scheduledAt ? (
        <p className="flex items-center gap-2 font-bold"><Icon name="calendar" size={18} />{t('validationScheduled', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(c.scheduledAt)) })}</p>
      ) : c.validator.schedulingUrl ? (
        <a className="btn btn-primary self-start" href={c.validator.schedulingUrl} target="_blank" rel="noreferrer"><Icon name="calendar" size={16} />{t('validationBook')}</a>
      ) : sent ? (
        <p role="status" className="text-sm text-graphite">{t('validationProposed', { times: sent })}</p>
      ) : (
        <form className="flex flex-col gap-2" noValidate onSubmit={async (e) => {
          e.preventDefault();
          if (times.trim().length < 3) { setErr(t('validationProposeHint')); return; }
          setBusy(true);
          const r = await call('POST', `/public/franchise/validation/${encodeURIComponent(token)}/calls/${c.id}`, { proposedTimes: times.trim() });
          setBusy(false);
          if (!r.ok) { setErr(r.error.message); return; }
          setSent(times.trim());
        }}>
          <ErrorSummary message={err} />
          <label htmlFor={fieldId} className="font-semibold">{t('validationPropose')}</label>
          <textarea id={fieldId} rows={2} className="input min-h-20 rounded-md border border-line p-3" value={times} onChange={(e) => setTimes(e.target.value)} />
          <p className="text-xs text-graphite">{t('validationProposeHint')}</p>
          <button type="submit" className="btn btn-primary self-start" disabled={busy}><Icon name="send" size={16} />{t('validationSend')}</button>
        </form>
      )}
    </article>
  );
}
