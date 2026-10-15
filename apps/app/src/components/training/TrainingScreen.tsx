'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, Button, Icon, Tabs, cx } from '@bh/ui';
import { API_URL, getAccessToken } from '@/lib/http/client';
import { PageHeader } from '../shell/PageHeader';
import { LoadingBlock } from '../ui/States';
import { ErrorNote, LiveOnly, Panel, useNet, useNetMe, useOrgId } from '../community/net';
import { CourseView, LessonPlayer } from './CoursePlayer';
import { Authoring, CourseEditor } from './CourseEditor';
import { AssignPanel, LeadsPanel, ReportsPanel } from './TrainingAdmin';

export interface CourseT {
  id: string; slug: string; title: string; summary: string | null; status: string; visibility: string; category: string | null; estimatedMinutes: number | null; passMark: number;
  validityMonths: number | null; prerequisiteIds: string[]; trainerUserIds: string[]; price: { amount: number; currency: string } | null; saleLocationId: string | null; seats: number | null; startsOn: string | null;
  authorId: string | null; reviewComment: string | null; locked?: boolean; canEdit?: boolean; authorName?: string | null; enrolled?: number; completed?: number; certificateEnabled: boolean; description: string | null; scheduleNote: string | null;
}
export interface TrainingHome {
  enrolments: { id: string; status: string; progressPct: number; dueAt: string | null; overdue: boolean; completedAt: string | null; expiresAt: string | null; source: string; course: { id: string; title: string; summary: string | null; estimatedMinutes: number | null; category: string | null } }[];
  catalogue: CourseT[];
  paths: { id: string; title: string; description: string | null; courses: { id: string; title: string; completed: boolean }[] }[];
  certificates: { id: string; code: string; courseTitle: string; issuedAt: string; expiresAt: string | null; valid: boolean }[];
  authoring: CourseT[];
  can: { author: boolean; manage: boolean; assign: boolean; leads: boolean };
}

const TABS = ['learning', 'catalogue', 'authoring', 'assign', 'reports', 'leads'] as const;
type Tab = (typeof TABS)[number];

/** Training academy: my learning, catalogue, course player, authoring with HQ approval, assignments, reports, course leads. */
export function TrainingScreen() {
  return <LiveOnly><Training /></LiveOnly>;
}

function Training() {
  const t = useTranslations('training');
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const me = useNetMe();
  const home = useNet<TrainingHome>('/training/home');
  const go = useCallback((q: Record<string, string | null>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) next.set(k, v);
    router.replace(`${path}${next.size ? `?${next}` : ''}`, { scroll: false });
  }, [router, path]);
  const courseId = params.get('course');
  const lessonId = params.get('lesson');
  const editId = params.get('edit');
  const h = home.data;
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'learning';
  const visible = TABS.filter((k) => (k === 'authoring' ? h?.can.author || h?.can.manage : k === 'assign' || k === 'reports' ? h?.can.assign : k === 'leads' ? h?.can.leads : true));

  return (
    <>
      <PageHeader icon="book" title={t('title')} description={t('description')} scope={false} />
      <ErrorNote error={home.error ?? me.error} />
      {!h || !me.data ? <LoadingBlock variant="cards" rows={3} /> : lessonId ? (
        <LessonPlayer id={lessonId} onOpen={(id) => go({ lesson: id })} onCourse={(id) => { void home.reload(); go({ course: id }); }} />
      ) : courseId ? (
        <CourseView id={courseId} onLesson={(id) => go({ lesson: id })} onBack={() => go({})} onEdit={(id) => go({ tab: 'authoring', edit: id })} onChanged={() => void home.reload()} />
      ) : editId ? (
        <CourseEditor id={editId} me={me.data} catalogue={[...h.catalogue, ...h.authoring]} onBack={() => { void home.reload(); go({ tab: 'authoring' }); }} />
      ) : (
        <>
          <Tabs items={visible.map((k) => ({ key: k, label: t(`tabs.${k}`) }))} value={tab} onChange={(k) => go({ tab: k })} />
          {tab === 'learning' && <MyLearning home={h} onCourse={(id) => go({ course: id })} />}
          {tab === 'catalogue' && <Catalogue home={h} onCourse={(id) => go({ course: id })} />}
          {tab === 'authoring' && <Authoring home={h} onEdit={(id) => go({ tab: 'authoring', edit: id })} onChanged={() => void home.reload()} />}
          {tab === 'assign' && <AssignPanel me={me.data} home={h} />}
          {tab === 'reports' && <ReportsPanel home={h} />}
          {tab === 'leads' && <LeadsPanel home={h} />}
        </>
      )}
    </>
  );
}

export function useCertificateDownload() {
  const orgId = useOrgId();
  return async (id: string, code: string) => {
    const res = await fetch(`${API_URL}/v1/orgs/${orgId}/training/certificates/${id}/pdf`, { headers: { Authorization: `Bearer ${getAccessToken() ?? ''}` }, credentials: 'include' });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `certificate-${code}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
}

function MyLearning({ home, onCourse }: { home: TrainingHome; onCourse: (id: string) => void }) {
  const t = useTranslations('training.home');
  const locale = useLocale();
  const download = useCertificateDownload();
  const active = home.enrolments.filter((e) => e.status === 'active' || e.status === 'expired');
  const done = home.enrolments.filter((e) => e.status === 'completed');
  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_340px]">
      <div className="flex flex-col gap-3">
        <Panel title={t('todo')}>
          {!active.length && <p className="text-sm text-stone">{t('nothingDue')}</p>}
          <ul className="grid gap-3 md:grid-cols-2">
            {active.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => onCourse(e.course.id)} className={cx('flex w-full flex-col gap-2 rounded-lg border-[1.5px] p-4 text-left hover:border-ink', e.overdue ? 'border-danger' : 'border-line-soft')}>
                  <span className="flex flex-wrap gap-1.5">
                    {e.course.category && <Badge tone="neutral">{e.course.category}</Badge>}
                    {e.status === 'expired' ? <Badge tone="warning">{t('recertify')}</Badge> : e.overdue ? <Badge tone="danger">{t('overdue')}</Badge> : e.dueAt ? <Badge tone="info" icon="clock">{t('due', { date: new Date(e.dueAt).toLocaleDateString(locale) })}</Badge> : null}
                  </span>
                  <span className="font-bold">{e.course.title}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-canvas" role="progressbar" aria-valuenow={e.progressPct} aria-valuemin={0} aria-valuemax={100} aria-label={t('progress')}><span className="block h-full bg-ink" style={{ width: `${e.progressPct}%` }} /></span>
                  <span className="text-xs text-stone">{t('percent', { pct: e.progressPct })}{e.course.estimatedMinutes ? ` · ${t('minutes', { count: e.course.estimatedMinutes })}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        {home.paths.length > 0 && (
          <Panel title={t('paths')}>
            {home.paths.map((p) => (
              <div key={p.id} className="flex flex-col gap-2">
                <h3 className="font-bold">{p.title}</h3>
                {p.description && <p className="text-[13px] text-stone">{p.description}</p>}
                <ol className="flex flex-wrap items-center gap-2">
                  {p.courses.map((c, i) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <button type="button" onClick={() => onCourse(c.id)} className={cx('inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold', c.completed ? 'bg-success-bg text-success' : 'bg-canvas')}>
                        {c.completed && <Icon name="check" size={14} />}{c.title}
                      </button>
                      {i < p.courses.length - 1 && <Icon name="chevron-right" size={14} />}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </Panel>
        )}
        {done.length > 0 && (
          <Panel title={t('completed')}>
            <ul className="flex flex-col divide-y divide-line-soft">
              {done.map((e) => <li key={e.id} className="flex flex-wrap items-center gap-2 py-2 text-sm"><button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => onCourse(e.course.id)}>{e.course.title}</button><span className="text-stone">{t('completedOn', { date: new Date(e.completedAt!).toLocaleDateString(locale) })}</span></li>)}
            </ul>
          </Panel>
        )}
      </div>
      <Panel title={t('certificates')}>
        {!home.certificates.length && <p className="text-sm text-stone">{t('noCertificates')}</p>}
        <ul className="flex flex-col gap-2">
          {home.certificates.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-lg bg-canvas p-3">
              <span className="flex items-center gap-2 font-bold"><Icon name="star" size={15} />{c.courseTitle}</span>
              <span className="text-xs text-stone">{t('issued', { date: new Date(c.issuedAt).toLocaleDateString(locale) })}{c.expiresAt ? ` · ${t('validUntil', { date: new Date(c.expiresAt).toLocaleDateString(locale) })}` : ''}</span>
              <span className="flex flex-wrap items-center gap-2">
                {!c.valid && <Badge tone="warning">{t('expired')}</Badge>}
                <Button size="sm" variant="secondary" icon="download" onClick={() => download(c.id, c.code)}>{t('download')}</Button>
                <code className="text-xs">{c.code}</code>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function Catalogue({ home, onCourse }: { home: TrainingHome; onCourse: (id: string) => void }) {
  const t = useTranslations('training.home');
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {home.catalogue.map((c) => (
        <li key={c.id}>
          <button type="button" onClick={() => onCourse(c.id)} className="flex h-full w-full flex-col gap-2 rounded-xl bg-surface p-4 text-left hover:ring-2 hover:ring-ink">
            <span className="flex flex-wrap gap-1.5">{c.category && <Badge tone="neutral">{c.category}</Badge>}{c.locked && <Badge tone="warning" icon="lock">{t('needsPrerequisite')}</Badge>}{c.validityMonths ? <Badge tone="info">{t('recertEvery', { months: c.validityMonths })}</Badge> : null}</span>
            <span className="font-bold">{c.title}</span>
            {c.summary && <span className="text-[13px] text-stone">{c.summary}</span>}
            {c.estimatedMinutes && <span className="mt-auto text-xs text-stone">{t('minutes', { count: c.estimatedMinutes })}</span>}
          </button>
        </li>
      ))}
      {!home.catalogue.length && <li className="rounded-xl bg-surface p-6 text-sm text-stone">{t('catalogueEmpty')}</li>}
    </ul>
  );
}
