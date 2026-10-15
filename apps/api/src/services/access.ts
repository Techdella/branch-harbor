import { and, count, eq, inArray } from 'drizzle-orm';
import {
  ACCESS_ACTIONS, ACTION_META, ROLE_TEMPLATES, TEAM_ROLE_ORDER, WORKSPACES, WORKSPACE_META, asBusinessModel, effectiveCapabilities, inviteRolesFor, modulesFor,
  normalizeCapabilities, parseCapability, permissionsFromCapabilities, workspacesFor, settingsModulesFor, type Capability, type Role, type ScopeKind,
} from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { customRoles, memberAccessOverrides, roleAssignments, roleCapabilities } from '../db/schema/index.ts';
import { AppError, notFound } from '../lib/errors.ts';

/** The capability catalogue for an industry: workspaces, modules (with status) and actions. */
export function catalogue(industry: string) {
  return {
    industry,
    workspaces: WORKSPACES.map((w) => WORKSPACE_META[w]),
    actions: ACCESS_ACTIONS.map((a) => ({ key: a, ...ACTION_META[a] })),
    modules: modulesFor(industry).map((m) => ({ ...m, actions: [...m.actions], screens: m.screens ? [...m.screens] : undefined })),
  };
}

/** System role templates offered to an organisation (independent businesses get the simplified set). */
export function templatesFor(industry: string, model: string) {
  const offered = new Set<Role>(inviteRolesFor(asBusinessModel(model)));
  return TEAM_ROLE_ORDER.filter((r) => offered.has(r)).map((r) => {
    const t = ROLE_TEMPLATES[r];
    const caps = effectiveCapabilities({ role: r, scopeKind: 'organization' }, industry);
    return {
      key: t.key, name: t.name, description: t.description, primaryWorkspace: t.primaryWorkspace, defaultScope: t.defaultScope, networkOnly: !!t.networkOnly,
      capabilities: [...caps].sort(),
      workspaces: workspacesFor(caps, industry).map((w) => w.key),
    };
  });
}

/**
 * Validates capability strings for an organisation: every entry must name a module of the industry's catalogue
 * and an action that module supports. Returns the normalised set (with implied `view`).
 */
export function validateCapabilities(list: readonly string[], industry: string, field = 'capabilities'): Set<Capability> {
  const mods = new Map(modulesFor(industry).map((m) => [m.key, m]));
  const bad = list.filter((c) => {
    const p = parseCapability(c);
    return !p || !mods.get(p.module)?.actions.includes(p.action);
  });
  if (bad.length) throw new AppError(400, 'validation_failed', `Unknown module actions: ${bad.slice(0, 5).join(', ')}`, { [field]: `Not part of this business's access catalogue: ${bad.slice(0, 5).join(', ')}` });
  return normalizeCapabilities(list, industry);
}

/** HQ-private modules can only be granted on organisation-wide assignments. */
export function assertScopeAllows(caps: Iterable<string>, scopeKind: ScopeKind, industry: string) {
  if (scopeKind === 'organization') return;
  const hq = new Set(modulesFor(industry).filter((m) => m.hqOnly).map((m) => m.key));
  const bad = [...new Set([...caps].map((c) => parseCapability(c)?.module).filter((m): m is string => !!m && hq.has(m)))];
  if (bad.length) {
    throw new AppError(400, 'hq_only_module', `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} only available to people with organisation-wide access (HQ).`, { grants: 'HQ-private modules need an organisation-wide assignment' }, { modules: bad });
  }
}

export async function customRoleCaps(db: Exec, roleId: string): Promise<string[]> {
  return (await db.select({ c: roleCapabilities.capability }).from(roleCapabilities).where(eq(roleCapabilities.roleId, roleId))).map((r) => r.c);
}

export async function loadCustomRole(db: Exec, organizationId: string, roleId: string) {
  const [r] = await db.select().from(customRoles).where(and(eq(customRoles.id, roleId), eq(customRoles.organizationId, organizationId)));
  if (!r) throw notFound('Role');
  return { ...r, capabilities: await customRoleCaps(db, r.id) };
}

export async function listCustomRoles(db: Exec, organizationId: string) {
  const roles = await db.select().from(customRoles).where(eq(customRoles.organizationId, organizationId)).orderBy(customRoles.name);
  if (!roles.length) return [];
  const ids = roles.map((r) => r.id);
  const caps = await db.select().from(roleCapabilities).where(inArray(roleCapabilities.roleId, ids));
  const used = await db.select({ id: roleAssignments.customRoleId, c: count() }).from(roleAssignments).where(inArray(roleAssignments.customRoleId, ids)).groupBy(roleAssignments.customRoleId);
  return roles.map((r) => ({
    id: r.id, name: r.name, description: r.description, baseRole: r.baseRole, primaryWorkspace: r.primaryWorkspace,
    capabilities: caps.filter((c) => c.roleId === r.id).map((c) => c.capability).sort(),
    assignedCount: used.find((u) => u.id === r.id)?.c ?? 0,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function overridesFor(db: Exec, assignmentId: string) {
  const rows = await db.select().from(memberAccessOverrides).where(eq(memberAccessOverrides.assignmentId, assignmentId));
  return { grants: rows.filter((r) => r.effect === 'grant').map((r) => r.capability).sort(), revokes: rows.filter((r) => r.effect === 'revoke').map((r) => r.capability).sort() };
}

/** What an assignment would give (for previews, grant checks and audit diffs). */
export async function assignmentCaps(db: Exec, industry: string, a: { role: string; customRoleId: string | null; scopeKind: string }, over?: { grants: string[]; revokes: string[] }) {
  return effectiveCapabilities(
    { role: a.role, scopeKind: a.scopeKind as ScopeKind, customCapabilities: a.customRoleId ? await customRoleCaps(db, a.customRoleId) : null, grants: over?.grants, revokes: over?.revokes },
    industry,
  );
}

/** A preview of what a capability set shows: workspaces with their modules, settings, and the legacy permissions. */
export function preview(caps: ReadonlySet<Capability>, industry: string) {
  return {
    workspaces: workspacesFor(caps, industry),
    settings: settingsModulesFor(caps, industry),
    permissions: [...permissionsFromCapabilities(caps)].sort(),
  };
}

export function roleName(role: string, custom?: { name: string } | null) {
  return role === 'custom' ? (custom?.name ?? 'Custom role') : (ROLE_TEMPLATES[role as Role]?.name ?? role);
}

export function diff(before: ReadonlySet<string>, after: ReadonlySet<string>) {
  return { added: [...after].filter((c) => !before.has(c)).sort(), removed: [...before].filter((c) => !after.has(c)).sort() };
}
