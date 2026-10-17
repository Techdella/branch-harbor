import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  ASSISTANT_NAME, isLegalTopic, type AiActionCard, type AiActionRisk, type AiBlock, type AiCitation, type MarinaStreamEvent,
} from '@bh/shared';
import type { Services } from '../context.ts';
import { aiConversations, aiMessages, aiProposedActions, networkNotifications } from '../db/schema/index.ts';
import { AppError, forbidden, notFound } from '../lib/errors.ts';
import { audit } from '../services/audit.ts';
import { loadOrgAssignments } from '../services/authz.ts';
import { capabilitiesOf } from '../domain/scope.ts';
import { buildAssistantContext, type AssistantContext } from './context.ts';
import type { LlmMessage } from './llm.ts';
import { compact } from './present.ts';
import { ASSISTANT_SYSTEM, assistantContext } from './prompts.ts';
import { loadTools, toLlmTools, toolsFor } from './registry.ts';
import { sandboxPhrases } from './sandbox.ts';
import { loadAiSettings, logToolCall, recordUsage, usageView } from './settings.ts';
import { ToolError, type MarinaTool, type WriteTool } from './types.ts';

export type Emit = (e: MarinaStreamEvent) => void;

export interface Screen {
  path?: string | null;
  title?: string | null;
  recordType?: string | null;
  recordId?: string | null;
}

export interface TurnInput {
  conversationId?: string | null;
  text: string;
  screen?: Screen | null;
  channel?: 'web' | 'mobile' | 'api' | 'seed';
}

export interface TurnResult {
  conversationId: string;
  messageId: string;
  text: string;
  blocks: AiBlock[];
  citations: AiCitation[];
  actions: AiActionCard[];
  navigate: { path: string; label: string } | null;
  notices: Array<{ code: string; message: string }>;
  credits: number;
}

const MAX_STEPS = 8;
const MAX_USER_TURNS = 40;
const MAX_TOOL_RESULT_CHARS = 24_000;

/** Throws when the person may not use the assistant here (organisation switch, access, fair use). */
export async function assertAssistantAvailable(s: Services, ctx: AssistantContext) {
  if (!ctx.can('ai.assistant', 'view')) throw forbidden(`${ASSISTANT_NAME} is not part of your access`);
  const settings = await loadAiSettings(s.db, ctx.orgId);
  if (!settings.enabled) throw new AppError(403, 'ai_disabled', `${ASSISTANT_NAME} is switched off for this organisation. An AI admin at head office can switch her back on in Settings.`);
  const usage = await usageView(s, ctx.orgId);
  if (usage.state === 'paused') throw new AppError(429, 'ai_credit_limit', `${ASSISTANT_NAME} has reached this month’s fair-use limit for your organisation. She is back when the allowance resets at the start of next month; everything else keeps working.`);
  return { settings, usage };
}

/** Escapes anything that could close the untrusted wrapper early. */
const neutralise = (s: string) => s.replace(/<\/?\s*untrusted_data[^>]*>/gi, '[tag removed]');

export function actionCard(row: typeof aiProposedActions.$inferSelect): AiActionCard {
  return {
    id: row.id, tool: row.kind, title: row.title ?? row.summary, summary: row.summary, details: row.details ?? [], risk: row.risk as AiActionRisk,
    status: row.status as AiActionCard['status'], fromUntrustedContent: row.fromUntrusted, editable: (row.editable ?? []) as AiActionCard['editable'],
    payload: row.payload, result: row.result ?? null, link: row.link ?? null,
  };
}

interface TurnState {
  untrusted: boolean;
  blocks: AiBlock[];
  citations: AiCitation[];
  actionIds: string[];
  navigate: { path: string; label: string } | null;
}

async function runTool(s: Services, ctx: AssistantContext, conversationId: string | null, tool: MarinaTool | undefined, name: string, rawInput: unknown, st: TurnState, emit: Emit, source = 'chat') {
  if (!tool) return { content: JSON.stringify({ error: `Unknown tool ${name}` }), isError: true };
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    await logToolCall(s.db, { organizationId: ctx.orgId, userId: ctx.user.id, conversationId, tool: name, kind: tool.kind, status: 'error', input: rawInput, summary: 'invalid input' });
    return { content: JSON.stringify({ error: 'INVALID_INPUT', issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) }), isError: true };
  }
  const input = parsed.data;
  const t0 = Date.now();
  if (tool.kind === 'read') {
    emit({ type: 'tool', name, status: 'running', label: name });
    try {
      const result = await tool.run(ctx, input);
      const pres = tool.present?.(result, input, ctx) ?? {};
      for (const b of pres.blocks ?? []) {
        st.blocks.push(b);
        emit({ type: 'block', block: b });
      }
      if (pres.citations?.length) {
        st.citations.push(...pres.citations);
        emit({ type: 'citations', citations: pres.citations });
      }
      if (pres.navigate) {
        st.navigate = pres.navigate;
        emit({ type: 'navigate', ...pres.navigate });
      }
      if (tool.untrustedOutput) st.untrusted = true;
      emit({ type: 'tool', name, status: 'done', label: name });
      await logToolCall(s.db, { organizationId: ctx.orgId, userId: ctx.user.id, conversationId, tool: name, kind: 'read', status: 'ok', input, summary: pres.summary ?? null, untrusted: tool.untrustedOutput, durationMs: Date.now() - t0 });
      const data = JSON.stringify(compact(result));
      const payload = tool.untrustedOutput
        ? { summary: pres.summary, untrusted: true, data: `<untrusted_data source="${name}">${neutralise(data)}</untrusted_data>` }
        : { summary: pres.summary, data: JSON.parse(data) };
      let content = JSON.stringify(payload);
      if (content.length > MAX_TOOL_RESULT_CHARS) content = JSON.stringify({ summary: pres.summary, note: 'Result truncated; ask for a narrower question.', data: content.slice(0, MAX_TOOL_RESULT_CHARS) });
      return { content, isError: false };
    } catch (err) {
      const e = err instanceof ToolError ? err : err instanceof AppError ? new ToolError(err.code, err.message, err.status) : new ToolError('error', 'The tool failed', 500);
      if (!(err instanceof ToolError) && !(err instanceof AppError)) s.log.error({ err, tool: name }, '[ai] tool failed');
      const denied = e.status === 403 || e.status === 404;
      emit({ type: 'tool', name, status: denied ? 'denied' : 'error', label: name });
      await logToolCall(s.db, { organizationId: ctx.orgId, userId: ctx.user.id, conversationId, tool: name, kind: 'read', status: denied ? 'denied' : 'error', input, summary: e.message, durationMs: Date.now() - t0 });
      return { content: JSON.stringify(denied ? { denied: e.message } : { error: e.message }), isError: !denied };
    }
  }
  // Write tool: never executes here. Check access, prepare the card.
  const w = tool as WriteTool;
  const action = w.action ?? 'edit';
  if (!ctx.can('ai.assistant', 'edit') || (w.modules && !w.modules.some((m) => ctx.can(m, action)))) {
    emit({ type: 'tool', name, status: 'denied', label: name });
    await logToolCall(s.db, { organizationId: ctx.orgId, userId: ctx.user.id, conversationId, tool: name, kind: 'write', status: 'denied', input, untrusted: st.untrusted });
    return { content: JSON.stringify({ denied: 'The person does not have access to make this change.' }), isError: false };
  }
  try {
    const p = await w.preview(ctx, input);
    const risk = typeof w.risk === 'function' ? w.risk(input) : w.risk;
    const [row] = await s.db.insert(aiProposedActions).values({
      organizationId: ctx.orgId, conversationId, userId: ctx.user.id, kind: name, title: p.title, summary: p.summary, details: p.details ?? [], editable: p.editable ?? [],
      risk, fromUntrusted: st.untrusted, source, link: p.link ?? null, payload: input as Record<string, unknown>, scopeKind: 'organization', scopeId: ctx.orgId,
    }).returning();
    st.actionIds.push(row!.id);
    emit({ type: 'action', action: actionCard(row!) });
    await logToolCall(s.db, { organizationId: ctx.orgId, userId: ctx.user.id, conversationId, actionId: row!.id, tool: name, kind: 'write', status: 'proposed', input, summary: p.title, untrusted: st.untrusted, durationMs: Date.now() - t0 });
    return { content: JSON.stringify({ status: 'awaiting_confirmation', actionId: row!.id, summary: p.title, note: 'Not executed. The person must confirm the card in the app.' }), isError: false };
  } catch (err) {
    const e = err instanceof ToolError ? err : err instanceof AppError ? new ToolError(err.code, err.message, err.status) : new ToolError('error', (err as Error).message, 500);
    await logToolCall(s.db, { organizationId: ctx.orgId, userId: ctx.user.id, conversationId, tool: name, kind: 'write', status: 'error', input, summary: e.message, untrusted: st.untrusted });
    return { content: JSON.stringify(e.status === 403 ? { denied: e.message } : { error: e.message }), isError: e.status !== 403 };
  }
}

/** Builds the display transcript (user questions and assistant answers with their blocks) from stored messages. */
export function transcript(rows: Array<typeof aiMessages.$inferSelect>) {
  const turns: Array<{ id: string; role: 'user' | 'assistant'; text: string; blocks: unknown[]; citations: unknown[]; meta: Record<string, unknown>; createdAt: string }> = [];
  for (const m of rows) {
    const content = Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string }>) : [];
    if (m.role === 'user') {
      const texts = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').filter((t) => !t.startsWith('<screen'));
      if (texts.length) turns.push({ id: m.id, role: 'user', text: texts.join('\n'), blocks: [], citations: [], meta: {}, createdAt: m.createdAt.toISOString() });
      continue;
    }
    const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim();
    const last = turns[turns.length - 1];
    if (last?.role === 'assistant') {
      last.text = [last.text, text].filter(Boolean).join('\n\n');
      last.blocks.push(...(m.blocks ?? []));
      last.citations.push(...(m.citations ?? []));
      last.meta = { ...last.meta, ...m.meta };
    } else turns.push({ id: m.id, role: 'assistant', text, blocks: [...(m.blocks ?? [])], citations: [...(m.citations ?? [])], meta: { ...m.meta }, createdAt: m.createdAt.toISOString() });
  }
  return turns;
}

/**
 * One assistant turn: the agent loop with streaming. Read tools run as the person; write tools become action cards.
 */
export async function runTurn(s: Services, ctx: AssistantContext, input: TurnInput, emit: Emit): Promise<TurnResult> {
  const { settings, usage } = await assertAssistantAvailable(s, ctx);
  let conv: typeof aiConversations.$inferSelect | undefined;
  if (input.conversationId) {
    [conv] = await s.db.select().from(aiConversations).where(and(eq(aiConversations.id, input.conversationId), eq(aiConversations.organizationId, ctx.orgId), eq(aiConversations.userId, ctx.user.id), isNull(aiConversations.archivedAt)));
    if (!conv) throw notFound('Conversation');
  } else {
    [conv] = await s.db.insert(aiConversations).values({
      organizationId: ctx.orgId, userId: ctx.user.id, scopeKind: 'organization', scopeId: ctx.orgId, title: input.text.slice(0, 80), channel: input.channel ?? 'web',
      context: input.screen ? { ...input.screen } : {},
    }).returning();
  }
  const history = await s.db.select().from(aiMessages).where(eq(aiMessages.conversationId, conv!.id)).orderBy(asc(aiMessages.createdAt));
  const userTurns = history.filter((m) => m.role === 'user' && Array.isArray(m.content) && (m.content as Array<{ type: string }>).some((b) => b.type === 'text')).length;
  if (userTurns >= MAX_USER_TURNS) throw new AppError(409, 'conversation_full', 'This conversation is long. Start a new one to keep answers fast.');

  const messages: LlmMessage[] = history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as LlmMessage['content'] }));
  const screen = input.screen?.path ? `<screen path="${String(input.screen.path).replace(/"/g, '')}"${input.screen.recordType ? ` record="${String(input.screen.recordType).replace(/"/g, '')}:${String(input.screen.recordId ?? '').replace(/"/g, '')}"` : ''}${input.screen.title ? ` title="${String(input.screen.title).replace(/"/g, '').slice(0, 80)}"` : ''} />` : null;
  const userContent = [...(screen ? [{ type: 'text' as const, text: screen }] : []), { type: 'text' as const, text: input.text }];
  messages.push({ role: 'user', content: userContent });
  await s.db.insert(aiMessages).values({ organizationId: ctx.orgId, conversationId: conv!.id, role: 'user', content: userContent });

  const tools = await toolsFor(ctx, settings);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const llmTools = toLlmTools(tools);
  const context = assistantContext(ctx);
  const st: TurnState = { untrusted: false, blocks: [], citations: [], actionIds: [], navigate: null };
  let credits = 0;
  let text = '';
  let lastAssistantId: string | null = null;
  emit({ type: 'start', conversationId: conv!.id, messageId: '' });

  for (let step = 0; step < MAX_STEPS; step++) {
    let res;
    try {
      res = await s.marina.call({ tier: 'main', system: ASSISTANT_SYSTEM, context, tools: llmTools, messages, locale: ctx.locale, onText: (d) => { text += d; emit({ type: 'text', delta: d }); } });
    } catch (err) {
      s.log.error({ err }, '[ai] model call failed');
      throw new AppError(503, 'ai_unavailable', `${ASSISTANT_NAME} could not respond right now. Please try again; everything else keeps working.`);
    }
    credits += await recordUsage(s.db, ctx.orgId, 'chat', res.model, res.usage);
    const [row] = await s.db.insert(aiMessages).values({
      organizationId: ctx.orgId, conversationId: conv!.id, role: 'assistant', content: res.content, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens ?? 0, cacheWriteTokens: res.usage.cacheWriteTokens ?? 0, model: res.model,
    }).returning({ id: aiMessages.id });
    lastAssistantId = row!.id;
    messages.push({ role: 'assistant', content: res.content as LlmMessage['content'] });
    if (text && !text.endsWith('\n')) {
      text += '\n\n';
      emit({ type: 'text', delta: '\n\n' });
    }
    if (res.stopReason === 'refusal') {
      const t = 'I can’t help with that request.';
      text += t;
      emit({ type: 'text', delta: t });
      break;
    }
    if (res.stopReason === 'pause_turn') continue;
    const uses = res.content.filter((b) => b.type === 'tool_use') as Array<{ id: string; name: string; input: unknown }>;
    if (!uses.length || res.stopReason !== 'tool_use') break;
    const results: LlmMessage['content'] = [];
    for (const u of uses) {
      const r = await runTool(s, ctx, conv!.id, byName.get(u.name), u.name, u.input, st, emit);
      (results as unknown[]).push({ type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
    await s.db.insert(aiMessages).values({ organizationId: ctx.orgId, conversationId: conv!.id, role: 'user', content: results });
  }

  const notices: Array<{ code: 'not_legal_advice' | 'over_allowance' | 'sandbox' | 'untrusted_content'; message: string }> = [];
  if (isLegalTopic(input.text) || (s.marina.mode === 'live' && isLegalTopic(text))) notices.push({ code: 'not_legal_advice', message: 'This is general information from your records, not legal advice. Check with your franchise counsel.' });
  if (st.untrusted && st.actionIds.length) notices.push({ code: 'untrusted_content', message: 'Some of this came from messages, reviews or documents written by other people. Check the prepared action before confirming.' });
  if (usage.state === 'over_allowance') notices.push({ code: 'over_allowance', message: 'Your organisation is above this month’s included AI credits (fair use applies).' });
  if (s.marina.mode === 'sandbox') notices.push({ code: 'sandbox', message: 'Sandbox mode: answers come from your data with fixed wording.' });
  for (const n of notices) emit({ type: 'notice', code: n.code, message: n.message });

  if (lastAssistantId) {
    await s.db.update(aiMessages).set({ blocks: st.blocks, citations: st.citations, meta: { actionIds: st.actionIds, navigate: st.navigate, notices, sandbox: s.marina.mode === 'sandbox' } }).where(eq(aiMessages.id, lastAssistantId));
  }
  await s.db.update(aiConversations).set({ updatedAt: new Date() }).where(eq(aiConversations.id, conv!.id));
  const actions = st.actionIds.length ? (await s.db.select().from(aiProposedActions).where(inArray(aiProposedActions.id, st.actionIds))).map(actionCard) : [];
  const after = await usageView(s, ctx.orgId);
  emit({ type: 'done', usage: { credits: Math.round(credits * 100) / 100, state: after.state }, text: text.trim() });
  return { conversationId: conv!.id, messageId: lastAssistantId ?? '', text: text.trim() || sandboxPhrases(ctx.locale).none, blocks: st.blocks, citations: st.citations, actions, navigate: st.navigate, notices, credits };
}

/* ------------------------------------------------------------------ */
/* Action cards: confirm, approve, cancel                              */
/* ------------------------------------------------------------------ */

async function loadAction(s: Services, orgId: string, id: string) {
  const [a] = await s.db.select().from(aiProposedActions).where(and(eq(aiProposedActions.id, id), eq(aiProposedActions.organizationId, orgId)));
  if (!a) throw notFound('Action');
  return a;
}

async function execute(s: Services, ctx: AssistantContext, a: typeof aiProposedActions.$inferSelect, tool: WriteTool, decidedBy: string, approvedBy: string | null) {
  const t0 = Date.now();
  let status: 'executed' | 'failed' = 'executed';
  let result: Record<string, unknown>;
  let link = a.link;
  try {
    const out = await tool.execute(ctx, a.payload);
    result = out.result;
    link = out.link ?? a.link;
  } catch (err) {
    status = 'failed';
    result = { error: err instanceof ToolError || err instanceof AppError ? err.message : 'The action failed' };
    if (!(err instanceof ToolError) && !(err instanceof AppError)) s.log.error({ err, tool: a.kind }, '[ai] action failed');
  }
  const [u] = await s.db.update(aiProposedActions).set({ status, result, link, decidedBy, decidedAt: new Date(), approvedBy, confirmedAt: a.confirmedAt ?? new Date() }).where(eq(aiProposedActions.id, a.id)).returning();
  await logToolCall(s.db, { organizationId: a.organizationId, userId: decidedBy, conversationId: a.conversationId, actionId: a.id, tool: a.kind, kind: 'write', status, input: a.payload, summary: status === 'failed' ? String(result.error) : a.title, untrusted: a.fromUntrusted, durationMs: Date.now() - t0 });
  await audit(s.db, { organizationId: a.organizationId, actorUserId: decidedBy, action: `ai_action.${status}`, targetType: 'ai_proposed_action', targetId: a.id, metadata: { tool: a.kind, risk: a.risk, proposedBy: a.userId, approvedBy, fromUntrusted: a.fromUntrusted } });
  return u!;
}

/** The person confirms their own card (optionally with edited inputs). */
export async function confirmAction(s: Services, ctx: AssistantContext, id: string, edits: Record<string, unknown> = {}) {
  const a = await loadAction(s, ctx.orgId, id);
  if (a.userId !== ctx.user.id) throw notFound('Action');
  if (a.status !== 'proposed') throw new AppError(409, 'already_decided', `This action is already ${a.status.replace('_', ' ')}`);
  const tools = await loadTools();
  const tool = tools.get(a.kind);
  if (!tool || tool.kind !== 'write') throw new AppError(409, 'unsupported_action', 'This action can no longer be confirmed here');
  const editableKeys = new Set((a.editable ?? []).map((e) => e.key));
  const merged = { ...a.payload, ...Object.fromEntries(Object.entries(edits).filter(([k]) => editableKeys.has(k))) };
  const parsed = tool.input.safeParse(merged);
  if (!parsed.success) throw new AppError(400, 'validation_failed', 'Some fields need attention', Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])));
  const settings = await loadAiSettings(s.db, ctx.orgId);
  if (!settings.enabled) throw new AppError(403, 'ai_disabled', `${ASSISTANT_NAME} is switched off for this organisation. An AI admin at head office can switch her back on in Settings.`);
  const [row] = await s.db.update(aiProposedActions).set({ payload: parsed.data as Record<string, unknown>, confirmedAt: new Date() }).where(eq(aiProposedActions.id, a.id)).returning();
  if (settings.approvalRequiredFor.includes(a.risk as AiActionRisk) && !ctx.can('ai.assistant', 'publish')) {
    const [held] = await s.db.update(aiProposedActions).set({ status: 'pending_approval' }).where(eq(aiProposedActions.id, a.id)).returning();
    await logToolCall(s.db, { organizationId: ctx.orgId, userId: ctx.user.id, conversationId: a.conversationId, actionId: a.id, tool: a.kind, kind: 'write', status: 'pending_approval', input: parsed.data, summary: a.title });
    // Tell the approvers (organisation-wide ai.assistant:publish).
    const byUser = await loadOrgAssignments(s.db, ctx.orgId);
    const approvers = [...byUser.entries()].filter(([uid, as]) => uid !== ctx.user.id && as.some((x) => x.scopeKind === 'organization' && capabilitiesOf(x).has('ai.assistant:publish'))).map(([uid]) => uid);
    if (approvers.length) {
      await s.db.insert(networkNotifications).values(approvers.map((userId) => ({ organizationId: ctx.orgId, userId, kind: 'marina_approval', title: `${ASSISTANT_NAME}: approval needed`, body: `${ctx.user.name}: ${a.title ?? a.summary}`, link: `/marina?action=${a.id}`, data: { actionId: a.id } })));
    }
    return actionCard(held!);
  }
  return actionCard(await execute(s, ctx, row!, tool, ctx.user.id, null));
}

/** An HQ approver decides a held action. Approved actions run as the person who proposed them. */
export async function decideHeldAction(s: Services, approver: AssistantContext, id: string, decision: 'approve' | 'reject') {
  if (!approver.can('ai.assistant', 'publish') || !approver.hq) throw forbidden(`Approving ${ASSISTANT_NAME} actions needs organisation-wide AI admin access`);
  const a = await loadAction(s, approver.orgId, id);
  if (a.status !== 'pending_approval') throw new AppError(409, 'already_decided', `This action is ${a.status.replace('_', ' ')}`);
  if (decision === 'reject') {
    const [u] = await s.db.update(aiProposedActions).set({ status: 'rejected', decidedBy: approver.user.id, decidedAt: new Date() }).where(eq(aiProposedActions.id, a.id)).returning();
    await logToolCall(s.db, { organizationId: a.organizationId, userId: approver.user.id, actionId: a.id, tool: a.kind, kind: 'write', status: 'rejected', input: a.payload });
    return actionCard(u!);
  }
  const tool = (await loadTools()).get(a.kind);
  if (!tool || tool.kind !== 'write') throw new AppError(409, 'unsupported_action', 'This action can no longer be run');
  const proposer = await buildAssistantContext(s, a.organizationId, a.userId);
  return actionCard(await execute(s, proposer, a, tool, approver.user.id, approver.user.id));
}

export async function cancelAction(s: Services, ctx: AssistantContext, id: string) {
  const a = await loadAction(s, ctx.orgId, id);
  if (a.userId !== ctx.user.id) throw notFound('Action');
  if (a.status !== 'proposed' && a.status !== 'pending_approval') throw new AppError(409, 'already_decided', `This action is already ${a.status.replace('_', ' ')}`);
  const [u] = await s.db.update(aiProposedActions).set({ status: 'cancelled', decidedBy: ctx.user.id, decidedAt: new Date() }).where(eq(aiProposedActions.id, a.id)).returning();
  await logToolCall(s.db, { organizationId: a.organizationId, userId: ctx.user.id, conversationId: a.conversationId, actionId: a.id, tool: a.kind, kind: 'write', status: 'cancelled', input: a.payload });
  return actionCard(u!);
}

/**
 * Proposes an action outside a conversation (insight suggestions, setup assistant, course builder): the same access
 * checks and card as in chat.
 */
export async function proposeAction(s: Services, ctx: AssistantContext, toolName: string, input: unknown, source: string, opts: { untrusted?: boolean } = {}): Promise<AiActionCard> {
  const tool = (await loadTools()).get(toolName);
  if (!tool || tool.kind !== 'write') throw new AppError(400, 'unsupported_action', 'Unknown action');
  const settings = await loadAiSettings(s.db, ctx.orgId);
  if (!settings.enabled) throw new AppError(403, 'ai_disabled', `${ASSISTANT_NAME} is switched off for this organisation. An AI admin at head office can switch her back on in Settings.`);
  const st: TurnState = { untrusted: !!opts.untrusted, blocks: [], citations: [], actionIds: [], navigate: null };
  const r = await runTool(s, ctx, null, tool, toolName, input, st, () => {}, source);
  if (!st.actionIds.length) {
    const j = JSON.parse(r.content) as { denied?: string; error?: string };
    throw new AppError(j.denied ? 403 : 400, j.denied ? 'forbidden' : 'action_failed', j.denied ?? j.error ?? 'Could not prepare the action');
  }
  const [row] = await s.db.select().from(aiProposedActions).where(eq(aiProposedActions.id, st.actionIds[0]!));
  return actionCard(row!);
}

/** Pending actions for the person (and held actions for approvers). */
export async function listActions(s: Services, ctx: AssistantContext) {
  const mine = await s.db.select().from(aiProposedActions).where(and(eq(aiProposedActions.organizationId, ctx.orgId), eq(aiProposedActions.userId, ctx.user.id), inArray(aiProposedActions.status, ['proposed', 'pending_approval']))).orderBy(desc(aiProposedActions.createdAt)).limit(50);
  const held = ctx.hq && ctx.can('ai.assistant', 'publish')
    ? await s.db.select().from(aiProposedActions).where(and(eq(aiProposedActions.organizationId, ctx.orgId), eq(aiProposedActions.status, 'pending_approval'))).orderBy(desc(aiProposedActions.createdAt)).limit(50)
    : [];
  return { mine: mine.map(actionCard), toApprove: held.filter((h) => h.userId !== ctx.user.id).map(actionCard) };
}
