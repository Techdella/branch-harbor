import { and, count, eq, inArray } from 'drizzle-orm';
import {
  ACCESS_ACTIONS, ACTION_META, ROLE_TEMPLATES, ROLE_TEAMS, TEAM_ROLE_ORDER, WORKSPACES, WORKSPACE_META, asBusinessModel, canonicalRole, effectiveCapabilities, inviteRolesFor, modulesFor,
  normalizeCapabilities, parseCapability, permissionsFromCapabilities, scopeKindsFor, sensitiveClassesIn, workspacesFor, settingsModulesFor, type Capability, type Role, type ScopeKind,
} from '@bh/shared';
import type { Exec } from '../db/client.ts';
import {
  brands, customRoles, locations, memberAccessOverrides, memberProfiles, ownerGroups, portfolios, regions, roleAssignments, roleCapabilities, roleLabels, territories,
} from '../db/schema/index.ts';
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

/**
 * System role templates offered to an organisation (independent businesses get the simplified set), grouped by team.
 * `label` is the business's own name for the role, when it renamed it. Templates are starting points, not an org chart.
 */
export function templatesFor(industry: string, model: string, labels: ReadonlyMap<string, string> = new Map()) {
  const offered = new Set<Role>(inviteRolesFor(asBusinessModel(model)));
  return TEAM_ROLE_ORDER.filter((r) => offered.has(r)).map((r) => {
    const t = ROLE_TEMPLATES[r];
    const caps = effectiveCapabilities({ role: r, scopeKind: t.defaultScope }, industry);
    const orgCaps = effectiveCapabilities({ role: r, scopeKind: 'organization' }, industry);
    return {
      key: t.key, name: t.name, label: labels.get(r) ?? null, team: t.team, description: t.description, primaryWorkspace: t.primaryWorkspace, defaultScope: t.defaultScope,
      networkOnly: !!t.networkOnly, support: !!t.support,
      capabilities: [...orgCaps].sort(),
      sensitive: [...sensitiveClassesIn(caps, industry)].sort(),
      workspaces: workspacesFor(caps, industry).map((w) => w.key),
    };
  });
}

/** Team order for grouping templates, and the scope kinds this business can assign. */
export function roleMeta(model: string) {
  return { teams: [...ROLE_TEAMS], scopeKinds: scopeKindsFor(asBusinessModel(model)) };
}

/** The business's own names for system roles. */
export async function loadRoleLabels(db: Exec, organizationId: string): Promise<Map<string, string>> {
  const rows = await db.select({ role: roleLabels.role, name: roleLabels.name }).from(roleLabels).where(eq(roleLabels.organizationId, organizationId));
  return new Map(rows.map((r) => [r.role, r.name]));
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

/** HQ-private modules can only be granted on organisation-wide assignments (a territory also takes the ones it runs for itself, `territoryOk`). */
export function assertScopeAllows(caps: Iterable<string>, scopeKind: ScopeKind, industry: string) {
  if (scopeKind === 'organization') return;
  const hq = new Set(modulesFor(industry).filter((m) => m.hqOnly && !(scopeKind === 'territory' && m.territoryOk)).map((m) => m.key));
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

/**
 * A preview of what a capability set shows: workspaces with their modules and actions, settings, the sensitive data
 * classes it reaches, what stays hidden, and the legacy permissions.
 */
export function preview(caps: ReadonlySet<Capability>, industry: string) {
  const mods = modulesFor(industry).filter((m) => m.status === 'available');
  const actions = Object.fromEntries(mods.filter((m) => caps.has(`${m.key}:view`)).map((m) => [m.key, m.actions.filter((a) => caps.has(`${m.key}:${a}`))]));
  return {
    workspaces: workspacesFor(caps, industry),
    settings: settingsModulesFor(caps, industry),
    actions,
    hidden: mods.filter((m) => !caps.has(`${m.key}:view`)).map((m) => m.key),
    sensitive: [...sensitiveClassesIn(caps, industry)].sort(),
    permissions: [...permissionsFromCapabilities(caps)].sort(),
  };
}

export function roleName(role: string, custom?: { name: string } | null, labels?: ReadonlyMap<string, string>) {
  if (role === 'custom') return custom?.name ?? 'Custom role';
  const key = canonicalRole(role);
  return labels?.get(key) ?? ROLE_TEMPLATES[key as Role]?.name ?? role;
}

export function diff(before: ReadonlySet<string>, after: ReadonlySet<string>) {
  return { added: [...after].filter((c) => !before.has(c)).sort(), removed: [...before].filter((c) => !after.has(c)).sort() };
}

/** Names of every scope in the organisation, keyed `<kind>:<id>` (brands, territories, regions, portfolios, owner groups, locations). */
export async function scopeNames(db: Exec, organizationId: string): Promise<Map<string, string>> {
  const q = (table: typeof regions | typeof ownerGroups | typeof locations | typeof territories | typeof portfolios | typeof brands) =>
    db.select({ id: table.id, name: table.name }).from(table).where(eq(table.organizationId, organizationId));
  const [b, t, r, p, g, l] = await Promise.all([q(brands), q(territories), q(regions), q(portfolios), q(ownerGroups), q(locations)]);
  const out = new Map<string, string>();
  for (const [kind, rows] of [['brand', b], ['territory', t], ['region', r], ['portfolio', p], ['owner_group', g], ['location', l]] as const) for (const x of rows) out.set(`${kind}:${x.id}`, x.name);
  return out;
}

/** Job titles and denied sensitive classes per person in the organisation. */
export async function memberProfilesFor(db: Exec, organizationId: string): Promise<Map<string, { jobTitle: string | null; deniedClasses: string[] }>> {
  const rows = await db.select().from(memberProfiles).where(eq(memberProfiles.organizationId, organizationId));
  return new Map(rows.map((r) => [r.userId, { jobTitle: r.jobTitle, deniedClasses: r.deniedClasses }]));
}
