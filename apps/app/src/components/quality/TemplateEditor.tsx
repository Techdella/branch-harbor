'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, Textarea, Toggle, cx } from '@bh/ui';
import { AUDIT_QUESTION_TYPES, type AuditQuestion, type AuditQuestionType, type AuditSection, type AuditTemplateBody } from '@bh/shared';
import { ApiError } from '@/lib/errors';
import { useApp } from '../shell/AppContext';
import { PageHeader } from '../shell/PageHeader';
import { Banner, DeniedState, ErrorState, LoadingBlock } from '../ui/States';
import { qualityApi, useQualityAction } from './api';
import { QuestionTraining } from '../supply/AuditProgrammes';
import { ActionError } from './ui';

const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 8)}`;
const blankQuestion = (): AuditQuestion => ({ id: rid('q'), text: '', type: 'yes_no', weight: 1, critical: false, photoRequired: false });
const blankSection = (): AuditSection => ({ id: rid('s'), title: '', questions: [blankQuestion()] });
const blank = (): AuditTemplateBody => ({ name: '', description: '', passThreshold: 80, reauditDays: 30, correctiveDays: 14, sections: [blankSection()] });

function move<T>(list: T[], i: number, d: -1 | 1): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** Checklist template editor (HQ): sections, questions of each type, weights, critical items and required photos. */
export function TemplateEditor({ id }: { id: string }) {
  const t = useTranslations('quality');
  const app = useApp();
  const router = useRouter();
  const isNew = id === 'new';
  const [body, setBody] = useState<AuditTemplateBody | null>(isNew ? blank() : null);
  const [meta, setMeta] = useState<{ status: string; version: number } | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const act = useQualityAction();
  useEffect(() => {
    if (isNew) return;
    qualityApi.template(id).then((tp) => {
      setBody({ name: tp.name, description: tp.description, passThreshold: tp.passThreshold, reauditDays: tp.reauditDays, correctiveDays: tp.correctiveDays, sections: tp.sections });
      setMeta({ status: tp.status, version: tp.version });
    }, (e) => setLoadError(e instanceof ApiError ? e : new ApiError('unknown_error', String(e))));
  }, [id, isNew]);
  if (!app.capabilities.has('operations.audits:publish')) return <DeniedState />;
  if (loadError) return <ErrorState error={loadError} />;
  if (!body) return <LoadingBlock variant="detail" />;

  const setSection = (i: number, s: AuditSection) => setBody((b) => b && { ...b, sections: b.sections.map((x, k) => (k === i ? s : x)) });
  const setQuestion = (si: number, qi: number, q: Partial<AuditQuestion>) => setBody((b) => b && { ...b, sections: b.sections.map((s, k) => (k === si ? { ...s, questions: s.questions.map((x, j) => (j === qi ? { ...x, ...q } : x)) } : s)) });
  const questions = body.sections.flatMap((s) => s.questions);
  const ready = body.name.trim() && body.sections.every((s) => s.title.trim() && s.questions.length && s.questions.every((q) => q.text.trim()));
  const save = async () => {
    setSaved(false);
    const r = await act.run(() => (isNew ? qualityApi.createTemplate(body) : qualityApi.saveTemplate(id, body)));
    if (!r) return;
    setSaved(true);
    setMeta({ status: r.status, version: r.version });
    if (isNew) router.replace(`/audits/templates/${r.id}`);
  };

  return (
    <>
      <PageHeader icon="list" title={isNew ? t('templates.new') : body.name || t('templates.untitled')} description={t('editor.description')} scope={false}
        actions={<>
          <Link href="/audits?tab=templates" className="inline-flex h-10 items-center gap-2 rounded-full bg-canvas px-4 text-sm font-bold hover:bg-line-soft"><Icon name="arrow-left" size={15} />{t('editor.back')}</Link>
          {!isNew && meta && <Button variant="ghost" size="sm" onClick={async () => { const r = await act.run(() => qualityApi.setTemplateStatus(id, meta.status === 'active' ? 'archived' : 'active')); if (r) setMeta({ status: r.status, version: r.version }); }}>{meta.status === 'active' ? t('editor.archive') : t('editor.restore')}</Button>}
          <Button icon="check" disabled={!ready} loading={act.pending} onClick={save}>{t('editor.save')}</Button>
        </>}
      />
      <ActionError error={act.error} />
      {saved && <Banner tone="success" live="polite">{t('editor.saved', { version: meta?.version ?? 1 })}</Banner>}
      {meta?.status === 'archived' && <Banner tone="warning">{t('editor.archivedNote')}</Banner>}
      <section className="grid gap-3 rounded-xl bg-surface p-5 md:grid-cols-2" data-testid="template-editor">
        <Field label={t('editor.name')}>{(x) => <Input id={x.id} value={body.name} maxLength={160} onChange={(e) => setBody({ ...body, name: e.target.value })} />}</Field>
        <Field label={t('editor.descriptionLabel')} optional>{(x) => <Input id={x.id} value={body.description} maxLength={1000} onChange={(e) => setBody({ ...body, description: e.target.value })} />}</Field>
        <div className="grid grid-cols-3 gap-2 md:col-span-2">
          <Field label={t('editor.passMark')} hint={t('editor.passMarkHint')}>{(x) => <Input id={x.id} type="number" min={0} max={100} value={body.passThreshold} onChange={(e) => setBody({ ...body, passThreshold: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />}</Field>
          <Field label={t('editor.correctiveDays')} hint={t('editor.correctiveDaysHint')}>{(x) => <Input id={x.id} type="number" min={1} max={180} value={body.correctiveDays} onChange={(e) => setBody({ ...body, correctiveDays: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
          <Field label={t('editor.reauditDays')} hint={t('editor.reauditDaysHint')}>{(x) => <Input id={x.id} type="number" min={1} max={365} value={body.reauditDays} onChange={(e) => setBody({ ...body, reauditDays: Math.max(1, Number(e.target.value) || 1) })} />}</Field>
        </div>
        <div className="flex flex-wrap gap-1.5 md:col-span-2">
          <Badge tone="neutral">{t('templates.questions', { count: questions.length })}</Badge>
          <Badge tone="danger" icon="alert">{t('templates.critical', { count: questions.filter((q) => q.critical).length })}</Badge>
          <Badge tone="info" icon="image">{t('editor.photoCount', { count: questions.filter((q) => q.photoRequired || q.type === 'photo').length })}</Badge>
          <Badge tone="neutral">{t('editor.totalWeight', { n: questions.filter((q) => q.type !== 'text').reduce((a, q) => a + q.weight, 0) })}</Badge>
        </div>
      </section>
      {body.sections.map((s, si) => (
        <section key={s.id} className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-label={s.title || t('editor.section', { n: si + 1 })}>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1"><Field label={t('editor.section', { n: si + 1 })}>{(x) => <Input id={x.id} value={s.title} maxLength={160} placeholder={t('editor.sectionPlaceholder')} onChange={(e) => setSection(si, { ...s, title: e.target.value })} />}</Field></div>
            <Button variant="ghost" size="sm" icon="chevron-down" aria-label={t('editor.moveDown')} disabled={si === body.sections.length - 1} onClick={() => setBody({ ...body, sections: move(body.sections, si, 1) })} />
            <Button variant="ghost" size="sm" icon="chevron-left" className="rotate-90" aria-label={t('editor.moveUp')} disabled={si === 0} onClick={() => setBody({ ...body, sections: move(body.sections, si, -1) })} />
            <Button variant="ghost" size="sm" icon="x" aria-label={t('editor.removeSection')} disabled={body.sections.length === 1} onClick={() => setBody({ ...body, sections: body.sections.filter((_, k) => k !== si) })} />
          </div>
          <ol className="flex flex-col gap-2">
            {s.questions.map((q, qi) => (
              <li key={q.id} className={cx('flex flex-col gap-2 rounded-lg border-[1.5px] p-3', q.critical ? 'border-danger/40 bg-danger-bg/30' : 'border-line-soft bg-canvas-raised')}>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[220px] flex-[3]"><Field label={t('editor.question', { n: qi + 1 })}>{(x) => <Input id={x.id} value={q.text} maxLength={300} onChange={(e) => setQuestion(si, qi, { text: e.target.value })} />}</Field></div>
                  <div className="min-w-[140px] flex-1"><Field label={t('editor.type')}>{(x) => (
                    <Select id={x.id} value={q.type} onChange={(e) => setQuestion(si, qi, { type: e.target.value as AuditQuestionType, ...(e.target.value === 'text' ? { weight: 0, critical: false } : {}) })}>
                      {AUDIT_QUESTION_TYPES.map((ty) => <option key={ty} value={ty}>{t(`qtype.${ty}`)}</option>)}
                    </Select>
                  )}</Field></div>
                  <div className="w-24"><Field label={t('editor.weight')}>{(x) => <Input id={x.id} type="number" min={0} max={100} disabled={q.type === 'text'} value={q.weight} onChange={(e) => setQuestion(si, qi, { weight: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />}</Field></div>
                </div>
                {q.type === 'number' && (
                  <div className="grid grid-cols-3 gap-2">
                    <Field label={t('editor.min')} optional>{(x) => <Input id={x.id} type="number" value={q.min ?? ''} onChange={(e) => setQuestion(si, qi, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
                    <Field label={t('editor.max')} optional>{(x) => <Input id={x.id} type="number" value={q.max ?? ''} onChange={(e) => setQuestion(si, qi, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />}</Field>
                    <Field label={t('editor.unit')} optional>{(x) => <Input id={x.id} value={q.unit ?? ''} maxLength={12} onChange={(e) => setQuestion(si, qi, { unit: e.target.value || undefined })} />}</Field>
                  </div>
                )}
                <Field label={t('editor.guidance')} optional>{(x) => <Textarea id={x.id} className="min-h-14" value={q.guidance ?? ''} maxLength={600} onChange={(e) => setQuestion(si, qi, { guidance: e.target.value || undefined })} />}</Field>
                <div className="flex flex-wrap items-center gap-4 text-[13px] font-bold">
                  {q.type !== 'text' && <label className="flex items-center gap-2"><Toggle checked={q.critical} label={t('editor.critical')} onChange={(v) => setQuestion(si, qi, { critical: v })} />{t('editor.critical')}</label>}
                  {q.type !== 'photo' && <label className="flex items-center gap-2"><Toggle checked={q.photoRequired} label={t('editor.photoRequired')} onChange={(v) => setQuestion(si, qi, { photoRequired: v })} />{t('editor.photoRequired')}</label>}
                  <span className="flex-1" />
                  <Button variant="ghost" size="sm" icon="chevron-down" aria-label={t('editor.moveDown')} disabled={qi === s.questions.length - 1} onClick={() => setSection(si, { ...s, questions: move(s.questions, qi, 1) })} />
                  <Button variant="ghost" size="sm" icon="chevron-left" className="rotate-90" aria-label={t('editor.moveUp')} disabled={qi === 0} onClick={() => setSection(si, { ...s, questions: move(s.questions, qi, -1) })} />
                  <Button variant="ghost" size="sm" icon="x" aria-label={t('editor.removeQuestion')} disabled={s.questions.length === 1} onClick={() => setSection(si, { ...s, questions: s.questions.filter((_, k) => k !== qi) })} />
                </div>
                {q.critical && <p className="text-xs font-bold text-danger">{t('editor.criticalHint')}</p>}
                <QuestionTraining q={q} onChange={(p) => setQuestion(si, qi, p)} />
              </li>
            ))}
          </ol>
          <Button variant="secondary" size="sm" icon="plus" className="self-start" onClick={() => setSection(si, { ...s, questions: [...s.questions, blankQuestion()] })}>{t('editor.addQuestion')}</Button>
        </section>
      ))}
      <Button variant="secondary" icon="plus" className="self-start" onClick={() => setBody({ ...body, sections: [...body.sections, blankSection()] })}>{t('editor.addSection')}</Button>
    </>
  );
}
