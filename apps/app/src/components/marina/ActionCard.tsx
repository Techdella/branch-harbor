'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Icon, cx } from '@bh/ui';
import type { AiActionCard } from '@bh/shared';
import { marina } from '@/lib/marina';
import { useErrorText } from '@/lib/useErrorText';
import { ApiError } from '@/lib/errors';

const RISK_TONE: Record<string, string> = {
  change: 'bg-canvas text-graphite', bulk: 'bg-[#E4EEFF] text-[#1D3F7A]', outbound: 'bg-[#FFF1C9] text-[#6B4A00]', publish: 'bg-[#FFF1C9] text-[#6B4A00]', money: 'bg-[#FCE3E1] text-[#8A1F17]', delete: 'bg-[#FCE3E1] text-[#8A1F17]',
};

/**
 * A proposed action: nothing has happened yet. The person reviews it, may edit the editable fields, and confirms or
 * cancels. Confirming runs it as them through the same checks as the app (or holds it for an HQ approver).
 */
export function ActionCard({ action, onChange, approver }: { action: AiActionCard; onChange?: (a: AiActionCard) => void; approver?: boolean }) {
  const t = useTranslations('marina');
  const errText = useErrorText();
  const [a, setA] = useState(action);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (next: AiActionCard) => {
    setA(next);
    onChange?.(next);
  };
  const run = async (fn: () => Promise<AiActionCard>) => {
    setBusy(true);
    setError(null);
    try {
      update(await fn());
      setEditing(false);
    } catch (e) {
      setError(errText(e instanceof ApiError ? e : new ApiError('unknown_error', String(e))));
    } finally {
      setBusy(false);
    }
  };
  const open = a.status === 'proposed';
  return (
    <div className={cx('flex flex-col gap-2.5 rounded-md border-[1.5px] bg-surface p-3.5', open ? 'border-ink' : 'border-line-soft')} data-testid="marina-action">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.06em] text-stone">
        <Icon name="workflow" size={13} />
        {t('action.kicker')}
        <span className={cx('rounded-full px-2 py-0.5 normal-case tracking-normal', RISK_TONE[a.risk] ?? RISK_TONE.change)}>{t(`risk.${a.risk}`)}</span>
      </div>
      <div className="text-sm font-bold">{a.title}</div>
      {a.summary && <p className="text-xs text-stone">{a.summary}</p>}
      {a.fromUntrustedContent && open && (
        <p className="flex items-start gap-1.5 rounded-sm bg-[#FFF1C9] px-2.5 py-1.5 text-[11px] font-semibold text-[#6B4A00]"><Icon name="alert" size={12} />{t('action.untrusted')}</p>
      )}
      {a.details.length > 0 && !editing && (
        <dl className="flex flex-col gap-1 rounded-sm bg-canvas p-2.5 text-xs">
          {a.details.slice(0, 12).map((d, i) => (
            <div key={i} className="grid grid-cols-[minmax(70px,30%)_1fr] gap-2">
              <dt className="font-bold">{d.label}</dt>
              <dd className="whitespace-pre-line break-words">{d.value.length > 600 ? `${d.value.slice(0, 600)}…` : d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {editing && (
        <div className="flex flex-col gap-2">
          {a.editable.map((f) => {
            const v = String(edits[f.key] ?? a.payload[f.key] ?? '');
            const set = (val: string) => setEdits((e) => ({ ...e, [f.key]: f.kind === 'number' ? Number(val) : f.kind === 'date' && val && val.length <= 16 ? new Date(val).toISOString() : val }));
            return (
              <label key={f.key} className="flex flex-col gap-1 text-xs font-bold">
                {f.label}
                {f.kind === 'textarea' ? (
                  <textarea value={v} onChange={(e) => set(e.target.value)} rows={5} className="rounded-sm border border-line-soft bg-surface p-2 text-xs font-normal" />
                ) : (
                  <input type={f.kind === 'number' ? 'number' : f.kind === 'date' ? 'datetime-local' : 'text'} value={f.kind === 'date' ? v.slice(0, 16) : v} onChange={(e) => set(e.target.value)} className="h-9 rounded-sm border border-line-soft bg-surface px-2 text-xs font-normal" />
                )}
              </label>
            );
          })}
        </div>
      )}
      {error && <p role="alert" className="text-xs font-semibold text-danger">{error}</p>}
      {open && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon="check" loading={busy} onClick={() => run(() => marina.confirm(a.id, edits))} data-testid="marina-confirm">{t('action.confirm')}</Button>
          {a.editable.length > 0 && <Button size="sm" variant="secondary" icon="edit" disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? t('action.doneEditing') : t('action.edit')}</Button>}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => marina.cancel(a.id))}>{t('action.cancel')}</Button>
        </div>
      )}
      {a.status === 'pending_approval' && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold"><Icon name="clock" size={12} />{t('action.pendingApproval')}</p>
          {approver && (
            <div className="flex gap-2">
              <Button size="sm" icon="check" loading={busy} onClick={() => run(() => marina.decide(a.id, 'approve'))}>{t('action.approve')}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => marina.decide(a.id, 'reject'))}>{t('action.reject')}</Button>
            </div>
          )}
        </div>
      )}
      {a.status === 'executed' && (
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold text-success" role="status">
          <Icon name="check-circle" size={12} />{t('action.done')}
          {a.link && <Link href={a.link} className="underline">{t('action.open')}</Link>}
        </p>
      )}
      {a.status === 'failed' && <p className="text-xs font-semibold text-danger" role="alert">{t('action.failed', { reason: String(a.result?.error ?? '') })}</p>}
      {(a.status === 'cancelled' || a.status === 'rejected') && <p className="text-xs text-stone">{t(a.status === 'cancelled' ? 'action.cancelled' : 'action.rejected')}</p>}
    </div>
  );
}
