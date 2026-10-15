import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  COMBINED_ROLES, INDUSTRIES, ROLES, SENSITIVE_CLASSES, TEAM_SHAPES, TEAM_SHAPE_SUGGESTIONS, assignmentAccessSchema, asBusinessModel, canonicalRole, combinedRoleCapabilities, coverageAreasFor, customRoleSchema,
  memberProfileSchema, parseCapability, portfolioSchema, roleLabelSchema, scopeSchema, territoryScopeSchema, type Capability, type Role, type ScopeKind, type TeamShape,
} from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  brands, customRoles, locations, memberAccessOverrides, memberProfiles, organizations, portfolioLocations, portfolios, roleAssignments, roleCapabilities, roleLabels, territories, users,
} from '../db/schema/index.ts';
import { assignmentCovers, canGrantCapabilities, capabilitiesInScope, hasCapabilityInScope, type Assignment, type ScopeChain } from '../domain/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import {
  assertScopeAllows, assignmentCaps, catalogue, diff, listCustomRoles, loadCustomRole, loadRoleLabels, memberProfilesFor, overridesFor, preview, roleMeta, roleName, scopeNames, templatesFor,
  validateCapabilities,
} from '../services/access.ts';
import { actor, audit } from '../services/audit.ts';
import { accessSummaryFor, defaultBrandId, locationsInScope, requireMember, resolveScopeChain, withEffectiveAccess } from '../services/authz.ts';
import { assertRoleForModel } from '../services/businessMode.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';
import { effectiveCapabilities } from '@bh/shared';

/**
 * Access model endpoints: the capability catalogue, role templates, custom roles (CRUD) and per-person access
 * (role + overrides per assignment). Everything that changes access is audited, and nobody can grant a module
 * action they don't hold in that scope. Access is loaded from the database on every request, so changes apply
 * immediately.
 */
export const accessRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const orgOf = async (orgId: string) => {
    const [o] = await s.db.select({ id: organizations.id, industry: organizations.industry, model: organizations.model }).from(organizations).where(eq(organizations.id, orgId));
    if (!o) throw notFound('Organisation');
    return o;
  };
  const orgChain = (orgId: string): ScopeChain => ({ organizationId: orgId, kind: 'organization' });
  const chainFor = (orgId: string, kind: string, id: string) => resolveScopeChain(s.db, { organizationId: orgId, kind: kind as ScopeKind, id });

  /** Team & access at organisation level (custom roles are organisation-wide definitions). */
  const requireTeamAdmin = async (req: FastifyRequest, orgId: string, action: 'view' | 'edit') => {
    const mine = await requireMember(req, s.db, orgId);
    if (!hasCapabilityInScope(mine, 'settings.team', action, orgChain(orgId))) throw forbidden(`You need Team & access (${action}) for the whole organisation`);
    return mine;
  };

  app.addHook('preHandler', authenticate);


    app.get('/orgs/:orgId/access/me', {
      schema: { tags: ['access'], security: secured, params: orgParams, summary: 'My access in this organisation: workspaces, landing workspace and capabilities per assignment' },
    }, async (req) => {
      const { orgId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      const org = await orgOf(orgId);
      const [labels, profiles] = await Promise.all([loadRoleLabels(s.db, orgId), memberProfilesFor(s.db, orgId)]);
      return {
        industry: org.industry,
        ...(await accessSummaryFor(s.db, mine, org.industry)),
        jobTitle: profiles.get(req.user!.id)?.jobTitle ?? null,
        roleLabels: Object.fromEntries(labels),
        assignments: mine.map((a) => ({ id: a.id, role: a.role, customRoleId: a.customRoleId ?? null, scope: { kind: a.scopeKind, id: a.scopeId }, capabilities: [...(a.capabilities ?? [])].sort() })),
      };
    });

    app.get('/orgs/:orgId/roles', {
      schema: { tags: ['access'], security: secured, params: orgParams, summary: 'System role templates for this business and its custom roles' },
    }, async (req) => {
      const { orgId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      if (!mine.some((a) => a.capabilities?.has('settings.team:view'))) throw forbidden('You need Team & access to see roles');
      const org = await orgOf(orgId);
      const labels = await loadRoleLabels(s.db, orgId);
      return { industry: org.industry, templates: templatesFor(org.industry, org.model, labels), custom: await listCustomRoles(s.db, orgId), catalogue: catalogue(org.industry), ...roleMeta(org.model) };
    });

    app.post('/orgs/:orgId/roles', {
      schema: { tags: ['access'], security: secured, params: orgParams, body: customRoleSchema, summary: 'Create a custom role (tick modules + actions). You can only include what you hold organisation-wide.' },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const mine = await requireTeamAdmin(req, orgId, 'edit');
      const org = await orgOf(orgId);
      const caps = validateCapabilities(req.body.capabilities, org.industry);
      if (!canGrantCapabilities(mine, caps, orgChain(orgId))) throw forbidden('You cannot create a role with access you do not hold yourself');
      const role = await s.db.transaction(async (tx) => {
        const [dupe] = await tx.select({ id: customRoles.id }).from(customRoles).where(and(eq(customRoles.organizationId, orgId), eq(customRoles.name, req.body.name)));
        if (dupe) throw conflict('role_name_taken', 'A role with this name already exists');
        const [role] = await tx.insert(customRoles).values({
          organizationId: orgId, name: req.body.name, description: req.body.description ?? null, baseRole: req.body.baseRole ?? null,
          primaryWorkspace: req.body.primaryWorkspace ?? null, createdBy: requireUser(req).id,
        }).returning();
        if (caps.size) await tx.insert(roleCapabilities).values([...caps].map((c) => ({ roleId: role!.id, organizationId: orgId, capability: c })));
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.role_created', scopeKind: 'organization', scopeId: orgId, targetType: 'custom_role', targetId: role!.id, metadata: { name: role!.name, capabilities: [...caps].sort() } });
        return role!;
      });
      return reply.code(201).send({ ...role, capabilities: [...caps].sort(), preview: preview(caps, org.industry), createdAt: iso(role.createdAt), updatedAt: iso(role.updatedAt) });
    });

    app.patch('/orgs/:orgId/roles/:id', {
      schema: { tags: ['access'], security: secured, params: idParams, body: customRoleSchema.partial(), summary: 'Change a custom role. Everyone with the role is affected on their next request.' },
    }, async (req) => {
      const { orgId, id } = req.params;
      const mine = await requireTeamAdmin(req, orgId, 'edit');
      const org = await orgOf(orgId);
      const before = await loadCustomRole(s.db, orgId, id);
      const beforeCaps = new Set(before.capabilities);
      const afterCaps = req.body.capabilities ? validateCapabilities(req.body.capabilities, org.industry) : beforeCaps;
      // Changing a role touches everyone who has it: you must hold both what it gave and what it will give.
      if (!canGrantCapabilities(mine, new Set([...beforeCaps, ...afterCaps]) as Set<Capability>, orgChain(orgId))) throw forbidden('You cannot change a role with access you do not hold yourself');
      const changes = diff(beforeCaps, afterCaps);
      await s.db.transaction(async (tx) => {
        const patch = Object.fromEntries(Object.entries({ name: req.body.name, description: req.body.description, baseRole: req.body.baseRole, primaryWorkspace: req.body.primaryWorkspace }).filter(([, v]) => v !== undefined));
        await tx.update(customRoles).set({ ...patch, updatedAt: new Date() }).where(eq(customRoles.id, id));
        if (req.body.capabilities) {
          await tx.delete(roleCapabilities).where(eq(roleCapabilities.roleId, id));
          if (afterCaps.size) await tx.insert(roleCapabilities).values([...afterCaps].map((c) => ({ roleId: id, organizationId: orgId, capability: c })));
        }
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.role_updated', scopeKind: 'organization', scopeId: orgId, targetType: 'custom_role', targetId: id, metadata: { ...patch, ...changes } });
      });
      const after = await loadCustomRole(s.db, orgId, id);
      return { ...after, capabilities: after.capabilities.sort(), preview: preview(new Set(after.capabilities) as Set<Capability>, org.industry), changes, createdAt: iso(after.createdAt), updatedAt: iso(after.updatedAt) };
    });

    app.delete('/orgs/:orgId/roles/:id', {
      schema: { tags: ['access'], security: secured, params: idParams, summary: 'Delete a custom role that nobody has any more' },
    }, async (req) => {
      const { orgId, id } = req.params;
      await requireTeamAdmin(req, orgId, 'edit');
      const role = await loadCustomRole(s.db, orgId, id);
      const inUse = await s.db.select({ id: roleAssignments.id }).from(roleAssignments).where(eq(roleAssignments.customRoleId, id)).limit(1);
      if (inUse.length) throw conflict('role_in_use', 'People still have this role. Give them another role first.');
      await s.db.transaction(async (tx) => {
        await tx.delete(customRoles).where(eq(customRoles.id, id));
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.role_deleted', scopeKind: 'organization', scopeId: orgId, targetType: 'custom_role', targetId: id, metadata: { name: role.name } });
      });
      return { id, deleted: true };
    });

    app.get('/orgs/:orgId/members/:userId/access', {
      schema: {
        tags: ['access'], security: secured, params: orgParams.extend({ userId: z.uuid() }),
        summary: '"What can this person see?" — each assignment you manage with its role, overrides and effective module actions, plus the resulting workspaces',
      },
    }, async (req) => {
      const { orgId, userId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      const org = await orgOf(orgId);
      const [u] = await s.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
      const rows = await s.db.select().from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.userId, userId)));
      if (!u || !rows.length) throw notFound('Member');
      const access = await withEffectiveAccess(s.db, orgId, rows, org.industry);
      const custom = await listCustomRoles(s.db, orgId);
      const [labels, names, profiles] = await Promise.all([loadRoleLabels(s.db, orgId), scopeNames(s.db, orgId), memberProfilesFor(s.db, orgId)]);
      const out = [];
      const visible: Assignment[] = [];
      for (const [i, row] of rows.entries()) {
        const chain = await chainFor(orgId, row.scopeKind, row.scopeId).catch(() => null);
        if (!chain) continue;
        const self = userId === req.user!.id;
        if (!self && !hasCapabilityInScope(mine, 'settings.team', 'view', chain)) continue;
        const a = access[i]!;
        visible.push(a);
        const ov = await overridesFor(s.db, row.id);
        const ownerOnly = row.role === 'org_owner' && !mine.some((m) => m.role === 'org_owner' && assignmentCovers(m, chain));
        const inScope = await locationsInScope(s.db, orgId, row.scopeKind, row.scopeId);
        out.push({
          id: row.id, role: canonicalRole(row.role), roleName: roleName(row.role, custom.find((c) => c.id === row.customRoleId), labels), customRoleId: row.customRoleId,
          scope: { kind: row.scopeKind, id: row.scopeId, name: names.get(`${row.scopeKind}:${row.scopeId}`) ?? null },
          locations: inScope === 'all' ? 'all' : [...inScope].map((id) => names.get(`location:${id}`) ?? id).sort(),
          grants: ov.grants, revokes: ov.revokes, capabilities: [...(a.capabilities ?? [])].sort(),
          editable: !ownerOnly && canGrantCapabilities(mine, a.capabilities ?? new Set(), chain),
          expiresAt: iso(row.expiresAt),
        });
      }
      if (!out.length) throw forbidden('You cannot see this person’s access');
      const profile = profiles.get(userId);
      return { user: u, industry: org.industry, jobTitle: profile?.jobTitle ?? null, deniedClasses: profile?.deniedClasses ?? [], assignments: out, summary: await accessSummaryFor(s.db, visible, org.industry) };
    });

    async function scopeName(orgId: string, kind: string, id: string): Promise<string | null> {
      if (kind === 'organization') return null;
      return (await scopeNames(s.db, orgId)).get(`${kind}:${id}`) ?? null;
    }

    /** Resolves a requested role (system or custom) into its capabilities, validating the custom role belongs to the org. */
    const customRoleFor = async (orgId: string, role: string, customRoleId: string | null | undefined) => {
      if (role === 'custom') {
        if (!customRoleId) throw badRequest('Pick a custom role', { customRoleId: 'Required for a custom role' });
        await loadCustomRole(s.db, orgId, customRoleId);
        return customRoleId;
      }
      if (customRoleId) throw badRequest('customRoleId is only used with role "custom"', { customRoleId: 'Remove it or use role "custom"' });
      return null;
    };

    app.put('/orgs/:orgId/role-assignments/:id/access', {
      schema: {
        tags: ['access'], security: secured, params: idParams, body: assignmentAccessSchema,
        summary: 'Set what one assignment gives: its role (system or custom) and per-person overrides (extra or removed module actions). Audited; applies on the next request.',
      },
    }, async (req) => {
      const { orgId, id } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      const org = await orgOf(orgId);
      const [row] = await s.db.select().from(roleAssignments).where(and(eq(roleAssignments.id, id), eq(roleAssignments.organizationId, orgId)));
      if (!row) throw notFound('Role assignment');
      const chain = await chainFor(orgId, row.scopeKind, row.scopeId);
      const role = req.body.role ?? row.role;
      const customRoleId = req.body.role === undefined && req.body.customRoleId === undefined ? row.customRoleId : await customRoleFor(orgId, role, req.body.customRoleId);
      if (role !== 'custom') assertRoleForModel(org, role as Role, row.scopeKind);
      const grants = [...validateCapabilities(req.body.grants, org.industry, 'grants')].filter((c) => req.body.grants.includes(c));
      const revokes = req.body.revokes.filter((c) => validateCapabilities([c], org.industry, 'revokes').size > 0);
      assertScopeAllows(grants, row.scopeKind as ScopeKind, org.industry);
      const isOwner = mine.some((m) => m.role === 'org_owner' && assignmentCovers(m, chain));
      if ((row.role === 'org_owner' || role === 'org_owner') && !isOwner) throw forbidden('Only an owner can change ownership');
      if (row.role === 'org_owner' && role !== 'org_owner') {
        const owners = await s.db.select({ id: roleAssignments.id }).from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.role, 'org_owner')));
        if (owners.length <= 1) throw conflict('last_owner', 'An organisation must keep at least one owner');
      }
      const beforeOv = await overridesFor(s.db, id);
      const before = await assignmentCaps(s.db, org.industry, row, beforeOv);
      const after = await assignmentCaps(s.db, org.industry, { role, customRoleId, scopeKind: row.scopeKind }, { grants, revokes });
      if (role !== 'org_owner' && !canGrantCapabilities(mine, new Set([...before, ...after]) as Set<Capability>, chain)) {
        throw forbidden('You cannot give or change access you do not hold yourself in this scope');
      }
      const changes = diff(before, after);
      await s.db.transaction(async (tx) => {
        await tx.update(roleAssignments).set({ role, customRoleId }).where(eq(roleAssignments.id, id));
        await tx.delete(memberAccessOverrides).where(eq(memberAccessOverrides.assignmentId, id));
        const ovRows = [...grants.map((c) => ({ capability: c, effect: 'grant' })), ...revokes.map((c) => ({ capability: c, effect: 'revoke' }))];
        if (ovRows.length) await tx.insert(memberAccessOverrides).values(ovRows.map((o) => ({ ...o, organizationId: orgId, assignmentId: id, createdBy: requireUser(req).id })));
        await audit(tx, {
          organizationId: orgId, ...actor(req), action: 'access.assignment_updated', scopeKind: row.scopeKind, scopeId: row.scopeId, targetType: 'user', targetId: row.userId,
          metadata: { assignmentId: id, before: { role: row.role, customRoleId: row.customRoleId, ...beforeOv }, after: { role, customRoleId, grants, revokes }, ...changes },
        });
      });
      return { id, role, customRoleId, scope: { kind: row.scopeKind, id: row.scopeId }, grants, revokes, capabilities: [...after].sort(), preview: preview(after, org.industry), changes };
    });

    app.post('/orgs/:orgId/role-assignments', {
      schema: {
        tags: ['access'], security: secured, params: orgParams,
        body: assignmentAccessSchema.extend({ userId: z.uuid(), role: assignmentAccessSchema.shape.role.unwrap(), scope: scopeSchema }),
        summary: 'Give an existing member another role in a scope (new people are invited instead)',
      },
    }, async (req, reply) => {
      const { orgId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      const org = await orgOf(orgId);
      const b = req.body;
      const existing = await s.db.select({ id: roleAssignments.id }).from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.userId, b.userId))).limit(1);
      if (!existing.length) throw notFound('Member');
      if (b.role === 'customer') throw badRequest('Customers are not team members');
      const chain = await chainFor(orgId, b.scope.kind, b.scope.id);
      const customRoleId = await customRoleFor(orgId, b.role, b.customRoleId);
      if (b.role !== 'custom') assertRoleForModel(org, b.role as Role, b.scope.kind);
      const grants = req.body.grants.filter((c) => validateCapabilities([c], org.industry, 'grants').size > 0);
      assertScopeAllows(grants, b.scope.kind, org.industry);
      const caps = await assignmentCaps(s.db, org.industry, { role: b.role, customRoleId, scopeKind: b.scope.kind }, { grants, revokes: b.revokes });
      if (b.role === 'org_owner' ? !mine.some((m) => m.role === 'org_owner' && assignmentCovers(m, chain)) : !canGrantCapabilities(mine, caps, chain)) {
        throw forbidden('You cannot give access you do not hold yourself in this scope');
      }
      const row = await s.db.transaction(async (tx) => {
        const [row] = await tx.insert(roleAssignments).values({ organizationId: orgId, userId: b.userId, role: b.role, customRoleId, scopeKind: b.scope.kind, scopeId: b.scope.id, createdBy: requireUser(req).id })
          .onConflictDoNothing().returning();
        if (!row) throw conflict('assignment_exists', 'This person already has this role in this scope');
        const ovRows = [...grants.map((c) => ({ capability: c, effect: 'grant' })), ...b.revokes.map((c) => ({ capability: c, effect: 'revoke' }))];
        if (ovRows.length) await tx.insert(memberAccessOverrides).values(ovRows.map((o) => ({ ...o, organizationId: orgId, assignmentId: row.id, createdBy: requireUser(req).id })));
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.assignment_created', scopeKind: b.scope.kind, scopeId: b.scope.id, targetType: 'user', targetId: b.userId, metadata: { role: b.role, customRoleId, grants, revokes: b.revokes } });
        return row;
      });
      return reply.code(201).send({ id: row.id, role: row.role, customRoleId, scope: b.scope, capabilities: [...caps].sort(), preview: preview(caps, org.industry) });
    });

    app.post('/orgs/:orgId/access/preview', {
      schema: {
        tags: ['access'], security: secured, params: orgParams,
        body: z.object({
          role: assignmentAccessSchema.shape.role.unwrap(), customRoleId: z.uuid().nullable().optional(), scopeKind: scopeSchema.shape.kind, scopeId: z.uuid().optional(),
          capabilities: z.array(z.string()).optional(), grants: z.array(z.string()).default([]), revokes: z.array(z.string()).default([]), deniedClasses: z.array(z.enum(SENSITIVE_CLASSES)).default([]),
        }),
        summary: 'Effective-access preview before saving: workspaces, modules and actions, the locations it reaches, sensitive data classes and what stays hidden',
      },
    }, async (req) => {
      const { orgId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      if (!mine.some((a) => a.capabilities?.has('settings.team:view'))) throw forbidden('You need Team & access');
      const org = await orgOf(orgId);
      const b = req.body;
      const raw = b.capabilities
        ? validateCapabilities(b.capabilities, org.industry)
        : await assignmentCaps(s.db, org.industry, { role: b.role, customRoleId: b.customRoleId ?? null, scopeKind: b.scopeKind }, { grants: b.grants, revokes: b.revokes });
      const caps = effectiveCapabilities({ role: 'custom', scopeKind: b.scopeKind, customCapabilities: raw, deniedClasses: b.deniedClasses }, org.industry);
      let locs: { all: boolean; names: string[] } = { all: b.scopeKind === 'organization', names: [] };
      if (b.scopeKind !== 'organization' && b.scopeId) {
        await chainFor(orgId, b.scopeKind, b.scopeId);
        const ids = await locationsInScope(s.db, orgId, b.scopeKind, b.scopeId);
        const names = await scopeNames(s.db, orgId);
        locs = { all: ids === 'all', names: ids === 'all' ? [] : [...ids].map((id) => names.get(`location:${id}`) ?? id).sort() };
      }
      return { capabilities: [...caps].sort(), locations: locs, ...preview(caps, org.industry) };
    });

    // Members' role names (custom roles included) for the Team screen.
    app.get('/orgs/:orgId/access/assignments', {
      schema: { tags: ['access'], security: secured, params: orgParams, summary: 'Role assignments you manage with role names and effective workspaces' },
    }, async (req) => {
      const { orgId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      const org = await orgOf(orgId);
      const rows = await s.db.select({ a: roleAssignments, u: { id: users.id, name: users.name, email: users.email } }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).where(eq(roleAssignments.organizationId, orgId));
      const access = await withEffectiveAccess(s.db, orgId, rows.map((r) => r.a), org.industry);
      const custom = rows.some((r) => r.a.customRoleId) ? await s.db.select({ id: customRoles.id, name: customRoles.name }).from(customRoles).where(inArray(customRoles.id, rows.map((r) => r.a.customRoleId).filter((x): x is string => !!x))) : [];
      const labels = await loadRoleLabels(s.db, orgId);
      const out = [];
      for (const [i, r] of rows.entries()) {
        const chain = await chainFor(orgId, r.a.scopeKind, r.a.scopeId).catch(() => null);
        if (!chain || (r.u.id !== req.user!.id && !hasCapabilityInScope(mine, 'settings.team', 'view', chain))) continue;
        const caps = access[i]!.capabilities ?? new Set<Capability>();
        out.push({
          id: r.a.id, user: r.u, role: canonicalRole(r.a.role), customRoleId: r.a.customRoleId, roleName: roleName(r.a.role, custom.find((c) => c.id === r.a.customRoleId), labels),
          scope: { kind: r.a.scopeKind, id: r.a.scopeId, name: await scopeName(orgId, r.a.scopeKind, r.a.scopeId) },
          workspaces: preview(caps, org.industry).workspaces.map((w) => w.key),
          editable: canGrantCapabilities(mine, caps, chain) && (r.a.role !== 'org_owner' || mine.some((m) => m.role === 'org_owner' && assignmentCovers(m, chain))),
        });
      }
      return { items: out, held: [...capabilitiesInScope(mine, orgChain(orgId))].sort() };
    });

    /* ---------------------------- role names ---------------------------- */

    app.put('/orgs/:orgId/access/role-labels/:role', {
      schema: {
        tags: ['access'], security: secured, params: orgParams.extend({ role: z.enum(ROLES) }), body: roleLabelSchema,
        summary: 'Rename a system role for this business (any template can be renamed; null restores the template name). Access is unchanged.',
      },
    }, async (req) => {
      const { orgId, role } = req.params;
      await requireTeamAdmin(req, orgId, 'edit');
      const name = req.body.name;
      if (name) {
        await s.db.insert(roleLabels).values({ organizationId: orgId, role, name }).onConflictDoUpdate({ target: [roleLabels.organizationId, roleLabels.role], set: { name, updatedAt: new Date() } });
      } else {
        await s.db.delete(roleLabels).where(and(eq(roleLabels.organizationId, orgId), eq(roleLabels.role, role)));
      }
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'access.role_renamed', scopeKind: 'organization', scopeId: orgId, targetType: 'role', targetId: null, metadata: { role, name } });
      return { role, label: name };
    });

    /* ------------------------ job title and denies ----------------------- */

    app.put('/orgs/:orgId/members/:userId/profile', {
      schema: {
        tags: ['access'], security: secured, params: orgParams.extend({ userId: z.uuid() }), body: memberProfileSchema,
        summary: 'A person’s job title (free text, separate from their roles) and the sensitive data classes denied to them across every role they hold',
      },
    }, async (req) => {
      const { orgId, userId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      const rows = await s.db.select().from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.userId, userId)));
      if (!rows.length) throw notFound('Member');
      // You manage a person's profile when you could change every one of their assignments.
      const access = await withEffectiveAccess(s.db, orgId, rows);
      for (const [i, row] of rows.entries()) {
        const chain = await chainFor(orgId, row.scopeKind, row.scopeId);
        const owner = row.role === 'org_owner' && !mine.some((m) => m.role === 'org_owner' && assignmentCovers(m, chain));
        if (owner || !canGrantCapabilities(mine, access[i]!.capabilities ?? new Set(), chain)) throw forbidden('You cannot change this person’s access');
      }
      if (req.body.deniedClasses?.length && rows.some((r) => r.role === 'org_owner')) throw badRequest('Owners always hold everything', { deniedClasses: 'Not for owners' });
      const [before] = await s.db.select().from(memberProfiles).where(and(eq(memberProfiles.organizationId, orgId), eq(memberProfiles.userId, userId)));
      const next = { jobTitle: req.body.jobTitle === undefined ? (before?.jobTitle ?? null) : (req.body.jobTitle || null), deniedClasses: req.body.deniedClasses ?? before?.deniedClasses ?? [] };
      await s.db.insert(memberProfiles).values({ organizationId: orgId, userId, ...next }).onConflictDoUpdate({ target: [memberProfiles.organizationId, memberProfiles.userId], set: { ...next, updatedAt: new Date() } });
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'access.profile_updated', scopeKind: 'organization', scopeId: orgId, targetType: 'user', targetId: userId, metadata: { before: before ? { jobTitle: before.jobTitle, deniedClasses: before.deniedClasses } : null, after: next } });
      return { userId, ...next };
    });

    /* ----------------------------- coverage ----------------------------- */

    /** Who handles each area. Owners hold everything, so they never count as covering an area. */
    const coverage = async (orgId: string) => {
      const org = await orgOf(orgId);
      const rows = await s.db.select({ a: roleAssignments, u: { id: users.id, name: users.name } }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).where(eq(roleAssignments.organizationId, orgId));
      const access = await withEffectiveAccess(s.db, orgId, rows.map((r) => r.a), org.industry);
      const owners = new Set(rows.filter((r) => r.a.role === 'org_owner').map((r) => r.u.id));
      return coverageAreasFor(org.industry, asBusinessModel(org.model)).map((area) => {
        const holders = new Map<string, string>();
        rows.forEach((r, i) => { if (!owners.has(r.u.id) && access[i]!.capabilities?.has(area.capability as Capability)) holders.set(r.u.id, r.u.name); });
        return { key: area.key, capability: area.capability, suggestedRole: area.suggestedRole, covered: holders.size > 0, holders: [...holders].map(([id, name]) => ({ id, name })) };
      });
    };

    app.get('/orgs/:orgId/access/coverage', {
      schema: { tags: ['access'], security: secured, params: orgParams, summary: 'Coverage: who handles each area (royalties, approvals, the franchise pipeline…). Uncovered areas go to the owner until someone is assigned.' },
    }, async (req) => {
      const { orgId } = req.params;
      await requireTeamAdmin(req, orgId, 'view');
      const items = await coverage(orgId);
      return { items, uncovered: items.filter((i) => !i.covered).map((i) => i.key) };
    });

    app.post('/orgs/:orgId/access/coverage/:area/assign', {
      schema: {
        tags: ['access'], security: secured, params: orgParams.extend({ area: z.string().max(40) }), body: z.object({ userId: z.uuid() }),
        summary: '"Assign to…": give a person the area (a per-person grant on their organisation-wide role). You can only give what you hold.',
      },
    }, async (req) => {
      const { orgId, area } = req.params;
      const mine = await requireTeamAdmin(req, orgId, 'edit');
      const org = await orgOf(orgId);
      const def = coverageAreasFor(org.industry, asBusinessModel(org.model)).find((a) => a.key === area);
      if (!def) throw notFound('Area');
      const rows = await s.db.select().from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.userId, req.body.userId)));
      if (!rows.length) throw notFound('Member');
      const row = rows.find((r) => r.scopeKind === 'organization');
      if (!row) throw badRequest('This person has no organisation-wide role. Give them one first, then assign the area.', { userId: 'Needs an organisation-wide role' });
      const mod = parseCapability(def.capability)!.module;
      const caps = [def.capability, `${mod}:view`];
      if (!canGrantCapabilities(mine, new Set(caps) as Set<Capability>, orgChain(orgId))) throw forbidden('You cannot give access you do not hold yourself');
      await s.db.transaction(async (tx) => {
        for (const c of caps) {
          await tx.delete(memberAccessOverrides).where(and(eq(memberAccessOverrides.assignmentId, row.id), eq(memberAccessOverrides.capability, c), eq(memberAccessOverrides.effect, 'revoke')));
          await tx.insert(memberAccessOverrides).values({ organizationId: orgId, assignmentId: row.id, capability: c, effect: 'grant', createdBy: requireUser(req).id }).onConflictDoNothing();
        }
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.area_assigned', scopeKind: 'organization', scopeId: orgId, targetType: 'user', targetId: req.body.userId, metadata: { area, capabilities: caps, assignmentId: row.id } });
      });
      const items = await coverage(orgId);
      return { items, uncovered: items.filter((i) => !i.covered).map((i) => i.key) };
    });

    /* ----------------------------- team shape ---------------------------- */

    const teamShapeState = async (orgId: string) => {
      const [o] = await s.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
      const st = (o?.settings ?? {}) as { teamShape?: TeamShape; teamShapeRoles?: Record<string, string> };
      const custom = await listCustomRoles(s.db, orgId);
      return {
        shape: st.teamShape ?? null,
        shapes: TEAM_SHAPES.map((k) => ({ key: k, templates: [...TEAM_SHAPE_SUGGESTIONS[k].templates], combined: [...TEAM_SHAPE_SUGGESTIONS[k].combined] })),
        combined: COMBINED_ROLES.map((c) => {
          const role = custom.find((r) => r.id === st.teamShapeRoles?.[c.key]);
          return { key: c.key, name: c.name, description: c.description, from: [...c.from], roleId: role?.id ?? null, roleName: role?.name ?? null };
        }),
      };
    };

    app.get('/orgs/:orgId/access/team-shape', {
      schema: { tags: ['access'], security: secured, params: orgParams, summary: 'The team shape chosen at onboarding (full, small, just me, custom) and its suggested roles' },
    }, async (req) => {
      await requireTeamAdmin(req, req.params.orgId, 'view');
      return teamShapeState(req.params.orgId);
    });

    app.put('/orgs/:orgId/access/team-shape', {
      schema: {
        tags: ['access'], security: secured, params: orgParams,
        body: z.object({ shape: z.enum(TEAM_SHAPES), names: z.record(z.string(), z.string().trim().min(1).max(80)).optional(), descriptions: z.record(z.string(), z.string().trim().max(300)).optional() }),
        summary: 'Choose or change the team shape. A small team gets combined roles ("Marketing & sales", "Operations & finance"…) created as the business’s own roles. Nothing is locked or removed.',
      },
    }, async (req) => {
      const { orgId } = req.params;
      const mine = await requireTeamAdmin(req, orgId, 'edit');
      const org = await orgOf(orgId);
      const [o] = await s.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
      const st = (o?.settings ?? {}) as Record<string, unknown> & { teamShapeRoles?: Record<string, string> };
      const created: Record<string, string> = { ...(st.teamShapeRoles ?? {}) };
      const existing = await listCustomRoles(s.db, orgId);
      await s.db.transaction(async (tx) => {
        for (const key of TEAM_SHAPE_SUGGESTIONS[req.body.shape].combined) {
          if (created[key] && existing.some((r) => r.id === created[key])) continue;
          const def = COMBINED_ROLES.find((c) => c.key === key)!;
          const name = req.body.names?.[key] ?? def.name;
          const dupe = existing.find((r) => r.name.toLowerCase() === name.toLowerCase());
          if (dupe) { created[key] = dupe.id; continue; }
          // You can only create what you hold yourself (the owner holds everything).
          const caps = [...combinedRoleCapabilities(key, org.industry)].filter((c) => canGrantCapabilities(mine, [c as Capability], orgChain(orgId)));
          const [role] = await tx.insert(customRoles).values({ organizationId: orgId, name, description: req.body.descriptions?.[key] ?? def.description, primaryWorkspace: def.primaryWorkspace, createdBy: requireUser(req).id }).returning();
          if (caps.length) await tx.insert(roleCapabilities).values(caps.map((c) => ({ roleId: role!.id, organizationId: orgId, capability: c })));
          created[key] = role!.id;
        }
        await tx.update(organizations).set({ settings: { ...st, teamShape: req.body.shape, teamShapeRoles: created }, updatedAt: new Date() }).where(eq(organizations.id, orgId));
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.team_shape_set', scopeKind: 'organization', scopeId: orgId, metadata: { shape: req.body.shape, roles: created } });
      });
      return teamShapeState(orgId);
    });

    /* ------------------- scopes: portfolios and territories ------------------- */

    const assertLocations = async (orgId: string, ids: readonly string[]) => {
      if (!ids.length) return;
      const found = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), inArray(locations.id, [...ids])));
      if (found.length !== new Set(ids).size) throw badRequest('Some locations are not part of this business', { locationIds: 'Unknown location' });
    };
    const requireOrgCap = async (req: FastifyRequest, orgId: string, module: string, action: 'view' | 'edit') => {
      const mine = await requireMember(req, s.db, orgId);
      if (!hasCapabilityInScope(mine, module, action, orgChain(orgId))) throw forbidden(`You need ${module} (${action}) for the whole organisation`);
      return mine;
    };

    app.get('/orgs/:orgId/access/scopes', {
      schema: { tags: ['access'], security: secured, params: orgParams, summary: 'Every scope you can assign: brands, territories (sub-networks), regions, portfolios, owner groups and locations' },
    }, async (req) => {
      const { orgId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      if (!mine.some((a) => a.capabilities?.has('settings.team:view'))) throw forbidden('You need Team & access');
      const [bs, ts, ps, members, locs, names] = await Promise.all([
        s.db.select().from(brands).where(eq(brands.organizationId, orgId)),
        s.db.select().from(territories).where(eq(territories.organizationId, orgId)),
        s.db.select().from(portfolios).where(eq(portfolios.organizationId, orgId)),
        s.db.select().from(portfolioLocations).where(eq(portfolioLocations.organizationId, orgId)),
        s.db.select({ id: locations.id, name: locations.name, regionId: locations.regionId, ownerGroupId: locations.ownerGroupId, territoryId: locations.territoryId, brandId: locations.brandId }).from(locations).where(eq(locations.organizationId, orgId)),
        scopeNames(s.db, orgId),
      ]);
      const byKind = (kind: string) => [...names].filter(([k]) => k.startsWith(`${kind}:`)).map(([k, name]) => ({ id: k.slice(kind.length + 1), name })).sort((a, b) => a.name.localeCompare(b.name));
      return {
        brands: bs.map((b) => ({ id: b.id, name: b.name, isDefault: b.isDefault })),
        territories: ts.map((t) => ({ id: t.id, name: t.name, kind: t.kind, country: t.country, brandId: t.brandId, locationIds: locs.filter((l) => l.territoryId === t.id).map((l) => l.id) })).sort((a, b) => a.name.localeCompare(b.name)),
        regions: byKind('region'),
        portfolios: ps.map((p) => ({ id: p.id, name: p.name, description: p.description, locationIds: members.filter((m) => m.portfolioId === p.id).map((m) => m.locationId) })).sort((a, b) => a.name.localeCompare(b.name)),
        ownerGroups: byKind('owner_group'),
        locations: locs.sort((a, b) => a.name.localeCompare(b.name)),
      };
    });

    app.post('/orgs/:orgId/access/portfolios', {
      schema: { tags: ['access'], security: secured, params: orgParams, body: portfolioSchema, summary: 'Create a portfolio: any named set of locations (for field consultants and area representatives)' },
    }, async (req, reply) => {
      const { orgId } = req.params;
      await requireTeamAdmin(req, orgId, 'edit');
      await assertLocations(orgId, req.body.locationIds);
      const p = await s.db.transaction(async (tx) => {
        const [p] = await tx.insert(portfolios).values({ organizationId: orgId, name: req.body.name, description: req.body.description ?? null, createdBy: requireUser(req).id }).returning();
        if (req.body.locationIds.length) await tx.insert(portfolioLocations).values([...new Set(req.body.locationIds)].map((locationId) => ({ portfolioId: p!.id, locationId, organizationId: orgId })));
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.portfolio_created', scopeKind: 'portfolio', scopeId: p!.id, metadata: { name: p!.name, locationIds: req.body.locationIds } });
        return p!;
      });
      return reply.code(201).send({ id: p.id, name: p.name, description: p.description, locationIds: [...new Set(req.body.locationIds)] });
    });

    app.patch('/orgs/:orgId/access/portfolios/:id', {
      schema: { tags: ['access'], security: secured, params: idParams, body: portfolioSchema.partial(), summary: 'Rename a portfolio or change its locations (applies to everyone assigned to it on their next request)' },
    }, async (req) => {
      const { orgId, id } = req.params;
      await requireTeamAdmin(req, orgId, 'edit');
      const [p] = await s.db.select().from(portfolios).where(and(eq(portfolios.id, id), eq(portfolios.organizationId, orgId)));
      if (!p) throw notFound('Portfolio');
      if (req.body.locationIds) await assertLocations(orgId, req.body.locationIds);
      await s.db.transaction(async (tx) => {
        await tx.update(portfolios).set({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.description !== undefined ? { description: req.body.description } : {}), updatedAt: new Date() }).where(eq(portfolios.id, id));
        if (req.body.locationIds) {
          await tx.delete(portfolioLocations).where(eq(portfolioLocations.portfolioId, id));
          if (req.body.locationIds.length) await tx.insert(portfolioLocations).values([...new Set(req.body.locationIds)].map((locationId) => ({ portfolioId: id, locationId, organizationId: orgId })));
        }
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.portfolio_updated', scopeKind: 'portfolio', scopeId: id, metadata: req.body });
      });
      return { id, updated: true };
    });

    app.delete('/orgs/:orgId/access/portfolios/:id', { schema: { tags: ['access'], security: secured, params: idParams, summary: 'Delete a portfolio nobody is assigned to' } }, async (req) => {
      const { orgId, id } = req.params;
      await requireTeamAdmin(req, orgId, 'edit');
      const inUse = await s.db.select({ id: roleAssignments.id }).from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.scopeKind, 'portfolio'), eq(roleAssignments.scopeId, id))).limit(1);
      if (inUse.length) throw conflict('scope_in_use', 'People are still assigned to this portfolio. Move them first.');
      await s.db.delete(portfolios).where(and(eq(portfolios.id, id), eq(portfolios.organizationId, orgId)));
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'access.portfolio_deleted', scopeKind: 'organization', scopeId: orgId, targetType: 'portfolio', targetId: id });
      return { id, deleted: true };
    });

    const setTerritoryLocations = async (tx: typeof s.db, orgId: string, territoryId: string, ids: readonly string[]) => {
      await tx.update(locations).set({ territoryId: null }).where(and(eq(locations.organizationId, orgId), eq(locations.territoryId, territoryId)));
      if (ids.length) await tx.update(locations).set({ territoryId }).where(and(eq(locations.organizationId, orgId), inArray(locations.id, [...ids])));
    };

    app.post('/orgs/:orgId/access/territories', {
      schema: { tags: ['access'], security: secured, params: orgParams, body: territoryScopeSchema, summary: 'Create a territory: a sub-network (a country for a master franchisee, a development area) holding locations and franchise pipeline entries' },
    }, async (req, reply) => {
      const { orgId } = req.params;
      await requireOrgCap(req, orgId, 'network.locations', 'edit');
      await assertLocations(orgId, req.body.locationIds ?? []);
      if (req.body.brandId) await chainFor(orgId, 'brand', req.body.brandId);
      const t = await s.db.transaction(async (tx) => {
        const [t] = await tx.insert(territories).values({ organizationId: orgId, name: req.body.name, kind: req.body.kind, country: req.body.country ?? null, brandId: req.body.brandId ?? (await defaultBrandId(tx, orgId)) }).returning();
        if (req.body.locationIds) await setTerritoryLocations(tx as typeof s.db, orgId, t!.id, req.body.locationIds);
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.territory_created', scopeKind: 'territory', scopeId: t!.id, metadata: { name: t!.name, locationIds: req.body.locationIds ?? [] } });
        return t!;
      });
      return reply.code(201).send({ id: t.id, name: t.name, kind: t.kind, country: t.country, brandId: t.brandId, locationIds: req.body.locationIds ?? [] });
    });

    app.patch('/orgs/:orgId/access/territories/:id', {
      schema: { tags: ['access'], security: secured, params: idParams, body: territoryScopeSchema.partial(), summary: 'Rename a territory or change which locations it holds' },
    }, async (req) => {
      const { orgId, id } = req.params;
      await requireOrgCap(req, orgId, 'network.locations', 'edit');
      await chainFor(orgId, 'territory', id);
      if (req.body.locationIds) await assertLocations(orgId, req.body.locationIds);
      await s.db.transaction(async (tx) => {
        const patch = Object.fromEntries(Object.entries({ name: req.body.name, kind: req.body.kind, country: req.body.country, brandId: req.body.brandId }).filter(([, v]) => v !== undefined));
        await tx.update(territories).set({ ...patch, updatedAt: new Date() }).where(eq(territories.id, id));
        if (req.body.locationIds) await setTerritoryLocations(tx as typeof s.db, orgId, id, req.body.locationIds);
        await audit(tx, { organizationId: orgId, ...actor(req), action: 'access.territory_updated', scopeKind: 'territory', scopeId: id, metadata: req.body });
      });
      return { id, updated: true };
    });

};

/** Public: the capability catalogue and role templates (no tenant data). */
export const accessCatalogueRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/access/catalogue', {
    schema: {
      tags: ['access'], summary: 'Capability catalogue: workspaces → modules → actions, and the system role templates',
      description: 'Modules with status "planned" are not built yet; clients must not show them.',
      querystring: z.object({ industry: z.enum(INDUSTRIES).default('studios'), model: z.enum(['independent', 'network']).default('network') }),
    },
  }, async (req) => ({ ...catalogue(req.query.industry), templates: templatesFor(req.query.industry, req.query.model) }));

};
