import { and, asc, eq, gte, isNull, lte, or } from 'drizzle-orm';
import { ASSISTANT_NAME, BRIEFING_SECTIONS, type BriefingItem, type BriefingSection } from '@bh/shared';
import type { Services } from '../../context.ts';
import { aiBriefings, aiTasks, aiUserPrefs, networkNotifications, organizations, users } from '../../db/schema/index.ts';
import { buildAssistantContext, type AssistantContext } from '../context.ts';
import { itemsOf } from '../present.ts';
import { sandboxPhrases } from '../sandbox.ts';
import { listInsights } from './insights.ts';
import { moduleBriefingItems } from './briefing-modules.ts';
import { isSandbox, languageName, oneShot } from './_llm.ts';

/**
 * Daily / weekly briefing per person: what needs attention in the areas they can see (overdue corrective actions,
 * expiring documents, bad reviews, KPI drops, leads to follow up, tickets, royalties, training). Built from the REST
 * routes as the person; a short summary is written by the fast model (or by fixed wording in the sandbox).
 */

const DAY = 86_400_000;
const safe = async <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);

export async function buildBriefingItems(ctx: AssistantContext, sections: BriefingSection[] = [...BRIEFING_SECTIONS]): Promise<BriefingItem[]> {
  const want = new Set(sections.length ? sections : BRIEFING_SECTIONS);
  const items: BriefingItem[] = [];
  const api = ctx.api;
  const o = ctx.o;

  if (want.has('overdue_actions') && ctx.can('operations.audits')) {
    const acts = itemsOf(await safe(api.get(o('/audits/actions'), { status: 'overdue' }), { items: [] }));
    if (acts.length) items.push({ section: 'overdue_actions', severity: acts.some((a) => a.critical) ? 'critical' : 'warning', title: `${acts.length} overdue corrective action${acts.length === 1 ? '' : 's'}`, detail: acts.slice(0, 3).map((a) => `${a.locationName}: ${a.title}`).join(' · '), link: '/audits', count: acts.length });
    const audits = itemsOf(await safe(api.get(o('/audits'), { status: 'open', limit: 100 }), { items: [] })).filter((a) => a.overdue);
    if (audits.length) items.push({ section: 'overdue_actions', severity: 'warning', title: `${audits.length} audit${audits.length === 1 ? '' : 's'} past due`, detail: audits.slice(0, 3).map((a) => `${a.locationName} (${a.dueDate})`).join(' · '), link: '/audits', count: audits.length });
  }
  if (want.has('expiring_documents') && ctx.can('legal.compliance_documents')) {
    const docs = itemsOf(await safe(api.get(o('/compliance/documents')), { items: [] })).filter((d) => !d.superseded && d.daysLeft !== null && d.daysLeft <= 30);
    if (docs.length) items.push({ section: 'expiring_documents', severity: docs.some((d) => d.daysLeft < 0) ? 'critical' : 'warning', title: `${docs.length} compliance document${docs.length === 1 ? '' : 's'} expired or expiring within 30 days`, detail: docs.slice(0, 3).map((d) => `${d.locationName ?? d.ownerGroupName}: ${d.title} (${d.daysLeft < 0 ? `expired ${-d.daysLeft} days ago` : `${d.daysLeft} days left`})`).join(' · '), link: '/compliance', count: docs.length });
  }
  if (want.has('reviews') && ctx.can('marketing.reviews')) {
    const bad = itemsOf(await safe(api.get(o('/reviews'), { maxRating: 2 }), { items: [] })).filter((r) => Date.now() - Date.parse(r.reviewedAt) < 7 * DAY && !r.reply?.text);
    if (bad.length) items.push({ section: 'reviews', severity: 'warning', title: `${bad.length} negative review${bad.length === 1 ? '' : 's'} this week without a reply`, detail: bad.slice(0, 3).map((r) => `${r.locationName}: ${r.rating}★`).join(' · '), link: '/marketing/reviews', count: bad.length });
  }
  if (want.has('kpis') && ctx.can('ai.assistant')) {
    const ins = await safe(listInsights(ctx, { limit: 5 }), []);
    for (const i of ins.slice(0, 3)) items.push({ section: 'kpis', severity: i.severity as BriefingItem['severity'], title: i.title, detail: i.explanation, link: `/marina?insight=${i.id}` });
  }
  if (want.has('leads')) {
    if (ctx.can('sales.customer_pipeline')) {
      const fresh = itemsOf(await safe(api.get(o('/sales/leads'), { status: 'new', limit: 200 }), { items: [] })).filter((l) => Date.now() - Date.parse(l.createdAt) > DAY);
      if (fresh.length) items.push({ section: 'leads', severity: fresh.length > 5 ? 'warning' : 'info', title: `${fresh.length} new lead${fresh.length === 1 ? '' : 's'} not contacted for over a day`, detail: fresh.slice(0, 3).map((l) => l.name).join(', '), link: '/sales/leads', count: fresh.length });
    }
    if (ctx.can('sales.franchise_pipeline')) {
      const tasks = itemsOf(await safe(api.get(o('/franchise/tasks')), { items: [] })).filter((t) => t.status === 'open' && t.overdue);
      if (tasks.length) items.push({ section: 'leads', severity: 'warning', title: `${tasks.length} overdue franchise follow-up${tasks.length === 1 ? '' : 's'}`, detail: tasks.slice(0, 3).map((t) => `${t.prospectName ?? ''}: ${t.title}`).join(' · '), link: '/franchise/pipeline', count: tasks.length });
    }
  }
  if (want.has('tickets') && ctx.can('community.help_desk')) {
    const t = itemsOf(await safe(api.get(o('/helpdesk/tickets'), { status: 'active' }), { items: [] }));
    const breached = t.filter((x) => x.sla?.breached || x.sla?.state === 'breached');
    if (ctx.can('community.help_desk', 'edit') && t.length) items.push({ section: 'tickets', severity: breached.length ? 'warning' : 'info', title: `${t.length} open help desk ticket${t.length === 1 ? '' : 's'}${breached.length ? `, ${breached.length} past SLA` : ''}`, detail: t.slice(0, 3).map((x) => `#${x.number} ${x.subject}`).join(' · '), link: '/help', count: t.length });
    else {
      const waiting = t.filter((x) => x.status === 'pending');
      if (waiting.length) items.push({ section: 'tickets', severity: 'info', title: `${waiting.length} help desk answer${waiting.length === 1 ? '' : 's'} waiting for you`, detail: waiting.slice(0, 3).map((x) => x.subject).join(' · '), link: '/help', count: waiting.length });
    }
  }
  if (want.has('royalties') && (ctx.can('finance.royalties') || ctx.can('finance.invoices'))) {
    const inv = itemsOf(await safe(api.get(o('/finance/invoices'), { limit: 500 }), { items: [] })).filter((x) => x.state === 'overdue');
    if (inv.length) items.push({ section: 'royalties', severity: 'critical', title: `${inv.length} overdue royalty invoice${inv.length === 1 ? '' : 's'}`, detail: inv.slice(0, 3).map((x) => `${x.location?.name ?? ''} ${x.number} (${x.daysOverdue} days)`).join(' · '), link: ctx.can('finance.royalties') ? '/finance/royalties' : '/finance/statements', count: inv.length });
  }
  if (want.has('training')) {
    if (ctx.can('community.announcements')) {
      const reads = itemsOf(await safe(api.get(o('/community/announcements')), { items: [] })).filter((a) => a.requiredRead && !a.acknowledgedAt && a.status === 'published');
      if (reads.length) items.push({ section: 'training', severity: reads.some((a) => a.overdue) ? 'warning' : 'info', title: `${reads.length} required read${reads.length === 1 ? '' : 's'} to confirm`, detail: reads.slice(0, 3).map((a) => a.title).join(' · '), link: '/community', count: reads.length });
    }
    if (ctx.can('training.assignments')) {
      const rep = itemsOf(await safe(api.get(o('/training/reports/completion')), { items: [] }));
      const overdue = rep.reduce((a, x) => a + (x.overdue ?? 0), 0);
      if (overdue) items.push({ section: 'training', severity: 'info', title: `${overdue} overdue training assignment${overdue === 1 ? '' : 's'}`, detail: rep.filter((x) => x.overdue).slice(0, 3).map((x) => `${x.locationName}: ${x.overdue}`).join(' · '), link: '/training', count: overdue });
    }
  }
  // Local marketing, sales data, supply, self-checks and agreement deadlines.
  items.push(...(await moduleBriefingItems(ctx, want)));
  // Personal tasks due today or overdue.
  const tasks = await ctx.s.db.select().from(aiTasks).where(and(eq(aiTasks.organizationId, ctx.orgId), eq(aiTasks.userId, ctx.user.id), eq(aiTasks.status, 'open'), or(lte(aiTasks.dueAt, new Date(Date.now() + DAY)), lte(aiTasks.remindAt, new Date(Date.now() + DAY))))).orderBy(asc(aiTasks.dueAt)).limit(5);
  if (tasks.length) items.push({ section: 'overdue_actions', severity: 'info', title: `${tasks.length} of your tasks due today`, detail: tasks.map((t) => t.title).join(' · '), link: '/marina', count: tasks.length });
  const order = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity]);
}

export async function briefingSummary(ctx: AssistantContext, items: BriefingItem[]): Promise<string> {
  const p = sandboxPhrases(ctx.locale);
  if (!items.length) return p.quiet;
  if (isSandbox(ctx.s)) return `${p.briefing} ${items.slice(0, 4).map((i) => i.title).join('; ')}.`;
  const r = await oneShot(ctx.s, ctx.orgId, 'briefing', {
    tier: 'fast', effort: 'low', locale: ctx.locale,
    system: `You are ${ASSISTANT_NAME}. Write a 2–3 sentence morning briefing from the items given: what matters most first, then what can wait. Use only the items; no new facts. Sound calm and plain-spoken: short sentences, amounts with their currency, no exclamation marks about problems, and never claim to be human.`,
    messages: [{ role: 'user', content: `Language: ${languageName(ctx.locale)}. Person: ${ctx.user.name}.\nItems:\n${items.map((i) => `- [${i.severity}] ${i.title}: ${i.detail}${i.suggestion ? ` (suggested: ${i.suggestion})` : ''}`).join('\n')}` }],
    maxTokens: 600,
  }).catch(() => null);
  return r?.text || `${p.briefing} ${items.slice(0, 4).map((i) => i.title).join('; ')}.`;
}

function localParts(now: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const get = (t: string) => f.find((x) => x.type === t)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), weekday };
}

/** Prepares (or returns today's) briefing for one person. */
export async function generateBriefing(s: Services, orgId: string, userId: string, opts: { kind?: 'daily' | 'weekly' | 'on_demand'; deliver?: boolean; force?: boolean; ctx?: AssistantContext } = {}) {
  const ctx = opts.ctx ?? (await buildAssistantContext(s, orgId, userId));
  const today = localParts(new Date(), ctx.org.defaultTimeZone).date;
  const [existing] = await s.db.select().from(aiBriefings).where(and(eq(aiBriefings.organizationId, orgId), eq(aiBriefings.userId, userId), eq(aiBriefings.date, today)));
  if (existing && !opts.force) return existing;
  const [prefs] = await s.db.select().from(aiUserPrefs).where(and(eq(aiUserPrefs.organizationId, orgId), eq(aiUserPrefs.userId, userId)));
  const items = await buildBriefingItems(ctx, (prefs?.sections ?? []) as BriefingSection[]);
  const summary = await briefingSummary(ctx, items);
  const values = { organizationId: orgId, userId, date: today, kind: opts.kind ?? 'on_demand', items, summary, createdAt: new Date() };
  const [row] = await s.db.insert(aiBriefings).values(values).onConflictDoUpdate({ target: [aiBriefings.organizationId, aiBriefings.userId, aiBriefings.date], set: { items, summary, kind: values.kind, createdAt: new Date() } }).returning();
  if (opts.deliver) {
    if (prefs?.briefingInApp !== false) {
      await s.db.insert(networkNotifications).values({ organizationId: orgId, userId, kind: 'marina_briefing', title: `${ASSISTANT_NAME}: your ${opts.kind === 'weekly' ? 'weekly' : 'daily'} briefing`, body: summary.slice(0, 500), link: '/marina', data: { briefingId: row!.id, items: items.length } });
    }
    if (prefs?.briefingEmail !== false && items.length) {
      const [u] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (u) {
        const lines = items.map((i) => `• ${i.title}${i.detail ? `\n  ${i.detail}` : ''}${i.suggestion ? `\n  → ${i.suggestion}` : ''}`).join('\n');
        await s.jobs.enqueue('email.send', { to: u.email, subject: `${ASSISTANT_NAME}: ${items.length} thing${items.length === 1 ? '' : 's'} for ${ctx.org.name} today`, text: `${summary}\n\n${lines}\n\n${s.cfg.APP_URL}/marina\n\nChange how often you get this in ${ASSISTANT_NAME} → Briefing settings.`, tag: 'marina-briefing' });
        await s.db.update(aiBriefings).set({ emailedAt: new Date() }).where(eq(aiBriefings.id, row!.id));
      }
    }
    await s.db.update(aiUserPrefs).set({ lastBriefingAt: new Date() }).where(and(eq(aiUserPrefs.organizationId, orgId), eq(aiUserPrefs.userId, userId)));
  }
  return row!;
}

/** Scheduler: prepares and delivers briefings whose local hour (and weekday for weekly) has come. */
export async function runBriefings(s: Services, now = new Date()) {
  const prefs = await s.db.select({ p: aiUserPrefs, tz: organizations.defaultTimeZone }).from(aiUserPrefs).innerJoin(organizations, eq(organizations.id, aiUserPrefs.organizationId))
    .where(and(gte(aiUserPrefs.briefingHour, 0), or(isNull(aiUserPrefs.lastBriefingAt), lte(aiUserPrefs.lastBriefingAt, new Date(now.getTime() - 20 * 3600_000)))));
  let sent = 0;
  for (const { p, tz } of prefs) {
    if (p.briefingFrequency === 'off') continue;
    const local = localParts(now, tz);
    if (local.hour < p.briefingHour) continue;
    if (p.briefingFrequency === 'weekly' && local.weekday !== p.briefingWeekday) continue;
    try {
      const ctx = await buildAssistantContext(s, p.organizationId, p.userId);
      if (!ctx.can('ai.assistant')) continue;
      await generateBriefing(s, p.organizationId, p.userId, { kind: p.briefingFrequency as 'daily' | 'weekly', deliver: true, force: true, ctx });
      sent++;
    } catch (err) {
      s.log.warn({ err, userId: p.userId }, '[ai] briefing failed');
    }
  }
  return sent;
}
