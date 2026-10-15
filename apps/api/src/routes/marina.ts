import { and, asc, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { AI_ACTION_RISKS, AI_TOOL_AREAS, ASSISTANT_NAME, BRIEFING_SECTIONS, aiOrgSettings as parseSettings, type MarinaStreamEvent } from '@bh/shared';
import { aiBriefings, aiConversations, aiKnowledgeSources, aiTasks, aiToolCalls, aiUserPrefs } from '../db/schema/index.ts';
import { AppError, forbidden, notFound, validationError } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { requireMember } from '../services/authz.ts';
import { buildAssistantContext, type AssistantContext } from '../ai/context.ts';
import { assertAssistantAvailable, cancelAction, confirmAction, decideHeldAction, listActions, runTurn, type Emit } from '../ai/engine.ts';
import { indexUpload, searchKnowledge, citationsFrom, syncOrgKnowledge } from '../ai/knowledge.ts';
import { loadTools, toolsFor } from '../ai/registry.ts';
import { loadAiSettings, saveAiSettings, usageView } from '../ai/settings.ts';
import { generateBriefing } from '../ai/skills/briefing.ts';
import { learnBrandVoice, generateCopy, translateContent } from '../ai/skills/content.ts';
import { buildCourseOutline } from '../ai/skills/course-builder.ts';
import { checkAuditPhoto, extractComplianceFields } from '../ai/skills/documents.ts';
import { suggestTicketAnswer } from '../ai/skills/helpdesk.ts';
import { actOnInsight, dismissInsight, listInsights, refreshInsights } from '../ai/skills/insights.ts';
import { scoreLead, scoreProspect } from '../ai/skills/scoring.ts';
import { planSetup } from '../ai/skills/setup.ts';
import { buildVisitBrief } from '../ai/skills/visit-brief.ts';
import { proposeAction } from '../ai/engine.ts';
import { ToolError } from '../ai/types.ts';
import { idParams, orgParams, secured } from './_common.ts';

const tags = ['ai'];
const screen = z.object({ path: z.string().max(300).nullable().optional(), title: z.string().max(200).nullable().optional(), recordType: z.string().max(60).nullable().optional(), recordId: z.string().max(80).nullable().optional() }).nullable().optional();
const chatBody = z.object({ conversationId: z.uuid().nullable().optional(), message: z.string().trim().min(1).max(8000), screen, channel: z.enum(['web', 'mobile', 'api']).default('web') });
const upload = z.object({ fileName: z.string().min(1).max(200), mimeType: z.string().min(3).max(120), dataBase64: z.string().min(4).max(28_000_000) });

/** The person's assistant context (member of the organisation, AI access). Locale from the app's Accept-Language. */
async function assistantFor(req: FastifyRequest, orgId: string, opts: { action?: 'view' | 'edit' | 'publish' | 'export'; hq?: boolean } = {}): Promise<AssistantContext> {
  const user = requireUser(req);
  await requireMember(req, req.server.ctx.db, orgId);
  const lang = String(req.headers['accept-language'] ?? '').split(',')[0]?.trim() || undefined;
  const ctx = await buildAssistantContext(req.server.ctx, orgId, user.id, { locale: lang && /^[a-z]{2}(-[A-Z]{2})?$/.test(lang) ? lang : undefined });
  if (!ctx.can('ai.assistant', opts.action ?? 'view')) throw forbidden(`${ASSISTANT_NAME} ${opts.action && opts.action !== 'view' ? `(${opts.action}) ` : ''}is not part of your access`);
  if (opts.hq && !ctx.hq) throw forbidden('This needs organisation-wide access');
  return ctx;
}

/** Turns tool errors into API errors. */
async function wrap<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ToolError) throw new AppError(err.status, err.code, err.message);
    throw err;
  }
}

export const marinaRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);

  /* ------------------------------ Chat ------------------------------ */

  app.post('/orgs/:orgId/ai/chat', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, security: secured, params: orgParams, body: chatBody, summary: `Ask ${ASSISTANT_NAME} (Server-Sent Events: start, text, tool, block, action, citations, navigate, notice, done, error)` },
  }, async (req, reply) => {
    const ctx = await assistantFor(req, req.params.orgId);
    await assertAssistantAvailable(s, ctx);
    reply.raw.writeHead(200, { ...(reply.getHeaders() as Record<string, string>), 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    reply.hijack();
    const emit: Emit = (e) => {
      if (!reply.raw.writableEnded) reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    try {
      await runTurn(s, ctx, { conversationId: req.body.conversationId ?? null, text: req.body.message, screen: req.body.screen ?? null, channel: req.body.channel }, emit);
    } catch (err) {
      const e = err instanceof AppError ? err : null;
      if (!e) req.log.error({ err }, '[ai] chat failed');
      emit({ type: 'error', code: e?.code ?? 'internal_error', message: e?.message ?? 'Something went wrong.' } as MarinaStreamEvent);
    } finally {
      reply.raw.end();
    }
  });

  app.post('/orgs/:orgId/ai/ask', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { tags, security: secured, params: orgParams, body: chatBody, summary: `Ask ${ASSISTANT_NAME} and get the whole answer as JSON (mobile and integrations)` },
  }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    return runTurn(s, ctx, { conversationId: req.body.conversationId ?? null, text: req.body.message, screen: req.body.screen ?? null, channel: req.body.channel }, () => {});
  });

  app.delete('/orgs/:orgId/ai/conversations/:id', { schema: { tags, security: secured, params: idParams, summary: 'Archive one of your conversations' } }, async (req) => {
    const me = requireUser(req);
    const [c] = await s.db.update(aiConversations).set({ archivedAt: new Date() }).where(and(eq(aiConversations.id, req.params.id), eq(aiConversations.organizationId, req.params.orgId), eq(aiConversations.userId, me.id))).returning();
    if (!c) throw notFound('Conversation');
    return { id: c.id, archived: true };
  });

  /* ------------------------------ Action cards ------------------------------ */

  app.get('/orgs/:orgId/ai/actions', { schema: { tags, security: secured, params: orgParams, summary: 'Your action cards waiting for confirmation, and held actions to approve (AI admins)' } }, async (req) => listActions(s, await assistantFor(req, req.params.orgId)));

  app.post('/orgs/:orgId/ai/actions/:id/confirm', {
    schema: { tags, security: secured, params: idParams, body: z.object({ edits: z.record(z.string(), z.unknown()).default({}) }), summary: 'Confirm an action card (optionally with edited fields). It runs as you, through the same checks as the app.' },
  }, async (req) => wrap(confirmAction(s, await assistantFor(req, req.params.orgId, { action: 'edit' }), req.params.id, req.body.edits)));

  app.post('/orgs/:orgId/ai/actions/:id/cancel', { schema: { tags, security: secured, params: idParams } }, async (req) => cancelAction(s, await assistantFor(req, req.params.orgId), req.params.id));

  app.post('/orgs/:orgId/ai/actions/:id/decision', {
    schema: { tags, security: secured, params: idParams, body: z.object({ decision: z.enum(['approve', 'reject']) }), summary: 'Approve or reject an action held for HQ approval (organisation AI controls)' },
  }, async (req) => wrap(decideHeldAction(s, await assistantFor(req, req.params.orgId, { action: 'publish', hq: true }), req.params.id, req.body.decision)));

  /* ------------------------------ Status, settings, usage ------------------------------ */

  app.get('/orgs/:orgId/ai/assistant', { schema: { tags, security: secured, params: orgParams, summary: `${ASSISTANT_NAME}: mode, usage, controls and the tools available to you` } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    const settings = await loadAiSettings(s.db, ctx.orgId);
    const tools = await toolsFor(ctx, settings);
    return {
      name: ASSISTANT_NAME, mode: s.marina.mode, enabled: settings.enabled, usage: await usageView(s, ctx.orgId),
      can: { use: true, act: ctx.can('ai.assistant', 'edit'), admin: ctx.can('ai.assistant', 'publish') && ctx.hq, export: ctx.can('ai.assistant', 'export') },
      tools: tools.map((t) => ({ name: t.name, kind: t.kind, area: t.area })),
    };
  });

  app.get('/orgs/:orgId/ai/settings', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    const all = await loadTools();
    return { settings: await loadAiSettings(s.db, ctx.orgId), areas: AI_TOOL_AREAS, risks: AI_ACTION_RISKS, toolCount: all.size, canEdit: ctx.can('ai.assistant', 'publish') && ctx.hq };
  });

  app.put('/orgs/:orgId/ai/settings', {
    schema: {
      tags, security: secured, params: orgParams, summary: 'Organisation AI controls (AI admins with organisation-wide access)',
      body: z.object({
        enabled: z.boolean().optional(),
        allowedAreas: z.array(z.enum(AI_TOOL_AREAS)).nullable().optional(),
        approvalRequiredFor: z.array(z.enum(AI_ACTION_RISKS)).optional(),
        retentionDays: z.number().int().min(7).max(3650).optional(),
        helpdeskAutoAnswer: z.boolean().optional(),
        helpdeskAutoResolve: z.boolean().optional(),
        guardrails: z.object({ bannedClaims: z.array(z.string().trim().min(1).max(200)).max(100), requiredDisclaimers: z.array(z.string().trim().min(1).max(500)).max(20) }).optional(),
        brandVoice: z.object({ tone: z.string().max(200), preferredWords: z.array(z.string().max(60)).max(30), avoidWords: z.array(z.string().max(60)).max(30) }).partial().optional(),
        contentLocales: z.array(z.string().max(10)).max(9).optional(),
      }),
    },
  }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'publish', hq: true });
    const cur = await loadAiSettings(s.db, ctx.orgId);
    const { brandVoice, ...rest } = req.body;
    const next = await saveAiSettings(s.db, ctx.orgId, { ...rest, ...(brandVoice ? { brandVoice: { ...cur.brandVoice, ...brandVoice } } : {}) }, ctx.user.id);
    const { audit } = await import('../services/audit.ts');
    await audit(s.db, { organizationId: ctx.orgId, actorUserId: ctx.user.id, action: 'ai.settings_updated', targetType: 'ai_settings', targetId: ctx.orgId, metadata: { changed: Object.keys(req.body) } });
    return { settings: parseSettings(next) };
  });

  app.get('/orgs/:orgId/ai/usage', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }), summary: 'Monthly AI credits used, the plan allowance and the fair-use limit' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    return usageView(s, ctx.orgId, req.query.month);
  });

  app.get('/orgs/:orgId/ai/tool-calls', {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), userId: z.uuid().optional() }), summary: 'The assistant’s audit log: every tool call and action (personal data masked). AI export access.' },
  }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'export' });
    const mineOnly = !ctx.hq;
    const rows = await s.db.select().from(aiToolCalls).where(and(eq(aiToolCalls.organizationId, ctx.orgId), ...(mineOnly ? [eq(aiToolCalls.userId, ctx.user.id)] : req.query.userId ? [eq(aiToolCalls.userId, req.query.userId)] : []))).orderBy(desc(aiToolCalls.createdAt)).limit(req.query.limit);
    return { items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
  });

  /* ------------------------------ Briefing ------------------------------ */

  const prefsBody = z.object({ briefingFrequency: z.enum(['off', 'daily', 'weekly']), briefingHour: z.number().int().min(0).max(23), briefingWeekday: z.number().int().min(1).max(7), briefingEmail: z.boolean(), briefingInApp: z.boolean(), sections: z.array(z.enum(BRIEFING_SECTIONS)) }).partial();
  const loadPrefs = async (orgId: string, userId: string) => {
    const [p] = await s.db.select().from(aiUserPrefs).where(and(eq(aiUserPrefs.organizationId, orgId), eq(aiUserPrefs.userId, userId)));
    if (p) return p;
    const [created] = await s.db.insert(aiUserPrefs).values({ organizationId: orgId, userId }).onConflictDoNothing().returning();
    return created ?? (await s.db.select().from(aiUserPrefs).where(and(eq(aiUserPrefs.organizationId, orgId), eq(aiUserPrefs.userId, userId))))[0]!;
  };

  app.get('/orgs/:orgId/ai/prefs', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    return loadPrefs(ctx.orgId, ctx.user.id);
  });
  app.put('/orgs/:orgId/ai/prefs', { schema: { tags, security: secured, params: orgParams, body: prefsBody, summary: 'Your briefing schedule, channels and sections' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    await loadPrefs(ctx.orgId, ctx.user.id);
    const [p] = await s.db.update(aiUserPrefs).set({ ...req.body, updatedAt: new Date() }).where(and(eq(aiUserPrefs.organizationId, ctx.orgId), eq(aiUserPrefs.userId, ctx.user.id))).returning();
    return p!;
  });

  app.get('/orgs/:orgId/ai/briefing', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ refresh: z.coerce.boolean().default(false) }), summary: 'Today’s briefing (prepared on demand when not ready yet)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    await assertAssistantAvailable(s, ctx);
    await loadPrefs(ctx.orgId, ctx.user.id);
    const b = await generateBriefing(s, ctx.orgId, ctx.user.id, { ctx, force: req.query.refresh });
    const history = await s.db.select({ id: aiBriefings.id, date: aiBriefings.date, summary: aiBriefings.summary }).from(aiBriefings).where(and(eq(aiBriefings.organizationId, ctx.orgId), eq(aiBriefings.userId, ctx.user.id))).orderBy(desc(aiBriefings.date)).limit(7);
    return { ...b, createdAt: b.createdAt.toISOString(), emailedAt: b.emailedAt?.toISOString() ?? null, history };
  });

  /* ------------------------------ Insights ------------------------------ */

  app.get('/orgs/:orgId/ai/insights', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['open', 'all']).default('open') }), summary: 'Insights on your locations (anomalies with explanation, evidence and suggested actions)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    return { items: await listInsights(ctx, { status: req.query.status }) };
  });
  app.post('/orgs/:orgId/ai/insights/run', { schema: { tags, security: secured, params: orgParams, summary: 'Run detection now (AI admins)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'publish', hq: true });
    return { detected: await refreshInsights(s, ctx.orgId) };
  });
  app.post('/orgs/:orgId/ai/insights/:id/dismiss', { schema: { tags, security: secured, params: idParams } }, async (req) => dismissInsight(await assistantFor(req, req.params.orgId), req.params.id));
  app.post('/orgs/:orgId/ai/insights/:id/actions/:index', {
    schema: { tags, security: secured, params: idParams.extend({ index: z.coerce.number().int().min(0).max(10) }), summary: 'Turn a suggested action into an action card' },
  }, async (req) => wrap(actOnInsight(await assistantFor(req, req.params.orgId, { action: 'edit' }), req.params.id, req.params.index)));

  /* ------------------------------ Skills ------------------------------ */

  app.get('/orgs/:orgId/ai/visit-brief', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ location: z.string().min(1).max(120) }), summary: 'One-page visit brief for a location' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    await assertAssistantAvailable(s, ctx);
    return wrap(buildVisitBrief(ctx, req.query.location));
  });

  app.post('/orgs/:orgId/ai/content/generate', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ kind: z.enum(['email', 'social', 'ad', 'website_section', 'coming_soon']), brief: z.string().trim().min(3).max(2000), locale: z.string().max(10).optional() }), summary: 'Brand-voice copy with guardrails applied' },
  }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'edit' });
    await assertAssistantAvailable(s, ctx);
    return generateCopy(ctx, req.body);
  });
  app.post('/orgs/:orgId/ai/content/translate', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ text: z.string().trim().min(1).max(20_000), targetLocales: z.array(z.string().max(10)).min(1).max(9), sourceLocale: z.string().max(10).optional() }), summary: 'Translate content into the organisation’s site locales' },
  }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'edit' });
    await assertAssistantAvailable(s, ctx);
    return translateContent(ctx, req.body);
  });
  app.post('/orgs/:orgId/ai/brand-voice/learn', { schema: { tags, security: secured, params: orgParams, summary: 'Learn the brand voice profile from approved content (AI admins)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'publish', hq: true });
    await assertAssistantAvailable(s, ctx);
    return learnBrandVoice(ctx);
  });

  app.post('/orgs/:orgId/ai/helpdesk/tickets/:id/suggest', { schema: { tags, security: secured, params: idParams, summary: 'Suggested answer to a ticket from the knowledge base, with citations (help desk agents)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    if (!ctx.can('community.help_desk', 'edit')) throw forbidden('Suggested answers are for help desk agents');
    await assertAssistantAvailable(s, ctx);
    return wrap(suggestTicketAnswer(ctx, req.params.id));
  });

  app.post('/orgs/:orgId/ai/documents/extract', { schema: { tags, security: secured, params: orgParams, body: upload, summary: 'Read an insurance certificate, licence or permit (PDF or image) into compliance document fields for you to confirm' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    if (!ctx.can('legal.compliance_documents', 'edit')) throw forbidden('Uploading compliance documents is not part of your access');
    await assertAssistantAvailable(s, ctx);
    return wrap(extractComplianceFields(ctx, req.body));
  });

  app.post('/orgs/:orgId/ai/audits/:id/photo-check', {
    schema: { tags, security: secured, params: idParams, body: z.object({ questionId: z.string().min(1).max(80), mimeType: z.string().max(60), dataBase64: z.string().min(4).max(14_000_000) }), summary: 'Suggested pass / fail for an audit photo against its checklist item. The auditor decides.' },
  }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    if (!ctx.can('operations.audits', 'edit')) throw forbidden('Conducting audits is not part of your access');
    await assertAssistantAvailable(s, ctx);
    return wrap(checkAuditPhoto(ctx, { auditId: req.params.id, ...req.body }));
  });

  app.post('/orgs/:orgId/ai/courses/outline', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ title: z.string().max(200).optional(), text: z.string().max(400_000).optional(), libraryResourceId: z.uuid().optional(), upload: upload.optional() }), summary: 'Build a course (lessons and quiz) from a manual; returns the outline and an action card to create the draft' },
  }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'edit' });
    if (!ctx.can('training.academy', 'edit')) throw forbidden('Writing courses is not part of your access');
    await assertAssistantAvailable(s, ctx);
    const outline = await wrap(buildCourseOutline(ctx, req.body));
    const action = await wrap(proposeAction(s, ctx, 'create_course_draft', { title: outline.title, summary: outline.summary.slice(0, 500), modules: outline.modules, quiz: outline.quiz }, 'course_builder', { untrusted: true }));
    return { outline, action };
  });

  app.post('/orgs/:orgId/ai/setup', { schema: { tags, security: secured, params: orgParams, body: z.object({ message: z.string().trim().min(5).max(4000) }), summary: 'Setup assistant: a plan (locations, team, theme, first campaigns) as action cards' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'edit' });
    await assertAssistantAvailable(s, ctx);
    return planSetup(ctx, req.body.message);
  });

  app.get('/orgs/:orgId/ai/score/lead/:id', { schema: { tags, security: secured, params: idParams, summary: 'Explained lead score and next best action' } }, async (req) => {
    const r = await wrap(scoreLead(await assistantFor(req, req.params.orgId), req.params.id));
    if (!r) throw notFound('Lead');
    return r;
  });
  app.get('/orgs/:orgId/ai/score/prospect/:id', { schema: { tags, security: secured, params: idParams, summary: 'Explained franchise-candidate score and next best action' } }, async (req) => wrap(scoreProspect(await assistantFor(req, req.params.orgId), req.params.id)));

  /* ------------------------------ Knowledge base ------------------------------ */

  app.get('/orgs/:orgId/ai/knowledge', { schema: { tags, security: secured, params: orgParams, summary: 'Knowledge base sources (AI admins see all; others the uploads they added)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    const admin = ctx.can('ai.assistant', 'publish') && ctx.hq;
    const rows = await s.db.select().from(aiKnowledgeSources).where(and(eq(aiKnowledgeSources.organizationId, ctx.orgId), ...(admin ? [] : [eq(aiKnowledgeSources.createdBy, ctx.user.id)]))).orderBy(desc(aiKnowledgeSources.updatedAt)).limit(500);
    return { items: rows.map((r) => ({ id: r.id, sourceType: r.sourceType, title: r.title, url: r.url, chunkCount: r.chunkCount, status: r.status, error: r.error, fileName: r.fileName, hqOnly: r.hqOnly, updatedAt: r.updatedAt.toISOString() })), canManage: admin };
  });
  app.post('/orgs/:orgId/ai/knowledge/sync', { schema: { tags, security: secured, params: orgParams, summary: 'Re-index the library, courses, help-desk answers and brand guidelines (AI admins)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'publish', hq: true });
    return syncOrgKnowledge(s, ctx.orgId);
  });
  app.post('/orgs/:orgId/ai/knowledge/uploads', {
    bodyLimit: 30 * 1024 * 1024,
    schema: { tags, security: secured, params: orgParams, body: upload.extend({ title: z.string().max(200).optional(), hqOnly: z.boolean().default(false), locationIds: z.array(z.uuid()).max(500).optional() }), summary: 'Add a PDF, DOCX or Markdown file to the knowledge base (AI admins). Optionally only for some locations or HQ.' },
  }, async (req, reply) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'publish', hq: true });
    if (!/pdf|wordprocessingml|markdown|text\//.test(req.body.mimeType) && !/\.(pdf|docx|md|txt)$/i.test(req.body.fileName)) throw validationError('Upload a PDF, DOCX, Markdown or text file', { fileName: 'Unsupported type' });
    const r = await indexUpload(s, ctx.orgId, { fileName: req.body.fileName, mimeType: req.body.mimeType, data: Buffer.from(req.body.dataBase64, 'base64'), title: req.body.title, hqOnly: req.body.hqOnly, audiences: req.body.locationIds?.length ? [{ locationIds: req.body.locationIds }] : [], userId: ctx.user.id });
    reply.code(201);
    return r;
  });
  app.delete('/orgs/:orgId/ai/knowledge/:id', { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId, { action: 'publish', hq: true });
    const [r] = await s.db.delete(aiKnowledgeSources).where(and(eq(aiKnowledgeSources.id, req.params.id), eq(aiKnowledgeSources.organizationId, ctx.orgId))).returning();
    if (!r) throw notFound('Source');
    return { id: r.id, deleted: true };
  });
  app.get('/orgs/:orgId/ai/knowledge/search', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ q: z.string().min(2).max(300) }), summary: 'Search the knowledge base (only what is shared with you)' } }, async (req) => {
    const ctx = await assistantFor(req, req.params.orgId);
    const hits = await searchKnowledge(s, ctx, req.query.q, 8);
    return { hits: hits.map((h) => ({ title: h.title, heading: h.heading, excerpt: h.content.slice(0, 400), url: h.url, sourceType: h.sourceType })), citations: citationsFrom(hits) };
  });

  /* ------------------------------ Personal tasks ------------------------------ */

  app.get('/orgs/:orgId/ai/tasks', { schema: { tags, security: secured, params: orgParams, querystring: z.object({ status: z.enum(['open', 'done', 'all']).default('open') }) } }, async (req) => {
    const me = requireUser(req);
    await requireMember(req, s.db, req.params.orgId);
    const rows = await s.db.select().from(aiTasks).where(and(eq(aiTasks.organizationId, req.params.orgId), eq(aiTasks.userId, me.id), ...(req.query.status === 'all' ? [] : [eq(aiTasks.status, req.query.status)]))).orderBy(asc(aiTasks.dueAt), desc(aiTasks.createdAt)).limit(200);
    return { items: rows.map((t) => ({ id: t.id, title: t.title, note: t.note, link: t.link, dueAt: t.dueAt?.toISOString() ?? null, remindAt: t.remindAt?.toISOString() ?? null, status: t.status, createdAt: t.createdAt.toISOString() })) };
  });
  app.post('/orgs/:orgId/ai/tasks', {
    schema: { tags, security: secured, params: orgParams, body: z.object({ title: z.string().trim().min(1).max(200), note: z.string().max(2000).nullable().optional(), link: z.string().max(300).nullable().optional(), dueAt: z.iso.datetime({ offset: true }).nullable().optional(), remindAt: z.iso.datetime({ offset: true }).nullable().optional() }), summary: 'Add a personal task or reminder' },
  }, async (req, reply) => {
    const me = requireUser(req);
    await requireMember(req, s.db, req.params.orgId);
    const [t] = await s.db.insert(aiTasks).values({ organizationId: req.params.orgId, userId: me.id, title: req.body.title, note: req.body.note ?? null, link: req.body.link?.startsWith('/') ? req.body.link : null, dueAt: req.body.dueAt ? new Date(req.body.dueAt) : null, remindAt: req.body.remindAt ? new Date(req.body.remindAt) : null }).returning();
    reply.code(201);
    return { id: t!.id, title: t!.title, status: t!.status };
  });
  app.patch('/orgs/:orgId/ai/tasks/:id', { schema: { tags, security: secured, params: idParams, body: z.object({ status: z.enum(['open', 'done']) }) } }, async (req) => {
    const me = requireUser(req);
    const [t] = await s.db.update(aiTasks).set({ status: req.body.status, updatedAt: new Date() }).where(and(eq(aiTasks.id, req.params.id), eq(aiTasks.organizationId, req.params.orgId), eq(aiTasks.userId, me.id))).returning();
    if (!t) throw notFound('Task');
    return { id: t.id, status: t.status };
  });

  /* ------------------------------ Recent conversations (home card) ------------------------------ */

  app.get('/orgs/:orgId/ai/recent', { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const me = requireUser(req);
    await requireMember(req, s.db, req.params.orgId);
    const rows = await s.db.select({ id: aiConversations.id, title: aiConversations.title, updatedAt: aiConversations.updatedAt }).from(aiConversations)
      .where(and(eq(aiConversations.organizationId, req.params.orgId), eq(aiConversations.userId, me.id), isNull(aiConversations.archivedAt), gte(aiConversations.updatedAt, new Date(Date.now() - 30 * 86_400_000)))).orderBy(desc(aiConversations.updatedAt)).limit(10);
    return { items: rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })) };
  });
  void inArray;
};
