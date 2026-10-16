import { z } from 'zod';
import { SITE_THEMES } from '@bh/shared';
import { defineTool, ToolError } from '../types.ts';
import { table } from '../present.ts';
import { citationsFrom, semanticSearch } from '../knowledge.ts';
import { listInsights } from '../skills/insights.ts';
import { buildVisitBrief } from '../skills/visit-brief.ts';

/** Tools built on the assistant's own skills: knowledge search, insights, visit briefs, setup and course drafts. */

const TZ: Record<string, string> = {
  CA: 'America/Toronto', US: 'America/New_York', GB: 'Europe/London', IE: 'Europe/Dublin', AU: 'Australia/Sydney', NZ: 'Pacific/Auckland', FR: 'Europe/Paris', DE: 'Europe/Berlin',
  ES: 'Europe/Madrid', PT: 'Europe/Lisbon', BR: 'America/Sao_Paulo', NL: 'Europe/Amsterdam', IT: 'Europe/Rome', MX: 'America/Mexico_City', SG: 'Asia/Singapore', AE: 'Asia/Dubai',
};

const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  kind: 'read',
  area: 'knowledge',
  modules: null,
  untrustedOutput: true,
  description: 'Search the organisation’s knowledge base: operations manual and library documents, training courses, help-desk answers, brand guidelines and uploaded files. Returns excerpts with their source titles; cite the titles you use. Only documents shared with the person are searched.',
  input: z.object({ query: z.string().min(2).max(300) }),
  async run(ctx, i) {
    const hits = await semanticSearch(ctx.s, ctx, i.query, 6);
    return { hits: hits.map((h) => ({ title: h.title, heading: h.heading, excerpt: h.content.slice(0, 1500), sourceType: h.sourceType, url: h.url, sourceId: h.sourceId })) };
  },
  present: (r: { hits: Array<{ title: string; heading: string | null; excerpt: string; sourceType: string; url: string | null; sourceId: string }> }) => ({
    summary: r.hits.length
      ? `From "${r.hits[0]!.title}"${r.hits[0]!.heading ? ` (${r.hits[0]!.heading})` : ''}: ${r.hits[0]!.excerpt.replace(/\s+/g, ' ').slice(0, 420)}${r.hits[0]!.excerpt.length > 420 ? '…' : ''}\nSources: ${[...new Set(r.hits.map((h) => h.title))].join(', ')}.`
      : 'Nothing in the knowledge base matches that.',
    citations: citationsFrom(r.hits.map((h) => ({ chunkId: '', sourceId: h.sourceId, title: h.title, url: h.url, sourceType: h.sourceType, heading: h.heading, content: h.excerpt, score: 0 }))),
  }),
});

const listInsightsTool = defineTool({
  name: 'list_insights',
  kind: 'read',
  area: 'general',
  modules: ['ai.assistant'],
  description: 'Open insights detected on the person’s locations: revenue or booking drops, overdue royalties, rating drops, audit score declines, churn risk and compliance gaps, each with an explanation, evidence and suggested actions.',
  input: z.object({}),
  run: (ctx) => listInsights(ctx, { limit: 20 }),
  present: (r: Array<{ id: string; title: string; severity: string; explanation: string; locationName: string | null }>) => ({
    summary: r.length ? `${r.length} open insight(s): ${r.slice(0, 5).map((x) => x.title).join('; ')}.` : 'No open insights.',
    blocks: r.length ? [table('Insights', [{ key: 'severity', label: 'Severity', kind: 'status' }, { key: 'title', label: 'Insight' }, { key: 'explanation', label: 'Why' }], r)] : [],
    citations: [{ id: 'insights', title: 'Insights feed', url: '/marina', sourceType: 'screen' }],
  }),
});

const visitBriefTool = defineTool({
  name: 'prepare_visit_brief',
  kind: 'read',
  area: 'network',
  modules: ['network.locations'],
  description: 'Prepare a one-page visit brief for a location: KPIs vs the previous month, last audit and open corrective actions, recent reviews, compliance documents, open tickets, overdue royalties and suggested talking points.',
  input: z.object({ location: z.string().min(1).max(120).describe('Location name, code or id') }),
  run: (ctx, i) => buildVisitBrief(ctx, i.location),
  present: (b) => ({
    summary: `Visit brief for ${b.location.name}: ${b.talkingPoints.length} talking point(s). ${b.talkingPoints.slice(0, 3).join(' ')}`,
    blocks: [table(`Visit brief: ${b.location.name}`, [{ key: 'topic', label: 'Topic' }, { key: 'detail', label: 'Detail' }], [
      ...(b.kpis ? [{ topic: `Revenue (${b.kpis.period})`, detail: b.kpis.revenue ? `${b.kpis.revenue} vs ${b.kpis.previousRevenue} (${b.kpis.growthPct ?? 0}%)` : 'Not in your access' }] : []),
      ...(b.lastAudit ? [{ topic: 'Last audit', detail: `${b.lastAudit.name}: ${b.lastAudit.scorePct ?? '—'}% (${b.lastAudit.passed ? 'passed' : 'failed'})` }] : []),
      { topic: 'Open corrective actions', detail: String(b.openActions.length) },
      ...(b.reviews ? [{ topic: 'Reviews (90 days)', detail: `${b.reviews.average ?? '—'}★ from ${b.reviews.count}` }] : []),
      { topic: 'Compliance documents', detail: b.compliance.map((c: { title: string; daysLeft: number | null }) => `${c.title}${c.daysLeft !== null ? ` (${c.daysLeft} d)` : ''}`).join('; ') || '—' },
      { topic: 'Open tickets', detail: String(b.tickets.length) },
      ...b.talkingPoints.map((p: string, n: number) => ({ topic: `Talking point ${n + 1}`, detail: p })),
    ])],
    navigate: { path: `/marina/visit-brief?location=${b.location.id}`, label: `Visit brief: ${b.location.name}` },
  }),
});

const createLocations = defineTool({
  name: 'create_locations',
  kind: 'write',
  area: 'network',
  modules: ['network.locations'],
  risk: 'bulk',
  description: 'Create one or more locations (status onboarding) with name, country and city. Addresses can be completed later in Locations.',
  input: z.object({ locations: z.array(z.object({ name: z.string().trim().min(1).max(120), country: z.string().length(2), city: z.string().trim().min(1).max(120).default('To be confirmed'), currency: z.string().length(3).optional() })).min(1).max(50) }),
  async preview(_ctx, i) {
    return {
      title: `Create ${i.locations.length} location${i.locations.length === 1 ? '' : 's'}`,
      summary: i.locations.slice(0, 6).map((l) => `${l.name} (${l.city}, ${l.country})`).join('; ') + (i.locations.length > 6 ? '…' : ''),
      details: i.locations.map((l) => ({ label: l.name, value: `${l.city}, ${l.country}` })),
      link: '/locations',
    };
  },
  async execute(ctx, i) {
    const created: string[] = [];
    for (const [n, l] of i.locations.entries()) {
      const country = l.country.toUpperCase();
      const code = `${l.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'LOC'}${String(n + 1).padStart(2, '0')}`.slice(0, 24);
      const r = await ctx.api.post(ctx.o('/locations'), { name: l.name, code, address: { line1: 'Address to be added', city: l.city, country }, timeZone: TZ[country] ?? ctx.org.defaultTimeZone, currency: l.currency ?? ctx.org.defaultCurrency, status: 'onboarding' });
      created.push(r.id);
    }
    return { result: { created: created.length, locationIds: created }, link: '/locations' };
  },
});

const setTheme = defineTool({
  name: 'set_site_theme',
  kind: 'write',
  area: 'marketing',
  modules: ['network.templates', 'marketing.website_builder'],
  risk: 'change',
  description: 'Choose the website theme for the brand’s sites (content is kept; publishing is separate).',
  input: z.object({ themeId: z.enum(SITE_THEMES.map((t) => t.id) as [string, ...string[]]) }),
  async preview(_ctx, i) {
    return { title: `Use the "${i.themeId}" website theme`, summary: 'Switching theme keeps every page’s content.', details: [{ label: 'Theme', value: i.themeId }], link: '/marketing/websites' };
  },
  async execute(ctx, i) {
    const cur = await ctx.api.get(ctx.o('/builder/sites'));
    await ctx.api.put(ctx.o('/builder/theme'), { ...(cur.theme ?? {}), themeId: i.themeId, colorMode: cur.theme?.colorMode ?? 'theme' });
    return { result: { themeId: i.themeId }, link: '/marketing/websites' };
  },
});

const courseInput = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(500).optional(),
  modules: z.array(z.object({ title: z.string().trim().min(1).max(200), lessons: z.array(z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(100_000) })).min(1).max(20) })).min(1).max(12),
  quiz: z.array(z.object({ prompt: z.string().min(1).max(1000), options: z.array(z.string().min(1).max(300)).min(2).max(8), correct: z.number().int().min(0).max(7) })).max(30).default([]),
});

const createCourseDraft = defineTool({
  name: 'create_course_draft',
  kind: 'write',
  area: 'training',
  modules: ['training.academy'],
  risk: 'change',
  description: 'Create a training course DRAFT with modules, lessons and a final quiz (an outline from the course builder). Publishing follows the academy’s approval rules.',
  input: courseInput,
  async preview(_ctx, i) {
    const lessons = i.modules.reduce((a, m) => a + m.lessons.length, 0);
    return { title: `Create course draft "${i.title}"`, summary: `${i.modules.length} modules, ${lessons} lessons${i.quiz.length ? `, ${i.quiz.length}-question quiz` : ''}.`, details: i.modules.map((m) => ({ label: m.title, value: m.lessons.map((l) => l.title).join(' · ') })), link: '/training', editable: [{ key: 'title', label: 'Title', kind: 'text' }] };
  },
  async execute(ctx, i) {
    const c = await ctx.api.post(ctx.o('/training/courses'), { title: i.title, summary: i.summary ?? null, visibility: 'internal' });
    const courseId = c.id ?? c.course?.id;
    if (!courseId) throw new ToolError('error', 'The course could not be created');
    for (const [mi, m] of i.modules.entries()) {
      const mod = await ctx.api.post(ctx.o(`/training/courses/${courseId}/modules`), { title: m.title, position: mi });
      for (const [li, l] of m.lessons.entries()) await ctx.api.post(ctx.o(`/training/modules/${mod.id}/lessons`), { title: l.title, kind: 'text', body: l.body, position: li });
    }
    if (i.quiz.length) {
      const lastMod = await ctx.api.post(ctx.o(`/training/courses/${courseId}/modules`), { title: 'Check your knowledge', position: i.modules.length });
      await ctx.api.post(ctx.o(`/training/modules/${lastMod.id}/lessons`), { title: 'Quiz', kind: 'quiz', quiz: i.quiz.map((q, n) => ({ id: `q${n + 1}`, prompt: q.prompt, options: q.options, correct: [q.correct] })) });
    }
    return { result: { courseId }, link: `/training?course=${courseId}` };
  },
});

export default [searchKnowledgeTool, listInsightsTool, visitBriefTool, createLocations, setTheme, createCourseDraft];
