/**
 * Marketing workspace API: email builder (templates, render preview, test send), segments and campaigns with
 * consent-aware sending, contact tags, marketing settings (tracking, postal address, quiet hours), automations
 * (builder, activation, pause/resume, test run, run history), forms and submissions, the brand asset library and
 * follow-up tasks. Every list is filtered to the caller's locations.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import {
  AUTOMATION_TRIGGERS, emailDocumentSchema, formDefinitionSchema, marketingSettingsSchema, segmentRulesSchema, unknownTokens, validateAutomationGraph,
  type Permission, type ScopeKind, SCOPE_KINDS } from '@bh/shared';
import {
  assetBlobs, automationRuns, automationSteps, automations, brandAssets, campaigns, contactTags, customers, emailSends, emailTemplates, formSubmissions, forms,
  locations, marketingTasks, organizations, contactSegments, users,
} from '../db/schema/index.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { randomToken } from '../lib/crypto.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requirePerm, type ScopeTarget } from '../services/authz.ts';
import { advanceRun, recordAutomationAudit, testRun } from '../services/automation-engine.ts';
import { renderEmail } from '../services/email-render.ts';
import { addTag, campaignContent, campaignStats, consentedCustomerIds, emailBrandFor, marketingSettingsOf, parseRules, personalValues, removeTag, segmentMembers, sendMarketingEmail } from '../services/marketing.ts';
import { iso, isoDateTime, orgParams, secured } from './_common.ts';

const idp = z.object({ orgId: z.uuid(), id: z.uuid() });
const scopeSchema = z.object({ kind: z.enum(SCOPE_KINDS), id: z.uuid() });
const MAX_UPLOAD = 10 * 1024 * 1024;
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif', 'application/pdf', 'video/mp4', 'font/woff2'];

export const marketingRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  // Raw uploads for the asset library (encapsulated: only this plugin accepts binary bodies).
  app.addContentTypeParser(UPLOAD_TYPES, { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

  const orgScope = (orgId: string): ScopeTarget => ({ organizationId: orgId, kind: 'organization', id: orgId });
  const scopeOf = (orgId: string, locationId: string | null): ScopeTarget => (locationId ? { organizationId: orgId, kind: 'location', id: locationId } : orgScope(orgId));
  const allowed = (req: FastifyRequest, orgId: string, p: Permission) => authorisedLocations(req, s.db, orgId, p);
  const inAllowed = (a: 'all' | Set<string>, locationId: string | null) => a === 'all' || (!!locationId && a.has(locationId));
  /** HQ items (no location) are visible to anyone with the permission somewhere; editing them needs it at the organisation. */
  async function anywhere(req: FastifyRequest, orgId: string, p: Permission) {
    const a = await allowed(req, orgId, p);
    if (a !== 'all' && !a.size) throw forbidden(`Missing permission ${p}`);
    return a;
  }
  async function scopeLocationIds(orgId: string, kind: ScopeKind, id: string): Promise<string[] | 'all'> {
    if (kind === 'organization') return 'all';
    const col = kind === 'location' ? locations.id : kind === 'region' ? locations.regionId : locations.ownerGroupId;
    return (await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), eq(col, id)))).map((l) => l.id);
  }
  const intersect = (a: string[] | 'all', b: 'all' | Set<string>): string[] | 'all' => (a === 'all' ? (b === 'all' ? 'all' : [...b]) : b === 'all' ? a : a.filter((x) => b.has(x)));

  // ── Settings ──
  app.get('/orgs/:orgId/marketing/settings', { schema: { tags: ['marketing'], security: secured, params: orgParams } }, async (req) => {
    await anywhere(req, req.params.orgId, 'email.draft');
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, req.params.orgId));
    return { settings: marketingSettingsOf(org!), emailMode: s.mailer.mode, smsEnabled: s.messaging.smsEnabled, whatsappEnabled: s.messaging.whatsappEnabled, storageMode: s.assets.mode, jobsMode: s.jobs.mode };
  });
  app.put('/orgs/:orgId/marketing/settings', { schema: { tags: ['marketing'], security: secured, params: orgParams, body: marketingSettingsSchema, summary: 'Tracking (off by default), postal address, sender name, quiet hours' } }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'email.send', orgScope(orgId));
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    await s.db.update(organizations).set({ settings: { ...org!.settings, marketing: req.body }, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'marketing.settings_updated', scopeKind: 'organization', scopeId: orgId, targetType: 'organization', targetId: orgId, metadata: { tracking: req.body.tracking } });
    return { settings: req.body };
  });

  // ── Email templates ──
  const tplBody = z.object({ name: z.string().trim().min(1).max(120), subject: z.string().max(200).default(''), preheader: z.string().max(200).default(''), document: emailDocumentSchema, category: z.string().max(40).default('campaign'), locationId: z.uuid().nullable().default(null) });
  const tplView = (t: typeof emailTemplates.$inferSelect) => ({ ...t, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), archivedAt: iso(t.archivedAt), warnings: unknownTokens(t.document, t.subject).map((x) => `unknown_token:${x}`) });

  app.get('/orgs/:orgId/email/templates', { schema: { tags: ['marketing'], security: secured, params: orgParams } }, async (req) => {
    const a = await anywhere(req, req.params.orgId, 'email.draft');
    const rows = await s.db.select().from(emailTemplates).where(and(eq(emailTemplates.organizationId, req.params.orgId), isNull(emailTemplates.archivedAt))).orderBy(desc(emailTemplates.updatedAt));
    return { items: rows.filter((t) => !t.locationId || inAllowed(a, t.locationId)).map(tplView) };
  });
  app.post('/orgs/:orgId/email/templates', { schema: { tags: ['marketing'], security: secured, params: orgParams, body: tplBody } }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'email.draft', scopeOf(orgId, req.body.locationId));
    const [t] = await s.db.insert(emailTemplates).values({ ...req.body, organizationId: orgId, createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'email_template.created', targetType: 'email_template', targetId: t!.id });
    return reply.code(201).send(tplView(t!));
  });
  async function loadTpl(req: FastifyRequest, orgId: string, id: string, p: Permission = 'email.draft') {
    const [t] = await s.db.select().from(emailTemplates).where(and(eq(emailTemplates.id, id), eq(emailTemplates.organizationId, orgId)));
    if (!t) throw notFound('Email template');
    await requirePerm(req, s.db, p, scopeOf(orgId, t.locationId));
    return t;
  }
  app.get('/orgs/:orgId/email/templates/:id', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const a = await anywhere(req, req.params.orgId, 'email.draft');
    const [t] = await s.db.select().from(emailTemplates).where(and(eq(emailTemplates.id, req.params.id), eq(emailTemplates.organizationId, req.params.orgId)));
    if (!t || (t.locationId && !inAllowed(a, t.locationId))) throw notFound('Email template');
    return tplView(t);
  });
  app.put('/orgs/:orgId/email/templates/:id', { schema: { tags: ['marketing'], security: secured, params: idp, body: tplBody.omit({ locationId: true }) } }, async (req) => {
    const t = await loadTpl(req, req.params.orgId, req.params.id);
    const [u] = await s.db.update(emailTemplates).set({ ...req.body, updatedAt: new Date() }).where(eq(emailTemplates.id, t.id)).returning();
    return tplView(u!);
  });
  app.delete('/orgs/:orgId/email/templates/:id', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const t = await loadTpl(req, req.params.orgId, req.params.id);
    await s.db.update(emailTemplates).set({ archivedAt: new Date() }).where(eq(emailTemplates.id, t.id));
    return { id: t.id, archived: true };
  });

  app.post('/orgs/:orgId/email/render', {
    schema: { tags: ['marketing'], security: secured, params: orgParams, summary: 'Preview: MJML → email-safe HTML and plain text with sample personalisation', body: z.object({ document: emailDocumentSchema, subject: z.string().max(200).default(''), preheader: z.string().max(200).default(''), locationId: z.uuid().nullable().default(null) }) },
  }, async (req) => {
    const { orgId } = req.params;
    await anywhere(req, orgId, 'email.draft');
    const { brand, org } = await emailBrandFor(s.db, orgId);
    const settings = marketingSettingsOf(org);
    const [loc] = req.body.locationId ? await s.db.select().from(locations).where(and(eq(locations.id, req.body.locationId), eq(locations.organizationId, orgId))) : [];
    const me = requireUser(req);
    const [u] = await s.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, me.id));
    const address = settings.postalAddress || (loc ? [loc.address.line1, loc.address.postalCode, loc.address.city, loc.country].filter(Boolean).join(', ') : '');
    const r = await renderEmail({ document: req.body.document, subject: req.body.subject, preheader: req.body.preheader, brand, values: personalValues({ name: u?.name ?? '', email: u?.email ?? '' }, { locationName: loc?.name, businessName: org.name }), postalAddress: address, unsubscribeUrl: `${s.cfg.PUBLIC_API_URL}/v1/public/email/unsubscribe/preview`, locale: loc?.locale ?? org.defaultLocale });
    return { ...r, warnings: [...r.warnings, ...unknownTokens(req.body.document, req.body.subject).map((x) => `unknown_token:${x}`)] };
  });

  app.post('/orgs/:orgId/email/test', {
    schema: { tags: ['marketing'], security: secured, params: orgParams, summary: 'Send a test to yourself (sandbox when no email provider is configured)', body: z.object({ document: emailDocumentSchema, subject: z.string().min(1).max(200), preheader: z.string().max(200).default(''), locationId: z.uuid().nullable().default(null) }) },
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req) => {
    const { orgId } = req.params;
    await anywhere(req, orgId, 'email.draft');
    const me = requireUser(req);
    const [u] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, me.id));
    const r = await sendMarketingEmail(s, { organizationId: orgId, customer: null, to: u!.email, locationId: req.body.locationId, document: req.body.document, subject: req.body.subject, preheader: req.body.preheader, test: true });
    return { to: u!.email, status: r.status, sandbox: r.status === 'sandbox' };
  });

  // ── Segments & tags ──
  // Segments live in contact_segments (inbox routes: GET/POST /segments). Email audiences preview here, with consent.
  app.post('/orgs/:orgId/email/audience-preview', {
    schema: { tags: ['marketing'], security: secured, params: orgParams, summary: 'How many contacts match, and how many can be emailed (consent)', body: z.object({ scope: scopeSchema, rules: segmentRulesSchema }) },
  }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'email.draft', { organizationId: orgId, ...req.body.scope });
    const reach = intersect(await scopeLocationIds(orgId, req.body.scope.kind, req.body.scope.id), await allowed(req, orgId, 'customers.read').catch(() => new Set<string>()));
    const members = await segmentMembers(s.db, orgId, req.body.rules, reach);
    const consented = await consentedCustomerIds(s.db, members.filter((m) => m.email).map((m) => m.id), 'marketing_email');
    return { matching: members.length, emailable: consented.size, sample: members.slice(0, 5).map((m) => ({ id: m.id, name: m.name })) };
  });

  app.get('/orgs/:orgId/tags', { schema: { tags: ['marketing'], security: secured, params: orgParams } }, async (req) => {
    await anywhere(req, req.params.orgId, 'customers.read');
    const rows = await s.db.select({ tag: contactTags.tag, n: sql<number>`count(*)::int` }).from(contactTags).where(eq(contactTags.organizationId, req.params.orgId)).groupBy(contactTags.tag).orderBy(contactTags.tag);
    return { items: rows };
  });
  app.post('/orgs/:orgId/customers/:id/tags', { schema: { tags: ['marketing'], security: secured, params: idp, body: z.object({ add: z.array(z.string().trim().min(1).max(40)).max(20).default([]), remove: z.array(z.string().trim().min(1).max(40)).max(20).default([]) }) } }, async (req) => {
    const { orgId, id } = req.params;
    const [c] = await s.db.select().from(customers).where(and(eq(customers.id, id), eq(customers.organizationId, orgId)));
    if (!c?.locationId) throw notFound('Customer');
    await requirePerm(req, s.db, 'customers.write', scopeOf(orgId, c.locationId));
    for (const t of req.body.add) await addTag(s, orgId, id, t, `manual:${Date.now()}`);
    for (const t of req.body.remove) await removeTag(s.db, id, t);
    return { tags: (await s.db.select({ tag: contactTags.tag }).from(contactTags).where(eq(contactTags.customerId, id))).map((r) => r.tag) };
  });

  // ── Email campaigns (campaigns.channel = email) ──
  const campaignView = async (c: typeof campaigns.$inferSelect) => ({
    id: c.id, name: c.name, status: c.status, scope: { kind: c.scopeKind, id: c.scopeId }, startsAt: iso(c.startsAt), endsAt: iso(c.endsAt), createdAt: c.createdAt.toISOString(),
    subject: campaignContent(c.content).subject, segmentId: campaignContent(c.content).segmentId, recipientCount: Array.isArray(c.content.recipients) ? c.content.recipients.length : null,
    stats: await campaignStats(s.db, c.id),
  });
  app.get('/orgs/:orgId/email/campaigns', { schema: { tags: ['marketing'], security: secured, params: orgParams } }, async (req) => {
    const a = await anywhere(req, req.params.orgId, 'email.draft');
    const rows = await s.db.select().from(campaigns).where(and(eq(campaigns.organizationId, req.params.orgId), eq(campaigns.channel, 'email'))).orderBy(desc(campaigns.createdAt)).limit(200);
    const visible = rows.filter((c) => (c.scopeKind === 'organization' ? a === 'all' : c.scopeKind !== 'location' || inAllowed(a, c.scopeId)));
    return { items: await Promise.all(visible.map(campaignView)) };
  });
  app.post('/orgs/:orgId/email/campaigns', {
    schema: { tags: ['marketing'], security: secured, params: orgParams, body: z.object({ name: z.string().trim().min(1).max(120), scope: scopeSchema, subject: z.string().max(200).default(''), preheader: z.string().max(200).default(''), document: emailDocumentSchema, segmentId: z.uuid().nullable().default(null), templateId: z.uuid().nullable().default(null) }) },
  }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'email.draft', { organizationId: orgId, ...req.body.scope });
    const { scope, name, ...content } = req.body;
    const [c] = await s.db.insert(campaigns).values({ organizationId: orgId, name, channel: 'email', scopeKind: scope.kind, scopeId: scope.id, content, status: 'draft', createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'campaign.drafted', scopeKind: scope.kind, scopeId: scope.id, targetType: 'campaign', targetId: c!.id, metadata: { channel: 'email' } });
    return reply.code(201).send(await campaignView(c!));
  });
  async function loadCampaign(req: FastifyRequest, orgId: string, id: string, p: Permission) {
    const [c] = await s.db.select().from(campaigns).where(and(eq(campaigns.id, id), eq(campaigns.organizationId, orgId), eq(campaigns.channel, 'email')));
    if (!c) throw notFound('Campaign');
    await requirePerm(req, s.db, p, { organizationId: orgId, kind: c.scopeKind as ScopeKind, id: c.scopeId });
    return c;
  }
  app.get('/orgs/:orgId/email/campaigns/:id', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const c = await loadCampaign(req, req.params.orgId, req.params.id, 'email.draft');
    return { ...(await campaignView(c)), content: { subject: campaignContent(c.content).subject, preheader: campaignContent(c.content).preheader, document: campaignContent(c.content).document } };
  });
  app.put('/orgs/:orgId/email/campaigns/:id', {
    schema: { tags: ['marketing'], security: secured, params: idp, body: z.object({ name: z.string().trim().min(1).max(120), subject: z.string().max(200), preheader: z.string().max(200).default(''), document: emailDocumentSchema, segmentId: z.uuid().nullable() }) },
  }, async (req) => {
    const c = await loadCampaign(req, req.params.orgId, req.params.id, 'email.draft');
    if (c.status !== 'draft') throw conflict('campaign_locked', 'Only draft campaigns can be edited');
    const { name, ...content } = req.body;
    const [u] = await s.db.update(campaigns).set({ name, content: { ...c.content, ...content }, updatedAt: new Date() }).where(eq(campaigns.id, c.id)).returning();
    return campaignView(u!);
  });
  app.post('/orgs/:orgId/email/campaigns/:id/send', {
    schema: { tags: ['marketing'], security: secured, params: idp, summary: 'Send now or schedule. Recipients = segment ∩ campaign scope ∩ your customer access; consent is checked per recipient at send time.', body: z.object({ at: isoDateTime.nullable().default(null) }) },
  }, async (req) => {
    const { orgId } = req.params;
    const c = await loadCampaign(req, orgId, req.params.id, 'email.send');
    if (c.status !== 'draft') throw conflict('already_sent', 'This campaign was already sent or scheduled');
    const content = campaignContent(c.content);
    if (!content.subject.trim()) throw validationError('Add a subject line', { subject: 'Required' });
    if (!content.document.blocks.length) throw validationError('Add some content', { document: 'Empty' });
    if (!content.segmentId) throw validationError('Choose who receives it', { segmentId: 'Required' });
    const [seg] = await s.db.select().from(contactSegments).where(and(eq(contactSegments.id, content.segmentId), eq(contactSegments.organizationId, orgId)));
    if (!seg) throw notFound('Segment');
    const { org } = await emailBrandFor(s.db, orgId);
    const settings = marketingSettingsOf(org);
    const reach = intersect(intersect(await scopeLocationIds(orgId, c.scopeKind as ScopeKind, c.scopeId), await allowed(req, orgId, 'email.send')), await allowed(req, orgId, 'customers.read').catch(() => new Set<string>()));
    // Every email prints a postal address: the configured one, else the recipient's location address.
    void settings;
    const members = await segmentMembers(s.db, orgId, parseRules(seg.rules), reach);
    const recipients = members.filter((m) => m.email).map((m) => m.id);
    const at = req.body.at ? new Date(req.body.at) : null;
    const [u] = await s.db.update(campaigns).set({ status: at ? 'scheduled' : 'active', startsAt: at ?? new Date(), content: { ...c.content, recipients, sentBy: req.user!.id }, updatedAt: new Date() }).where(and(eq(campaigns.id, c.id), eq(campaigns.status, 'draft'))).returning();
    if (!u) throw conflict('already_sent', 'This campaign was already sent or scheduled');
    await audit(s.db, { organizationId: orgId, ...actor(req), action: at ? 'campaign.scheduled' : 'campaign.sent', scopeKind: c.scopeKind, scopeId: c.scopeId, targetType: 'campaign', targetId: c.id, metadata: { recipients: recipients.length, at: req.body.at } });
    if (!at) await s.jobs.enqueue('marketing.campaign', { campaignId: c.id }, { jobId: `campaign-${c.id}` });
    return campaignView(u);
  });
  app.get('/orgs/:orgId/email/campaigns/:id/recipients', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const c = await loadCampaign(req, req.params.orgId, req.params.id, 'email.draft');
    const a = await allowed(req, req.params.orgId, 'customers.read').catch(() => new Set<string>());
    const rows = await s.db.select().from(emailSends).where(eq(emailSends.campaignId, c.id)).orderBy(desc(emailSends.createdAt)).limit(500);
    return { items: rows.filter((r) => inAllowed(a, r.locationId)).map((r) => ({ id: r.id, customerId: r.customerId, email: r.email, status: r.status, skipReason: r.skipReason, sentAt: iso(r.sentAt), openedAt: iso(r.openedAt), clickedAt: iso(r.clickedAt), unsubscribedAt: iso(r.unsubscribedAt) })) };
  });

  // ── Automations ──
  const autoView = async (a: typeof automations.$inferSelect) => {
    const [stats] = await s.db.select({ total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where status in ('active','waiting'))::int`, completed: sql<number>`count(*) filter (where status = 'completed')::int` }).from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.test, false)));
    return { id: a.id, name: a.name, status: a.status, triggerEvent: a.triggerEvent, scope: { kind: a.scopeKind, id: a.scopeId }, graph: a.graph, version: a.version, activatedAt: iso(a.activatedAt), updatedAt: a.updatedAt.toISOString(), stats: stats ?? { total: 0, active: 0, completed: 0 } };
  };
  async function loadAuto(req: FastifyRequest, orgId: string, id: string) {
    const [a] = await s.db.select().from(automations).where(and(eq(automations.id, id), eq(automations.organizationId, orgId)));
    if (!a) throw notFound('Automation');
    await requirePerm(req, s.db, 'automations.manage', { organizationId: orgId, kind: a.scopeKind as ScopeKind, id: a.scopeId });
    return a;
  }
  const graphOrThrow = (g: unknown) => {
    const r = validateAutomationGraph(g);
    if (!r.graph) throw new AppError(422, 'automation_invalid', 'The flow could not be read', undefined, { issues: r.issues });
    return r;
  };
  app.get('/orgs/:orgId/automations', { schema: { tags: ['marketing'], security: secured, params: orgParams } }, async (req) => {
    const a = await anywhere(req, req.params.orgId, 'automations.manage');
    const rows = await s.db.select().from(automations).where(and(eq(automations.organizationId, req.params.orgId), or(eq(automations.status, 'draft'), eq(automations.status, 'active'), eq(automations.status, 'paused')))).orderBy(desc(automations.updatedAt));
    return { items: await Promise.all(rows.filter((x) => (x.scopeKind === 'organization' ? a === 'all' : x.scopeKind !== 'location' || inAllowed(a, x.scopeId))).map(autoView)), triggers: AUTOMATION_TRIGGERS };
  });
  app.post('/orgs/:orgId/automations', { schema: { tags: ['marketing'], security: secured, params: orgParams, body: z.object({ name: z.string().trim().min(1).max(120), scope: scopeSchema, graph: z.unknown() }) } }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'automations.manage', { organizationId: orgId, ...req.body.scope });
    const g = graphOrThrow(req.body.graph);
    const trig = g.graph!.nodes.find((n) => n.type === 'trigger');
    const [a] = await s.db.insert(automations).values({ organizationId: orgId, scopeKind: req.body.scope.kind, scopeId: req.body.scope.id, name: req.body.name, triggerEvent: trig?.type === 'trigger' ? trig.config.event : 'lead.created', graph: g.graph!, createdBy: req.user!.id }).returning();
    await recordAutomationAudit(s, a!, req.user!.id, 'automation.created');
    return reply.code(201).send({ ...(await autoView(a!)), issues: g.issues });
  });
  app.get('/orgs/:orgId/automations/:id', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const a = await loadAuto(req, req.params.orgId, req.params.id);
    return { ...(await autoView(a)), issues: validateAutomationGraph(a.graph).issues };
  });
  app.put('/orgs/:orgId/automations/:id', { schema: { tags: ['marketing'], security: secured, params: idp, body: z.object({ name: z.string().trim().min(1).max(120), graph: z.unknown(), version: z.number().int().min(1) }) } }, async (req) => {
    const a = await loadAuto(req, req.params.orgId, req.params.id);
    if (a.version !== req.body.version) throw conflict('revision_conflict', 'This automation was changed somewhere else. Reload to continue.', { version: a.version });
    const g = graphOrThrow(req.body.graph);
    if (a.status === 'active' && !g.ok) throw new AppError(422, 'automation_invalid', 'Fix the flow before saving an active automation', undefined, { issues: g.issues });
    const trig = g.graph!.nodes.find((n) => n.type === 'trigger');
    const [u] = await s.db.update(automations).set({ name: req.body.name, graph: g.graph!, triggerEvent: trig?.type === 'trigger' ? trig.config.event : a.triggerEvent, version: a.version + 1, updatedAt: new Date() }).where(eq(automations.id, a.id)).returning();
    return { ...(await autoView(u!)), issues: g.issues };
  });
  app.post('/orgs/:orgId/automations/:id/status', { schema: { tags: ['marketing'], security: secured, params: idp, summary: 'Activate, pause, resume or archive', body: z.object({ status: z.enum(['active', 'paused', 'archived']) }) } }, async (req) => {
    const a = await loadAuto(req, req.params.orgId, req.params.id);
    if (req.body.status === 'active') {
      const g = validateAutomationGraph(a.graph);
      if (!g.ok) throw new AppError(422, 'automation_invalid', 'Fix the flow before turning it on', undefined, { issues: g.issues });
      const missingTemplate = a.graph.nodes.some((n) => n.type === 'action' && n.config.action === 'send_email' && !n.config.templateId);
      if (missingTemplate) throw new AppError(422, 'automation_invalid', 'Choose an email for every “send email” step', undefined, { issues: [{ nodeId: null, code: 'email_missing' }] });
    }
    const [u] = await s.db.update(automations).set({ status: req.body.status, activatedAt: req.body.status === 'active' && a.status !== 'paused' ? new Date() : a.activatedAt, updatedAt: new Date() }).where(eq(automations.id, a.id)).returning();
    await recordAutomationAudit(s, a, req.user!.id, `automation.${req.body.status}`);
    if (req.body.status === 'active' && a.status === 'paused') {
      // Resume: runs that became due while paused continue now.
      const due = await s.db.select({ id: automationRuns.id }).from(automationRuns).where(and(eq(automationRuns.automationId, a.id), inArray(automationRuns.status, ['active', 'waiting'])));
      for (const r of due) await s.jobs.enqueue('automation.advance', { runId: r.id });
    }
    return autoView(u!);
  });
  app.post('/orgs/:orgId/automations/:id/test-run', {
    schema: { tags: ['marketing'], security: secured, params: idp, summary: 'Run the flow now with yourself as the contact: delays are skipped, messages go to you (sandbox without providers)', body: z.object({ locationId: z.uuid().nullable().default(null), phone: z.string().max(30).nullable().default(null) }) },
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req) => {
    const a = await loadAuto(req, req.params.orgId, req.params.id);
    const g = validateAutomationGraph(a.graph);
    if (!g.ok) throw new AppError(422, 'automation_invalid', 'Fix the flow before testing it', undefined, { issues: g.issues });
    const me = requireUser(req);
    const [u] = await s.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, me.id));
    const runId = await testRun(s, a, { userId: me.id, email: u!.email, name: u!.name, phone: req.body.phone }, req.body.locationId);
    const steps = await s.db.select().from(automationSteps).where(eq(automationSteps.runId, runId)).orderBy(automationSteps.createdAt);
    const [run] = await s.db.select().from(automationRuns).where(eq(automationRuns.id, runId));
    return { runId, status: run!.status, steps: steps.map((x) => ({ nodeId: x.nodeId, nodeType: x.nodeType, status: x.status, result: x.result })) };
  });
  app.get('/orgs/:orgId/automations/:id/runs', { schema: { tags: ['marketing'], security: secured, params: idp, querystring: z.object({ customerId: z.uuid().optional() }) } }, async (req) => {
    const a = await loadAuto(req, req.params.orgId, req.params.id);
    const reach = await allowed(req, req.params.orgId, 'customers.read').catch(() => new Set<string>());
    const conds = [eq(automationRuns.automationId, a.id)];
    if (req.query.customerId) conds.push(eq(automationRuns.customerId, req.query.customerId));
    const runs = await s.db.select({ r: automationRuns, name: customers.name }).from(automationRuns).leftJoin(customers, eq(customers.id, automationRuns.customerId)).where(and(...conds)).orderBy(desc(automationRuns.startedAt)).limit(100);
    const visible = runs.filter(({ r }) => r.test || inAllowed(reach, r.locationId));
    const steps = visible.length ? await s.db.select().from(automationSteps).where(inArray(automationSteps.runId, visible.map(({ r }) => r.id))) : [];
    return {
      items: visible.map(({ r, name }) => ({
        id: r.id, test: r.test, status: r.status, customer: r.customerId ? { id: r.customerId, name } : null, currentNodeId: r.currentNodeId, nextRunAt: iso(r.nextRunAt), startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt), error: r.error,
        steps: steps.filter((x) => x.runId === r.id).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime()).map((x) => ({ nodeId: x.nodeId, nodeType: x.nodeType, status: x.status, result: x.result, at: x.createdAt.toISOString() })),
      })),
    };
  });
  app.post('/orgs/:orgId/automations/runs/:id/stop', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const [r] = await s.db.select().from(automationRuns).where(and(eq(automationRuns.id, req.params.id), eq(automationRuns.organizationId, req.params.orgId)));
    if (!r) throw notFound('Run');
    await loadAuto(req, req.params.orgId, r.automationId);
    await s.db.update(automationRuns).set({ status: 'stopped', finishedAt: new Date(), error: 'stopped_by_user' }).where(and(eq(automationRuns.id, r.id), inArray(automationRuns.status, ['active', 'waiting'])));
    return { id: r.id, stopped: true };
  });
  // Internal: advance a run now (used by the dashboard "retry" and tests).
  app.post('/orgs/:orgId/automations/runs/:id/advance', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const [r] = await s.db.select().from(automationRuns).where(and(eq(automationRuns.id, req.params.id), eq(automationRuns.organizationId, req.params.orgId)));
    if (!r) throw notFound('Run');
    await loadAuto(req, req.params.orgId, r.automationId);
    await advanceRun(s, r.id);
    return { id: r.id };
  });

  // ── Forms ──
  const formView = (f: typeof forms.$inferSelect, submissions = 0) => ({ ...f, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(), submissions, publicPath: `/f/${f.id}` });
  app.get('/orgs/:orgId/forms', { schema: { tags: ['marketing'], security: secured, params: orgParams } }, async (req) => {
    const a = await anywhere(req, req.params.orgId, 'forms.manage');
    const rows = await s.db.select().from(forms).where(and(eq(forms.organizationId, req.params.orgId), or(eq(forms.status, 'draft'), eq(forms.status, 'published')))).orderBy(desc(forms.updatedAt));
    const visible = rows.filter((f) => !f.locationId || inAllowed(a, f.locationId));
    const counts = visible.length ? await s.db.select({ id: formSubmissions.formId, n: sql<number>`count(*)::int` }).from(formSubmissions).where(inArray(formSubmissions.formId, visible.map((f) => f.id))).groupBy(formSubmissions.formId) : [];
    return { items: visible.map((f) => formView(f, counts.find((c) => c.id === f.id)?.n ?? 0)) };
  });
  app.post('/orgs/:orgId/forms', { schema: { tags: ['marketing'], security: secured, params: orgParams, body: formDefinitionSchema.extend({ locationId: z.uuid().nullable().default(null) }) } }, async (req, reply) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'forms.manage', scopeOf(orgId, req.body.locationId));
    const [f] = await s.db.insert(forms).values({ organizationId: orgId, locationId: req.body.locationId, name: req.body.name, fields: req.body.fields, settings: req.body.settings, createdBy: req.user!.id }).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'form.created', targetType: 'form', targetId: f!.id });
    return reply.code(201).send(formView(f!));
  });
  async function loadForm(req: FastifyRequest, orgId: string, id: string) {
    const [f] = await s.db.select().from(forms).where(and(eq(forms.id, id), eq(forms.organizationId, orgId)));
    if (!f) throw notFound('Form');
    await requirePerm(req, s.db, 'forms.manage', scopeOf(orgId, f.locationId));
    return f;
  }
  app.get('/orgs/:orgId/forms/:id', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => formView(await loadForm(req, req.params.orgId, req.params.id)));
  app.put('/orgs/:orgId/forms/:id', { schema: { tags: ['marketing'], security: secured, params: idp, body: formDefinitionSchema.extend({ status: z.enum(['draft', 'published']).optional() }) } }, async (req) => {
    const f = await loadForm(req, req.params.orgId, req.params.id);
    const ids = req.body.fields.map((x) => x.id);
    if (new Set(ids).size !== ids.length) throw validationError('Two fields have the same key', { fields: 'Duplicate key' });
    if (req.body.settings.routing === 'visitor_choice' && !req.body.fields.some((x) => x.type === 'location')) throw validationError('Add a location field so visitors can choose', { routing: 'Needs a location field' });
    const [u] = await s.db.update(forms).set({ name: req.body.name, fields: req.body.fields, settings: req.body.settings, status: req.body.status ?? f.status, updatedAt: new Date() }).where(eq(forms.id, f.id)).returning();
    return formView(u!);
  });
  app.delete('/orgs/:orgId/forms/:id', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const f = await loadForm(req, req.params.orgId, req.params.id);
    await s.db.update(forms).set({ status: 'archived', updatedAt: new Date() }).where(eq(forms.id, f.id));
    return { id: f.id, archived: true };
  });
  app.get('/orgs/:orgId/forms/:id/submissions', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const f = await loadForm(req, req.params.orgId, req.params.id);
    const reach = await allowed(req, req.params.orgId, 'customers.read').catch(() => new Set<string>());
    const rows = await s.db.select().from(formSubmissions).where(eq(formSubmissions.formId, f.id)).orderBy(desc(formSubmissions.createdAt)).limit(200);
    // Answers are customer data: only people with customer access at that location see them.
    return { items: rows.map((r) => ({ id: r.id, locationId: r.locationId, leadId: r.leadId, createdAt: r.createdAt.toISOString(), consents: r.consents, data: inAllowed(reach, r.locationId) ? r.data : null })) };
  });

  // ── Brand asset library ──
  const assetView = (a: typeof brandAssets.$inferSelect) => ({
    id: a.id, locationId: a.locationId, folder: a.folder, name: a.name, mime: a.mime, size: a.size, url: a.url, alt: a.alt, usageRights: a.usageRights,
    rightsExpireAt: iso(a.rightsExpireAt), expired: !!a.rightsExpireAt && a.rightsExpireAt < new Date(), shareMode: a.shareMode, sharedLocationIds: a.sharedLocationIds, createdAt: a.createdAt.toISOString(),
  });
  const canSee = (a: typeof brandAssets.$inferSelect, reach: 'all' | Set<string>) => reach === 'all' || (a.locationId ? reach.has(a.locationId) : a.shareMode === 'all_locations' || (a.shareMode === 'selected' && a.sharedLocationIds.some((l) => reach.has(l))));

  app.get('/orgs/:orgId/assets', { schema: { tags: ['marketing'], security: secured, params: orgParams, querystring: z.object({ folder: z.string().max(120).optional(), q: z.string().max(80).optional(), type: z.enum(['image', 'video', 'document', 'any']).default('any') }) } }, async (req) => {
    const { orgId } = req.params;
    const reach = await anywhere(req, orgId, 'website.edit').catch(() => anywhere(req, orgId, 'assets.manage'));
    const rows = await s.db.select().from(brandAssets).where(and(eq(brandAssets.organizationId, orgId), isNull(brandAssets.archivedAt))).orderBy(desc(brandAssets.createdAt)).limit(1000);
    const visible = rows.filter((a) => canSee(a, reach))
      .filter((a) => req.query.folder === undefined || a.folder === req.query.folder)
      .filter((a) => !req.query.q || a.name.toLowerCase().includes(req.query.q.toLowerCase()))
      .filter((a) => req.query.type === 'any' || (req.query.type === 'image' ? a.mime.startsWith('image/') : req.query.type === 'video' ? a.mime.startsWith('video/') : !a.mime.startsWith('image/') && !a.mime.startsWith('video/')));
    const folders = [...new Set(rows.filter((a) => canSee(a, reach)).map((a) => a.folder))].sort();
    return { items: visible.map(assetView), folders, storageMode: s.assets.mode };
  });
  app.post('/orgs/:orgId/assets/upload', {
    schema: { tags: ['marketing'], security: secured, params: orgParams, summary: 'Upload a file (raw body with its Content-Type, max 10 MB)', querystring: z.object({ name: z.string().trim().min(1).max(160), folder: z.string().max(120).default(''), locationId: z.uuid().optional() }) },
    bodyLimit: MAX_UPLOAD,
  }, async (req, reply) => {
    const { orgId } = req.params;
    const locationId = req.query.locationId ?? null;
    await requirePerm(req, s.db, 'assets.manage', scopeOf(orgId, locationId));
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const body = req.body as unknown;
    if (!UPLOAD_TYPES.includes(mime) || !Buffer.isBuffer(body)) throw validationError('Upload an image, video, PDF or font file', { file: 'Unsupported type' });
    if (!body.length) throw validationError('The file is empty', { file: 'Empty' });
    if (mime === 'image/svg+xml' && /<script|on\w+=|javascript:/i.test(body.toString('utf8'))) throw validationError('This SVG contains scripts', { file: 'Unsafe SVG' });
    const ext = mime.split('/')[1]!.replace('svg+xml', 'svg').replace('jpeg', 'jpg');
    const safeName = req.query.name.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120) || `file.${ext}`;
    const out = await s.db.transaction(async (tx) => {
      const [a] = await tx.insert(brandAssets).values({ organizationId: orgId, locationId, folder: req.query.folder.trim(), name: safeName, mime, size: body.length, storage: s.assets.mode, storageKey: '', url: '', createdBy: req.user!.id }).returning();
      const key = `${orgId}/${a!.id}/${randomToken(6)}.${ext}`;
      let url = `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/public/assets/${a!.id}/${encodeURIComponent(`${a!.id}.${ext}`)}`;
      if (s.assets.mode === 's3') {
        const r = await s.assets.put(key, body, mime);
        if (r.url) url = r.url;
      } else {
        await tx.insert(assetBlobs).values({ assetId: a!.id, data: body });
      }
      const [u] = await tx.update(brandAssets).set({ storageKey: key, url }).where(eq(brandAssets.id, a!.id)).returning();
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'asset.uploaded', scopeKind: locationId ? 'location' : 'organization', scopeId: locationId ?? orgId, targetType: 'asset', targetId: a!.id, metadata: { mime, size: body.length, storage: s.assets.mode } });
      return u!;
    });
    return reply.code(201).send(assetView(out));
  });
  app.patch('/orgs/:orgId/assets/:id', {
    schema: { tags: ['marketing'], security: secured, params: idp, body: z.object({ name: z.string().trim().min(1).max(160).optional(), folder: z.string().max(120).optional(), alt: z.string().max(240).optional(), usageRights: z.string().max(500).optional(), rightsExpireAt: isoDateTime.nullable().optional(), shareMode: z.enum(['private', 'all_locations', 'selected']).optional(), sharedLocationIds: z.array(z.uuid()).max(500).optional() }) },
  }, async (req) => {
    const { orgId, id } = req.params;
    const [a] = await s.db.select().from(brandAssets).where(and(eq(brandAssets.id, id), eq(brandAssets.organizationId, orgId)));
    if (!a) throw notFound('Asset');
    await requirePerm(req, s.db, 'assets.manage', scopeOf(orgId, a.locationId));
    if ((req.body.shareMode || req.body.sharedLocationIds) && a.locationId) throw validationError('Only headquarters assets can be shared with locations', { shareMode: 'HQ only' });
    const b = req.body;
    const [u] = await s.db.update(brandAssets).set({ ...b, rightsExpireAt: b.rightsExpireAt === undefined ? a.rightsExpireAt : b.rightsExpireAt ? new Date(b.rightsExpireAt) : null, updatedAt: new Date() }).where(eq(brandAssets.id, id)).returning();
    return assetView(u!);
  });
  app.delete('/orgs/:orgId/assets/:id', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const { orgId, id } = req.params;
    const [a] = await s.db.select().from(brandAssets).where(and(eq(brandAssets.id, id), eq(brandAssets.organizationId, orgId)));
    if (!a) throw notFound('Asset');
    await requirePerm(req, s.db, 'assets.manage', scopeOf(orgId, a.locationId));
    await s.db.update(brandAssets).set({ archivedAt: new Date() }).where(eq(brandAssets.id, id));
    return { id, archived: true };
  });

  // ── Follow-up tasks ──
  app.get('/orgs/:orgId/marketing/tasks', { schema: { tags: ['marketing'], security: secured, params: orgParams } }, async (req) => {
    const reach = await anywhere(req, req.params.orgId, 'customers.read');
    const rows = await s.db.select({ t: marketingTasks, name: customers.name }).from(marketingTasks).leftJoin(customers, eq(customers.id, marketingTasks.customerId)).where(and(eq(marketingTasks.organizationId, req.params.orgId), eq(marketingTasks.status, 'open'))).orderBy(marketingTasks.dueAt).limit(200);
    return { items: rows.filter(({ t }) => inAllowed(reach, t.locationId)).map(({ t, name }) => ({ id: t.id, title: t.title, locationId: t.locationId, customer: t.customerId ? { id: t.customerId, name } : null, dueAt: iso(t.dueAt), source: t.source })) };
  });
  app.post('/orgs/:orgId/marketing/tasks/:id/complete', { schema: { tags: ['marketing'], security: secured, params: idp } }, async (req) => {
    const [t] = await s.db.select().from(marketingTasks).where(and(eq(marketingTasks.id, req.params.id), eq(marketingTasks.organizationId, req.params.orgId)));
    if (!t) throw notFound('Task');
    await requirePerm(req, s.db, 'customers.write', scopeOf(req.params.orgId, t.locationId));
    await s.db.update(marketingTasks).set({ status: 'done', completedAt: new Date() }).where(eq(marketingTasks.id, t.id));
    return { id: t.id, done: true };
  });
};
