'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Badge, Button, Icon, Select, cx } from '@bh/ui';
import type { Registration } from '@/lib/types';
import { useApi, useMutation } from '@/lib/useApi';
import { moneyWithCode } from '@/lib/format';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';

const STATUSES = ['awaiting_review', 'accepted', 'waitlisted'] as const;

export function RegistrationsScreen() {
  const t = useTranslations('registrations');
  const tOps = useTranslations('ops.sports.registrations');
  const locale = useLocale();
  const app = useApp();
  const [tab, setTab] = useState<(typeof STATUSES)[number]>('awaiting_review');
  const [groupSel, setGroupSel] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const res = useApi((api) => api.sports.registrations(app.ctx), [app.role, app.scopeId]);
  const decide = useMutation((api, id: string, decision: 'accept' | 'waitlist', groupId?: string) => api.sports.decide(id, { decision, groupId }));
  const canAct = app.role !== 'staff';

  const act = async (r: Registration, decision: 'accept' | 'waitlist') => {
    const out = await decide.run(r.id, decision, groupSel[r.id]);
    if (out) {
      setMsg(decision === 'accept' ? t('acceptedMsg', { name: r.participant }) : t('waitlistedMsg', { name: r.participant }));
      res.reload();
    }
  };

  return (
    <>
      <PageHeader icon="file" title={tOps('title')} description={tOps('description')} />
      <Async res={res} loading={<LoadingBlock variant="cards" rows={4} />}>
        {(data) => {
          const items = data.items.filter((r) => r.status === tab);
          return (
            <>
              <div role="tablist" aria-label={t('statusTabs')} className="flex flex-wrap gap-1.5">
                {STATUSES.map((s) => (
                  <button key={s} role="tab" aria-selected={tab === s} type="button" onClick={() => setTab(s)} className={cx('h-10 rounded-full px-4 text-[13px] font-bold', tab === s ? 'bg-ink text-white' : 'bg-surface')}>
                    {t(`status.${s}`)} · {data.items.filter((r) => r.status === s).length}
                  </button>
                ))}
              </div>
              {msg && <Banner tone="success" live="polite">{msg}</Banner>}
              {decide.error && <Banner tone="danger" live="assertive">{decide.error.message}</Banner>}
              {!canAct && <Banner tone="neutral" icon="lock">{t('coachReadOnly')}</Banner>}
              {items.length === 0 ? (
                <Empty icon="file" title={t('empty')} />
              ) : (
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))]">
                  {items.map((r) => {
                    const g = groupSel[r.id] ?? '';
                    const group = data.groups.find((x) => x.id === g);
                    const blocked = !r.formsComplete || !g || (group ? group.roster >= group.capacity : false);
                    return (
                      <article key={r.id} className="flex flex-col gap-2.5 rounded-lg bg-surface p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={r.participant} size={42} />
                            <div>
                              <h3 className="text-[15px] font-bold">{r.participant}</h3>
                              <div className="text-xs text-stone">{t('ageProgramme', { age: r.age, programme: r.programme })}</div>
                            </div>
                          </div>
                          <Badge tone={r.status === 'accepted' ? 'success' : r.status === 'waitlisted' ? 'info' : 'warning'}>{t(`status.${r.status}`)}</Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-xs">
                          <div className="rounded-sm bg-canvas px-2.5 py-2">
                            <div className="text-stone">{t('guardian')}</div>
                            <strong>{r.guardian}</strong>
                            <div className={r.guardianVerified ? 'text-success' : 'text-warning'}>{r.guardianVerified ? t('verified') : t('invitationPending')}</div>
                          </div>
                          <div className="rounded-sm bg-canvas px-2.5 py-2">
                            <div className="text-stone">{t('payment')}</div>
                            <strong>
                              {r.payment.label}
                              {r.payment.amount && ` · ${moneyWithCode(r.payment.amount, locale)}`}
                            </strong>
                          </div>
                        </div>
                        <div className={cx('flex items-center gap-1.5 text-xs', r.formsComplete ? 'text-success' : 'font-bold text-danger')}>
                          <Icon name={r.formsComplete ? 'check-circle' : 'alert'} size={13} />
                          {r.formsNote}
                        </div>
                        {r.status === 'accepted' && r.groupId && <div className="text-xs">{t('inGroup', { group: data.groups.find((x) => x.id === r.groupId)?.name ?? '' })}</div>}
                        {r.status === 'awaiting_review' && canAct && (
                          <div className="flex flex-col gap-1.5">
                            <label className="sr-only" htmlFor={`grp-${r.id}`}>{t('assignGroup')}</label>
                            <Select id={`grp-${r.id}`} value={g} onChange={(e) => setGroupSel((s) => ({ ...s, [r.id]: e.target.value }))}>
                              <option value="">{t('assignGroupPlaceholder')}</option>
                              {data.groups.map((gr) => (
                                <option key={gr.id} value={gr.id} disabled={gr.roster >= gr.capacity}>
                                  {gr.name} · {gr.roster >= gr.capacity ? t('full') : `${gr.roster}/${gr.capacity}`}
                                </option>
                              ))}
                            </Select>
                            <div className="flex gap-1.5">
                              <Button size="sm" className="flex-1" disabled={blocked} loading={decide.pending} onClick={() => act(r, 'accept')}>
                                {t('accept')}
                              </Button>
                              <Button size="sm" variant="secondary" onClick={() => act(r, 'waitlist')}>
                                {t('waitlist')}
                              </Button>
                            </div>
                            {!r.formsComplete && <p className="text-[11px] text-stone">{t('formsBlock')}</p>}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-stone">{t('paymentNotSelection')}</p>
            </>
          );
        }}
      </Async>
    </>
  );
}
