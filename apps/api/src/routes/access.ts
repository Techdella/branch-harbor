import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { INDUSTRIES, assignmentAccessSchema, customRoleSchema, scopeSchema, type Capability, type Role, type ScopeKind } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { customRoles, locations, memberAccessOverrides, organizations, ownerGroups, regions, roleAssignments, roleCapabilities, users } from '../db/schema/index.ts';
import { assignmentCovers, canGrantCapabilities, capabilitiesInScope, hasCapabilityInScope, type Assignment, type ScopeChain } from '../domain/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import {
  assertScopeAllows, assignmentCaps, catalogue, diff, listCustomRoles, loadCustomRole, overridesFor, preview, roleName, templatesFor, validateCapabilities,
} from '../services/access.ts';
import { actor, audit } from '../services/audit.ts';
import { accessSummaryFor, requireMember, resolveScopeChain, withEffectiveAccess } from '../services/authz.ts';
import { assertRoleForModel } from '../services/businessMode.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';

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
      return {
        industry: org.industry,
        ...(await accessSummaryFor(s.db, mine, org.industry)),
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
      return { industry: org.industry, templates: templatesFor(org.industry, org.model), custom: await listCustomRoles(s.db, orgId), catalogue: catalogue(org.industry) };
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
        out.push({
          id: row.id, role: row.role, roleName: roleName(row.role, custom.find((c) => c.id === row.customRoleId)), customRoleId: row.customRoleId,
          scope: { kind: row.scopeKind, id: row.scopeId, name: await scopeName(orgId, row.scopeKind, row.scopeId) },
          grants: ov.grants, revokes: ov.revokes, capabilities: [...(a.capabilities ?? [])].sort(),
          editable: !ownerOnly && canGrantCapabilities(mine, a.capabilities ?? new Set(), chain),
          expiresAt: iso(row.expiresAt),
        });
      }
      if (!out.length) throw forbidden('You cannot see this person’s access');
      return { user: u, industry: org.industry, assignments: out, summary: await accessSummaryFor(s.db, visible, org.industry) };
    });

    async function scopeName(orgId: string, kind: string, id: string): Promise<string | null> {
      if (kind === 'organization') return null;
      const table = kind === 'region' ? regions : kind === 'owner_group' ? ownerGroups : locations;
      const [row] = await s.db.select({ name: table.name }).from(table).where(and(eq(table.id, id), eq(table.organizationId, orgId)));
      return row?.name ?? null;
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
        body: z.object({ role: assignmentAccessSchema.shape.role.unwrap(), customRoleId: z.uuid().nullable().optional(), scopeKind: scopeSchema.shape.kind, capabilities: z.array(z.string()).optional(), grants: z.array(z.string()).default([]), revokes: z.array(z.string()).default([]) }),
        summary: 'Preview the workspaces and navigation a role (or a ticked set of module actions) would give, before saving',
      },
    }, async (req) => {
      const { orgId } = req.params;
      const mine = await requireMember(req, s.db, orgId);
      if (!mine.some((a) => a.capabilities?.has('settings.team:view'))) throw forbidden('You need Team & access');
      const org = await orgOf(orgId);
      const b = req.body;
      const caps = b.capabilities
        ? validateCapabilities(b.capabilities, org.industry)
        : await assignmentCaps(s.db, org.industry, { role: b.role, customRoleId: b.customRoleId ?? null, scopeKind: b.scopeKind }, { grants: b.grants, revokes: b.revokes });
      return { capabilities: [...caps].sort(), ...preview(caps, org.industry) };
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
      const out = [];
      for (const [i, r] of rows.entries()) {
        const chain = await chainFor(orgId, r.a.scopeKind, r.a.scopeId).catch(() => null);
        if (!chain || (r.u.id !== req.user!.id && !hasCapabilityInScope(mine, 'settings.team', 'view', chain))) continue;
        const caps = access[i]!.capabilities ?? new Set<Capability>();
        out.push({
          id: r.a.id, user: r.u, role: r.a.role, customRoleId: r.a.customRoleId, roleName: roleName(r.a.role, custom.find((c) => c.id === r.a.customRoleId)),
          scope: { kind: r.a.scopeKind, id: r.a.scopeId, name: await scopeName(orgId, r.a.scopeKind, r.a.scopeId) },
          workspaces: preview(caps, org.industry).workspaces.map((w) => w.key),
          editable: canGrantCapabilities(mine, caps, chain) && (r.a.role !== 'org_owner' || mine.some((m) => m.role === 'org_owner' && assignmentCovers(m, chain))),
        });
      }
      return { items: out, held: [...capabilitiesInScope(mine, orgChain(orgId))].sort() };
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
