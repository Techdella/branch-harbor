'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Select } from '@bh/ui';
import type { Project } from '@/lib/franchise/api';
import { useApp } from '../shell/AppContext';
import { qualityApi, useQuality, useQualityAction } from './api';
import { ScheduleDrawer } from './AuditsScreen';
import { ActionError, ScoreBadge, useQFmt } from './ui';

/**
 * Pre-opening checks with an audit checklist, inside the new-location project: HQ picks the checklist and schedules the
 * audit; the opening can only be requested (and approved) once an audit with it has passed.
 */
export function PreOpeningAudit({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const t = useTranslations('quality');
  const app = useApp();
  const router = useRouter();
  const f = useQFmt();
  const manage = app.capabilities.has('operations.audits:publish');
  const templates = useQuality(() => qualityApi.templates(), [app.org.id], manage);
  const act = useQualityAction();
  const [scheduling, setScheduling] = useState(false);
  const pre = project.preOpening ?? null;
  if (!pre && !manage) return null;
  if (project.status === 'opened' && !pre) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border-[1.5px] border-line-soft p-3" data-testid="pre-opening-audit">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 text-[13px] font-bold">{t('preOpening.title')}</span>
        {pre && (pre.passed ? <Badge tone="success" icon="check-circle">{t('preOpening.passed')}</Badge> : <Badge tone="warning" icon="shield">{t('preOpening.required')}</Badge>)}
      </div>
      <p className="text-xs text-stone">{pre ? t('preOpening.explain', { name: pre.templateName ?? '' }) : t('preOpening.none')}</p>
      <ActionError error={act.error} />
      {manage && project.status === 'active' && (
        <Field label={t('preOpening.checklist')}>{(x) => (
          <Select id={x.id} value={pre?.templateId ?? ''} disabled={act.pending} onChange={async (e) => { if (await act.run(() => qualityApi.setPreOpening(project.id, e.target.value || null))) onChanged(); }}>
            <option value="">{t('preOpening.noChecklist')}</option>
            {(templates.data?.items ?? []).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
          </Select>
        )}</Field>
      )}
      {pre?.latest && (
        <Link href={`/audits/${pre.latest.id}`} className="flex flex-wrap items-center gap-2 rounded-md bg-canvas-raised px-3 py-2 text-[13px] hover:bg-line-soft">
          <span className="flex-1">{pre.latest.status === 'completed' ? t('preOpening.latestDone') : t('preOpening.latestDue', { date: f.date(pre.latest.dueDate) })}</span>
          {pre.latest.status === 'completed' && <ScoreBadge score={pre.latest.scorePct} passed={pre.latest.passed} />}
        </Link>
      )}
      {manage && pre && !pre.passed && project.location && project.status === 'active' && (!pre.latest || pre.latest.status === 'completed') && (
        <Button size="sm" variant="secondary" icon="calendar" className="self-start" onClick={() => setScheduling(true)}>{t('preOpening.schedule')}</Button>
      )}
      {manage && pre && !project.location && <p className="text-xs text-stone">{t('preOpening.afterProvision')}</p>}
      {scheduling && project.location && <ScheduleDrawer preset={{ locationId: project.location.id, projectId: project.id, templateId: pre?.templateId }} onClose={() => setScheduling(false)} onDone={(id) => router.push(`/audits/${id}`)} />}
    </div>
  );
}
