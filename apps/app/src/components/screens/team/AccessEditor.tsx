'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, cx } from '@bh/ui';
import {
  ACCESS_ACTIONS, SENSITIVE_CLASSES, WORKSPACES, capability, effectiveCapabilities, moduleDef, modulesFor, parseCapability, type AccessAction, type ModuleArea, type ModuleDef, type ScopeKind,
  type WorkspaceKey,
} from '@bh/shared';
import { WORKSPACE_ICON, settingsNav, visibleWorkspaces, workspaceNav } from '@/lib/access';
import {
  accessApi, useAccess, useAccessAction, type AssignmentAccessVM, type CustomRoleVM, type MemberAccessVM, type MyAccessVM, type PreviewVM, type RoleTemplateVM, type RolesVM, type ScopesVM,
} from '@/lib/http/access';
import { useApp } from '../../shell/AppContext';
import { ScopePicker, type ScopeValue } from './ScopePicker';
import { useNavLabel } from '../../shell/Sidebar';
import { Async, Banner, LoadingBlock } from '../../ui/States';

const AREAS: readonly ModuleArea[] = [...WORKSPACES, 'settings'];

/** Translated module name / description, falling back to the catalogue's English (new modules from other features). */
export function useModuleText() {
  const t = useTranslations('access');
  return {
    name: (m: ModuleDef) => (t.has(`modules.${m.key}.name`) ? t(`modules.${m.key}.name`) : m.name),
    description: (m: ModuleDef) => (t.has(`modules.${m.key}.description`) ? t(`modules.${m.key}.description`) : m.description),
    area: (a: ModuleArea) => (a === 'settings' ? t('nav.settings') : t(`workspace.${a}.name`)),
  };
}

/**
 * Role name for a system role key or a custom role. A business can rename any template (`labels`, its own name wins);
 * otherwise the translated template name.
 */
export function useRoleName(labels?: Record<string, string> | null) {
  const t = useTranslations('access.roles');
  return (role: string, custom?: { name: string } | null) =>
    role === 'custom' ? (custom?.name ?? t('custom')) : labels?.[role] ? labels[role]! : t.has(`${role}.name`) ? t(`${role}.name`) : role;
}

/** The business's renamed templates, from the roles listing. */
export const labelsOf = (roles: RolesVM | undefined): Record<string, string> => Object.fromEntries((roles?.templates ?? []).filter((r) => r.label).map((r) => [r.key, r.label!]));

/** Role options grouped by team (templates are starting points, not an org chart), then the business's own roles. */
export function RoleOptions({ roles, includeOwner = false }: { roles: RolesVM; includeOwner?: boolean }) {
  const t = useTranslations('access');
  const roleName = useRoleName(labelsOf(roles));
  const teams = roles.teams?.length ? roles.teams : [...new Set(roles.templates.map((r) => r.team))];
  return (
    <>
      {teams.map((team) => {
        const list = roles.templates.filter((r) => r.team === team && (includeOwner || r.key !== 'org_owner'));
        if (!list.length) return null;
        return (
          <optgroup key={team} label={t.has(`teams.${team}`) ? t(`teams.${team}`) : team}>
            {list.map((r) => <option key={r.key} value={r.key}>{roleName(r.key)}</option>)}
          </optgroup>
        );
      })}
      {roles.custom.length > 0 && (
        <optgroup label={t('editor.customRoles')}>
          {roles.custom.map((c) => <option key={c.id} value={`custom:${c.id}`}>{c.name}</option>)}
        </optgroup>
      )}
    </>
  );
}

/**
 * Tick modules and actions, grouped by workspace, in plain language. Only built modules are listed (no placeholders).
 * `disabledReason` explains why a box can't be changed (HQ-only module, or access you don't hold yourself).
 */
export function ModuleGrid({ value, onChange, disabledReason }: { value: ReadonlySet<string>; onChange: (next: Set<string>) => void; disabledReason?: (cap: string) => string | null }) {
  const t = useTranslations('access');
  const app = useApp();
  const text = useModuleText();
  const mods = modulesFor(app.industry).filter((m) => m.status === 'available');
  const toggle = (m: ModuleDef, a: AccessAction, on: boolean) => {
    const next = new Set(value);
    if (on) {
      next.add(capability(m.key, a));
      next.add(capability(m.key, 'view'));
    } else if (a === 'view') {
      for (const x of m.actions) next.delete(capability(m.key, x));
    } else next.delete(capability(m.key, a));
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-4" data-testid="module-grid">
      {AREAS.map((area) => {
        // Screen-level sub-modules sit right under their parent module.
        const inArea = mods.filter((m) => m.area === area);
        const list = inArea.filter((m) => !m.parent || !inArea.some((p) => p.key === m.parent)).flatMap((m) => [m, ...inArea.filter((c) => c.parent === m.key)]);
        if (!list.length) return null;
        return (
          <fieldset key={area} className="flex flex-col gap-1.5">
            <legend className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">
              {area !== 'settings' && <Icon name={WORKSPACE_ICON[area]} size={13} />}
              {text.area(area)}
            </legend>
            {list.map((m) => (
              <div key={m.key} data-testid={`module-${m.key}`} className={cx('flex flex-wrap items-start gap-x-4 gap-y-2 rounded-md px-3 py-2.5', m.parent && 'ml-6 border-l-2 border-line-soft', value.has(capability(m.key, 'view')) ? 'bg-lime/30' : 'bg-canvas')}>
                <div className="min-w-[200px] flex-1">
                  {m.parent && <div className="text-[11px] font-semibold text-mute">{t('editor.subModule', { parent: (() => { const p = mods.find((x) => x.key === m.parent); return p ? text.name(p) : m.parent; })() })}</div>}
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-bold">
                    {text.name(m)}
                    {m.sensitive && <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-semibold text-stone">{t(`sensitive.${m.sensitive}`)}</span>}
                  </div>
                  <div className="text-xs text-stone">{text.description(m)}</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ACCESS_ACTIONS.filter((a) => m.actions.includes(a)).map((a) => {
                    const cap = capability(m.key, a);
                    const reason = disabledReason?.(cap) ?? null;
                    const checked = value.has(cap);
                    return (
                      <label key={a} title={reason ?? t(`actions.${a}.description`)} className={cx('flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-semibold', checked ? 'border-ink bg-surface' : 'border-line-soft bg-surface/60', reason && 'cursor-not-allowed opacity-50')}>
                        <input type="checkbox" className="h-4 w-4 accent-ink" checked={checked} disabled={!!reason} onChange={(e) => toggle(m, a, e.target.checked)} data-testid={`cap-${cap}`} />
                        {t(`actions.${a}.name`)}
                        {reason && <span className="sr-only">({reason})</span>}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

/** Live preview of the navigation a set of module actions gives: workspaces and their screens. */
export function NavPreview({ caps }: { caps: ReadonlySet<string> }) {
  const t = useTranslations('access');
  const app = useApp();
  const label = useNavLabel();
  const ws = visibleWorkspaces(caps, app.industry);
  const settings = settingsNav(caps, app.industry);
  return (
    <aside className="flex flex-col gap-3 rounded-xl bg-canvas p-4" aria-label={t('editor.previewTitle')} data-testid="nav-preview">
      <div>
        <h3 className="text-sm font-bold">{t('editor.previewTitle')}</h3>
        <p className="text-xs text-stone">{ws.length > 1 ? t('editor.previewSwitcher', { count: ws.length }) : t('editor.previewSingle')}</p>
      </div>
      {ws.length === 0 && settings.length === 0 && <p className="text-sm text-stone">{t('editor.previewNothing')}</p>}
      {ws.map((w: WorkspaceKey) => (
        <div key={w}>
          <div className="flex items-center gap-1.5 text-xs font-bold">
            <Icon name={WORKSPACE_ICON[w]} size={13} />
            {t(`workspace.${w}.name`)}
          </div>
          <ul className="mt-1 flex flex-wrap gap-1">
            {workspaceNav(w, caps, app.industry).map((l) => (
              <li key={l.href} className="rounded-full bg-surface px-2.5 py-1 text-xs">{label(l)}</li>
            ))}
          </ul>
        </div>
      ))}
      {settings.length > 0 && (
        <div>
          <div className="text-xs font-bold">{t('nav.settings')}</div>
          <ul className="mt-1 flex flex-wrap gap-1">
            {settings.map((l) => (
              <li key={l.href} className="rounded-full bg-surface px-2.5 py-1 text-xs">{label(l)}</li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

/**
 * Effective access, exactly as the server computes it, before anything is saved: the workspaces and modules with
 * their actions, the locations it reaches, the sensitive data it includes and what stays hidden.
 */
export function EffectivePreview({ preview }: { preview: PreviewVM }) {
  const t = useTranslations('access');
  const app = useApp();
  const text = useModuleText();
  const mod = (key: string) => moduleDef(app.industry, key);
  const hiddenByArea = AREAS.map((area) => ({ area, mods: preview.hidden.map(mod).filter((m): m is ModuleDef => !!m && m.area === area) })).filter((x) => x.mods.length);
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-ink/20 bg-canvas p-4" aria-labelledby="effective-title" data-testid="effective-preview">
      <div>
        <h3 id="effective-title" className="text-sm font-bold">{t('preview.title')}</h3>
        <p className="text-xs text-stone">{t('preview.intro')}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-[0.06em] text-mute">{t('preview.workspaces')}</h4>
          {preview.workspaces.length === 0 && preview.settings.length === 0 && <p className="text-sm text-stone">{t('editor.previewNothing')}</p>}
          <ul className="mt-1 flex flex-col gap-2">
            {preview.workspaces.map((w) => (
              <li key={w.key}>
                <div className="flex items-center gap-1.5 text-sm font-bold"><Icon name={WORKSPACE_ICON[w.key]} size={13} />{t(`workspace.${w.key}.name`)}</div>
                <ul className="ml-5 mt-0.5 flex flex-col gap-0.5 text-xs">
                  {w.modules.map((k) => {
                    const m = mod(k);
                    return (
                      <li key={k}>
                        <strong>{m ? text.name(m) : k}</strong>{' '}
                        <span className="text-stone">· {(preview.actions[k] ?? []).map((a) => t(`actions.${a}.name`)).join(', ')}</span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {preview.settings.length > 0 && (
              <li>
                <div className="text-sm font-bold">{t('nav.settings')}</div>
                <p className="ml-5 text-xs">{preview.settings.map((k) => { const m = mod(k); return m ? text.name(m) : k; }).join(', ')}</p>
              </li>
            )}
          </ul>
        </div>
        <div className="flex flex-col gap-3">
          <div>
            <h4 className="text-xs font-bold uppercase tracking-[0.06em] text-mute">{t('preview.locations')}</h4>
            <p className="text-sm" data-testid="preview-locations">{preview.locations.all ? t('preview.allLocations') : preview.locations.names.length ? preview.locations.names.join(', ') : t('preview.noLocations')}</p>
          </div>
          <div>
            <h4 className="text-xs font-bold uppercase tracking-[0.06em] text-mute">{t('preview.sensitiveTitle')}</h4>
            <p className="text-sm" data-testid="preview-sensitive">
              {preview.sensitive.length ? preview.sensitive.map((c) => t(`sensitive.${c}`)).join(', ') : t('preview.sensitiveNone')}
            </p>
          </div>
          <div>
            <h4 className="text-xs font-bold uppercase tracking-[0.06em] text-mute">{t('preview.hidden')}</h4>
            {hiddenByArea.length === 0 ? (
              <p className="text-sm text-stone">{t('preview.hiddenNone')}</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-xs text-stone" data-testid="preview-hidden">
                {hiddenByArea.map(({ area, mods }) => (
                  <li key={area}><strong className="text-ink">{text.area(area)}:</strong> {mods.map((m) => text.name(m)).join(', ')}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Capabilities the signed-in person holds at a scope (for "you can't grant what you don't hold"). */
function useHeldAt(me: MyAccessVM | undefined) {
  const app = useApp();
  return (scope: { kind: ScopeKind; id: string }) => {
    const loc = scope.kind === 'location' ? app.locations.find((l) => l.id === scope.id) : undefined;
    const covers = (a: MyAccessVM['assignments'][number]) =>
      a.scope.kind === 'organization' ||
      (a.scope.kind === scope.kind && a.scope.id === scope.id) ||
      (a.scope.kind === 'region' && loc?.regionId === a.scope.id) ||
      (a.scope.kind === 'owner_group' && loc?.ownerGroupId === a.scope.id) ||
      // Brand, territory and portfolio are resolved by the server; a location it returned to you is inside them.
      ((a.scope.kind === 'territory' || a.scope.kind === 'portfolio' || a.scope.kind === 'brand') && scope.kind === 'location' && !!loc);
    return new Set((me?.assignments ?? []).filter(covers).flatMap((a) => a.capabilities));
  };
}

/** Base capabilities of a role at a scope, before per-person overrides. */
function baseCaps(industry: string, role: string, scopeKind: ScopeKind, custom: CustomRoleVM | undefined) {
  return effectiveCapabilities({ role, scopeKind, customCapabilities: custom?.capabilities ?? null }, industry);
}

/** Label of a scope: the whole business, or its kind and name. */
function useScopeLabel() {
  const t = useTranslations('access');
  return (scope: { kind: ScopeKind; name: string | null }) => (scope.kind === 'organization' ? t('editor.wholeBusiness') : `${t(`scopeKind.${scope.kind}`)}: ${scope.name ?? ''}`);
}

/** "What can this person see?" — their job title and denies, every role you manage with its modules, and adding roles. */
export function MemberAccessPanel({ userId, onClose, onSaved }: { userId: string; onClose: () => void; onSaved?: () => void }) {
  const t = useTranslations('access');
  const app = useApp();
  const res = useAccess(() => Promise.all([accessApi.member(userId), accessApi.roles(), accessApi.me(), app.org.model === 'independent' ? Promise.resolve(null) : accessApi.scopes().catch(() => null)]), [userId]);
  return (
    <section className="flex flex-col gap-4 rounded-xl bg-surface p-5" aria-labelledby="member-access-title" data-testid="member-access">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="member-access-title" className="text-lg font-bold">{t('editor.title', { name: res.data?.[0].user.name ?? '' })}</h2>
          <p className="text-sm text-stone">{t('editor.intro')}</p>
        </div>
        <Button variant="secondary" icon="x" onClick={onClose}>{t('editor.close')}</Button>
      </div>
      <Async res={res} loading={<LoadingBlock variant="detail" />}>
        {([member, roles, me, scopes]) => {
          const editable = member.assignments.some((a) => a.editable);
          return (
            <div className="flex flex-col gap-5">
              <ProfileEditor member={member} editable={editable} onSaved={() => (res.reload(), onSaved?.())} />
              {member.assignments.length > 1 && <p className="text-xs text-stone">{t('editor.unionNote')}</p>}
              {member.assignments.map((a) => (
                <AssignmentEditor key={a.id} a={a} roles={roles} me={me} deniedClasses={member.deniedClasses} onSaved={() => (res.reload(), onSaved?.())} />
              ))}
              {editable && <AddRole userId={userId} roles={roles} scopes={scopes} onAdded={() => (res.reload(), onSaved?.())} />}
            </div>
          );
        }}
      </Async>
    </section>
  );
}

/** Job title (free text, not a role) and the sensitive classes denied across all of the person's roles. */
function ProfileEditor({ member, editable, onSaved }: { member: MemberAccessVM; editable: boolean; onSaved: () => void }) {
  const t = useTranslations('access');
  const owner = member.assignments.some((a) => a.role === 'org_owner');
  const [jobTitle, setJobTitle] = useState(member.jobTitle ?? '');
  const [denied, setDenied] = useState<Set<string>>(() => new Set(member.deniedClasses));
  const [ok, setOk] = useState(false);
  const save = useAccessAction(() => accessApi.setProfile(member.user.id, { jobTitle: jobTitle.trim() || null, ...(owner ? {} : { deniedClasses: [...denied] }) }));
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-canvas p-4" data-testid="profile-editor">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Field label={t('profile.jobTitle')} hint={t('profile.jobTitleHint')}>
          {(p) => <Input id={p.id} aria-describedby={p.describedBy} value={jobTitle} disabled={!editable} onChange={(e) => (setJobTitle(e.target.value), setOk(false))} data-testid="job-title" />}
        </Field>
        {!owner && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-bold">{t('profile.denyTitle')}</legend>
            <p className="text-xs text-stone">{t('profile.denyHint')}</p>
            <div className="flex flex-wrap gap-1.5">
              {SENSITIVE_CLASSES.map((c) => (
                <label key={c} className={cx('flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold', denied.has(c) ? 'border-danger bg-danger-bg' : 'border-line-soft bg-surface', !editable && 'opacity-50')}>
                  <input type="checkbox" className="h-4 w-4 accent-ink" disabled={!editable} checked={denied.has(c)} onChange={(e) => { const n = new Set(denied); if (e.target.checked) n.add(c); else n.delete(c); setDenied(n); setOk(false); }} data-testid={`deny-${c}`} />
                  {t('profile.deny', { kind: t(`sensitive.${c}`) })}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
      {ok && <Banner tone="success" live="polite">{t('profile.saved')}</Banner>}
      {editable && (
        <div>
          <Button size="sm" variant="secondary" loading={save.pending} onClick={async () => { if (await save.run()) { setOk(true); onSaved(); } }} data-testid="profile-save">{t('profile.save')}</Button>
        </div>
      )}
    </div>
  );
}

function AssignmentEditor({ a, roles, me, deniedClasses, onSaved }: { a: AssignmentAccessVM; roles: RolesVM; me: MyAccessVM; deniedClasses: string[]; onSaved: () => void }) {
  const t = useTranslations('access');
  const app = useApp();
  const roleName = useRoleName(labelsOf(roles));
  const scopeLabel = useScopeLabel();
  const heldAt = useHeldAt(me);
  const [role, setRole] = useState(a.role === 'custom' && a.customRoleId ? `custom:${a.customRoleId}` : a.role);
  const [caps, setCaps] = useState<Set<string>>(() => new Set(a.capabilities));
  const [saved, setSaved] = useState<{ added: number; removed: number } | null>(null);
  const [reviewing, setReviewing] = useState<PreviewVM | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [templateSaved, setTemplateSaved] = useState<string | null>(null);
  const customOf = (key: string) => (key.startsWith('custom:') ? roles.custom.find((c) => c.id === key.slice(7)) : undefined);
  const base: ReadonlySet<string> = useMemo(() => baseCaps(app.industry, role.startsWith('custom:') ? 'custom' : role, a.scope.kind, customOf(role)), [role, app.industry, a.scope.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const held = heldAt(a.scope);
  const hqOnly = new Set(modulesFor(app.industry).filter((m) => m.hqOnly && !(a.scope.kind === 'territory' && m.territoryOk)).map((m) => m.key));
  const disabledReason = (cap: string) => {
    if (!a.editable) return t('editor.notEditable');
    if (a.scope.kind !== 'organization' && hqOnly.has(parseCapability(cap)!.module)) return t('editor.hqOnly');
    if (!held.has(cap) && !caps.has(cap)) return t('editor.notHeld');
    return null;
  };
  const preview = useAccessAction(() => accessApi.preview({ role: 'custom', scopeKind: a.scope.kind, scopeId: a.scope.kind === 'organization' ? undefined : a.scope.id, capabilities: [...caps], deniedClasses }));
  const save = useAccessAction(() => {
    const grants = [...caps].filter((c) => !base.has(c));
    const revokes = [...base].filter((c) => !caps.has(c));
    const custom = customOf(role);
    return accessApi.setAssignment(a.id, { role: custom ? 'custom' : role, customRoleId: custom?.id ?? null, grants, revokes });
  });
  const asTemplate = useAccessAction((name: string) => accessApi.createRole({ name, capabilities: [...caps].filter((c) => held.has(c) || a.scope.kind === 'organization'), baseRole: role.startsWith('custom:') ? undefined : role }));
  const remove = useAccessAction(() => accessApi.removeAssignment(a.id));
  const overrides = [...caps].filter((c) => !base.has(c)).length + [...base].filter((c) => !caps.has(c)).length;
  const ownerRole = a.role === 'org_owner';
  const tpl = roles.templates.find((r) => r.key === role);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line-soft p-4" data-testid={`assignment-${a.id}`}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('editor.role')}>
          {(p) => (
            <Select
              id={p.id}
              value={role}
              disabled={!a.editable || ownerRole}
              onChange={(e) => {
                const next = e.target.value;
                setRole(next);
                setCaps(new Set(baseCaps(app.industry, next.startsWith('custom:') ? 'custom' : next, a.scope.kind, customOf(next))));
                setSaved(null);
                setReviewing(null);
              }}
              data-testid="assignment-role"
            >
              {ownerRole && <option value="org_owner">{roleName('org_owner')}</option>}
              <RoleOptions roles={roles} />
            </Select>
          )}
        </Field>
        <div className="pb-2.5 text-sm">
          <span className="text-stone">{t('editor.scope')}</span> <strong>{scopeLabel(a.scope)}</strong>
          {a.scope.kind !== 'organization' && Array.isArray(a.locations) && (
            <span className="block text-xs text-stone" data-testid="assignment-locations">{t('editor.reaches', { count: a.locations.length, names: a.locations.slice(0, 4).join(', ') })}</span>
          )}
        </div>
        {tpl?.support && <Badge tone="info" icon="shield">{t('roleTags.support')}</Badge>}
        {overrides > 0 && <Badge tone="info" icon="sliders">{t('editor.overrides', { count: overrides })}</Badge>}
      </div>
      {ownerRole && <p className="text-xs text-stone">{t('editor.ownerNote')}</p>}
      {!a.editable && <Banner tone="info">{t('editor.readOnly')}</Banner>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <ModuleGrid value={caps} onChange={(n) => (setCaps(n), setSaved(null), setReviewing(null))} disabledReason={ownerRole ? () => t('editor.ownerNote') : disabledReason} />
        <NavPreview caps={caps} />
      </div>
      {reviewing && <EffectivePreview preview={reviewing} />}
      {(save.error ?? preview.error ?? asTemplate.error ?? remove.error) && <Banner tone="danger" live="assertive">{(save.error ?? preview.error ?? asTemplate.error ?? remove.error)!.message}</Banner>}
      {saved && <Banner tone="success" live="polite">{t('editor.saved', { added: saved.added, removed: saved.removed })}</Banner>}
      {templateSaved && <Banner tone="success" live="polite">{t('editor.templateSaved', { name: templateSaved })}</Banner>}
      {a.editable && !ownerRole && (
        <div className="flex flex-wrap items-end gap-2">
          {!reviewing ? (
            <Button loading={preview.pending} data-testid="assignment-review" onClick={async () => { const p = await preview.run(); if (p) setReviewing(p); }}>
              {t('editor.review')}
            </Button>
          ) : (
            <>
              <Button
                loading={save.pending}
                data-testid="assignment-save"
                onClick={async () => {
                  const r = await save.run();
                  if (r) {
                    setSaved({ added: r.changes.added.length, removed: r.changes.removed.length });
                    setReviewing(null);
                    onSaved();
                  }
                }}
              >
                {t('editor.confirmSave')}
              </Button>
              <Button variant="secondary" onClick={() => setReviewing(null)}>{t('editor.backToEdit')}</Button>
            </>
          )}
          <Button variant="secondary" onClick={() => (setCaps(new Set(base)), setSaved(null), setReviewing(null))}>{t('editor.reset')}</Button>
          {templateName === null ? (
            <Button variant="ghost" icon="copy" onClick={() => (setTemplateName(''), setTemplateSaved(null))} data-testid="save-as-template">{t('editor.saveAsTemplate')}</Button>
          ) : (
            <span className="flex flex-wrap items-end gap-2">
              <Field label={t('editor.templateName')}>{(p) => <Input id={p.id} value={templateName} onChange={(e) => setTemplateName(e.target.value)} data-testid="template-name" />}</Field>
              <Button variant="secondary" disabled={!templateName.trim()} loading={asTemplate.pending} onClick={async () => { const r = await asTemplate.run(templateName.trim()); if (r) { setTemplateSaved(r.name); setTemplateName(null); } }} data-testid="template-save">{t('editor.templateSave')}</Button>
              <Button variant="ghost" onClick={() => setTemplateName(null)}>{t('editor.cancel')}</Button>
            </span>
          )}
          <Button variant="ghost" icon="x" className="ml-auto" loading={remove.pending} onClick={async () => { if (await remove.run()) onSaved(); }}>{t('editor.removeRole')}</Button>
        </div>
      )}
    </div>
  );
}

/** Scope choices for giving a role: the business, brands, territories, regions, portfolios, owner groups, locations. */
export function scopeChoices(scopes: ScopesVM | null, orgId: string): { value: string; kind: ScopeKind; id: string; name: string | null }[] {
  const out: { value: string; kind: ScopeKind; id: string; name: string | null }[] = [{ value: `organization:${orgId}`, kind: 'organization', id: orgId, name: null }];
  if (!scopes) return out;
  const add = (kind: ScopeKind, list: { id: string; name: string }[]) => { for (const x of list) out.push({ value: `${kind}:${x.id}`, kind, id: x.id, name: x.name }); };
  if (scopes.brands.length > 1) add('brand', scopes.brands);
  add('territory', scopes.territories);
  add('region', scopes.regions);
  add('portfolio', scopes.portfolios);
  add('owner_group', scopes.ownerGroups);
  add('location', scopes.locations);
  return out;
}

/** "Add another role": several roles per person; their access is the union. */
function AddRole({ userId, roles, scopes, onAdded }: { userId: string; roles: RolesVM; scopes: ScopesVM | null; onAdded: () => void }) {
  const t = useTranslations('access');
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState('trainer');
  const [scope, setScope] = useState<ScopeValue>({ kind: 'organization', id: app.org.id });
  const add = useAccessAction(() => {
    const custom = role.startsWith('custom:') ? role.slice(7) : undefined;
    return accessApi.addAssignment({ userId, role: custom ? 'custom' : role, ...(custom ? { customRoleId: custom } : {}), scope, grants: [], revokes: [] });
  });
  if (!open) return <div><Button variant="secondary" icon="plus" onClick={() => setOpen(true)} data-testid="add-role">{t('editor.addRole')}</Button></div>;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-line-soft p-4" data-testid="add-role-form">
      <h3 className="text-sm font-bold">{t('editor.addRoleTitle')}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('editor.role')}>{(p) => <Select id={p.id} value={role} onChange={(e) => setRole(e.target.value)} data-testid="add-role-role"><RoleOptions roles={roles} /></Select>}</Field>
      </div>
      <ScopePicker scopes={scopes} orgId={app.org.id} value={scope} onChange={setScope} testId="add-role-scope" />
      {add.error && <Banner tone="danger" live="assertive">{add.error.message}</Banner>}
      <div className="flex gap-2">
        <Button loading={add.pending} onClick={async () => { if (await add.run()) { setOpen(false); onAdded(); } }} data-testid="add-role-save">{t('editor.addRoleSave')}</Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>{t('editor.cancel')}</Button>
      </div>
    </div>
  );
}

/** Roles: the system templates (starting points, grouped by team, renameable) and the business's own roles. */
export function RolesTab() {
  const t = useTranslations('access');
  const res = useAccess(() => Promise.all([accessApi.roles(), accessApi.me()]), []);
  const [editing, setEditing] = useState<CustomRoleVM | 'new' | null>(null);
  return (
    <Async res={res} loading={<LoadingBlock variant="table" />}>
      {([roles, me]) => (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-stone">{t('roleAdmin.intro')}</p>
            <Button icon="plus" onClick={() => setEditing('new')} data-testid="role-create">{t('roleAdmin.create')}</Button>
          </div>
          {editing && <RoleForm role={editing === 'new' ? null : editing} roles={roles} me={me} onDone={() => (setEditing(null), res.reload())} />}
          <section className="rounded-xl bg-surface p-4" aria-labelledby="custom-roles">
            <h2 id="custom-roles" className="mb-2 text-base font-bold">{t('roleAdmin.customTitle')}</h2>
            {roles.custom.length === 0 ? (
              <p className="text-sm text-stone">{t('roleAdmin.customEmpty')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {roles.custom.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-md bg-canvas px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm">{c.name}</strong>
                      <span className="block text-xs text-stone">{c.description ?? ''} {t('roleAdmin.assigned', { count: c.assignedCount })}</span>
                    </span>
                    <Button size="sm" variant="secondary" onClick={() => setEditing(c)}>{t('roleAdmin.edit')}</Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-3 rounded-xl bg-surface p-4" aria-labelledby="template-roles">
            <div>
              <h2 id="template-roles" className="text-base font-bold">{t('roleAdmin.templatesTitle')}</h2>
              <p className="text-sm text-stone">{t('roleAdmin.templatesIntro')}</p>
            </div>
            {(roles.teams ?? []).map((team) => {
              const list = roles.templates.filter((r) => r.team === team);
              if (!list.length) return null;
              return (
                <div key={team} data-testid={`team-${team}`}>
                  <h3 className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">{t(`teams.${team}`)}</h3>
                  <ul className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
                    {list.map((r) => <TemplateCard key={r.key} r={r} roles={roles} onRenamed={() => res.reload()} />)}
                  </ul>
                </div>
              );
            })}
          </section>
        </div>
      )}
    </Async>
  );
}

function TemplateCard({ r, roles, onRenamed }: { r: RoleTemplateVM; roles: RolesVM; onRenamed: () => void }) {
  const t = useTranslations('access');
  const translated = useRoleName();
  const [name, setName] = useState<string | null>(null);
  const rename = useAccessAction((n: string | null) => accessApi.renameRole(r.key, n));
  return (
    <li className="flex flex-col gap-1.5 rounded-md bg-canvas p-3" data-testid={`template-${r.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm">{r.label ?? translated(r.key)}</strong>
        {r.label && <span className="text-xs text-stone">{t('roleAdmin.templateWas', { name: translated(r.key) })}</span>}
        {r.support && <Badge tone="info" icon="shield">{t('roleTags.support')}</Badge>}
        {r.key !== 'org_owner' && name === null && (
          <button type="button" className="ml-auto text-xs font-bold underline" onClick={() => setName(r.label ?? translated(r.key))} data-testid={`rename-${r.key}`}>{t('roleAdmin.rename')}</button>
        )}
      </div>
      {name !== null && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('roleAdmin.renameLabel')}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} data-testid={`rename-input-${r.key}`} />}</Field>
          <Button size="sm" disabled={!name.trim()} loading={rename.pending} onClick={async () => { if (await rename.run(name.trim())) { setName(null); onRenamed(); } }} data-testid={`rename-save-${r.key}`}>{t('roleAdmin.renameSave')}</Button>
          {r.label && <Button size="sm" variant="secondary" onClick={async () => { if (await rename.run(null)) { setName(null); onRenamed(); } }}>{t('roleAdmin.renameReset')}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setName(null)}>{t('editor.cancel')}</Button>
        </div>
      )}
      {rename.error && <Banner tone="danger" live="assertive">{rename.error.message}</Banner>}
      <span className="text-xs text-stone">{t.has(`roles.${r.key}.description`) ? t(`roles.${r.key}.description`) : r.description}</span>
      <span className="flex flex-wrap gap-1">
        <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold">{t('roleAdmin.usualScope', { scope: t(`scopeKind.${r.defaultScope}`) })}</span>
        {r.workspaces.map((w) => (
          <span key={w} className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold">{t(`workspace.${w}.name`)}</span>
        ))}
        {r.sensitive.map((c) => (
          <span key={c} className="rounded-full bg-blush px-2 py-0.5 text-[11px] font-semibold">{t(`sensitive.${c}`)}</span>
        ))}
      </span>
      {roles.templates.length === 0 && null}
    </li>
  );
}

function RoleForm({ role, roles, me, onDone }: { role: CustomRoleVM | null; roles: RolesVM; me: MyAccessVM; onDone: () => void }) {
  const t = useTranslations('access');
  const app = useApp();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [base, setBase] = useState(role?.baseRole ?? '');
  // New roles start empty (least privilege): nothing is ticked until you tick it or start from a template.
  const [caps, setCaps] = useState<Set<string>>(() => new Set(role?.capabilities ?? []));
  const held = new Set(me.assignments.filter((a) => a.scope.kind === 'organization').flatMap((a) => a.capabilities));
  const save = useAccessAction(() => {
    const body = { name: name.trim(), description: description.trim() || undefined, baseRole: base || undefined, capabilities: [...caps] };
    return role ? accessApi.updateRole(role.id, body) : accessApi.createRole(body);
  });
  const del = useAccessAction(() => accessApi.deleteRole(role!.id));
  return (
    <section className="flex flex-col gap-3 rounded-xl bg-surface p-5" aria-labelledby="role-form-title" data-testid="role-form">
      <h2 id="role-form-title" className="text-lg font-bold">{role ? t('roleAdmin.editTitle', { name: role.name }) : t('roleAdmin.createTitle')}</h2>
      {!role && <p className="text-sm text-stone">{t('roleAdmin.emptyStart')}</p>}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t('roleAdmin.name')} error={save.error?.fields?.name}>{(p) => <Input id={p.id} value={name} onChange={(e) => setName(e.target.value)} data-testid="role-name" />}</Field>
        <Field label={t('roleAdmin.description')}>{(p) => <Input id={p.id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Field label={t('roleAdmin.startFrom')}>
          {(p) => (
            <Select
              id={p.id}
              value={base}
              onChange={(e) => {
                setBase(e.target.value);
                const tpl = roles.templates.find((r) => r.key === e.target.value);
                if (tpl) setCaps(new Set(tpl.capabilities.filter((c) => held.has(c))));
                else setCaps(new Set());
              }}
            >
              <option value="">{t('roleAdmin.blank')}</option>
              <RoleOptions roles={{ ...roles, custom: [] }} />
            </Select>
          )}
        </Field>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <ModuleGrid value={caps} onChange={setCaps} disabledReason={(c) => (!held.has(c) && !caps.has(c) ? t('editor.notHeld') : null)} />
        <NavPreview caps={caps} />
      </div>
      {role && role.assignedCount > 0 && <p className="text-xs text-stone">{t('roleAdmin.appliesNow', { count: role.assignedCount })}</p>}
      {(save.error ?? del.error) && <Banner tone="danger" live="assertive">{(save.error ?? del.error)!.message}</Banner>}
      <div className="flex flex-wrap gap-2">
        <Button loading={save.pending} disabled={!name.trim()} data-testid="role-save" onClick={async () => (await save.run()) && onDone()}>{t('roleAdmin.save')}</Button>
        <Button variant="secondary" onClick={onDone}>{t('editor.cancel')}</Button>
        {role && (
          <Button variant="ghost" icon="x" loading={del.pending} disabled={role.assignedCount > 0} onClick={async () => (await del.run()) && onDone()} className="ml-auto">
            {t('roleAdmin.delete')}
          </Button>
        )}
      </div>
      {app.org.model !== 'independent' && <p className="text-xs text-stone">{t('roleAdmin.scopeNote')}</p>}
    </section>
  );
}
