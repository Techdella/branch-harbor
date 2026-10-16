/**
 * Public Marketing endpoints (no sign-in): form definitions and submissions (→ leads, with consent and spam
 * protection), newsletter sign-up, email unsubscribe and optional tracking, uploaded assets and site redirects.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { resolveTheme, validateSubmission, type SiteFont } from '@bh/shared';
import { assetBlobs, brandAssets, consentRecords, emailSends, formSubmissions, forms, locations, organizations, siteRedirects, websites } from '../db/schema/index.ts';
import { createRoutedLead } from '../services/lead-routing.ts';
import { sha256 } from '../lib/crypto.ts';
import { AppError, notFound, validationError } from '../lib/errors.ts';
import { addTag, emitMarketingEvent, marketingSettingsOf, upsertContact } from '../services/marketing.ts';
import { siteSlugCond } from '../services/brands.ts';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const UNSUB_COPY: Record<string, { title: string; body: string; button: string; done: string }> = {
  en: { title: 'Unsubscribe', body: 'Stop receiving marketing emails from {business}?', button: 'Unsubscribe', done: 'You have been unsubscribed. You will not receive marketing emails from {business} any more.' },
  fr: { title: 'Se désabonner', body: 'Ne plus recevoir les e-mails marketing de {business} ?', button: 'Se désabonner', done: 'Votre désabonnement est confirmé. Vous ne recevrez plus d’e-mails marketing de {business}.' },
  es: { title: 'Darse de baja', body: '¿Dejar de recibir correos de marketing de {business}?', button: 'Darse de baja', done: 'Te has dado de baja. Ya no recibirás correos de marketing de {business}.' },
  de: { title: 'Abmelden', body: 'Keine Marketing-E-Mails mehr von {business} erhalten?', button: 'Abmelden', done: 'Sie wurden abgemeldet und erhalten keine Marketing-E-Mails mehr von {business}.' },
  pt: { title: 'Cancelar inscrição', body: 'Deixar de receber e-mails de marketing de {business}?', button: 'Cancelar inscrição', done: 'Inscrição cancelada. Você não receberá mais e-mails de marketing de {business}.' },
  nl: { title: 'Afmelden', body: 'Geen marketingmails meer ontvangen van {business}?', button: 'Afmelden', done: 'Je bent afgemeld en ontvangt geen marketingmails meer van {business}.' },
  it: { title: 'Annulla iscrizione', body: 'Non ricevere più email di marketing da {business}?', button: 'Annulla iscrizione', done: 'Iscrizione annullata. Non riceverai più email di marketing da {business}.' },
  ar: { title: 'إلغاء الاشتراك', body: 'هل تريد إيقاف رسائل التسويق من {business}؟', button: 'إلغاء الاشتراك', done: 'تم إلغاء اشتراكك ولن تتلقى رسائل تسويقية من {business} بعد الآن.' },
};
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const submitBody = z.object({
  data: z.record(z.string(), z.unknown()),
  consents: z.record(z.string(), z.boolean()).default({}),
  /** Honeypot: humans never fill it. */
  website: z.string().max(200).optional(),
  /** When the form was rendered (ms since epoch): submissions faster than a person can type are refused. */
  startedAt: z.number().int().optional(),
  turnstileToken: z.string().max(2048).optional(),
  pageUrl: z.string().max(2048).optional(),
});

export const marketingPublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const tags = ['public marketing'];
  // The unsubscribe confirmation is a plain HTML form (works without JavaScript); its body carries nothing we need.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => done(null, {}));

  async function publishedForm(id: string) {
    const [row] = await s.db.select({ f: forms, o: organizations }).from(forms).innerJoin(organizations, eq(organizations.id, forms.organizationId)).where(and(eq(forms.id, id), eq(forms.status, 'published'), isNull(organizations.deletedAt)));
    if (!row) throw notFound('Form');
    return row;
  }
  const publicLocations = (orgId: string) => s.db.select({ id: locations.id, name: locations.name, slug: locations.slug }).from(locations).where(and(eq(locations.organizationId, orgId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));

  app.get('/public/forms/:id', { schema: { tags, summary: 'Published form definition (fields, consent wording, landing page, brand theme)', params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const { f, o } = await publishedForm(req.params.id);
    const site = (o.settings.site ?? {}) as { themeId?: string; colorMode?: 'theme' | 'brand'; primaryColor?: string; accentColor?: string; headingFont?: SiteFont; bodyFont?: SiteFont; logoUrl?: string };
    reply.header('cache-control', 'public, max-age=30');
    return {
      id: f.id, name: f.name, fields: f.fields,
      settings: { submitLabel: f.settings.submitLabel, successMessage: f.settings.successMessage, consents: f.settings.consents.map((c) => ({ purpose: c.purpose, label: c.label })), landing: f.settings.landing, routing: f.settings.routing },
      locations: f.fields.some((x) => x.type === 'location') ? await publicLocations(o.id) : [],
      brand: { name: o.name, slug: o.slug, logoUrl: site.logoUrl ?? null, defaultLocale: o.defaultLocale, theme: resolveTheme(site.themeId ?? 'classic', { colorMode: site.colorMode ?? (site.themeId ? 'theme' : 'brand'), primaryColor: site.primaryColor, accentColor: site.accentColor, headingFont: site.headingFont, bodyFont: site.bodyFont }) },
      botCheck: s.botCheck.enabled,
    };
  });

  app.post('/public/forms/:id/submit', {
    schema: { tags, summary: 'Submit a form: creates a lead (routed to a location), records consent, tags the contact and starts automations', params: z.object({ id: z.uuid() }), body: submitBody },
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const { f, o } = await publishedForm(req.params.id);
    const b = req.body;
    // Spam protection: honeypot (silently accepted), minimum fill time, optional Turnstile.
    if (b.website) return { ok: true, message: f.settings.successMessage || null };
    if (b.startedAt && Date.now() - b.startedAt < 1500) throw new AppError(422, 'too_fast', 'Please take a moment to fill in the form');
    if (!(await s.botCheck.verify(b.turnstileToken, req.ip))) throw new AppError(422, 'bot_check_failed', 'We could not verify this submission. Try again.');
    const locs = await publicLocations(o.id);
    const v = validateSubmission(f.fields, b.data, locs.map((l) => l.id));
    if (!v.ok) throw validationError('Some answers need attention', Object.fromEntries(Object.entries(v.errors).map(([k, code]) => [k, code === 'required' ? 'Required' : 'Invalid'])));
    const pick = (m: string) => { const fld = f.fields.find((x) => x.maps === m); const val = fld ? v.values[fld.id] : undefined; return typeof val === 'string' && val ? val : null; };
    const locField = f.fields.find((x) => x.type === 'location');
    const locationId = f.settings.routing === 'visitor_choice' && locField && typeof v.values[locField.id] === 'string' ? (v.values[locField.id] as string) : f.locationId;
    const allowedConsents = new Set(f.settings.consents.map((c) => c.purpose));
    const granted = Object.fromEntries(Object.entries(b.consents).filter(([k]) => allowedConsents.has(k as never)));
    const ipHash = sha256(`${req.ip}|${new Date().toISOString().slice(0, 10)}|${s.cfg.JWT_SECRET.slice(0, 8)}`);
    const out = await s.db.transaction(async (tx) => {
      const contact = await upsertContact(tx, o.id, { name: pick('name'), email: pick('email'), phone: pick('phone'), locationId });
      // One leads pipeline: the lead goes through the lead routing rules (Sales → Leads) like every other enquiry.
      const lead = await createRoutedLead(tx, { organizationId: o.id, kind: 'customer', locationId, customerId: contact?.id ?? null, source: 'form', name: pick('name'), email: pick('email'), phone: pick('phone'), message: pick('message') });
      for (const c of f.settings.consents) {
        if (granted[c.purpose] === true && contact) await tx.insert(consentRecords).values({ organizationId: o.id, customerId: contact.id, email: contact.email, purpose: c.purpose, version: c.version, granted: true, source: `form:${f.id}`, ip: ipHash });
      }
      const [sub] = await tx.insert(formSubmissions).values({ organizationId: o.id, formId: f.id, locationId, leadId: lead.id, customerId: contact?.id ?? null, data: v.values, consents: granted, ipHash, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300), pageUrl: b.pageUrl?.slice(0, 2048) ?? null }).returning();
      return { contact, lead, submission: sub! };
    });
    if (out.contact) {
      await emitMarketingEvent(s, { organizationId: o.id, type: 'form.submitted', key: `submission:${out.submission.id}`, customerId: out.contact.id, locationId, data: { formId: f.id, source: 'form' } });
      await emitMarketingEvent(s, { organizationId: o.id, type: 'lead.created', key: `lead:${out.lead.id}`, customerId: out.contact.id, locationId, data: { source: 'form', formId: f.id } });
      if (f.settings.tag) await addTag(s, o.id, out.contact.id, f.settings.tag, `submission:${out.submission.id}`);
    }
    for (const to of f.settings.notifyEmails) {
      await s.jobs.enqueue('email.send', { to, subject: `${f.name}: ${pick('name') ?? pick('email') ?? ''}`.trim(), text: f.fields.map((x) => `${x.label}: ${String(v.values[x.id] ?? '')}`).join('\n'), tag: 'form-submission' });
    }
    return reply.code(201).send({ ok: true, message: f.settings.successMessage || null });
  });

  app.post('/public/marketing/newsletter', {
    schema: { tags, summary: 'Newsletter sign-up from a website section (explicit consent required)', body: z.object({ brandSlug: z.string().min(1).max(80), locationSlug: z.string().max(80).optional(), email: z.email().max(200), name: z.string().max(120).optional(), consent: z.literal(true), website: z.string().max(200).optional(), startedAt: z.number().int().optional(), turnstileToken: z.string().max(2048).optional() }) },
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const b = req.body;
    if (b.website) return { ok: true };
    if (b.startedAt && Date.now() - b.startedAt < 1500) throw new AppError(422, 'too_fast', 'Please take a moment to fill in the form');
    if (!(await s.botCheck.verify(b.turnstileToken, req.ip))) throw new AppError(422, 'bot_check_failed', 'We could not verify this submission. Try again.');
    const [o] = await s.db.select().from(organizations).where(and(siteSlugCond(b.brandSlug), isNull(organizations.deletedAt), ne(organizations.status, 'suspended')));
    if (!o) throw notFound('Site');
    const [loc] = b.locationSlug ? await s.db.select().from(locations).where(and(eq(locations.organizationId, o.id), eq(locations.slug, b.locationSlug), eq(locations.publiclyVisible, true))) : [];
    const ipHash = sha256(`${req.ip}|${new Date().toISOString().slice(0, 10)}|${s.cfg.JWT_SECRET.slice(0, 8)}`);
    const out = await s.db.transaction(async (tx) => {
      const contact = await upsertContact(tx, o.id, { name: b.name ?? null, email: b.email, phone: null, locationId: loc?.id ?? null });
      await tx.insert(consentRecords).values({ organizationId: o.id, customerId: contact!.id, email: b.email, purpose: 'marketing_email', version: 'newsletter-1', granted: true, source: 'website_newsletter', ip: ipHash });
      const lead = await createRoutedLead(tx, { organizationId: o.id, kind: 'customer', locationId: loc?.id ?? null, customerId: contact!.id, source: 'newsletter', name: b.name ?? null, email: b.email });
      return { contact: contact!, lead };
    });
    await emitMarketingEvent(s, { organizationId: o.id, type: 'lead.created', key: `lead:${out.lead.id}`, customerId: out.contact.id, locationId: loc?.id ?? null, data: { source: 'newsletter' } });
    await addTag(s, o.id, out.contact.id, 'newsletter', `newsletter:${out.lead.id}`);
    return reply.code(201).send({ ok: true });
  });

  // ── Email: unsubscribe (GET shows a confirmation so link scanners never unsubscribe anyone) ──
  async function sendByToken(token: string) {
    const [row] = await s.db.select({ e: emailSends, o: organizations }).from(emailSends).innerJoin(organizations, eq(organizations.id, emailSends.organizationId)).where(eq(emailSends.token, token));
    return row ?? null;
  }
  const page = (lang: string, title: string, body: string, form?: { action: string; button: string }) => `<!doctype html><html lang="${esc(lang)}"${lang === 'ar' ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;background:#f4f4f2;color:#141414;margin:0;padding:48px 16px}main{max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px}button{min-height:44px;padding:10px 22px;border-radius:999px;border:0;background:#141414;color:#fff;font-weight:700;font-size:16px;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#141413;color:#f3f2ee}main{background:#1e1e1c}button{background:#f3f2ee;color:#141414}}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(body)}</p>${form ? `<form method="post" action="${esc(form.action)}"><button type="submit">${esc(form.button)}</button></form>` : ''}</main></body></html>`;

  app.get('/public/email/unsubscribe/:token', { schema: { tags, params: z.object({ token: z.string().min(10).max(80) }), hide: true } }, async (req, reply) => {
    const row = await sendByToken(req.params.token);
    const lang = (row?.o.defaultLocale ?? 'en').split('-')[0]!;
    const c = UNSUB_COPY[lang] ?? UNSUB_COPY.en!;
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    if (!row) return page(lang, c.title, c.done.replace('{business}', ''));
    if (row.e.unsubscribedAt) return page(lang, c.title, c.done.replace('{business}', row.o.name));
    return page(lang, c.title, c.body.replace('{business}', row.o.name), { action: `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/public/email/unsubscribe/${encodeURIComponent(req.params.token)}`, button: c.button });
  });

  const unsubscribe = async (token: string) => {
    const row = await sendByToken(token);
    if (!row) return null;
    if (!row.e.unsubscribedAt) {
      await s.db.transaction(async (tx) => {
        await tx.update(emailSends).set({ unsubscribedAt: new Date() }).where(eq(emailSends.id, row.e.id));
        if (row.e.customerId) await tx.insert(consentRecords).values({ organizationId: row.e.organizationId, customerId: row.e.customerId, email: row.e.email, purpose: 'marketing_email', version: 'unsubscribe', granted: false, source: 'email_unsubscribe' });
      });
    }
    return row;
  };
  app.post('/public/email/unsubscribe/:token', { schema: { tags, params: z.object({ token: z.string().min(10).max(80) }), summary: 'Withdraw email marketing consent (one click; also accepts RFC 8058 List-Unsubscribe-Post)' }, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const row = await unsubscribe(req.params.token);
    const lang = (row?.o.defaultLocale ?? 'en').split('-')[0]!;
    const c = UNSUB_COPY[lang] ?? UNSUB_COPY.en!;
    if ((req.headers.accept ?? '').includes('application/json')) return { ok: !!row };
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return page(lang, c.title, c.done.replace('{business}', row?.o.name ?? ''));
  });

  // ── Email tracking (only active when the business turned it on; nothing is recorded otherwise) ──
  app.get('/public/email/o/:file', { schema: { tags, params: z.object({ file: z.string().max(100) }), hide: true } }, async (req, reply) => {
    const token = req.params.file.replace(/\.gif$/, '');
    const row = await sendByToken(token);
    if (row && marketingSettingsOf(row.o).tracking.opens && !row.e.openedAt) await s.db.update(emailSends).set({ openedAt: new Date() }).where(eq(emailSends.id, row.e.id));
    return reply.type('image/gif').header('cache-control', 'no-store, private').send(PIXEL);
  });
  app.get('/public/email/c/:token/:i', { schema: { tags, params: z.object({ token: z.string().min(10).max(80), i: z.coerce.number().int().min(0).max(200) }), hide: true } }, async (req, reply) => {
    const row = await sendByToken(req.params.token);
    const href = row?.e.links[req.params.i];
    // Only links that were in the email are followed (no open redirect).
    if (!row || !href || !/^(https:|mailto:|tel:)/.test(href)) throw notFound('Link');
    if (marketingSettingsOf(row.o).tracking.clicks && !row.e.clickedAt) await s.db.update(emailSends).set({ clickedAt: new Date() }).where(eq(emailSends.id, row.e.id));
    return reply.redirect(href, 302);
  });

  // ── Uploaded assets (sandbox storage, or S3 without a public bucket URL) ──
  app.get('/public/assets/:id/:name', { schema: { tags, params: z.object({ id: z.uuid(), name: z.string().max(200) }), hide: true } }, async (req, reply) => {
    const [a] = await s.db.select().from(brandAssets).where(and(eq(brandAssets.id, req.params.id), isNull(brandAssets.archivedAt)));
    if (!a) throw notFound('Asset');
    let data: Buffer | null = null;
    if (a.storage === 'db') data = (await s.db.select({ d: assetBlobs.data }).from(assetBlobs).where(eq(assetBlobs.assetId, a.id)))[0]?.d ?? null;
    else data = await s.assets.get(a.storageKey);
    if (!data) throw notFound('Asset');
    reply.header('cache-control', 'public, max-age=86400, immutable').header('x-content-type-options', 'nosniff').header('cross-origin-resource-policy', 'cross-origin');
    if (a.mime === 'image/svg+xml') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return reply.type(a.mime).send(data);
  });

  // ── Site redirects (old page addresses after a slug change) ──
  app.get('/public/sites/redirect', { schema: { tags: ['sites'], querystring: z.object({ brand: z.string().min(1).max(80), location: z.string().max(80).optional(), slug: z.string().min(1).max(80) }) } }, async (req, reply) => {
    const [o] = await s.db.select({ id: organizations.id }).from(organizations).where(and(siteSlugCond(req.query.brand), isNull(organizations.deletedAt)));
    if (!o) throw notFound('Redirect');
    let websiteLoc: string | null = null;
    if (req.query.location) {
      const [l] = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, o.id), eq(locations.slug, req.query.location)));
      if (!l) throw notFound('Redirect');
      websiteLoc = l.id;
    }
    const [site] = await s.db.select({ id: websites.id }).from(websites).where(and(eq(websites.organizationId, o.id), websiteLoc ? eq(websites.locationId, websiteLoc) : isNull(websites.locationId)));
    if (!site) throw notFound('Redirect');
    const [r] = await s.db.select().from(siteRedirects).where(and(eq(siteRedirects.websiteId, site.id), eq(siteRedirects.fromSlug, req.query.slug)));
    if (!r) throw notFound('Redirect');
    reply.header('cache-control', 'public, max-age=60');
    return { to: r.toSlug };
  });
};
