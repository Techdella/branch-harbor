'use client';

/**
 * Client for the AI assistant (`/v1/orgs/:orgId/ai/*`). The chat streams Server-Sent Events over a POST (fetch +
 * ReadableStream, so the bearer token and the app locale travel as headers). Everything the assistant shows comes from
 * the API, which runs every tool as the signed-in person.
 */
import type { AiActionCard, AiBlock, AiCitation, BriefingItem, InsightEvidence, MarinaStreamEvent, SuggestedAction } from '@bh/shared';
import { ApiError } from './errors';
import { API_URL, getAccessToken, http, refreshAccessToken } from './http/client';
import { brandHeaderFor } from './http/brands';
import { orgId } from './http/workspace';

export interface Screen { path: string; title?: string | null; recordType?: string | null; recordId?: string | null }

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  blocks: AiBlock[];
  citations: AiCitation[];
  actions: AiActionCard[];
  tools: Array<{ name: string; status: string }>;
  notices: Array<{ code: string; message: string }>;
  navigate?: { path: string; label: string } | null;
  pending?: boolean;
  error?: { code: string; message: string } | null;
}

export interface ConversationSummary { id: string; title: string | null; updatedAt: string }

export interface AssistantInfo {
  name: string;
  mode: 'live' | 'sandbox';
  enabled: boolean;
  usage: UsageView;
  can: { use: boolean; act: boolean; admin: boolean; export: boolean };
  tools: Array<{ name: string; kind: string; area: string }>;
}

export interface UsageView {
  month: string; credits: number; allowance: number; fairUseLimit: number; state: 'ok' | 'over_allowance' | 'paused'; requests: number;
  byFeature: Array<{ feature: string; credits: number; requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
}

export interface Briefing { id: string; date: string; summary: string | null; items: BriefingItem[]; createdAt: string; history: Array<{ id: string; date: string; summary: string | null }> }
export interface Insight { id: string; kind: string; severity: 'info' | 'warning' | 'critical'; title: string; explanation: string; evidence: InsightEvidence[]; suggestedActions: Array<SuggestedAction & { index: number }>; locationId: string | null; locationName: string | null; status: string; detectedAt: string; periodLabel: string | null }

const o = (path: string) => `/orgs/${orgId()}${path}`;

/** Streams one turn; calls `onEvent` for every event. Resolves when the stream ends. */
export async function streamChat(input: { message: string; conversationId?: string | null; screen?: Screen | null; locale: string; signal?: AbortSignal }, onEvent: (e: MarinaStreamEvent) => void): Promise<void> {
  const send = (token: string | null) => fetch(`${API_URL}/v1${o('/ai/chat')}`, {
    method: 'POST',
    credentials: 'include',
    signal: input.signal,
    // The brand filter (top-bar switcher) travels with the chat like with every other request, so answers cover that brand.
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Accept-Language': input.locale, ...brandHeaderFor(o('/ai/chat')), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ message: input.message, conversationId: input.conversationId ?? null, screen: input.screen ?? null, channel: 'web' }),
  });
  let token = getAccessToken() ?? (await refreshAccessToken(null));
  let res: Response;
  try {
    res = await send(token);
    if (res.status === 401) {
      token = await refreshAccessToken(token);
      res = await send(token);
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    throw new ApiError('network_error', 'The BranchHarbor service could not be reached.');
  }
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
    throw new ApiError(j?.error?.code ?? 'http_error', j?.error?.message ?? 'Request failed', res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) {
        try {
          onEvent(JSON.parse(data.slice(6)) as MarinaStreamEvent);
        } catch {
          /* ignore a malformed event */
        }
      }
    }
  }
}

interface ApiTurn { id: string; role: 'user' | 'assistant'; text: string; blocks: AiBlock[]; citations: AiCitation[]; meta: { actionIds?: string[]; navigate?: { path: string; label: string } | null; notices?: Array<{ code: string; message: string }> } }

export const marina = {
  info: () => http.get<AssistantInfo>(o('/ai/assistant')),
  conversations: () => http.get<{ items: ConversationSummary[] }>(o('/ai/conversations')).then((r) => r.items),
  async conversation(id: string): Promise<Turn[]> {
    const r = await http.get<{ turns: ApiTurn[]; actions: AiActionCard[] }>(o(`/ai/conversations/${id}`));
    return r.turns.map((t) => ({
      id: t.id, role: t.role, text: t.text, blocks: t.blocks ?? [], citations: t.citations ?? [], tools: [],
      actions: (t.meta?.actionIds ?? []).map((aid) => r.actions.find((a) => a.id === aid)).filter((a): a is AiActionCard => !!a),
      notices: t.meta?.notices ?? [], navigate: t.meta?.navigate ?? null,
    }));
  },
  archive: (id: string) => http.del(o(`/ai/conversations/${id}`)),
  confirm: (id: string, edits: Record<string, unknown> = {}) => http.post<AiActionCard>(o(`/ai/actions/${id}/confirm`), { edits }),
  cancel: (id: string) => http.post<AiActionCard>(o(`/ai/actions/${id}/cancel`)),
  decide: (id: string, decision: 'approve' | 'reject') => http.post<AiActionCard>(o(`/ai/actions/${id}/decision`), { decision }),
  actions: () => http.get<{ mine: AiActionCard[]; toApprove: AiActionCard[] }>(o('/ai/actions')),
  briefing: (refresh = false) => http.get<Briefing>(o('/ai/briefing'), { refresh: refresh || undefined }),
  prefs: () => http.get<{ briefingFrequency: 'off' | 'daily' | 'weekly'; briefingHour: number; briefingWeekday: number; briefingEmail: boolean; briefingInApp: boolean; sections: string[] }>(o('/ai/prefs')),
  savePrefs: (p: Record<string, unknown>) => http.put(o('/ai/prefs'), p),
  insights: () => http.get<{ items: Insight[] }>(o('/ai/insights')).then((r) => r.items),
  dismissInsight: (id: string) => http.post(o(`/ai/insights/${id}/dismiss`)),
  actOnInsight: (id: string, index: number) => http.post<AiActionCard>(o(`/ai/insights/${id}/actions/${index}`)),
  runInsights: () => http.post<{ detected: number }>(o('/ai/insights/run')),
  visitBrief: (location: string) => http.get<VisitBrief>(o('/ai/visit-brief'), { location }),
  generate: (b: { kind: string; brief: string; locale?: string }) => http.post<{ text: string; locale: string; guardrails: { bannedFound: string[]; missingDisclaimers: string[] }; sandbox: boolean }>(o('/ai/content/generate'), b),
  translate: (b: { text: string; targetLocales: string[]; sourceLocale?: string }) => http.post<{ sandbox: boolean; note?: string; translations: Array<{ locale: string; text: string; translated: boolean }> }>(o('/ai/content/translate'), b),
  learnVoice: () => http.post<{ learned: boolean; reason?: string; voice: Record<string, unknown> }>(o('/ai/brand-voice/learn')),
  settings: () => http.get<{ settings: OrgAiSettings; areas: string[]; risks: string[]; canEdit: boolean }>(o('/ai/settings')),
  saveSettings: (b: Partial<OrgAiSettings>) => http.put<{ settings: OrgAiSettings }>(o('/ai/settings'), b),
  usage: () => http.get<UsageView>(o('/ai/usage')),
  knowledge: () => http.get<{ items: Array<{ id: string; sourceType: string; title: string; chunkCount: number; status: string; error: string | null; updatedAt: string }>; canManage: boolean }>(o('/ai/knowledge')),
  syncKnowledge: () => http.post<{ sources: number; removed: number }>(o('/ai/knowledge/sync')),
  uploadKnowledge: (b: { fileName: string; mimeType: string; dataBase64: string; title?: string }) => http.post(o('/ai/knowledge/uploads'), b),
  deleteKnowledge: (id: string) => http.del(o(`/ai/knowledge/${id}`)),
  tasks: () => http.get<{ items: Array<{ id: string; title: string; dueAt: string | null; remindAt: string | null; link: string | null; status: string }> }>(o('/ai/tasks')).then((r) => r.items),
  completeTask: (id: string) => http.patch(o(`/ai/tasks/${id}`), { status: 'done' }),
  setup: (message: string) => http.post<{ plan: { summary: string; locations: Array<{ name: string; country: string; city: string }>; team: Array<{ role: string; count: number; why: string }>; theme: { id: string; why: string } | null; campaigns: Array<{ name: string; subject: string; brief: string }> }; actions: AiActionCard[] }>(o('/ai/setup'), { message }),
  extractDocument: (b: { fileName: string; mimeType: string; dataBase64: string }) => http.post<Record<string, string | number | null>>(o('/ai/documents/extract'), b),
  suggestTicket: (ticketId: string) => http.post<{ answer: string; confidence: string; citations: AiCitation[] }>(o(`/ai/helpdesk/tickets/${ticketId}/suggest`)),
};

export interface OrgAiSettings {
  enabled: boolean; allowedAreas: string[] | null; approvalRequiredFor: string[]; retentionDays: number; helpdeskAutoAnswer: boolean; helpdeskAutoResolve: boolean;
  guardrails: { bannedClaims: string[]; requiredDisclaimers: string[] }; brandVoice: { tone: string; preferredWords: string[]; avoidWords: string[]; examples: string[]; learnedAt: string | null; learnedFrom: number }; contentLocales: string[];
}

export interface VisitBrief {
  location: { id: string; name: string; code: string | null; status: string; currency: string; city: string | null };
  generatedAt: string;
  kpis: { period: string; revenue: string | null; previousRevenue: string | null; growthPct: number | null; activity: number | null; occupancyPct: number | null; reviewRating: number | null; royaltyStatus: string | null; rank: string | null } | null;
  lastAudit: { id: string; name: string; completedAt: string | null; scorePct: number | null; passed: boolean | null } | null;
  nextAudit: { id: string; dueDate: string; overdue: boolean } | null;
  openActions: Array<{ title: string; dueDate: string; overdue: boolean; critical: boolean; status: string }>;
  reviews: { average: number | null; count: number; negative: Array<{ rating: number; comment: string; reviewedAt: string; replied: boolean }> } | null;
  compliance: Array<{ title: string; expiresOn: string | null; daysLeft: number | null; state: string | null }>;
  tickets: Array<{ number: number; subject: string; status: string; priority: string }>;
  royalties: Array<{ number: string; outstanding: string; state: string; daysOverdue: number | null }>;
  selfChecks: { runs: number; completionPct: number | null; passPct: number | null; missed: number; criticalFails: number; recentFailures: Array<{ date: string; name: string; items: string }> } | null;
  supply: { open: number; late: Array<{ number: string; supplierName: string; expectedDeliveryDate: string | null }>; offContractFlagged: number } | null;
  listing: { score: number; failing: string[]; openDrifts: number; pendingChanges: number; missingHolidayDates: string[] } | null;
  survey: { title: string; round: string; level: 'owner_group' | 'region' | 'hidden'; nps: number | null; themes: Array<{ theme: string; average: number | null }> } | null;
  talkingPoints: string[];
  sandbox: boolean;
}

/** The screen the person is looking at (path, page title and the record id when the path ends in one). */
export function currentScreen(pathname: string): Screen {
  const seg = pathname.split('/').filter(Boolean);
  const last = seg[seg.length - 1] ?? '';
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(last);
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const q = params ? [...params.entries()].find(([, v]) => /^[0-9a-f-]{36}$/.test(v)) : undefined;
  return {
    path: pathname,
    title: typeof document !== 'undefined' ? document.title.split(' · ')[0]?.slice(0, 120) ?? null : null,
    recordType: isId ? seg[seg.length - 2] ?? null : q ? q[0] : null,
    recordId: isId ? last : q ? q[1] : null,
  };
}

/** Suggested prompt keys per screen (messages: marina.suggest.<key>). */
export function suggestionsFor(pathname: string, has: (module: string) => boolean): string[] {
  const p = pathname;
  const pick = (keys: Array<[string, string | null]>) => keys.filter(([, m]) => !m || has(m)).map(([k]) => k);
  // Screens of the modules added later (most specific paths first).
  if (p.startsWith('/marketing/listings')) return pick([['listingsOutOfDate', 'marketing.listings'], ['listingDrift', 'marketing.listings']]);
  if (p.startsWith('/marketing/coop')) return pick([['coopLeft', 'marketing.coop'], ['coopWaiting', 'marketing.coop']]);
  if (p.startsWith('/marketing/calls')) return pick([['missedCalls', 'marketing.call_tracking'], ['callReport', 'marketing.call_tracking']]);
  if (p.startsWith('/marketing/social/calendar')) return pick([['contentCalendar', 'marketing.social'], ['draftSocial', 'marketing.social']]);
  if (p.startsWith('/sales-connectors')) return pick([['salesVariance', 'network.sales_connectors'], ['connectorHealth', 'network.sales_connectors'], ['reconciliation', 'network.sales_connectors']]);
  if (p.startsWith('/import')) return pick([['importStatus', 'settings.import']]);
  if (p.startsWith('/launch')) return pick([['launchBoard', 'network.bulk_launch']]);
  if (p.startsWith('/benchmarks')) return pick([['benchmarks', 'network.benchmarks']]);
  if (p.startsWith('/finance/supplier-rebates')) return pick([['rebates', 'finance.supplier_rebates'], ['lateDeliveries', 'operations.suppliers']]);
  if (p.startsWith('/suppliers')) return pick([['lateDeliveries', 'operations.suppliers'], ['supplierScores', 'operations.suppliers'], ['offContract', 'operations.suppliers']]);
  if (p.startsWith('/self-checks')) return pick([['missedSelfChecks', 'operations.self_checks']]);
  if (p.startsWith('/surveys')) return pick([['surveyResults', 'community.surveys']]);
  if (p.startsWith('/franchise/territories')) return pick([['territorySeattle', 'sales.territories'], ['territoriesAvailable', 'sales.territories'], ['territoryOverlaps', 'sales.territories']]);
  if (p.startsWith('/franchise/lifecycle')) return pick([['renewalsDue', 'legal.lifecycle'], ['cureDeadlines', 'legal.lifecycle']]);
  if (p.startsWith('/franchise/development')) return pick([['developmentSchedules', 'legal.lifecycle']]);
  if (p.startsWith('/franchise/validation')) return pick([['validators', 'sales.franchise_pipeline']]);
  if (p.startsWith('/franchise/master')) return pick([['splitStatement', 'finance.royalty_splits']]);
  if (p.startsWith('/reports/brands') || p.startsWith('/settings/brands')) return pick([['compareBrands', 'network.reports'], ['brands', null]]);
  if (p.startsWith('/settings/billing') || p.startsWith('/franchisee-billing')) return pick([['planStatus', null]]);
  if (p.startsWith('/audits')) return pick([['overdueActions', 'operations.audits'], ['auditTrend', 'operations.audits'], ['mostFailed', 'operations.audits'], ['planVisits', 'operations.audits'], ['scheduleReaudit', 'operations.audits']]);
  if (p.startsWith('/compliance')) return pick([['expiringDocs', 'legal.compliance_documents'], ['complianceGaps', 'legal.compliance_documents']]);
  if (p.startsWith('/league-table') || p.startsWith('/reports')) return pick([['revenueQuarter', 'network.league_table'], ['bottomLocations', 'network.league_table'], ['missedRoyalties', 'finance.invoices']]);
  if (p.startsWith('/finance')) return pick([['missedRoyalties', 'finance.invoices'], ['fundSummary', 'finance.marketing_fund'], ['statements', 'finance.invoices']]);
  if (p.startsWith('/marketing/reviews')) return pick([['badReviews', 'marketing.reviews'], ['ratingTrend', 'marketing.reviews']]);
  if (p.startsWith('/marketing/inbox')) return pick([['unreadInbox', 'marketing.inbox']]);
  if (p.startsWith('/marketing')) return pick([['draftEmail', 'marketing.email'], ['draftSocial', 'marketing.social'], ['comingSoon', 'marketing.email']]);
  if (p.startsWith('/sales') || p.startsWith('/customers')) return pick([['leadsFollowUp', 'sales.customer_pipeline'], ['candidates', 'sales.franchise_pipeline']]);
  if (p.startsWith('/franchise')) return pick([['candidates', 'sales.franchise_pipeline'], ['franchiseTasks', 'sales.franchise_pipeline'], ['openings', 'network.onboarding']]);
  if (p.startsWith('/help')) return pick([['openTickets', 'community.help_desk'], ['howTo', null]]);
  if (p.startsWith('/training')) return pick([['trainingOverdue', 'training.assignments'], ['courses', 'training.academy']]);
  if (p.startsWith('/community')) return pick([['requiredReads', 'community.announcements'], ['howTo', null]]);
  if (p.startsWith('/locations')) return pick([['visitBrief', 'network.locations'], ['locations', 'network.locations']]);
  return pick([['missedRoyalties', 'finance.invoices'], ['revenueQuarter', 'network.league_table'], ['overdueActions', 'operations.audits'], ['badReviews', 'marketing.reviews'], ['leadsFollowUp', 'sales.customer_pipeline'], ['listingsOutOfDate', 'marketing.listings'], ['missedCalls', 'marketing.call_tracking'], ['lateDeliveries', 'operations.suppliers'], ['howTo', null], ['remind', null]]).slice(0, 5);
}

/** Reads a File as base64 (no data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
