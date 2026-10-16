'use client';

import { useState } from 'react';
import type { IconName } from '@bh/icons';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, cx } from '@bh/ui';
import { TEAM_SHAPES } from '@bh/shared';
import { accessApi, useAccess, useAccessAction, type CoverageVM, type ScopesVM, type TeamShapeVM } from '@/lib/http/access';
import { useApp } from '../../shell/AppContext';
import { Async, Banner, LoadingBlock } from '../../ui/States';
import { useRoleName } from './AccessEditor';

const SHAPE_ICON: Record<string, IconName> = { full: 'users', small: 'user', solo: 'star', custom: 'sliders' };

/** The four team shapes as choices (onboarding and Team & access). */
export function ShapeChoices({ value, onChange, name = 'team-shape' }: { value: string | null; onChange: (shape: string) => void; name?: string }) {
  const t = useTranslations('access.shape');
  return (
    <div className="grid gap-2 md:grid-cols-2" role="radiogroup" aria-label={t('title')} data-testid="shape-choices">
      {TEAM_SHAPES.map((s) => (
        <label key={s} className={cx('flex cursor-pointer items-start gap-3 rounded-lg border p-3.5', value === s ? 'border-ink bg-lime/30' : 'border-line-soft bg-surface')}>
          <input type="radio" name={name} className="mt-1 h-4 w-4 accent-ink" checked={value === s} onChange={() => onChange(s)} data-testid={`shape-${s}`} />
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-canvas"><Icon name={SHAPE_ICON[s]!} size={16} /></span>
          <span>
            <span className="block text-sm font-bold">{t(`options.${s}.title`)}</span>
            <span className="block text-xs text-stone">{t(`options.${s}.body`)}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Names for the combined roles in the viewer's language (they are saved as the business's own roles). */
export function useCombinedNames() {
  const t = useTranslations('access.shape.combined');
  return {
    names: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, t(`${k}.name`)])),
    descriptions: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, t(`${k}.description`)])),
  };
}

/** Team & access → Team shape: change the shape at any time (nothing is locked or removed), and manage scopes. */
export function TeamShapeTab() {
  const t = useTranslations('access.shape');
  const roleName = useRoleName();
  const combinedText = useCombinedNames();
  const res = useAccess(() => accessApi.teamShape(), []);
  const [shape, setShape] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const save = useAccessAction((s: string, keys: string[]) => accessApi.setTeamShape(s, combinedText.names(keys), combinedText.descriptions(keys)));
  return (
    <div className="flex flex-col gap-4">
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {(state: TeamShapeVM) => {
          const current = shape ?? state.shape;
          const sugg = state.shapes.find((s) => s.key === current);
          return (
            <section className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-labelledby="shape-title" data-testid="team-shape">
              <div>
                <h2 id="shape-title" className="text-lg font-bold">{t('title')}</h2>
                <p className="text-sm text-stone">{t('intro')}</p>
              </div>
              {state.shape && <p className="text-sm">{t('current', { shape: t(`options.${state.shape}.title`) })}</p>}
              <ShapeChoices value={current} onChange={(s) => (setShape(s), setOk(false))} />
              {sugg && (sugg.templates.length > 0 || sugg.combined.length > 0) && (
                <div className="flex flex-col gap-2 rounded-lg bg-canvas p-3.5">
                  <h3 className="text-sm font-bold">{t('suggested')}</h3>
                  {sugg.combined.length > 0 && (
                    <ul className="flex flex-col gap-1">
                      {sugg.combined.map((k) => {
                        const c = state.combined.find((x) => x.key === k);
                        return (
                          <li key={k} className="text-sm">
                            <strong>{c?.roleName ?? t(`combined.${k}.name`)}</strong> <span className="text-xs text-stone">— {t(`combined.${k}.description`)}</span>{' '}
                            {c?.roleId ? <Badge tone="success" icon="check">{t('created')}</Badge> : <Badge tone="neutral" icon={null}>{t('willCreate')}</Badge>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {sugg.templates.length > 0 && <p className="text-xs text-stone">{t('templates', { roles: sugg.templates.map((r) => roleName(r)).join(', ') })}</p>}
                </div>
              )}
              <p className="text-xs text-stone">{t('nothingLocked')}</p>
              {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
              {ok && <Banner tone="success" live="polite">{t('saved')}</Banner>}
              <div>
                <Button disabled={!current} loading={save.pending} onClick={async () => { if (current && (await save.run(current, state.shapes.find((s) => s.key === current)?.combined ?? []))) { setOk(true); setShape(null); res.reload(); } }} data-testid="shape-save">
                  {t('save')}
                </Button>
              </div>
            </section>
          );
        }}
      </Async>
    </div>
  );
}

/**
 * "Uncovered areas": what nobody but the owner handles yet (royalties, approvals…). Until someone is assigned, its
 * approvals and notifications go to the owner. "Assign to…" gives one person the area (you can only give what you hold).
 */
export function CoverageCard({ people, onAssigned }: { people: { id: string; name: string }[]; onAssigned?: () => void }) {
  const t = useTranslations('access.coverage');
  const res = useAccess(() => accessApi.coverage(), []);
  const [area, setArea] = useState<string | null>(null);
  const [person, setPerson] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const assign = useAccessAction((a: string, u: string) => accessApi.assignArea(a, u));
  return (
    <Async res={res} loading={null}>
      {(cov: CoverageVM) => {
        const open = cov.items.filter((i) => !i.covered);
        return (
          <section className={cx('flex flex-col gap-2 rounded-xl p-4', open.length ? 'bg-butter' : 'bg-surface')} aria-labelledby="coverage-title" data-testid="coverage-card">
            <div className="flex flex-wrap items-center gap-2">
              <Icon name={open.length ? 'alert' : 'check-circle'} size={16} />
              <h2 id="coverage-title" className="text-base font-bold">{t('title')}</h2>
              <span className="text-xs text-stone">{open.length ? t('countOpen', { count: open.length }) : t('allCovered')}</span>
            </div>
            {open.length > 0 && <p className="text-xs text-stone">{t('fallback')}</p>}
            {done && <Banner tone="success" live="polite">{done}</Banner>}
            {assign.error && <Banner tone="danger" live="assertive">{assign.error.message}</Banner>}
            <ul className="flex flex-col gap-1.5">
              {open.map((i) => (
                <li key={i.key} className="flex flex-wrap items-center gap-2 rounded-md bg-surface px-3 py-2 text-sm" data-testid={`uncovered-${i.key}`}>
                  <span className="min-w-0 flex-1">{t('nobody', { area: t(`areas.${i.key}`) })}</span>
                  {area === i.key ? (
                    <span className="flex flex-wrap items-end gap-2">
                      <Select aria-label={t('assignTo')} value={person} onChange={(e) => setPerson(e.target.value)} data-testid="coverage-person">
                        <option value="">{t('choose')}</option>
                        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                      <Button size="sm" disabled={!person} loading={assign.pending} onClick={async () => {
                        const r = await assign.run(i.key, person);
                        if (r) { setDone(t('assigned', { name: people.find((p) => p.id === person)?.name ?? '', area: t(`areas.${i.key}`) })); setArea(null); setPerson(''); res.reload(); onAssigned?.(); }
                      }} data-testid="coverage-assign">{t('assign')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setArea(null)}>{t('cancel')}</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="secondary" onClick={() => (setArea(i.key), setPerson(''), setDone(null))} data-testid={`assign-${i.key}`}>{t('assignTo')}</Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      }}
    </Async>
  );
}


