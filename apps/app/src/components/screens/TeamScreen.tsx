'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Badge, Button, DataTable, Field, Icon, Input, Select, Tabs } from '@bh/ui';
import type { Member, ShiftView } from '@/lib/types';
import { addDays, dateInZone, fmtTime, fmtYmd, weekStart, zoneLabel } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { INDEPENDENT_ROLES } from '@bh/shared';
import { useApp } from '../shell/AppContext';
import { useBusinessMode } from '@/lib/useBusinessMode';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';

const ROLE_OPTIONS = ['hq_admin', 'regional_manager', 'franchise_owner', 'location_manager', 'staff', 'marketing_contributor', 'finance'] as const;
/** Independent businesses: owner, manager, staff, marketing contributor, finance — no HQ, regional or franchise roles. */
const INDEPENDENT_ROLE_OPTIONS = INDEPENDENT_ROLES;
const ORG_WIDE_ROLES: readonly string[] = ['org_owner', 'finance'];

export function TeamScreen() {
  const t = useTranslations('team');
  const app = useApp();
  const canMembers = app.can('members.manage');
  const [tab, setTab] = useState<'members' | 'schedule'>(canMembers ? 'members' : 'schedule');
  if (!canMembers && !app.can('operations.read')) return <DeniedState permission="operations.read" />;
  return (
    <>
      <PageHeader icon="user" title={t('title')} description={t('description')} />
      <Tabs
        items={[...(canMembers ? [{ key: 'members' as const, label: t('tab.members') }] : []), ...(app.can('operations.read') ? [{ key: 'schedule' as const, label: t('tab.schedule') }] : [])]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'members' && canMembers ? <MembersTab /> : <ScheduleTab />}
    </>
  );
}

function MembersTab() {
  const t = useTranslations('team');
  const ts = useTranslations('single.team');
  const app = useApp();
  const mode = useBusinessMode();
  const res = useApi((api) => api.team.members(app.ctx), [app.industry, app.role, app.org.id], app.can('members.manage'));
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('location_manager');
  const [scopeId, setScopeId] = useState(app.scopes.find((s) => s.kind === 'location')?.id ?? 'all');
  const [ok, setOk] = useState('');
  // Independent: no scope to pick — org-wide roles cover the business, the others its one location.
  const independentScope = ORG_WIDE_ROLES.includes(role) || !mode.location ? 'all' : `loc:${mode.location.id}`;
  const roleLabel = (r: string) => (mode.isIndependent ? ts(`role.${r}`) : t(`role.${r}`));
  const invite = useMutation((api) =>
    mode.isIndependent
      ? api.team.invite({ email, role: roleLabel(role), roleKey: role, scopeId: independentScope, scopeLabel: mode.businessName })
      : api.team.invite({ email, role: t(`role.${role}`), roleKey: role, scopeId, scopeLabel: app.scopes.find((s) => s.id === scopeId)?.label ?? '' }),
  );
  if (!app.can('members.manage')) return <DeniedState permission="members.manage" />;

  return (
    <>
      <div className="flex justify-end">
        <Button icon="plus" onClick={() => (setInviting(true), setOk(''))}>{t('invite')}</Button>
      </div>
      {ok && <Banner tone="success" live="polite">{ok}</Banner>}
      {inviting && (
        <section className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-label={t('invite')}>
          <h2 className="text-lg font-bold">{t('inviteTitle')}</h2>
          <div className={mode.isIndependent ? 'grid gap-3 md:grid-cols-2' : 'grid gap-3 md:grid-cols-3'}>
            <Field label={t('email')} error={invite.error?.fields?.email}>
              {(p) => <Input id={p.id} type="email" aria-invalid={p.invalid} aria-describedby={p.describedBy} value={email} onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field label={t('roleLabel')}>
              {(p) => (
                <Select id={p.id} value={role} onChange={(e) => setRole(e.target.value)} data-testid="invite-role">
                  {(mode.isIndependent ? INDEPENDENT_ROLE_OPTIONS : ROLE_OPTIONS).map((r) => (
                    <option key={r} value={r}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {!mode.isIndependent && (
            <Field label={t('scope')} hint={t('scopeHint')}>
              {(p) => (
                <Select id={p.id} aria-describedby={p.describedBy} value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                  {app.scopes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.kind === 'all' ? t('wholeOrg') : s.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            )}
          </div>
          <p className="text-xs text-stone">{mode.isIndependent ? ts(`roleHelp.${role}`) : t(`roleHelp.${role}`)}</p>
          <div className="flex gap-2">
            <Button
              loading={invite.pending}
              onClick={async () => {
                const m = await invite.run();
                if (m) {
                  setOk(t('invited', { email: m.email }));
                  setInviting(false);
                  setEmail('');
                  res.reload();
                }
              }}
            >
              {t('send')}
            </Button>
            <Button variant="secondary" onClick={() => setInviting(false)}>
              {t('cancel')}
            </Button>
          </div>
        </section>
      )}
      <Async res={res} permission="members.manage" loading={<LoadingBlock variant="table" />}>
        {(members) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
            <DataTable<Member>
              rows={members}
              rowKey={(m) => m.id}
              columns={[
                { key: 'person', header: t('col.person'), render: (m) => <span className="flex items-center gap-2.5"><Avatar name={m.name} size={32} pastel={m.status === 'support' ? '#F7EDA8' : '#E2F5A6'} /><span><strong>{m.name}</strong><span className="block text-xs text-stone">{m.email}</span></span></span> },
                { key: 'roles', header: t('col.assignments'), render: (m) => <ul className="flex flex-col gap-0.5">{m.assignments.map((a, i) => <li key={i}><strong>{a.role}</strong> <span className="text-stone">· {a.scopeLabel}</span></li>)}</ul> },
                { key: 'last', header: t('col.lastActive'), render: (m) => m.lastActive },
                { key: 'status', header: t('col.status'), render: (m) => <Badge tone={m.status === 'active' ? 'success' : m.status === 'invited' ? 'info' : 'warning'} icon={m.status === 'support' ? 'shield' : undefined}>{t(`status.${m.status}`)}</Badge> },
              ]}
            />
          </section>
        )}
      </Async>
      <p className="text-xs text-stone">{t('footer')}</p>
    </>
  );
}

/** Team → Schedule: shifts per location and person for one week, in each location's own time zone. */
function ScheduleTab() {
  const t = useTranslations('team.schedule');
  const locale = useLocale();
  const app = useApp();
  const tz = app.locations[0]?.timeZone ?? 'UTC';
  const [week, setWeek] = useState(() => weekStart(dateInZone(new Date(), tz)));
  const res = useApi((api) => api.team.schedule(app.ctx, week), [app.industry, app.role, app.scopeId, week], app.can('operations.read'));
  const now = Date.now();

  const byDay = (list: ShiftView[]) => {
    const groups = new Map<string, ShiftView[]>();
    for (const s of list) {
      const d = dateInZone(new Date(s.start), s.timeZone);
      if (d < week || d >= addDays(week, 7)) continue;
      groups.set(d, [...(groups.get(d) ?? []), s]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t('title')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" icon="chevron-left" onClick={() => setWeek(addDays(week, -7))} aria-label={t('prev')}>{t('prev')}</Button>
        <span className="text-sm font-bold" aria-live="polite">{t('weekOf', { date: fmtYmd(week, locale, { day: 'numeric', month: 'long', year: 'numeric' }) })}</span>
        <Button variant="secondary" onClick={() => setWeek(addDays(week, 7))} aria-label={t('next')}>{t('next')} <Icon name="chevron-right" size={14} /></Button>
        <Link href="/approvals" className="ml-auto text-xs font-bold underline">{t('swapsLink')}</Link>
      </div>
      <Async res={res} permission="operations.read" loading={<LoadingBlock variant="table" />}>
        {(list) => {
          const days = byDay(list);
          if (!days.length) return <Empty icon="calendar" title={t('emptyTitle')} body={t('emptyBody')} />;
          return (
            <div className="flex flex-col gap-3">
              {days.map(([d, shifts]) => (
                <section key={d} className="rounded-xl bg-surface p-3.5">
                  <h3 className="px-1 pb-2 text-sm font-bold">{fmtYmd(d, locale, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
                  <ul className="flex flex-col gap-1.5">
                    {shifts.map((s) => {
                      const live = Date.parse(s.start) <= now && Date.parse(s.end) >= now;
                      return (
                        <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-canvas-raised px-3.5 py-2.5 text-sm">
                          <span className="tabular min-w-[150px] font-semibold">
                            {fmtTime(s.start, s.timeZone, locale)}–{fmtTime(s.end, s.timeZone, locale)}
                            <span className="block text-xs font-medium text-stone">{zoneLabel(s.timeZone, locale)}</span>
                          </span>
                          <span className="flex min-w-[180px] flex-1 items-center gap-2">
                            <Avatar name={s.person} size={28} />
                            <span>
                              <strong>{s.person}</strong>
                              <span className="block text-xs text-stone">{s.role} · {s.locationName}</span>
                            </span>
                          </span>
                          <span className="flex flex-wrap gap-1.5">
                            {s.clockedInAt && s.clockedOutAt ? (
                              <Badge tone="neutral" icon="check">{t('worked', { from: fmtTime(s.clockedInAt, s.timeZone, locale), to: fmtTime(s.clockedOutAt, s.timeZone, locale) })}</Badge>
                            ) : s.clockedInAt ? (
                              <Badge tone="success" icon="clock">{t('clockedIn', { time: fmtTime(s.clockedInAt, s.timeZone, locale) })}</Badge>
                            ) : live ? (
                              <Badge tone="warning" icon="alert">{t('notClockedIn')}</Badge>
                            ) : null}
                            {s.pendingSwap && <Badge tone="info" icon="repeat">{t('swapPending', { name: s.pendingSwap.to })}</Badge>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          );
        }}
      </Async>
      <p className="text-xs text-stone">{t('footer')}</p>
    </section>
  );
}
