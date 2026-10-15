'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Field, Icon, Input, Select, cx } from '@bh/ui';
import {
  ACCESS_ACTIONS, WORKSPACES, capability, effectiveCapabilities, modulesFor, parseCapability, type AccessAction, type ModuleArea, type ModuleDef, type ScopeKind, type WorkspaceKey,
} from '@bh/shared';
import { WORKSPACE_ICON, settingsNav, visibleWorkspaces, workspaceNav } from '@/lib/access';
import { accessApi, useAccess, useAccessAction, type AssignmentAccessVM, type CustomRoleVM, type MyAccessVM, type RolesVM } from '@/lib/http/access';
import { useApp } from '../../shell/AppContext';
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

/** Role name for a system role key (translated) or a custom role. */
export function useRoleName() {
  const t = useTranslations('access.roles');
  return (role: string, custom?: { name: string } | null) => (role === 'custom' ? (custom?.name ?? t('custom')) : t.has(`${role}.name`) ? t(`${role}.name`) : role);
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
        const list = mods.filter((m) => m.area === area);
        if (!list.length) return null;
        return (
          <fieldset key={area} className="flex flex-col gap-1.5">
            <legend className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.06em] text-mute">
              {area !== 'settings' && <Icon name={WORKSPACE_ICON[area]} size={13} />}
              {text.area(area)}
            </legend>
            {list.map((m) => (
              <div key={m.key} className={cx('flex flex-wrap items-start gap-x-4 gap-y-2 rounded-md px-3 py-2.5', value.has(capability(m.key, 'view')) ? 'bg-lime/30' : 'bg-canvas')}>
                <div className="min-w-[200px] flex-1">
                  <div className="text-sm font-bold">{text.name(m)}</div>
                  <div className="text-xs text-stone">{text.description(m)}</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ACCESS_ACTIONS.filter((a) => m.actions.includes(a)).map((a) => {
                    const cap = capability(m.key, a);
                    const reason = disabledReason?.(cap) ?? null;
                    const checked = value.has(cap);
                    return (
                      <label key={a} title={reason ?? t(`actions.${a}.description`)} className={cx('flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-semibold', checked ? 'border-ink bg-surface' : 'border-line-soft bg-surface/60', reason && 'cursor-not-allowed opacity-50')}>
                        <input type="checkbox" className="h-4 w-4 accent-ink" checked={checked} disabled={!!reason} onChange={(e) => toggle(m, a, e.target.checked)} aria-describedby={reason ? undefined : undefined} data-testid={`cap-${cap}`} />
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

/** Capabilities the signed-in person holds at a scope (for "you can't grant what you don't hold"). */
function useHeldAt(me: MyAccessVM | undefined) {
  const app = useApp();
  return (scope: { kind: ScopeKind; id: string }) => {
    const loc = scope.kind === 'location' ? app.locations.find((l) => l.id === scope.id) : undefined;
    const covers = (a: MyAccessVM['assignments'][number]) =>
      a.scope.kind === 'organization' ||
      (a.scope.kind === 'region' && ((scope.kind === 'region' && scope.id === a.scope.id) || loc?.regionId === a.scope.id)) ||
      (a.scope.kind === 'owner_group' && ((scope.kind === 'owner_group' && scope.id === a.scope.id) || loc?.ownerGroupId === a.scope.id)) ||
      (a.scope.kind === 'location' && scope.kind === 'location' && scope.id === a.scope.id);
    return new Set((me?.assignments ?? []).filter(covers).flatMap((a) => a.capabilities));
  };
}

/** Base capabilities of a role at a scope, before per-person overrides. */
function baseCaps(industry: string, role: string, scopeKind: ScopeKind, custom: CustomRoleVM | undefined) {
  return effectiveCapabilities({ role, scopeKind, customCapabilities: custom?.capabilities ?? null }, industry);
}

/** "What can this person see?" — every assignment you manage, with its role, modules + actions and a nav preview. */
export function MemberAccessPanel({ userId, onClose, onSaved }: { userId: string; onClose: () => void; onSaved?: () => void }) {
  const t = useTranslations('access');
  const res = useAccess(() => Promise.all([accessApi.member(userId), accessApi.roles(), accessApi.me()]), [userId]);
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
        {([member, roles, me]) => (
          <div className="flex flex-col gap-5">
            {member.assignments.map((a) => (
              <AssignmentEditor key={a.id} a={a} roles={roles} me={me} onSaved={() => (res.reload(), onSaved?.())} />
            ))}
          </div>
        )}
      </Async>
    </section>
  );
}

function AssignmentEditor({ a, roles, me, onSaved }: { a: AssignmentAccessVM; roles: RolesVM; me: MyAccessVM; onSaved: () => void }) {
  const t = useTranslations('access');
  const app = useApp();
  const roleName = useRoleName();
  const heldAt = useHeldAt(me);
  const [role, setRole] = useState(a.role === 'custom' && a.customRoleId ? `custom:${a.customRoleId}` : a.role);
  const [caps, setCaps] = useState<Set<string>>(() => new Set(a.capabilities));
  const [saved, setSaved] = useState<{ added: number; removed: number } | null>(null);
  const customOf = (key: string) => (key.startsWith('custom:') ? roles.custom.find((c) => c.id === key.slice(7)) : undefined);
  const base: ReadonlySet<string> = useMemo(() => baseCaps(app.industry, role.startsWith('custom:') ? 'custom' : role, a.scope.kind, customOf(role)), [role, app.industry, a.scope.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const held = heldAt(a.scope);
  const hqOnly = new Set(modulesFor(app.industry).filter((m) => m.hqOnly).map((m) => m.key));
  const disabledReason = (cap: string) => {
    if (!a.editable) return t('editor.notEditable');
    if (a.scope.kind !== 'organization' && hqOnly.has(parseCapability(cap)!.module)) return t('editor.hqOnly');
    if (!held.has(cap) && !caps.has(cap)) return t('editor.notHeld');
    return null;
  };
  const save = useAccessAction(() => {
    const grants = [...caps].filter((c) => !base.has(c));
    const revokes = [...base].filter((c) => !caps.has(c));
    const custom = customOf(role);
    return accessApi.setAssignment(a.id, { role: custom ? 'custom' : role, customRoleId: custom?.id ?? null, grants, revokes });
  });
  const scopeLabel = a.scope.kind === 'organization' ? t('editor.wholeBusiness') : (a.scope.name ?? t(`scope.${a.scope.kind}`));
  const overrides = [...caps].filter((c) => !base.has(c)).length + [...base].filter((c) => !caps.has(c)).length;
  const ownerRole = a.role === 'org_owner';

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
              }}
              data-testid="assignment-role"
            >
              {ownerRole && <option value="org_owner">{roleName('org_owner')}</option>}
              {roles.templates.filter((r) => r.key !== 'org_owner').map((r) => (
                <option key={r.key} value={r.key}>{roleName(r.key)}</option>
              ))}
              {roles.custom.length > 0 && (
                <optgroup label={t('editor.customRoles')}>
                  {roles.custom.map((c) => (
                    <option key={c.id} value={`custom:${c.id}`}>{c.name}</option>
                  ))}
                </optgroup>
              )}
            </Select>
          )}
        </Field>
        <div className="pb-2.5 text-sm">
          <span className="text-stone">{t('editor.scope')}</span> <strong>{scopeLabel}</strong>
        </div>
        {overrides > 0 && <Badge tone="info" icon="sliders">{t('editor.overrides', { count: overrides })}</Badge>}
      </div>
      {ownerRole && <p className="text-xs text-stone">{t('editor.ownerNote')}</p>}
      {!a.editable && <Banner tone="info">{t('editor.readOnly')}</Banner>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <ModuleGrid value={caps} onChange={(n) => (setCaps(n), setSaved(null))} disabledReason={ownerRole ? () => t('editor.ownerNote') : disabledReason} />
        <NavPreview caps={caps} />
      </div>
      {save.error && <Banner tone="danger" live="assertive">{save.error.message}</Banner>}
      {saved && <Banner tone="success" live="polite">{t('editor.saved', { added: saved.added, removed: saved.removed })}</Banner>}
      {a.editable && !ownerRole && (
        <div className="flex flex-wrap gap-2">
          <Button
            loading={save.pending}
            data-testid="assignment-save"
            onClick={async () => {
              const r = await save.run();
              if (r) {
                setSaved({ added: r.changes.added.length, removed: r.changes.removed.length });
                onSaved();
              }
            }}
          >
            {t('editor.save')}
          </Button>
          <Button variant="secondary" onClick={() => (setCaps(new Set(base)), setSaved(null))}>{t('editor.reset')}</Button>
        </div>
      )}
    </div>
  );
}

/** Roles: the system templates (read-only starting points) and the business's own custom roles (create, edit, delete). */
export function RolesTab() {
  const t = useTranslations('access');
  const roleName = useRoleName();
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
          <section className="rounded-xl bg-surface p-4" aria-labelledby="template-roles">
            <h2 id="template-roles" className="mb-2 text-base font-bold">{t('roleAdmin.templatesTitle')}</h2>
            <ul className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
              {roles.templates.map((r) => (
                <li key={r.key} className="flex flex-col gap-1.5 rounded-md bg-canvas p-3">
                  <strong className="text-sm">{roleName(r.key)}</strong>
                  <span className="text-xs text-stone">{t.has(`roles.${r.key}.description`) ? t(`roles.${r.key}.description`) : r.description}</span>
                  <span className="flex flex-wrap gap-1">
                    {r.workspaces.map((w) => (
                      <span key={w} className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-semibold">{t(`workspace.${w}.name`)}</span>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Async>
  );
}

function RoleForm({ role, roles, me, onDone }: { role: CustomRoleVM | null; roles: RolesVM; me: MyAccessVM; onDone: () => void }) {
  const t = useTranslations('access');
  const app = useApp();
  const roleName = useRoleName();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [base, setBase] = useState(role?.baseRole ?? '');
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
              }}
            >
              <option value="">{t('roleAdmin.blank')}</option>
              {roles.templates.filter((r) => r.key !== 'org_owner').map((r) => (
                <option key={r.key} value={r.key}>{roleName(r.key)}</option>
              ))}
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
