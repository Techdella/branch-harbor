/**
 * The BranchHarbor AI assistant (docs/AI.md). Shared by the API, the web app, the mobile app and the marketing site.
 *
 * The assistant's name lives in ONE constant so it can be renamed: every piece of UI copy interpolates it
 * (`{name}` in message catalogues) instead of spelling it out.
 */

/** The assistant's display name. A marina is a harbour for boats; the word works in all our languages. */
export const ASSISTANT_NAME = 'Marina';

/** The access-model module that gates the assistant (see `AI_MODULES` in access.ts). */
export const AI_ASSISTANT_MODULE = 'ai.assistant';

/* ------------------------------------------------------------------ */
/* Credits and metering                                                */
/* ------------------------------------------------------------------ */

/** One AI credit is worth US$0.01 of model usage at list price. */
export const AI_CREDIT_USD = 0.01;

/** List prices per million tokens (USD) used to turn tokens into credits. Unknown models use the most expensive row. */
export const AI_MODEL_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  sandbox: { input: 0, output: 0 },
};
const FALLBACK_PRICE = { input: 5, output: 25 };

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Credits for one model call. Cache reads cost 0.1x input, cache writes 1.25x input. Sandbox runs are free. */
export function creditsFor(model: string, u: AiUsage): number {
  const p = AI_MODEL_PRICES[model] ?? Object.entries(AI_MODEL_PRICES).find(([k]) => model.startsWith(k))?.[1] ?? FALLBACK_PRICE;
  const usd = (u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheReadTokens ?? 0) * p.input * 0.1 + (u.cacheWriteTokens ?? 0) * p.input * 1.25) / 1_000_000;
  return Math.round((usd / AI_CREDIT_USD) * 100) / 100;
}

/** Fair-use ceiling as a multiple of the plan allowance: above the allowance a warning, above this the assistant pauses. */
export const AI_FAIR_USE_MULTIPLIER = 2;

export type AiUsageState = 'ok' | 'over_allowance' | 'paused';

export function aiUsageState(usedCredits: number, allowance: number, fairUseMultiplier = AI_FAIR_USE_MULTIPLIER): AiUsageState {
  if (usedCredits >= allowance * fairUseMultiplier) return 'paused';
  if (usedCredits >= allowance) return 'over_allowance';
  return 'ok';
}

/** `YYYY-MM` metering month (UTC). */
export function usageMonth(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/* ------------------------------------------------------------------ */
/* Organisation controls                                               */
/* ------------------------------------------------------------------ */

/**
 * Risk categories of write actions. Every write is shown as an action card the person confirms; the organisation may
 * additionally require an HQ approver (someone with `ai.assistant:publish`) for some categories.
 */
export const AI_ACTION_RISKS = ['change', 'bulk', 'outbound', 'publish', 'money', 'delete'] as const;
export type AiActionRisk = (typeof AI_ACTION_RISKS)[number];

/** Areas the organisation can switch the assistant's tools on or off for (workspace areas). */
export const AI_TOOL_AREAS = ['network', 'operations', 'sales', 'marketing', 'finance', 'legal', 'training', 'community', 'knowledge', 'general'] as const;
export type AiToolArea = (typeof AI_TOOL_AREAS)[number];

export interface AiGuardrails {
  /** Phrases the brand must never claim ("guaranteed results", "cures"). Case-insensitive. */
  bannedClaims: string[];
  /** Text that must appear in generated marketing copy (e.g. "Results vary."). */
  requiredDisclaimers: string[];
}

export interface AiBrandVoice {
  /** e.g. "warm, encouraging, plain-spoken". */
  tone: string;
  /** Words and phrases the brand likes to use. */
  preferredWords: string[];
  /** Words the brand avoids. */
  avoidWords: string[];
  /** Short approved examples the profile was learned from. */
  examples: string[];
  learnedAt: string | null;
  learnedFrom: number;
}

export interface AiOrgSettings {
  enabled: boolean;
  /** null = every area. */
  allowedAreas: AiToolArea[] | null;
  /** Categories that need an HQ approver after the person confirms. */
  approvalRequiredFor: AiActionRisk[];
  /** Conversations and tool logs older than this are deleted (days). */
  retentionDays: number;
  /** Help desk: post a suggested answer automatically when the knowledge base gives a confident match (HQ opt-in). */
  helpdeskAutoAnswer: boolean;
  /** Help desk: also mark auto-answered tickets as waiting on the requester. */
  helpdeskAutoResolve: boolean;
  guardrails: AiGuardrails;
  brandVoice: AiBrandVoice;
  /** Locales generated content is translated into (defaults to the organisation's site locales). */
  contentLocales: string[];
}

export const DEFAULT_AI_ORG_SETTINGS: AiOrgSettings = {
  enabled: true,
  allowedAreas: null,
  approvalRequiredFor: [],
  retentionDays: 365,
  helpdeskAutoAnswer: false,
  helpdeskAutoResolve: false,
  guardrails: { bannedClaims: [], requiredDisclaimers: [] },
  brandVoice: { tone: '', preferredWords: [], avoidWords: [], examples: [], learnedAt: null, learnedFrom: 0 },
  contentLocales: [],
};

export function aiOrgSettings(raw: unknown): AiOrgSettings {
  const r = (raw ?? {}) as Partial<AiOrgSettings>;
  return {
    ...DEFAULT_AI_ORG_SETTINGS,
    ...r,
    guardrails: { ...DEFAULT_AI_ORG_SETTINGS.guardrails, ...(r.guardrails ?? {}) },
    brandVoice: { ...DEFAULT_AI_ORG_SETTINGS.brandVoice, ...(r.brandVoice ?? {}) },
  };
}

/* ------------------------------------------------------------------ */
/* Guardrails                                                          */
/* ------------------------------------------------------------------ */

export interface GuardrailReport {
  /** Banned claims found in the text. */
  bannedFound: string[];
  /** Required disclaimers missing from the text. */
  missingDisclaimers: string[];
  ok: boolean;
}

const norm = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, ' ').trim();

export function checkGuardrails(text: string, g: AiGuardrails): GuardrailReport {
  const t = norm(text);
  const bannedFound = g.bannedClaims.filter((c) => c.trim() && t.includes(norm(c)));
  const missingDisclaimers = g.requiredDisclaimers.filter((d) => d.trim() && !t.includes(norm(d)));
  return { bannedFound, missingDisclaimers, ok: !bannedFound.length && !missingDisclaimers.length };
}

/** Removes sentences that contain a banned claim and appends missing disclaimers. */
export function applyGuardrails(text: string, g: AiGuardrails): { text: string; report: GuardrailReport } {
  const report = checkGuardrails(text, g);
  let out = text;
  if (report.bannedFound.length) {
    const parts = out.split(/(?<=[.!?])\s+/);
    out = parts.filter((p) => !report.bannedFound.some((c) => norm(p).includes(norm(c)))).join(' ');
  }
  for (const d of report.missingDisclaimers) out = `${out.trimEnd()}\n\n${d}`;
  return { text: out, report };
}

/* ------------------------------------------------------------------ */
/* Legal topics                                                        */
/* ------------------------------------------------------------------ */

const LEGAL_TERMS = [
  'franchise law', 'franchise disclosure', 'disclosure document', 'fdd', 'item 19', 'cooling-off', 'cooling off', 'waiting period', 'registration state',
  'franchise registration', 'franchise agreement', 'termination', 'non-compete', 'non compete', 'arthur wishart', 'franchising code', 'loi doubin',
  'wettbewerbsverbot', 'contrato de franquicia', 'contrat de franchise', 'franchisevertrag', 'lei de franquia', 'legal', 'lawsuit', 'liability',
];

/** True when a question or answer is about franchise law or contracts: answers carry a "not legal advice" note. */
export function isLegalTopic(text: string): boolean {
  const t = norm(text);
  return LEGAL_TERMS.some((w) => (w.length <= 3 ? new RegExp(`\\b${w}\\b`).test(t) : t.includes(w)));
}

/* ------------------------------------------------------------------ */
/* Conversation stream (SSE) and rich blocks                           */
/* ------------------------------------------------------------------ */

export interface AiTableBlock {
  type: 'table';
  title: string;
  columns: Array<{ key: string; label: string; kind?: 'text' | 'number' | 'money' | 'percent' | 'date' | 'status' }>;
  rows: Array<Record<string, string | number | null>>;
  /** Money columns: the currency of each row (never summed across currencies). */
  currencyKey?: string;
  note?: string;
}

export interface AiChartBlock {
  type: 'chart';
  title: string;
  kind: 'bar' | 'line';
  /** One chart per currency when values are money. */
  currency?: string | null;
  unit?: 'money' | 'count' | 'percent' | 'rating';
  series: Array<{ name: string; points: Array<{ label: string; value: number | null }> }>;
}

export type AiBlock = AiTableBlock | AiChartBlock;

export interface AiCitation {
  id: string;
  title: string;
  /** App path or URL to open the source. */
  url: string | null;
  sourceType: string;
  snippet?: string;
}

export interface AiActionCard {
  id: string;
  tool: string;
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  risk: AiActionRisk;
  status: 'proposed' | 'pending_approval' | 'executed' | 'rejected' | 'failed' | 'cancelled';
  /** The proposal followed untrusted content (reviews, messages, documents): shown with a warning. */
  fromUntrustedContent: boolean;
  /** Editable inputs (the person may change them before confirming). */
  editable: Array<{ key: string; label: string; kind: 'text' | 'textarea' | 'date' | 'number' }>;
  payload: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  link?: string | null;
}

export type MarinaStreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string; status: 'running' | 'done' | 'error' | 'denied'; label: string }
  | { type: 'block'; block: AiBlock }
  | { type: 'action'; action: AiActionCard }
  | { type: 'citations'; citations: AiCitation[] }
  | { type: 'navigate'; path: string; label: string }
  | { type: 'notice'; code: 'not_legal_advice' | 'over_allowance' | 'sandbox' | 'untrusted_content'; message: string }
  | { type: 'done'; usage: { credits: number; state: AiUsageState }; text: string }
  | { type: 'error'; code: string; message: string };

/* ------------------------------------------------------------------ */
/* Briefings and insights                                              */
/* ------------------------------------------------------------------ */

export const BRIEFING_SECTIONS = ['overdue_actions', 'expiring_documents', 'reviews', 'kpis', 'leads', 'tickets', 'royalties', 'training'] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

export interface BriefingItem {
  section: BriefingSection;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  link: string | null;
  count?: number;
}

export const INSIGHT_KINDS = ['revenue_drop', 'activity_drop', 'royalty_overdue', 'rating_drop', 'audit_decline', 'churn_risk', 'compliance_gap'] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];

export interface InsightEvidence {
  label: string;
  value: string;
  /** Optional numbers behind the value (shown as a mini chart). */
  series?: Array<{ label: string; value: number | null }>;
}

export interface SuggestedAction {
  label: string;
  tool: string;
  input: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Lead scoring (explained, never a black box)                         */
/* ------------------------------------------------------------------ */

export interface ScoreFactor {
  key: string;
  label: string;
  points: number;
  max: number;
  reason: string;
}

export interface ExplainedScore {
  score: number;
  band: 'hot' | 'warm' | 'cool' | 'cold';
  factors: ScoreFactor[];
  nextBestAction: { label: string; reason: string; tool?: string; input?: Record<string, unknown> };
}

export function scoreBand(score: number): ExplainedScore['band'] {
  return score >= 75 ? 'hot' : score >= 50 ? 'warm' : score >= 25 ? 'cool' : 'cold';
}

/** Sums factor points into a 0–100 score (capped), keeping every factor visible. */
export function explainedScore(factors: ScoreFactor[], nextBestAction: ExplainedScore['nextBestAction']): ExplainedScore {
  const max = factors.reduce((a, f) => a + f.max, 0) || 1;
  const pts = factors.reduce((a, f) => a + Math.max(0, Math.min(f.max, f.points)), 0);
  const score = Math.round((pts / max) * 100);
  return { score, band: scoreBand(score), factors, nextBestAction };
}

/* ------------------------------------------------------------------ */
/* PII minimisation                                                    */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?\d[\d ().-]{7,}\d)/g;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;

/** Masks emails, phone numbers and card-like numbers (used before anything is written to logs). */
export function redactPii(text: string): string {
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(CARD_RE, (m) => (m.replace(/\D/g, '').length >= 13 ? '[number]' : m))
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 9 && !/^\d{4}-\d{2}-\d{2}/.test(m) ? '[phone]' : m));
}
