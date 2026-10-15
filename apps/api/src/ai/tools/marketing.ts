import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AssistantContext } from '../context.ts';
import { defineTool, ToolError } from '../types.ts';
import { itemsOf, table } from '../present.ts';
import { plural, resolveLocation } from './_helpers.ts';
import { generateCopy } from '../skills/content.ts';

const bid = () => `b${randomBytes(5).toString('hex')}`;

/** Campaign scope: a named location, or the organisation for HQ. */
async function scopeFor(ctx: AssistantContext, location?: string) {
  const loc = await resolveLocation(ctx, location);
  if (loc) return { scope: { kind: 'location' as const, id: loc.id }, label: loc.name };
  if (!ctx.hq) throw new ToolError('validation_failed', 'Which location is this for? Your access is limited to specific locations.');
  return { scope: { kind: 'organization' as const, id: ctx.orgId }, label: ctx.org.name };
}

/** A simple email document from plain paragraphs (header, text blocks, optional button). */
export function simpleEmail(body: string, cta?: { label: string; href: string } | null) {
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 20);
  return {
    schemaVersion: 1,
    blocks: [
      { id: bid(), type: 'header', showLogo: true, title: '' },
      ...paras.map((p) => ({ id: bid(), type: 'text', text: p.slice(0, 5000), align: 'left', size: 'body' })),
      ...(cta?.href ? [{ id: bid(), type: 'button', label: cta.label.slice(0, 60), href: cta.href, align: 'center' }] : []),
      { id: bid(), type: 'footer', text: '', address: '' },
    ],
    style: { background: 'light', buttonShape: 'pill' },
  };
}

const listEmailCampaigns = defineTool({
  name: 'list_email_campaigns',
  kind: 'read',
  area: 'marketing',
  modules: ['marketing.email'],
  description: 'Email campaigns (draft, scheduled, sending, sent) with subject, scope and sent counts.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/email/campaigns')),
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: `${plural(items.length, 'email campaign')}.`,
      blocks: items.length ? [table('Email campaigns', [{ key: 'name', label: 'Campaign' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'subject', label: 'Subject' }, { key: 'createdAt', label: 'Created', kind: 'date' }], items.map((c) => ({ ...c, subject: c.content?.subject ?? c.subject ?? null })))] : [],
      citations: [{ id: 'email', title: 'Email', url: '/marketing/email', sourceType: 'screen' }],
    };
  },
});

const createEmailDraft = defineTool({
  name: 'create_email_campaign_draft',
  kind: 'write',
  area: 'marketing',
  modules: ['marketing.email'],
  risk: 'change',
  description: 'Create an email campaign as a DRAFT (never sends). Write the copy in the brand voice; the organisation’s guardrails (banned claims, required disclaimers) are applied. Optional location for a local campaign; otherwise HQ (organisation-wide).',
  input: z.object({
    name: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(1).max(200),
    preheader: z.string().max(200).optional(),
    body: z.string().max(8000).optional().describe('Plain text; blank lines separate paragraphs. Leave empty to have the copy written from the brief.'),
    brief: z.string().max(1000).optional().describe('What the email is about, when body is empty'),
    ctaLabel: z.string().max(60).optional(),
    ctaUrl: z.url().max(2000).optional(),
    location: z.string().max(120).optional(),
  }),
  async preview(ctx, i) {
    const { label } = await scopeFor(ctx, i.location);
    const body = i.body?.trim() || (await generateCopy(ctx, { kind: 'email', brief: i.brief ?? i.subject, locale: ctx.locale })).text;
    i.body = body;
    return {
      title: `Draft email: ${i.subject}`,
      summary: `Saved as a draft for ${label}. Nothing is sent.`,
      details: [{ label: 'Scope', value: label }, { label: 'Subject', value: i.subject }, { label: 'Body', value: body.slice(0, 1200) }],
      link: '/marketing/email',
      editable: [{ key: 'subject', label: 'Subject', kind: 'text' }, { key: 'body', label: 'Body', kind: 'textarea' }],
    };
  },
  async execute(ctx, i) {
    const { scope } = await scopeFor(ctx, i.location);
    const c = await ctx.api.post(ctx.o('/email/campaigns'), {
      name: i.name, scope, subject: i.subject, preheader: i.preheader ?? '', document: simpleEmail(i.body ?? '', i.ctaLabel && i.ctaUrl ? { label: i.ctaLabel, href: i.ctaUrl } : null),
    });
    return { result: { campaignId: c.id, status: 'draft' }, link: '/marketing/email' };
  },
});

const sendEmailCampaign = defineTool({
  name: 'send_email_campaign',
  kind: 'write',
  area: 'marketing',
  modules: ['marketing.email'],
  action: 'publish',
  risk: 'outbound',
  description: 'Send (or schedule) an existing email campaign to its segment. Only consented contacts receive it. Always outbound: prepare it only when the person explicitly asks to send.',
  input: z.object({ campaignId: z.uuid(), at: z.iso.datetime({ offset: true }).optional().describe('Schedule time; omit to send now') }),
  async preview(ctx, i) {
    const c = await ctx.api.get(ctx.o(`/email/campaigns/${i.campaignId}`));
    return {
      title: `${i.at ? 'Schedule' : 'Send'} "${c.name}"`,
      summary: i.at ? `Scheduled for ${i.at}` : 'Sends now to every consented contact in the segment.',
      details: [{ label: 'Campaign', value: c.name }, { label: 'Subject', value: c.content?.subject ?? '' }, { label: 'When', value: i.at ?? 'Now' }],
      link: '/marketing/email',
    };
  },
  async execute(ctx, i) {
    const r = await ctx.api.post(ctx.o(`/email/campaigns/${i.campaignId}/send`), { at: i.at ?? null });
    return { result: { status: r.status ?? 'sending' }, link: '/marketing/email' };
  },
});

const listAutomations = defineTool({
  name: 'list_automations',
  kind: 'read',
  area: 'marketing',
  modules: ['marketing.automations'],
  description: 'Marketing automations (journeys): name, trigger and status (draft, active, paused).',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/automations')),
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: `${plural(items.length, 'automation')}: ${items.filter((a) => a.status === 'active').length} active.`,
      blocks: items.length ? [table('Automations', [{ key: 'name', label: 'Journey' }, { key: 'trigger', label: 'Trigger' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'id', label: 'Id' }], items.map((a) => ({ ...a, trigger: a.trigger?.type ?? a.trigger ?? null })))] : [],
      citations: [{ id: 'automations', title: 'Automations', url: '/marketing/automations', sourceType: 'screen' }],
    };
  },
});

const setAutomationStatus = defineTool({
  name: 'set_automation_status',
  kind: 'write',
  area: 'marketing',
  modules: ['marketing.automations'],
  risk: (i: { status: string }) => (i.status === 'active' ? 'outbound' : 'change'),
  description: 'Activate, pause or archive an automation. Activating starts sending messages to people who match its trigger.',
  input: z.object({ automationId: z.uuid(), status: z.enum(['active', 'paused', 'archived']) }),
  async preview(ctx, i) {
    const a = await ctx.api.get(ctx.o(`/automations/${i.automationId}`));
    return { title: `${i.status === 'active' ? 'Activate' : i.status === 'paused' ? 'Pause' : 'Archive'} "${a.name}"`, summary: `Currently ${a.status}.`, details: [{ label: 'Journey', value: a.name }, { label: 'New status', value: i.status }], link: '/marketing/automations' };
  },
  async execute(ctx, i) {
    const r = await ctx.api.post(ctx.o(`/automations/${i.automationId}/status`), { status: i.status });
    return { result: { status: r.status ?? i.status }, link: '/marketing/automations' };
  },
});

const listSocialPosts = defineTool({
  name: 'list_social_posts',
  kind: 'read',
  area: 'marketing',
  modules: ['marketing.social'],
  description: 'Social posts (draft, pending approval, scheduled, published) with scheduled time and status.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/social/posts')),
  present: (r) => {
    const items = itemsOf(r);
    return {
      summary: `${plural(items.length, 'social post')}.`,
      blocks: items.length ? [table('Social posts', [{ key: 'body', label: 'Post' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'scheduledAt', label: 'Scheduled', kind: 'date' }], items.map((p) => ({ ...p, body: String(p.body ?? '').slice(0, 120) })))] : [],
      citations: [{ id: 'social', title: 'Social', url: '/marketing/social', sourceType: 'screen' }],
    };
  },
});

const createSocialDraft = defineTool({
  name: 'create_social_post_draft',
  kind: 'write',
  area: 'marketing',
  modules: ['marketing.social'],
  risk: 'change',
  description: 'Save a social post as a DRAFT for the brand accounts the person may post to (never publishes). Leave text empty to have it written in the brand voice from the brief.',
  input: z.object({ text: z.string().max(2200).optional(), brief: z.string().max(1000).optional(), location: z.string().max(120).optional(), scheduledAt: z.iso.datetime({ offset: true }).optional() }),
  async preview(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const accounts = itemsOf(await ctx.api.get(ctx.o('/social/postable-accounts'), { locationId: loc?.id }));
    if (!accounts.length) throw new ToolError('not_found', 'There is no connected social account you can post to.', 404);
    const text = i.text?.trim() || (await generateCopy(ctx, { kind: 'social', brief: i.brief ?? '', locale: ctx.locale })).text;
    i.text = text;
    return { title: 'Draft social post', summary: `For ${accounts.map((a) => a.handle).join(', ')}. Saved as a draft; nothing is published.`, details: [{ label: 'Accounts', value: accounts.map((a) => `${a.network} ${a.handle}`).join(', ') }, { label: 'Text', value: text }], link: '/marketing/social', editable: [{ key: 'text', label: 'Text', kind: 'textarea' }] };
  },
  async execute(ctx, i) {
    const loc = await resolveLocation(ctx, i.location);
    const accounts = itemsOf(await ctx.api.get(ctx.o('/social/postable-accounts'), { locationId: loc?.id }));
    const p = await ctx.api.post(ctx.o('/social/posts'), { locationId: loc?.id ?? null, body: i.text ?? '', accountIds: accounts.map((a) => a.id).slice(0, 20), scheduledAt: i.scheduledAt ?? null, submit: false });
    return { result: { postId: p.id, status: p.status ?? 'draft' }, link: '/marketing/social' };
  },
});

const listPages = defineTool({
  name: 'list_website_pages',
  kind: 'read',
  area: 'marketing',
  modules: ['marketing.website_builder'],
  description: 'Websites and their pages (per location): page id, title, slug, status and the public address.',
  input: z.object({}),
  run: (ctx) => ctx.api.get(ctx.o('/builder/sites')),
  present: (r) => {
    const rows = itemsOf(r).flatMap((w) => (w.pages ?? []).map((p: any) => ({ site: w.location?.name ?? 'Brand site', title: p.title, slug: p.slug, status: p.status, id: p.id })));
    return {
      summary: `${plural(itemsOf(r).length, 'website')} with ${plural(rows.length, 'page')}.`,
      blocks: rows.length ? [table('Website pages', [{ key: 'site', label: 'Site' }, { key: 'title', label: 'Page' }, { key: 'slug', label: 'Slug' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'id', label: 'Id' }], rows)] : [],
      citations: [{ id: 'builder', title: 'Website builder', url: '/marketing/websites', sourceType: 'screen' }],
    };
  },
});

const addSection = defineTool({
  name: 'add_website_section',
  kind: 'write',
  area: 'marketing',
  modules: ['marketing.website_builder'],
  risk: 'change',
  description: 'Add a section to a website page DRAFT (text, FAQ or call-to-action hero). Publishing stays a separate step in the website builder; locked brand sections are never changed.',
  input: z.object({
    pageId: z.uuid(),
    type: z.enum(['text', 'faq', 'hero']).default('text'),
    heading: z.string().max(140),
    body: z.string().max(6000).default(''),
    faq: z.array(z.object({ question: z.string().max(200), answer: z.string().max(1500) })).max(30).optional(),
  }),
  async preview(ctx, i) {
    const b = await ctx.api.get(ctx.o(`/pages/${i.pageId}/builder`));
    return { title: `Add a ${i.type} section to "${b.page?.title ?? 'page'}"`, summary: 'Saved to the draft; publish it from the website builder.', details: [{ label: 'Heading', value: i.heading }, { label: 'Text', value: i.body.slice(0, 600) || (i.faq ?? []).map((f) => f.question).join(' · ') }], link: '/marketing/websites', editable: [{ key: 'heading', label: 'Heading', kind: 'text' }, { key: 'body', label: 'Text', kind: 'textarea' }] };
  },
  async execute(ctx, i) {
    const b = await ctx.api.get(ctx.o(`/pages/${i.pageId}/builder`));
    const props = i.type === 'faq' ? { heading: i.heading, items: i.faq ?? [] } : i.type === 'hero' ? { eyebrow: '', heading: i.heading, body: i.body.slice(0, 400), ctaLabel: '', ctaHref: '', secondaryLabel: '', secondaryHref: '', image: '', imageAlt: '' } : { heading: i.heading, body: i.body };
    const document = { ...b.document, sections: [...(b.document?.sections ?? []), { id: `s${randomBytes(5).toString('hex')}`, type: i.type, props }] };
    await ctx.api.put(ctx.o(`/pages/${i.pageId}/document`), { document, baseRevision: b.page.revision, checkpoint: true, comment: 'Section added with the assistant' });
    return { result: { pageId: i.pageId, sections: document.sections.length }, link: '/marketing/websites' };
  },
});

const draftCopy = defineTool({
  name: 'draft_marketing_copy',
  kind: 'read',
  area: 'marketing',
  modules: ['marketing.campaigns', 'marketing.email', 'marketing.social', 'marketing.website_builder', 'marketing.ads'],
  description: 'Write marketing copy in the brand voice (email, social post, ad, website section or coming-soon campaign) with the organisation’s guardrails applied. Returns text only; nothing is saved.',
  input: z.object({ kind: z.enum(['email', 'social', 'ad', 'website_section', 'coming_soon']), brief: z.string().min(3).max(2000), locale: z.string().max(10).optional() }),
  run: (ctx, i) => generateCopy(ctx, { kind: i.kind, brief: i.brief, locale: i.locale ?? ctx.locale }),
  present: (r) => ({ summary: `Draft ${r.kind} copy:\n${r.text}${r.guardrails.bannedFound.length ? `\n(Removed banned claims: ${r.guardrails.bannedFound.join(', ')})` : ''}` }),
});

export default [listEmailCampaigns, createEmailDraft, sendEmailCampaign, listAutomations, setAutomationStatus, listSocialPosts, createSocialDraft, listPages, addSection, draftCopy];
