'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon } from '@bh/ui';
import { eligibleBirthDates } from '@bh/shared';
import type { SProgramme } from '@/lib/sports/types';
import { useSports, useSportsAction } from '@/lib/sports/useSports';
import { useApp } from '../../shell/AppContext';
import { PageHeader } from '../../shell/PageHeader';
import { Async, Banner, Empty, LoadingBlock } from '../../ui/States';
import { SetupWizard } from './SetupWizard';
import { Amount, CapacityBar, fmtDate, useScopeIds } from './ui';

/** Season/camp catalogue: age groups (rule + birth dates), venue, fees, registration window; setup wizard; AI drafts. */
export function ProgrammesScreen() {
  const t = useTranslations('sportsHub.programmes');
  const tOps = useTranslations('ops.sports.programmes');
  const locale = useLocale();
  const app = useApp();
  const scope = useScopeIds();
  const [wizard, setWizard] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const res = useSports((c) => c.programmes(scope), [scope.join(','), app.role]);
  const update = useSportsAction((c, id: string, patch: Partial<SProgramme>) => c.updateProgramme(id, patch));
  const ai = useSportsAction((c, id: string) => c.aiDescription(id));
  const director = app.can('customers.write');

  const setStatus = async (p: SProgramme, status: SProgramme['status']) => {
    if (await update.run(p.id, { status })) { setMsg(t(`statusChanged.${status}`, { name: p.name })); res.reload(); }
  };
  const draft = async (p: SProgramme) => {
    const r = await ai.run(p.id);
    if (r) setDrafts((d) => ({ ...d, [p.id]: r.draft }));
  };
  const applyDraft = async (p: SProgramme) => {
    if (await update.run(p.id, { description: drafts[p.id] })) { setDrafts((d) => { const { [p.id]: _, ...rest } = d; return rest; }); setMsg(t('descriptionSaved')); res.reload(); }
  };

  return (
    <>
      <PageHeader icon="flag" title={tOps('title')} description={tOps('description')} actions={director && !wizard ? <Button icon="plus" onClick={() => setWizard(true)}>{t('setup')}</Button> : null} />
      {msg && <Banner tone="success" live="polite">{msg}</Banner>}
      {(update.error || ai.error) && <Banner tone={ai.error?.code === 'ai_unavailable' ? 'neutral' : 'danger'} live="assertive" icon={ai.error ? 'marina' : undefined}>{(update.error ?? ai.error)!.message}</Banner>}
      {wizard && <SetupWizard onCancel={() => setWizard(false)} onDone={(m) => { setWizard(false); setMsg(m); res.reload(); }} />}
      <Async res={res} loading={<LoadingBlock variant="cards" rows={3} />} isEmpty={(d) => d.length === 0} empty={<Empty icon="flag" title={t('empty')} body={director ? t('emptyBody') : undefined} action={director ? <Button icon="plus" onClick={() => setWizard(true)}>{t('setup')}</Button> : undefined} />}>
        {(items) => (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr))]">
            {items.map((p) => {
              const loc = app.locations.find((l) => l.id === p.locationId);
              const range = p.ageCutoffDate ? eligibleBirthDates(p.ageRule, p.ageCutoffDate, p.ageMin, p.ageMax) : null;
              const held = p.counts.accepted + p.counts.awaitingReview + p.counts.submitted;
              return (
                <article key={p.id} className="flex flex-col gap-3 rounded-lg bg-surface p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-[16px] font-bold">{p.name}</h3>
                      <div className="text-xs text-stone">{loc?.name ?? p.locationId} · {t(`kinds.${p.kind}`)}{p.season ? ` · ${p.season.name}` : ''}</div>
                    </div>
                    <Badge tone={p.status === 'published' ? 'success' : p.status === 'draft' ? 'neutral' : 'warning'} icon={p.status === 'published' ? 'globe' : p.status === 'draft' ? 'edit' : 'lock'}>{t(`status.${p.status}`)}</Badge>
                  </div>
                  {p.description && <p className="line-clamp-3 text-sm text-graphite">{p.description}</p>}
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-sm bg-canvas px-2.5 py-2"><dt className="text-stone">{t('ages')}</dt><dd className="font-bold">{p.ageMin ?? 0}–{p.ageMax ?? '∞'} · {t(`rule.${p.ageRule}`)}</dd>{range && <dd className="text-stone">{t('born', { from: range.from ? fmtDate(range.from, locale) : '—', to: range.to ? fmtDate(range.to, locale) : '—' })}</dd>}</div>
                    <div className="rounded-sm bg-canvas px-2.5 py-2"><dt className="text-stone">{t('fee')}</dt><dd className="font-bold">{p.feeMinor ? <Amount amount={p.feeMinor} currency={p.currency} /> : t('free')}</dd>{p.siblingDiscountBps > 0 && <dd className="text-stone">{t('sibling', { pct: p.siblingDiscountBps / 100 })}</dd>}</div>
                    <div className="col-span-2 rounded-sm bg-canvas px-2.5 py-2"><dt className="text-stone">{t('window')}</dt><dd className="font-bold">{p.registrationOpensAt ? fmtDate(p.registrationOpensAt, locale) : t('now')} – {p.registrationClosesAt ? fmtDate(p.registrationClosesAt, locale) : t('noClose')}</dd></div>
                  </dl>
                  <CapacityBar used={held} capacity={p.capacity} label={t('placesHeld')} />
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <Badge tone="success" icon="check-circle">{t('accepted', { n: p.counts.accepted })}</Badge>
                    {p.counts.awaitingReview > 0 && <Badge tone="info" icon="clock">{t('review', { n: p.counts.awaitingReview })}</Badge>}
                    {p.counts.waitlisted > 0 && <Badge tone="neutral" icon="list">{t('waitlisted', { n: p.counts.waitlisted })}</Badge>}
                    {p.requiresApproval ? <Badge tone="neutral" icon="shield">{t('approval')}</Badge> : <Badge tone="neutral" icon="zap">{t('autoAccept')}</Badge>}
                  </div>
                  {p.refundPolicy ? <p className="text-xs text-stone"><Icon name="undo" size={12} className="mr-1 inline" />{p.refundPolicy}</p> : p.feeMinor > 0 && <p className="text-xs font-bold text-danger">{t('noPolicy')}</p>}
                  {drafts[p.id] && (
                    <div className="rounded-lg border border-line p-3 text-sm">
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-bold"><Icon name="marina" size={13} />{t('aiDraft')}</div>
                      <p className="whitespace-pre-line">{drafts[p.id]}</p>
                      <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => void applyDraft(p)}>{t('applyDraft')}</Button><Button size="sm" variant="ghost" onClick={() => setDrafts((d) => { const { [p.id]: _, ...rest } = d; return rest; })}>{t('discard')}</Button></div>
                    </div>
                  )}
                  {director && (
                    <div className="mt-auto flex flex-wrap gap-1.5 border-t border-line-soft pt-3">
                      {p.status === 'draft' && <Button size="sm" icon="globe" loading={update.pending} onClick={() => void setStatus(p, 'published')}>{t('publish')}</Button>}
                      {p.status === 'published' && <Button size="sm" variant="secondary" icon="lock" onClick={() => void setStatus(p, 'closed')}>{t('close')}</Button>}
                      {p.status === 'closed' && <Button size="sm" variant="secondary" icon="globe" onClick={() => void setStatus(p, 'published')}>{t('reopen')}</Button>}
                      {app.can('ai.use') && <Button size="sm" variant="ghost" icon="marina" loading={ai.pending} onClick={() => void draft(p)}>{t('draftDescription')}</Button>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </Async>
    </>
  );
}
