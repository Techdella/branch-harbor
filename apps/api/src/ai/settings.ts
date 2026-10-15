import { and, eq, sql } from 'drizzle-orm';
import { aiMonthlyAllowance, aiOrgSettings as parseSettings, aiUsageState, creditsFor, redactPii, usageMonth, type AiOrgSettings, type AiUsage, type AiUsageState } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { aiOrgSettings, aiToolCalls, aiUsage, organizations } from '../db/schema/index.ts';
import { billableLocations, loadSub, subPlan } from '../services/billing.ts';

export async function loadAiSettings(db: Exec, orgId: string): Promise<AiOrgSettings> {
  const [r] = await db.select().from(aiOrgSettings).where(eq(aiOrgSettings.organizationId, orgId));
  return parseSettings(r?.settings);
}

export async function saveAiSettings(db: Exec, orgId: string, patch: Partial<AiOrgSettings>, userId: string): Promise<AiOrgSettings> {
  const next = parseSettings({ ...(await loadAiSettings(db, orgId)), ...patch });
  await db.insert(aiOrgSettings).values({ organizationId: orgId, settings: next as unknown as Record<string, unknown>, updatedBy: userId })
    .onConflictDoUpdate({ target: aiOrgSettings.organizationId, set: { settings: next as unknown as Record<string, unknown>, updatedBy: userId, updatedAt: new Date() } });
  return next;
}

/* ------------------------------------------------------------------ */
/* Metering                                                            */
/* ------------------------------------------------------------------ */

export async function monthlyAllowance(db: Exec, orgId: string): Promise<number> {
  const [o] = await db.select({ model: organizations.model }).from(organizations).where(eq(organizations.id, orgId));
  const sub = await loadSub(db, orgId).catch(() => null);
  const plan = sub ? subPlan(sub, o?.model ?? 'network') : o?.model === 'independent' ? 'solo' : 'network';
  return aiMonthlyAllowance(plan, (await billableLocations(db, orgId)).length);
}

export interface UsageView {
  month: string;
  credits: number;
  allowance: number;
  fairUseLimit: number;
  state: AiUsageState;
  requests: number;
  byFeature: Array<{ feature: string; credits: number; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
}

export async function usageView(s: Services, orgId: string, month = usageMonth()): Promise<UsageView> {
  const rows = await s.db.select().from(aiUsage).where(and(eq(aiUsage.organizationId, orgId), eq(aiUsage.month, month)));
  const credits = Math.round(rows.reduce((a, r) => a + r.credits, 0) * 100) / 100;
  const allowance = await monthlyAllowance(s.db, orgId);
  return {
    month, credits, allowance, fairUseLimit: allowance * s.cfg.MARINA_FAIR_USE_MULTIPLIER,
    state: aiUsageState(credits, allowance, s.cfg.MARINA_FAIR_USE_MULTIPLIER),
    requests: rows.reduce((a, r) => a + r.requests, 0),
    byFeature: rows.map((r) => ({ feature: r.feature, credits: Math.round(r.credits * 100) / 100, requests: r.requests, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens })).sort((a, b) => b.credits - a.credits),
  };
}

/** Adds one model call to the organisation's monthly usage. Returns the credits it cost. */
export async function recordUsage(db: Exec, orgId: string, feature: string, model: string, u: AiUsage): Promise<number> {
  const credits = creditsFor(model, u);
  const month = usageMonth();
  await db.insert(aiUsage).values({
    organizationId: orgId, month, feature, requests: 1, inputTokens: u.inputTokens, outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens ?? 0, cacheWriteTokens: u.cacheWriteTokens ?? 0, credits,
  }).onConflictDoUpdate({
    target: [aiUsage.organizationId, aiUsage.month, aiUsage.feature],
    set: {
      requests: sql`${aiUsage.requests} + 1`,
      inputTokens: sql`${aiUsage.inputTokens} + ${u.inputTokens}`,
      outputTokens: sql`${aiUsage.outputTokens} + ${u.outputTokens}`,
      cacheReadTokens: sql`${aiUsage.cacheReadTokens} + ${u.cacheReadTokens ?? 0}`,
      cacheWriteTokens: sql`${aiUsage.cacheWriteTokens} + ${u.cacheWriteTokens ?? 0}`,
      credits: sql`${aiUsage.credits} + ${credits}`,
      updatedAt: new Date(),
    },
  });
  return credits;
}

/* ------------------------------------------------------------------ */
/* Tool-call audit log                                                 */
/* ------------------------------------------------------------------ */

/** Masks personal data in a tool input before it is logged (free text is masked, ids and dates kept). */
export function minimiseInput(input: unknown): Record<string, unknown> {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 4) return '[…]';
    if (typeof v === 'string') return redactPii(v.length > 500 ? `${v.slice(0, 500)}…` : v);
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /email|phone|password|token|secret/i.test(k) ? '[redacted]' : walk(x, depth + 1)]));
    return v;
  };
  const out = walk(input ?? {}, 0);
  return out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : { value: out };
}

export async function logToolCall(db: Exec, e: {
  organizationId: string; userId: string | null; conversationId?: string | null; actionId?: string | null; tool: string; kind: 'read' | 'write';
  status: string; input?: unknown; summary?: string | null; untrusted?: boolean; durationMs?: number | null;
}) {
  await db.insert(aiToolCalls).values({
    organizationId: e.organizationId, userId: e.userId, conversationId: e.conversationId ?? null, actionId: e.actionId ?? null, tool: e.tool, kind: e.kind,
    status: e.status, input: minimiseInput(e.input), summary: e.summary ? redactPii(e.summary).slice(0, 500) : null, untrusted: !!e.untrusted, durationMs: e.durationMs ?? null,
  });
}
