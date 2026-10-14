import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { aiConversations, aiMessages, aiProposedActions } from '../db/schema/index.ts';
import { notFound } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { requirePerm } from '../services/authz.ts';
import { decideProposedAction, PROPOSABLE_ACTIONS, sendAiMessage } from '../services/ai.ts';
import { idParams, orgParams, secured } from './_common.ts';

export const aiRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  const load = async (orgId: string, id: string, userId: string) => {
    const [c] = await s.db.select().from(aiConversations).where(and(eq(aiConversations.id, id), eq(aiConversations.organizationId, orgId), eq(aiConversations.userId, userId)));
    if (!c) throw notFound('Conversation');
    return c;
  };

  app.get('/orgs/:orgId/ai/status', { schema: { tags: ['ai'], security: secured, params: orgParams } }, async () => ({
    available: s.ai.enabled, model: s.ai.enabled ? s.ai.model : null, proposableActions: Object.keys(PROPOSABLE_ACTIONS),
    message: s.ai.enabled ? null : 'BranchHarbor AI is unavailable. Manual bookings, orders and publishing are unaffected.',
  }));

  app.post('/orgs/:orgId/ai/conversations', {
    schema: { tags: ['ai'], security: secured, params: orgParams, summary: 'Start a conversation bound to an explicit scope', body: z.object({ scope: z.object({ kind: z.enum(['organization', 'region', 'owner_group', 'location']), id: z.uuid() }), title: z.string().max(120).optional() }) },
  }, async (req, reply) => {
    const me = requireUser(req);
    await requirePerm(req, s.db, 'ai.use', { organizationId: req.params.orgId, ...req.body.scope });
    const [c] = await s.db.insert(aiConversations).values({ organizationId: req.params.orgId, userId: me.id, scopeKind: req.body.scope.kind, scopeId: req.body.scope.id, title: req.body.title ?? null }).returning();
    return reply.code(201).send(c);
  });

  app.get('/orgs/:orgId/ai/conversations', { schema: { tags: ['ai'], security: secured, params: orgParams } }, async (req) => {
    const me = requireUser(req);
    return { items: await s.db.select().from(aiConversations).where(and(eq(aiConversations.organizationId, req.params.orgId), eq(aiConversations.userId, me.id))).orderBy(desc(aiConversations.updatedAt)) };
  });

  app.get('/orgs/:orgId/ai/conversations/:id', { schema: { tags: ['ai'], security: secured, params: idParams } }, async (req) => {
    const c = await load(req.params.orgId, req.params.id, requireUser(req).id);
    const msgs = await s.db.select().from(aiMessages).where(eq(aiMessages.conversationId, c.id)).orderBy(asc(aiMessages.createdAt));
    const actions = await s.db.select().from(aiProposedActions).where(eq(aiProposedActions.conversationId, c.id)).orderBy(desc(aiProposedActions.createdAt));
    return { ...c, messages: msgs, proposedActions: actions };
  });

  app.post('/orgs/:orgId/ai/conversations/:id/messages', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['ai'], security: secured, params: idParams, summary: 'Send a message. Returns 503 ai_unavailable when ANTHROPIC_API_KEY is not configured.', body: z.object({ content: z.string().min(1).max(8000) }) },
  }, async (req) => {
    const c = await load(req.params.orgId, req.params.id, requireUser(req).id);
    return sendAiMessage(s, req, c, req.body.content);
  });

  app.post('/orgs/:orgId/ai/proposed-actions/:id/decision', {
    schema: { tags: ['ai'], security: secured, params: idParams, summary: 'Approve (execute through validated services, with your permissions) or reject a proposed action', body: z.object({ decision: z.enum(['approve', 'reject']) }) },
  }, async (req) => decideProposedAction(s, req, req.params.orgId, req.params.id, req.body.decision));
};
