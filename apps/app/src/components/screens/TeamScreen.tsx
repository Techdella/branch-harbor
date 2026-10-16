'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Avatar, Badge, Button, DataTable, Field, Icon, Input, Select, Tabs } from '@bh/ui';
import type { Member, ShiftView } from '@/lib/types';
import { addDays, dateInZone, fmtTime, fmtYmd, weekStart, zoneLabel } from '@/lib/format';
import { useApi, useMutation } from '@/lib/useApi';
import { accessApi, useAccess } from '@/lib/http/access';
import { MemberAccessPanel, RoleOptions, RolesTab, labelsOf, scopeChoices, useRoleName } from './team/AccessEditor';
import { CoverageCard, TeamShapeTab } from './team/TeamShape';
import { ScopesManager } from './team/ScopesManager';
import { ScopePicker, inviteScopeId, type ScopeValue } from './team/ScopePicker';
import { useApp } from '../shell/AppContext';
import { useBusinessMode } from '@/lib/useBusinessMode';
import { PageHeader } from '../shell/PageHeader';
import { Async, Banner, DeniedState, Empty, LoadingBlock } from '../ui/States';
import { useDataText } from '../ui/useDataText';

/** Team & access: members with "What can this person see?", and the business's roles. The staff schedule lives in Operations. */
export function TeamScreen() {
  const t = useTranslations('team');
  const ta = useTranslations('access');
  const app = useApp();
  const [tab, setTab] = useState<'members' | 'roles' | 'shape' | 'scopes'>('members');
  if (!app.hasModule('settings.team')) return <DeniedState />;
  const canEdit = app.capabilities.has('settings.team:edit');
  // Team shape and scopes are business-wide: for people who manage the team of the whole business.
  const orgAdmin = canEdit && app.session.assignments.some((a) => a.scope.kind === 'organization');
  return (
    <>
      <PageHeader icon="user" title={t('title')} description={t('description')} />
      {canEdit && (
        <Tabs
          items={[
            { key: 'members' as const, label: t('tab.members') },
            { key: 'roles' as const, label: ta('roleAdmin.tab') },
            ...(orgAdmin && app.org.model !== 'independent' ? [{ key: 'shape' as const, label: ta('shape.tab') }, { key: 'scopes' as const, label: ta('scopes.tab') }] : []),
          ]}
          value={tab}
          onChange={setTab}
        />
      )}
      {tab === 'roles' && canEdit ? <RolesTab /> : tab === 'shape' && orgAdmin ? <TeamShapeTab /> : tab === 'scopes' && orgAdmin ? <ScopesManager /> : <MembersTab />}
    </>
  );
}

function MembersTab() {
  const t = useTranslations('team');
  const ta = useTranslations('access');
  const ts = useTranslations('single.team');
  const app = useApp();
  const mode = useBusinessMode();
  const canEdit = app.capabilities.has('settings.team:edit');
  const res = useApi((api) => api.team.members(app.ctx), [app.industry, app.org.id]);
  const roles = useAccess(() => accessApi.roles(), [app.org.id], canEdit);
  const scopes = useAccess(() => accessApi.scopes(), [app.org.id], canEdit && !mode.isIndependent);
  const roleName = useRoleName(labelsOf(roles.data));
  const orgWide = app.session.assignments.some((a) => a.scope.kind === 'organization');
  const [inviting, setInviting] = useState(false);
  const [access, setAccess] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>(mode.isIndependent ? 'staff' : 'location_manager');
  const [scopeId, setScopeId] = useState(app.scopes.find((s) => s.kind === 'location')?.id ?? 'all');
  const firstLoc = app.scopes.find((s) => s.kind === 'location')?.id.replace(/^loc:/, '');
  const [pickedScope, setPickedScope] = useState<ScopeValue>(firstLoc ? { kind: 'location', id: firstLoc } : { kind: 'organization', id: app.org.id });
  const [ok, setOk] = useState('');
  const template = roles.data?.templates.find((r) => r.key === role);
  const custom = role.startsWith('custom:') ? roles.data?.custom.find((c) => `custom:${c.id}` === role) : undefined;
  // Independent: no scope to pick — org-wide roles cover the business, the others its one location.
  const independentScope = template?.defaultScope === 'organization' || !mode.location ? 'all' : `loc:${mode.location.id}`;
  const roleLabel = (r: string) => (r.startsWith('custom:') ? (custom?.name ?? r) : roleName(r));
  const dt = useDataText();
  /** Assignment role: independent businesses use their own role names; otherwise the access catalogue, else the API label. */
  const assignmentRole = (a: Member['assignments'][number]) =>
    a.renamed ? a.renamed : a.roleKey && mode.isIndependent && ts.has(`role.${a.roleKey}`) ? ts(`role.${a.roleKey}`) : a.roleKey ? roleName(a.roleKey) : dt(undefined, undefined, a.role);
  // Brands, territories and portfolios join the location scopes when inviting (the API resolves them).
  const extraScopes = scopeChoices(scopes.data ?? null, app.org.id).filter((c) => c.kind === 'territory' || c.kind === 'portfolio' || c.kind === 'brand');
  const invite = useMutation((api) =>
    mode.isIndependent
      ? api.team.invite({ email, role: roleLabel(role), roleKey: role, scopeId: independentScope, scopeLabel: mode.businessName })
      : api.team.invite({ email, role: roleLabel(role), roleKey: role, scopeId, scopeLabel: app.scopes.find((s) => s.id === scopeId)?.label ?? scopeChoices(scopes.data ?? null, app.org.id).find((c) => c.kind === pickedScope.kind && c.id === pickedScope.id)?.name ?? '' }),
  );

  return (
    <>
      {canEdit && (
        <div className="flex justify-end">
          <Button icon="plus" onClick={() => (setInviting(true), setOk(''))}>{t('invite')}</Button>
        </div>
      )}
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
                  {roles.data && <RoleOptions roles={roles.data} />}
                </Select>
              )}
            </Field>
            {!mode.isIndependent && (
              <div className={orgWide && scopes.data ? 'md:col-span-3' : undefined}>
                {orgWide && scopes.data ? (
                  <ScopePicker scopes={scopes.data} orgId={app.org.id} value={pickedScope} onChange={(v) => { setPickedScope(v); setScopeId(inviteScopeId(v)); }} testId="invite-scope" />
                ) : (
                  <Field label={t('scope')} hint={t('scopeHint')}>
                    {(p) => (
                      <Select id={p.id} aria-describedby={p.describedBy} value={scopeId} onChange={(e) => setScopeId(e.target.value)}>
                        {app.scopes.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.kind === 'all' ? t('wholeOrg') : s.label}
                          </option>
                        ))}
                        {extraScopes.length > 0 && (
                          <optgroup label={ta('scopes.title')}>
                            {extraScopes.map((c) => <option key={c.value} value={c.value}>{`${ta(`scopeKind.${c.kind}`)}: ${c.name ?? ''}`}</option>)}
                          </optgroup>
                        )}
                      </Select>
                    )}
                  </Field>
                )}
              </div>
            )}
          </div>
          <p className="text-xs text-stone">{custom ? (custom.description ?? '') : ta.has(`roles.${role}.description`) ? ta(`roles.${role}.description`) : (template?.description ?? '')}</p>
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
      {canEdit && orgWide && !mode.isIndependent && res.data && (
        <CoverageCard people={res.data.filter((m) => m.status === 'active').map((m) => ({ id: m.id, name: m.name }))} />
      )}
      {access && <MemberAccessPanel userId={access} onClose={() => setAccess(null)} onSaved={() => res.reload()} />}
      <Async res={res} loading={<LoadingBlock variant="table" />}>
        {(members) => (
          <section className="overflow-x-auto rounded-xl bg-surface p-3.5">
            <DataTable<Member>
              rows={members}
              rowKey={(m) => m.id}
              columns={[
                { key: 'person', header: t('col.person'), render: (m) => <span className="flex items-center gap-2.5"><Avatar name={m.name} size={32} pastel={m.status === 'support' ? '#F7EDA8' : '#E2F5A6'} /><span><strong>{m.name}</strong>{m.jobTitle && <span className="block text-xs font-semibold" data-testid="job-title-cell">{m.jobTitle}</span>}<span className="block text-xs text-stone">{m.email}</span></span></span> },
                { key: 'roles', header: t('col.assignments'), render: (m) => <ul className="flex flex-col gap-0.5">{m.assignments.map((a, i) => <li key={i}><strong>{assignmentRole(a)}</strong> <span className="text-stone">· {dt(a.scopeKey, a.scopeParams, a.scopeLabel)}</span></li>)}</ul> },
                { key: 'last', header: t('col.lastActive'), render: (m) => dt(m.lastActiveKey, m.lastActiveParams, m.lastActive) },
                { key: 'status', header: t('col.status'), render: (m) => <Badge tone={m.status === 'active' ? 'success' : m.status === 'invited' ? 'info' : 'warning'} icon={m.status === 'support' ? 'shield' : undefined}>{t(`status.${m.status}`)}</Badge> },
                {
                  key: 'access',
                  header: ta('editor.column'),
                  render: (m) =>
                    m.status === 'active' ? (
                      <Button size="sm" variant="secondary" icon="eye" onClick={() => setAccess(m.id)} data-testid={`access-${m.email}`}>
                        {ta('editor.open')}
                      </Button>
                    ) : null,
                },
              ]}
            />
          </section>
        )}
      </Async>
      <p className="text-xs text-stone">{t('footer')}</p>
    </>
  );
}

/** Operations → Staff schedule: shifts per location and person for one week, in each location's own time zone. */
export function ScheduleScreen() {
  const t = useTranslations('team.schedule');
  const app = useApp();
  if (!app.hasModule('operations.schedule')) return <DeniedState />;
  return (
    <>
      <PageHeader icon="clock" title={t('title')} />
      <ScheduleTab />
    </>
  );
}

function ScheduleTab() {
  const t = useTranslations('team.schedule');
  const locale = useLocale();
  const app = useApp();
  const tz = app.locations[0]?.timeZone ?? 'UTC';
  const [week, setWeek] = useState(() => weekStart(dateInZone(new Date(), tz)));
  const res = useApi((api) => api.team.schedule(app.ctx, week), [app.industry, app.scopeId, week]);
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
        {app.hasModule('network.approvals') && <Link href="/approvals" className="ml-auto text-xs font-bold underline">{t('swapsLink')}</Link>}
      </div>
      <Async res={res} loading={<LoadingBlock variant="table" />}>
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
