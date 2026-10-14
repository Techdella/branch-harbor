import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  aiConversations, aiMessages, auditEvents, classBookings, consentRecords, customers, foodOrders, appointments, pushTokens, refreshTokens, roleAssignments, users, organizations, registrations,
} from '../db/schema/index.ts';
import { AppError, unauthorized } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { audit } from '../services/audit.ts';
import { verifyPassword, serializeUser } from '../services/auth.ts';
import { secured } from './_common.ts';

export const meRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  app.patch('/me', {
    schema: { tags: ['me'], security: secured, body: z.object({ name: z.string().min(1).optional(), locale: z.string().optional(), timeZone: z.string().optional() }) },
  }, async (req) => {
    const me = requireUser(req);
    const [u] = await s.db.update(users).set({ ...req.body, updatedAt: new Date() }).where(eq(users.id, me.id)).returning();
    return serializeUser(u!);
  });

  app.get('/me/export', {
    schema: { tags: ['me'], security: secured, summary: 'Export all personal data held for the signed-in user (GDPR-style access request)' },
  }, async (req, reply) => {
    const me = requireUser(req);
    const [u] = await s.db.select().from(users).where(eq(users.id, me.id));
    if (!u) throw unauthorized();
    const custRows = await s.db.select().from(customers).where(or(eq(customers.userId, u.id), sql`lower(${customers.email}) = ${u.email.toLowerCase()}`));
    const custIds = custRows.map((c) => c.id);
    const [assignments, consents, sessions, bookings, food, appts, regs, convos, auditRows] = await Promise.all([
      s.db.select({ role: roleAssignments.role, scopeKind: roleAssignments.scopeKind, scopeId: roleAssignments.scopeId, organization: organizations.name, createdAt: roleAssignments.createdAt })
        .from(roleAssignments).innerJoin(organizations, eq(organizations.id, roleAssignments.organizationId)).where(eq(roleAssignments.userId, u.id)),
      s.db.select().from(consentRecords).where(or(eq(consentRecords.userId, u.id), custIds.length ? inArray(consentRecords.customerId, custIds) : sql`false`)),
      s.db.select({ createdAt: refreshTokens.createdAt, userAgent: refreshTokens.userAgent, ip: refreshTokens.ip, revokedAt: refreshTokens.revokedAt }).from(refreshTokens).where(eq(refreshTokens.userId, u.id)),
      custIds.length ? s.db.select().from(classBookings).where(inArray(classBookings.customerId, custIds)) : [],
      custIds.length ? s.db.select().from(foodOrders).where(inArray(foodOrders.customerId, custIds)) : [],
      custIds.length ? s.db.select().from(appointments).where(inArray(appointments.customerId, custIds)) : [],
      custIds.length ? s.db.select().from(registrations).where(or(inArray(registrations.participantCustomerId, custIds), inArray(registrations.guardianCustomerId, custIds))) : [],
      s.db.select().from(aiConversations).where(eq(aiConversations.userId, u.id)),
      s.db.select().from(auditEvents).where(eq(auditEvents.actorUserId, u.id)).orderBy(desc(auditEvents.createdAt)).limit(1000),
    ]);
    const convoIds = convos.map((c) => c.id);
    const messages = convoIds.length ? await s.db.select().from(aiMessages).where(inArray(aiMessages.conversationId, convoIds)) : [];
    const strip = <T extends Record<string, unknown>>(r: T) => Object.fromEntries(Object.entries(r).filter(([k]) => !/hash|secret|token/i.test(k)));
    await audit(s.db, { organizationId: null, actorUserId: u.id, action: 'privacy.export', targetType: 'user', targetId: u.id, ip: req.ip });
    reply.header('Content-Disposition', `attachment; filename="branchharbor-export-${u.id}.json"`);
    return {
      exportedAt: new Date().toISOString(),
      format: 'branchharbor.personal-data.v1',
      user: serializeUser(u),
      roleAssignments: assignments,
      consents,
      sessions,
      customerRecords: custRows.map(strip),
      classBookings: bookings.map(strip),
      foodOrders: food.map(strip),
      appointments: appts.map(strip),
      registrations: regs.map(strip),
      aiConversations: convos.map((c) => ({ ...c, messages: messages.filter((m) => m.conversationId === c.id) })),
      activity: auditRows,
    };
  });

  app.delete('/me', {
    schema: {
      tags: ['me'], security: secured,
      summary: 'Request account deletion. Signs out all sessions, removes access, and erases personal data (financial records are retained in anonymised form where law requires).',
      body: z.object({ password: z.string().min(1), confirm: z.literal('DELETE') }),
    },
  }, async (req, reply) => {
    const me = requireUser(req);
    const [u] = await s.db.select().from(users).where(eq(users.id, me.id));
    if (!u) throw unauthorized();
    if (!(await verifyPassword(u.passwordHash, req.body.password))) throw new AppError(403, 'invalid_password', 'Password is incorrect');
    const owned = await s.db.select({ orgId: roleAssignments.organizationId }).from(roleAssignments).where(and(eq(roleAssignments.userId, u.id), eq(roleAssignments.role, 'org_owner')));
    for (const o of owned) {
      const owners = await s.db.select({ id: roleAssignments.id }).from(roleAssignments).where(and(eq(roleAssignments.organizationId, o.orgId), eq(roleAssignments.role, 'org_owner')));
      if (owners.length <= 1) throw new AppError(409, 'sole_owner', 'Transfer ownership of your organisation before deleting your account');
    }
    await s.db.transaction(async (tx) => {
      await tx.delete(roleAssignments).where(eq(roleAssignments.userId, u.id));
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, u.id), isNull(refreshTokens.revokedAt)));
      await tx.update(customers).set({ name: 'Erased customer', email: null, phone: null, dateOfBirth: null, notes: null, erasedAt: new Date() }).where(eq(customers.userId, u.id));
      await tx.delete(aiConversations).where(eq(aiConversations.userId, u.id));
      await tx.delete(pushTokens).where(eq(pushTokens.userId, u.id));
      await tx.update(users).set({
        email: `deleted+${u.id}@invalid.branchharbor`, name: 'Deleted user', passwordHash: null, deletionRequestedAt: new Date(), deletedAt: new Date(), updatedAt: new Date(),
      }).where(eq(users.id, u.id));
      await audit(tx, { organizationId: null, actorUserId: u.id, action: 'privacy.account_deleted', targetType: 'user', targetId: u.id, ip: req.ip });
    });
    return reply.code(202).send({ status: 'deleted', note: 'Your account has been deleted and you have been signed out everywhere.' });
  });

  app.get('/me/consents', { schema: { tags: ['me'], security: secured } }, async (req) => {
    const me = requireUser(req);
    const rows = await s.db.select().from(consentRecords).where(eq(consentRecords.userId, me.id)).orderBy(desc(consentRecords.recordedAt));
    const current = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!current.has(r.purpose)) current.set(r.purpose, r);
    return { current: [...current.values()], history: rows };
  });

  app.post('/me/consents', {
    schema: { tags: ['me'], security: secured, summary: 'Record a consent decision (append-only history)', body: z.object({ purpose: z.enum(['marketing_email', 'marketing_sms', 'marketing_whatsapp', 'data_processing_ai', 'analytics']), granted: z.boolean(), version: z.string().min(1).default('2026-10') }) },
  }, async (req, reply) => {
    const me = requireUser(req);
    const [row] = await s.db.insert(consentRecords).values({ userId: me.id, email: me.email, purpose: req.body.purpose, version: req.body.version, granted: req.body.granted, source: 'account_settings', ip: req.ip }).returning();
    return reply.code(201).send(row);
  });
};
