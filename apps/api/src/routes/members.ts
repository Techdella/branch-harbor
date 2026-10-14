import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { inviteMemberSchema, type Role, type ScopeKind } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { invitations, locations, organizations, roleAssignments, users } from '../db/schema/index.ts';
import { canGrantRole, hasPermissionInScope, type ScopeChain } from '../domain/scope.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { requireMember, resolveScopeChain } from '../services/authz.ts';
import { idParams, iso, orgParams, secured } from './_common.ts';

export const memberRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const chainFor = async (orgId: string, kind: string, id: string): Promise<ScopeChain> => resolveScopeChain(s.db, { organizationId: orgId, kind: kind as ScopeKind, id });

  app.get('/orgs/:orgId/members', {
    schema: { tags: ['members'], security: secured, params: orgParams, summary: 'Role assignments visible to the requester (members.manage over the assignment scope)' },
  }, async (req) => {
    const { orgId } = req.params;
    const mine = await requireMember(req, s.db, orgId);
    const rows = await s.db
      .select({ a: roleAssignments, u: { id: users.id, name: users.name, email: users.email } })
      .from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(eq(roleAssignments.organizationId, orgId));
    const locs = await s.db.select().from(locations).where(eq(locations.organizationId, orgId));
    const locById = new Map(locs.map((l) => [l.id, l]));
    const visible = rows.filter((r) => {
      if (r.u.id === req.user!.id) return true;
      const l = r.a.scopeKind === 'location' ? locById.get(r.a.scopeId) : undefined;
      const chain: ScopeChain = {
        organizationId: orgId, kind: r.a.scopeKind as ScopeKind,
        regionId: r.a.scopeKind === 'region' ? r.a.scopeId : l?.regionId,
        ownerGroupId: r.a.scopeKind === 'owner_group' ? r.a.scopeId : l?.ownerGroupId,
        locationId: r.a.scopeKind === 'location' ? r.a.scopeId : undefined,
      };
      return hasPermissionInScope(mine, 'members.manage', chain);
    });
    const byUser = new Map<string, { user: { id: string; name: string; email: string }; assignments: Array<{ id: string; role: string; scope: { kind: string; id: string; name: string | null }; expiresAt: string | null; createdAt: string | null }> }>();
    for (const r of visible) {
      const entry = byUser.get(r.u.id) ?? { user: r.u, assignments: [] };
      entry.assignments.push({ id: r.a.id, role: r.a.role, scope: { kind: r.a.scopeKind, id: r.a.scopeId, name: r.a.scopeKind === 'location' ? locById.get(r.a.scopeId)?.name ?? null : null }, expiresAt: iso(r.a.expiresAt), createdAt: iso(r.a.createdAt) });
      byUser.set(r.u.id, entry);
    }
    return { items: [...byUser.values()] };
  });

  app.post('/orgs/:orgId/invitations', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags: ['members'], security: secured, params: orgParams, body: inviteMemberSchema, summary: 'Invite a member with a scoped role. You can only grant permissions you hold in that scope.' },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const b = req.body;
    if (b.role === 'customer') throw badRequest('Customers are not invited as team members');
    const mine = await requireMember(req, s.db, orgId);
    const chain = await chainFor(orgId, b.scope.kind, b.scope.id);
    if (!canGrantRole(mine, b.role, chain)) throw forbidden('You cannot grant this role in this scope');
    const token = randomToken();
    const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const inv = await s.db.transaction(async (tx) => {
      const [inv] = await tx.insert(invitations).values({
        organizationId: orgId, email: b.email.toLowerCase(), role: b.role, scopeKind: b.scope.kind, scopeId: b.scope.id,
        tokenHash: sha256(token), invitedBy: req.user!.id, expiresAt: new Date(Date.now() + 7 * 86400_000),
      }).returning();
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'member.invited', scopeKind: b.scope.kind, scopeId: b.scope.id, targetType: 'invitation', targetId: inv!.id, metadata: { email: b.email, role: b.role } });
      return inv!;
    });
    await s.jobs.enqueue('email.send', {
      to: b.email,
      subject: `You're invited to ${org?.name ?? 'BranchHarbor'}`,
      text: `You've been invited to join ${org?.name} on BranchHarbor as ${b.role.replace('_', ' ')}.\nAccept: ${s.cfg.APP_URL}/invitations/accept?token=${encodeURIComponent(token)}\nThis invitation expires in 7 days.`,
      tag: 'invitation',
    });
    return reply.code(201).send({
      id: inv.id, email: inv.email, role: inv.role, scope: { kind: inv.scopeKind, id: inv.scopeId }, status: inv.status, expiresAt: iso(inv.expiresAt),
      ...(s.cfg.NODE_ENV !== 'production' && s.cfg.EXPOSE_DEV_TOKENS && s.mailer.mode === 'log' ? { devInvitationToken: token } : {}),
    });
  });

  app.get('/orgs/:orgId/invitations', { schema: { tags: ['members'], security: secured, params: orgParams } }, async (req) => {
    const { orgId } = req.params;
    const mine = await requireMember(req, s.db, orgId);
    const rows = await s.db.select().from(invitations).where(eq(invitations.organizationId, orgId));
    const out = [];
    for (const r of rows) {
      const chain = await chainFor(orgId, r.scopeKind, r.scopeId).catch(() => null);
      if (chain && hasPermissionInScope(mine, 'members.manage', chain))
        out.push({ id: r.id, email: r.email, role: r.role, scope: { kind: r.scopeKind, id: r.scopeId }, status: r.status === 'pending' && r.expiresAt < new Date() ? 'expired' : r.status, expiresAt: iso(r.expiresAt), createdAt: iso(r.createdAt) });
    }
    return { items: out };
  });

  app.delete('/orgs/:orgId/invitations/:id', { schema: { tags: ['members'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    const mine = await requireMember(req, s.db, orgId);
    const [inv] = await s.db.select().from(invitations).where(and(eq(invitations.id, id), eq(invitations.organizationId, orgId)));
    if (!inv) throw notFound('Invitation');
    if (!hasPermissionInScope(mine, 'members.manage', await chainFor(orgId, inv.scopeKind, inv.scopeId))) throw forbidden();
    await s.db.update(invitations).set({ status: 'revoked' }).where(eq(invitations.id, id));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'member.invitation_revoked', targetType: 'invitation', targetId: id });
    return { id, status: 'revoked' };
  });

  app.delete('/orgs/:orgId/role-assignments/:id', {
    schema: { tags: ['members'], security: secured, params: idParams, summary: 'Remove a role assignment. Takes effect on the next request (roles are never cached in tokens).' },
  }, async (req) => {
    const { orgId, id } = req.params;
    const mine = await requireMember(req, s.db, orgId);
    const [a] = await s.db.select().from(roleAssignments).where(and(eq(roleAssignments.id, id), eq(roleAssignments.organizationId, orgId)));
    if (!a) throw notFound('Role assignment');
    const chain = await chainFor(orgId, a.scopeKind, a.scopeId);
    if (!canGrantRole(mine, a.role as Role, chain)) throw forbidden('You cannot remove this role in this scope');
    if (a.role === 'org_owner') {
      const owners = await s.db.select({ id: roleAssignments.id }).from(roleAssignments).where(and(eq(roleAssignments.organizationId, orgId), eq(roleAssignments.role, 'org_owner')));
      if (owners.length <= 1) throw conflict('last_owner', 'An organisation must keep at least one owner');
    }
    await s.db.transaction(async (tx) => {
      await tx.delete(roleAssignments).where(eq(roleAssignments.id, id));
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'member.role_revoked', scopeKind: a.scopeKind, scopeId: a.scopeId, targetType: 'user', targetId: a.userId, metadata: { role: a.role } });
    });
    return { id, revoked: true };
  });

  // Accepting an invitation is not org-scoped: the token identifies it.
  app.post('/invitations/accept', {
    schema: { tags: ['members'], security: secured, body: z.object({ token: z.string().min(10) }), summary: 'Accept an invitation (signed-in user email must match)' },
  }, async (req) => {
    const me = requireUser(req);
    const [inv] = await s.db.select().from(invitations).where(and(eq(invitations.tokenHash, sha256(req.body.token)), eq(invitations.status, 'pending'), gt(invitations.expiresAt, new Date())));
    if (!inv) throw badRequest('This invitation is invalid, revoked or expired');
    if (inv.email.toLowerCase() !== me.email.toLowerCase()) throw new AppError(403, 'invitation_email_mismatch', 'Sign in with the email address the invitation was sent to');
    await s.db.transaction(async (tx) => {
      await tx.insert(roleAssignments).values({ organizationId: inv.organizationId, userId: me.id, role: inv.role, scopeKind: inv.scopeKind, scopeId: inv.scopeId, createdBy: inv.invitedBy }).onConflictDoNothing();
      await tx.update(invitations).set({ status: 'accepted', acceptedAt: new Date(), acceptedBy: me.id }).where(eq(invitations.id, inv.id));
      await audit(tx, { organizationId: inv.organizationId, ...actor(req), action: 'member.invitation_accepted', scopeKind: inv.scopeKind, scopeId: inv.scopeId, targetType: 'invitation', targetId: inv.id, metadata: { role: inv.role } });
    });
    return { organizationId: inv.organizationId, role: inv.role, scope: { kind: inv.scopeKind, id: inv.scopeId } };
  });
};

