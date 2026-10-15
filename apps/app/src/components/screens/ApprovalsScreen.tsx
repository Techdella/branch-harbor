'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Tabs, Textarea, cx } from '@bh/ui';
import type { IconName } from '@bh/icons';
import type { ApprovalKind, ApprovalRequest } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { moneyWithCode, relativeTime } from '@/lib/format';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { useDataText } from '../ui/useDataText';

const KIND_UI: Record<ApprovalKind, { icon: IconName; bg: string }> = {
  refund: { icon: 'undo', bg: 'bg-blush' },
  ad_spend: { icon: 'megaphone', bg: 'bg-lilac' },
  shift_swap: { icon: 'repeat', bg: 'bg-aqua' },
  field: { icon: 'globe', bg: 'bg-butter' },
  page: { icon: 'globe', bg: 'bg-butter' },
};

/**
 * One inbox for owners / HQ: refunds over the organisation's threshold, local ad spend, shift swaps and website
 * changes. Every decision shows its consequence first; approving runs the underlying action on the server.
 */
export function ApprovalsScreen() {
  const t = useTranslations('approvals');
  const app = useApp();
  const [tab, setTab] = useState<'pending' | 'done'>('pending');
  const [kind, setKind] = useState<'all' | ApprovalKind>('all');
  const res = useApi((api) => api.approvals.list(app.ctx, tab), [app.industry, app.role, app.scopeId, tab], app.can('locations.read'));
  if (!app.can('locations.read')) return <DeniedState permission="locations.read" detail={t('denied')} />;

  return (
    <>
      <PageHeader icon="shield" title={t('title')} description={t('description')} />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs items={[{ key: 'pending', label: t('tab.pending') }, { key: 'done', label: t('tab.done') }]} value={tab} onChange={setTab} />
        <div role="group" aria-label={t('filter')} className="flex flex-wrap gap-1.5">
          {(['all', 'refund', 'ad_spend', 'shift_swap', 'field'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={cx('h-9 rounded-full border-[1.5px] px-3.5 text-[13px] font-semibold', kind === k ? 'border-ink bg-ink text-white' : 'border-line-soft bg-surface hover:border-ink')}>
              {t(`kind.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <Async res={res} loading={<LoadingBlock variant="cards" rows={3} />}>
        {(items) => {
          // Cards decided in this session stay visible (with their result) until the list is reloaded.
          const list = items.filter((a) => kind === 'all' || a.kind === kind || (kind === 'field' && a.kind === 'page'));
          if (!list.length) return <Empty icon="check-circle" title={tab === 'pending' ? t('emptyTitle') : t('emptyDoneTitle')} body={tab === 'pending' ? t('emptyBody') : undefined} />;
          return (
            <div className="grid items-start gap-3 lg:grid-cols-2">
              {list.map((a) => (
                <ApprovalCard key={a.id} a={a} onDecided={(u) => res.setData(items.map((x) => (x.id === u.id ? u : x)))} />
              ))}
            </div>
          );
        }}
      </Async>
      <p className="text-xs text-stone">{t('footer')}</p>
    </>
  );
}

function ApprovalCard({ a, onDecided }: { a: ApprovalRequest; onDecided: (a: ApprovalRequest) => void }) {
  const t = useTranslations('approvals');
  const locale = useLocale();
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const decide = useMutation((api, id: string, d: 'approve' | 'reject', c?: string) => api.approvals.decide(id, d, c));
  const dt = useDataText();
  const title = dt(a.titleKey, a.titleParams, a.title);
  const ui = KIND_UI[a.kind];
  const amount = a.amount ? moneyWithCode(a.amount, locale) : '';
  const consequence = deciding === 'reject'
    ? t('consequence.reject')
    : a.kind === 'refund' ? t('consequence.refund', { amount, location: a.locationName })
    : a.kind === 'ad_spend' ? t('consequence.ad_spend', { amount, location: a.locationName })
    : a.kind === 'shift_swap' ? t('consequence.shift_swap', { from: a.details.find((d) => (d.key ?? d.label) === 'from' || d.label === 'From')?.value ?? '', to: a.details.find((d) => (d.key ?? d.label) === 'to' || d.label === 'To')?.value ?? '' })
    : t('consequence.website', { location: a.locationName });
  const needsComment = deciding === 'reject' && (a.kind === 'field' || a.kind === 'page');

  return (
    <article className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-labelledby={`ap-${a.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-extrabold text-ink', ui.bg)}>
          <Icon name={ui.icon} size={14} />
          {t(`kind.${a.kind}`)}
        </span>
        <span className="ml-auto text-xs text-stone">{relativeTime(a.requestedAt, locale)}</span>
      </div>
      <div>
        <h2 id={`ap-${a.id}`} className="text-base font-bold">{title}</h2>
        <p className="text-[13px] text-stone">{t('requested', { location: a.locationName, name: a.requestedBy })}</p>
      </div>
      {a.amount && (
        <div className="flex items-baseline gap-2">
          <span className="tabular text-2xl font-extrabold">{amount}</span>
          <Badge tone="neutral">{a.amount.currency}</Badge>
        </div>
      )}
      {a.details.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          {a.details.map((d) => (
            <div key={d.key ?? d.label} className="contents">
              <dt className="text-stone">{dt(d.key ? `approval.detail.${d.key}` : undefined, undefined, d.label)}</dt>
              <dd className="font-semibold">{dt(d.valueKey, d.valueParams, d.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {a.reason && <p className="rounded-md bg-canvas-raised px-3 py-2 text-[13px]">“{a.reason}”</p>}

      {a.status === 'pending' ? (
        a.canDecide ? (
          deciding ? (
            <div className="flex flex-col gap-2 rounded-lg border-[1.5px] border-line-soft p-3.5" role="group" aria-label={t('confirmTitle')}>
              <p className="text-sm font-semibold" aria-live="polite">{consequence}</p>
              <Field label={needsComment ? t('commentRequired') : t('comment')} error={decide.error?.fields?.comment}>
                {(p) => <Textarea id={p.id} aria-invalid={p.invalid} aria-describedby={p.describedBy} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}
              </Field>
              {decide.error && !decide.error.fields?.comment && <Banner tone="danger" live="assertive">{decide.error.message}</Banner>}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={deciding === 'approve' ? 'primary' : 'danger'}
                  loading={decide.pending}
                  disabled={needsComment && !comment.trim()}
                  onClick={async () => {
                    const u = await decide.run(a.id, deciding, comment.trim() || undefined);
                    if (u) {
                      setDone(u.status === 'approved' ? t('approvedDone', { result: dt(u.resultKey, u.resultParams, u.result ?? '') }) : t('rejectedDone'));
                      setDeciding(null);
                      onDecided(u);
                    }
                  }}
                >
                  {deciding === 'approve' ? t('confirmApprove') : t('confirmReject')}
                </Button>
                <Button variant="secondary" onClick={() => (setDeciding(null), decide.clearError())}>{t('cancel')}</Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button variant="secondary" icon="x" onClick={() => setDeciding('reject')} aria-label={`${t('reject')}: ${title}`}>{t('reject')}</Button>
              <Button icon="check" onClick={() => setDeciding('approve')} aria-label={`${t('approve')}: ${title}`}>{t('approve')}</Button>
            </div>
          )
        ) : (
          <Badge tone="info" icon="clock">{t('waiting')}</Badge>
        )
      ) : (
        <div className="flex flex-col gap-1">
          <Badge tone={a.status === 'approved' ? 'success' : 'neutral'} icon={a.status === 'approved' ? 'check-circle' : 'x'}>
            {t(`status.${a.status}`, { name: a.decidedBy ?? '—' })}
          </Badge>
          {a.result && <span className="text-xs text-stone">{dt(a.resultKey, a.resultParams, a.result)}</span>}
          {a.decisionComment && <span className="text-xs text-stone">“{a.decisionComment}”</span>}
        </div>
      )}
      {done && <Banner tone="success" live="polite">{done}</Banner>}
    </article>
  );
}
