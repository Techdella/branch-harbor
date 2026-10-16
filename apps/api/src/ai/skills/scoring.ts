import { explainedScore, type ExplainedScore, type ScoreFactor } from '@bh/shared';
import type { AssistantContext } from '../context.ts';
import { itemsOf } from '../present.ts';

/**
 * Lead and franchise-candidate scoring with next-best-action. Every point comes from a named factor with its reason,
 * so the score is explained, never a black box. Inputs are the records the person can already see (REST routes).
 */

const DAY = 86_400_000;
const daysSince = (iso: string | null | undefined, now = Date.now()) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / DAY)) : null);

const SOURCE_POINTS: Record<string, number> = { referral: 20, broker: 18, event: 15, website: 12, brand_site: 12, franchise_portal: 10, campaign: 10, ads: 8, other: 5 };

export interface LeadFacts { id: string; name: string | null; email: string | null; phone: string | null; source: string | null; status: string; message: string | null; createdAt: string; marketingConsent?: boolean; locationId?: string | null; assignedUser?: unknown }

export function scoreLeadFacts(l: LeadFacts, activities: Array<{ type: string; createdAt: string; dueAt?: string | null; completedAt?: string | null }>, now = Date.now()): ExplainedScore {
  const age = daysSince(l.createdAt, now) ?? 0;
  const lastTouch = activities.map((a) => Date.parse(a.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const sinceTouch = lastTouch ? Math.floor((now - lastTouch) / DAY) : null;
  const factors: ScoreFactor[] = [
    { key: 'recency', label: 'Recency', max: 25, points: age <= 1 ? 25 : age <= 3 ? 20 : age <= 7 ? 14 : age <= 30 ? 7 : 2, reason: age <= 1 ? 'Came in within the last day' : `Came in ${age} days ago` },
    { key: 'source', label: 'Source', max: 20, points: SOURCE_POINTS[l.source ?? 'other'] ?? 5, reason: `Source: ${l.source ?? 'unknown'}` },
    { key: 'contact', label: 'Contact details', max: 15, points: (l.email ? 8 : 0) + (l.phone ? 7 : 0), reason: [l.email ? 'email' : null, l.phone ? 'phone' : null].filter(Boolean).join(' and ') || 'No way to reach them' },
    { key: 'intent', label: 'Stated intent', max: 15, points: l.message ? Math.min(15, 5 + Math.floor(l.message.length / 40)) : 0, reason: l.message ? 'Left a message describing what they want' : 'No message' },
    { key: 'engagement', label: 'Engagement', max: 15, points: Math.min(15, activities.length * 5), reason: activities.length ? `${activities.length} logged activit${activities.length === 1 ? 'y' : 'ies'}` : 'No calls, emails or notes yet' },
    { key: 'stage', label: 'Stage', max: 10, points: l.status === 'qualified' ? 10 : l.status === 'contacted' ? 6 : l.status === 'new' ? 4 : 0, reason: `Status: ${l.status}` },
  ];
  let next: ExplainedScore['nextBestAction'];
  if (l.status === 'converted' || l.status === 'lost') next = { label: 'No action needed', reason: `The lead is ${l.status}.` };
  else if (!activities.length) next = { label: l.phone ? 'Call today' : 'Send a personal reply today', reason: 'Nobody has contacted this lead yet; fast first contact converts best.', tool: 'add_lead_note', input: { leadId: l.id, type: l.phone ? 'call' : 'email', body: 'First contact' } };
  else if ((sinceTouch ?? 0) >= 3) next = { label: 'Follow up', reason: `Last touch was ${sinceTouch} days ago.`, tool: 'add_lead_note', input: { leadId: l.id, type: 'task', body: 'Follow up' } };
  else next = { label: 'Book a visit or trial', reason: 'The lead is engaged; propose a concrete next step.' };
  return explainedScore(factors, next);
}

export interface ProspectFacts { id: string; name: string; stage: string; source: string | null; liquidCapital?: { amount?: number; amountMinor?: number; currency?: string } | number | null; netWorth?: unknown; territoryId?: string | null; territoryName?: string | null; desiredTerritory?: string | null; stageEnteredAt?: string | null; createdAt: string; units?: number | null; message?: string | null }

const STAGE_POINTS: Record<string, number> = { enquiry: 4, qualified: 10, discovery_call: 14, disclosure_sent: 17, disclosure_receipt_signed: 19, waiting_period: 20, agreement_sent: 22, signed: 25, onboarding: 25, opened: 25, lost: 0 };

const capitalOf = (v: ProspectFacts['liquidCapital']): number | null => (typeof v === 'number' ? v : v && typeof v === 'object' ? (v.amount ?? (v.amountMinor !== undefined ? v.amountMinor / 100 : null)) : null);

export function scoreProspectFacts(p: ProspectFacts, tasks: Array<{ status: string; overdue?: boolean; title: string }>, now = Date.now()): ExplainedScore {
  const capital = capitalOf(p.liquidCapital);
  const inStage = daysSince(p.stageEnteredAt ?? p.createdAt, now) ?? 0;
  const overdue = tasks.filter((t) => t.status === 'open' && t.overdue);
  const factors: ScoreFactor[] = [
    { key: 'stage', label: 'Pipeline stage', max: 25, points: STAGE_POINTS[p.stage] ?? 0, reason: `Stage: ${p.stage.replace(/_/g, ' ')}` },
    { key: 'capital', label: 'Declared capital', max: 20, points: capital === null ? 0 : capital >= 250_000 ? 20 : capital >= 150_000 ? 15 : capital >= 75_000 ? 9 : 4, reason: capital === null ? 'No liquid capital declared' : `Self-declared liquid capital ${capital.toLocaleString('en')} (not verified)` },
    { key: 'territory', label: 'Territory', max: 15, points: p.territoryId ? 15 : p.desiredTerritory ? 8 : 0, reason: p.territoryId ? `Matched to ${p.territoryName ?? 'a territory'}` : p.desiredTerritory ? `Wants ${p.desiredTerritory} (not matched yet)` : 'No territory yet' },
    { key: 'source', label: 'Source', max: 15, points: Math.round(((SOURCE_POINTS[p.source ?? 'other'] ?? 5) / 20) * 15), reason: `Source: ${p.source ?? 'unknown'}` },
    { key: 'momentum', label: 'Momentum', max: 15, points: p.stage === 'lost' ? 0 : inStage <= 7 ? 15 : inStage <= 21 ? 9 : inStage <= 45 ? 4 : 0, reason: `${inStage} days in the current stage` },
    { key: 'followup', label: 'Follow-up', max: 10, points: overdue.length ? 0 : 10, reason: overdue.length ? `${overdue.length} overdue task(s): ${overdue.slice(0, 2).map((t) => t.title).join('; ')}` : 'No overdue tasks' },
  ];
  let next: ExplainedScore['nextBestAction'];
  if (p.stage === 'lost') next = { label: 'No action needed', reason: 'The candidate is marked lost.' };
  else if (overdue.length) next = { label: `Do the overdue task: ${overdue[0]!.title}`, reason: 'Overdue follow-ups are the most common reason candidates go cold.' };
  else if (p.stage === 'enquiry') next = { label: 'Qualify the candidate', reason: 'Check capital, territory and timing on a short call.', tool: 'move_prospect_stage', input: { prospectId: p.id, to: 'qualified' } };
  else if (p.stage === 'qualified') next = { label: 'Book the discovery call', reason: 'Qualified candidates should get a discovery call within a week.', tool: 'move_prospect_stage', input: { prospectId: p.id, to: 'discovery_call' } };
  else if (!p.territoryId) next = { label: 'Match a territory', reason: 'A reserved territory keeps a serious candidate engaged.' };
  else next = { label: 'Keep the cadence going', reason: `Next step in ${p.stage.replace(/_/g, ' ')} follows the pipeline rules (disclosure and waiting periods are enforced).` };
  return explainedScore(factors, next);
}

export async function scoreLead(ctx: AssistantContext, leadId: string) {
  const all = itemsOf<LeadFacts>(await ctx.api.get(ctx.o('/sales/leads'), { status: 'all', limit: 500 }));
  const course = all.find((l) => l.id === leadId) ? [] : itemsOf<LeadFacts>(await ctx.api.get(ctx.o('/sales/leads'), { status: 'all', kind: 'course', limit: 500 }));
  const lead = [...all, ...course].find((l) => l.id === leadId);
  if (!lead) return null;
  const acts = itemsOf<{ type: string; createdAt: string }>(await ctx.api.get(ctx.o(`/sales/leads/${leadId}/activities`)).catch(() => ({ items: [] })));
  return { lead: { id: lead.id, name: lead.name, status: lead.status, source: lead.source }, ...scoreLeadFacts(lead, acts) };
}

export async function scoreProspect(ctx: AssistantContext, prospectId: string) {
  const p = (await ctx.api.get(ctx.o(`/franchise/prospects/${prospectId}`))) as ProspectFacts & { prospect?: ProspectFacts; tasks?: unknown[] };
  const prospect = (p.prospect ?? p) as ProspectFacts;
  const tasks = itemsOf<{ status: string; overdue?: boolean; title: string; prospectId?: string }>(await ctx.api.get(ctx.o('/franchise/tasks')).catch(() => ({ items: [] }))).filter((t) => t.prospectId === prospectId);
  return { prospect: { id: prospect.id, name: prospect.name, stage: prospect.stage }, ...scoreProspectFacts(prospect, tasks) };
}
