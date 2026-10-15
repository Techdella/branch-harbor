import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { createSection, starterDocument, type PageDocument } from '@bh/shared';
import { automationRuns, automationSteps, emailSends, pageVersions, pages } from '../src/db/schema/index.ts';
import { renderEmail } from '../src/services/email-render.ts';
import { advanceRun, marketingTick, processMarketingEvent } from '../src/services/automation-engine.ts';
import { migrateSiteDocuments } from '../src/services/site-builder.ts';
import { resolveTheme } from '@bh/shared';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

const brand = { name: 'Stillwater Yoga', logoUrl: null, palette: resolveTheme('sage').light, fonts: resolveTheme('sage').fonts };

describe('email rendering (MJML)', () => {
  it('renders email-safe HTML with a plain-text part, the postal address and an unsubscribe link', async () => {
    const doc = starterDocument('announcement', { heading: 'Hello {{first_name|there}}', body: 'New classes at {{location_name}}.', button: 'Book now' });
    doc.blocks = doc.blocks.map((b, i) => ({ ...b, id: `b${i}` }));
    const btn = doc.blocks.find((b) => b.type === 'button')!;
    if (btn.type === 'button') btn.href = 'https://example.com/book';
    const img = doc.blocks.find((b) => b.type === 'image')!;
    if (img.type === 'image') { img.src = 'https://example.com/hero.jpg'; img.alt = 'Studio'; }
    const r = await renderEmail({ document: doc, subject: 'News for {{first_name|you}}', brand, values: { first_name: '<Ana>', location_name: 'Queen West' }, postalAddress: '12 Queen St W, Toronto', unsubscribeUrl: 'https://api.example/v1/public/email/unsubscribe/tok123', locale: 'en' });
    expect(r.subject).toBe('News for <Ana>');
    expect(r.html).toContain('Hello &lt;Ana&gt;');
    expect(r.html).not.toContain('<Ana>');
    expect(r.html).toContain('https://api.example/v1/public/email/unsubscribe/tok123');
    expect(r.html).toContain('12 Queen St W, Toronto');
    expect(r.html).toMatch(/<table/);
    expect(r.text).toContain('Unsubscribe: https://api.example/v1/public/email/unsubscribe/tok123');
    expect(r.text).toContain('Book now: https://example.com/book');
    expect(r.links).toEqual(['https://example.com/book']);
    // Snapshot of the plain-text part (stable; the HTML is MJML output).
    expect(r.text).toMatchSnapshot();
  });

  it('adds the legally required footer when the document has none, in the reader’s language', async () => {
    const r = await renderEmail({ document: { schemaVersion: 1, blocks: [{ id: 't', type: 'text', text: 'Hi', align: 'left', size: 'body' }], style: { background: 'light', buttonShape: 'pill' } }, subject: 'S', brand, values: {}, postalAddress: '', unsubscribeUrl: 'https://x.example/u/abc', locale: 'fr' });
    expect(r.html).toContain('Se désabonner');
    expect(r.warnings).toContain('postal_address_missing');
  });
});

describe.skipIf(!hasDb)('marketing workspace (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; email: string };
  let org: Record<string, any>;
  let locA: Record<string, any>;
  let locB: Record<string, any>;
  let manager: { token: string };

  beforeAll(async () => {
    app = await makeApp();
    owner = await verifiedUser(app, 'Owner');
    org = await createOrg(app, owner.token, { name: `Mkt ${uid()}` });
    locA = await createLocation(app, owner.token, org.id, { name: 'Queen West' });
    locB = await createLocation(app, owner.token, org.id, { name: 'Leslieville' });
    for (const l of [locA, locB]) await call(app, 'PATCH', `/v1/orgs/${org.id}/locations/${l.id}`, { token: owner.token, body: { publiclyVisible: true, status: 'operating' } });
    manager = await memberWithRole(app, owner.token, org.id, 'location_manager', { kind: 'location', id: locA.id });
  });
  afterAll(async () => { await app?.close(); });

  const O = () => `/v1/orgs/${org.id}`;

  describe('website builder governance', () => {
    let masterId: string;
    let pageA: string;
    const hero = { ...createSection('hero', { heading: 'Breathe with us' }), lock: 'locked' as const };
    const intro = { ...createSection('text', { body: 'HQ intro' }), lock: 'editable' as const };
    const offer = { ...createSection('cta', { heading: 'Intro offer' }), lock: 'approval' as const };

    it('HQ creates a master with lock modes and applies it to locations', async () => {
      const m = await call(app, 'POST', `${O()}/builder/masters`, { token: owner.token, body: { name: 'Home', pageSlug: 'home', document: { schemaVersion: 1, sections: [hero, intro, offer] } } });
      expect(m.status).toBe(201);
      masterId = m.body.id;
      const ap = await call(app, 'POST', `${O()}/builder/masters/${masterId}/apply`, { token: owner.token, body: { locationIds: [locA.id, locB.id] } });
      expect(ap.status).toBe(200);
      expect(ap.body.results.map((r: any) => r.status)).toEqual(['created', 'created']);
      pageA = ap.body.results.find((r: any) => r.locationId === locA.id).pageId;
      const b = await call(app, 'GET', `${O()}/pages/${pageA}/builder`, { token: manager.token });
      expect(b.status).toBe(200);
      expect(b.body.document.sections.map((s: any) => s.origin)).toEqual(['locked', 'hq', 'approval']);
      expect(b.body.permissions.governed).toBe(true);
    });

    it('a location editor cannot change locked sections; approval sections become approval requests', async () => {
      const b = await call(app, 'GET', `${O()}/pages/${pageA}/builder`, { token: manager.token });
      const doc: PageDocument = b.body.document;
      const [h, t, c] = doc.sections;
      const edited = { schemaVersion: 1, sections: [{ ...h, props: { ...h!.props, heading: 'Mine now' } }, { ...t, props: { ...t!.props, body: 'Local intro' } }, { ...c, props: { ...c!.props, heading: 'Half price' } }] };
      const r = await call(app, 'PUT', `${O()}/pages/${pageA}/document`, { token: manager.token, body: { document: edited, baseRevision: b.body.page.revision } });
      expect(r.status).toBe(200);
      expect(r.body.rejected).toEqual([{ sectionId: h!.id, reason: 'locked' }]);
      expect(r.body.pendingApprovals).toHaveLength(1);
      expect(r.body.document.sections[0].props.heading).toBe('Breathe with us');
      expect(r.body.document.sections[1].props.body).toBe('Local intro');
      expect(r.body.document.sections[1].origin).toBe('local');
      expect(r.body.document.sections[2].props.heading).toBe('Intro offer');
      // Stale revision → conflict (autosave from another tab).
      const stale = await call(app, 'PUT', `${O()}/pages/${pageA}/document`, { token: manager.token, body: { document: edited, baseRevision: b.body.page.revision } });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('revision_conflict');
      // HQ approves (the requester cannot approve their own request); the pending content applies.
      const apId = r.body.pendingApprovals[0].approvalId;
      const own = await call(app, 'POST', `${O()}/approvals/${apId}/decision`, { token: manager.token, body: { decision: 'approve' } });
      expect(own.status).toBe(403);
      const ok = await call(app, 'POST', `${O()}/approvals/${apId}/decision`, { token: owner.token, body: { decision: 'approve' } });
      expect(ok.status).toBe(200);
      const after = await call(app, 'GET', `${O()}/pages/${pageA}/builder`, { token: manager.token });
      expect(after.body.document.sections[2].props.heading).toBe('Half price');
      expect(after.body.document.sections[2].pending).toBeUndefined();
    });

    it('HQ master updates keep local overrides, then publish, restore and theme switching keep content', async () => {
      const m = await call(app, 'GET', `${O()}/builder/masters/${masterId}`, { token: owner.token });
      const next = { ...m.body.document, sections: m.body.document.sections.map((s: any) => ({ ...s, props: s.type === 'text' ? { ...s.props, body: 'HQ intro v2' } : s.type === 'hero' ? { ...s.props, heading: 'Breathe deeper' } : s.props })) };
      const save = await call(app, 'PUT', `${O()}/builder/masters/${masterId}/document`, { token: owner.token, body: { document: next, version: m.body.version } });
      expect(save.status).toBe(200);
      expect(save.body.affected.pages).toBe(2);
      const a = await call(app, 'GET', `${O()}/pages/${pageA}/builder`, { token: manager.token });
      expect(a.body.document.sections[0].props.heading).toBe('Breathe deeper');
      expect(a.body.document.sections[1].props.body).toBe('Local intro');
      // Strict validation before publishing: an empty CTA heading blocks publish with per-section issues.
      const broken = { ...a.body.document, sections: [...a.body.document.sections, createSection('cta')] };
      const sv = await call(app, 'PUT', `${O()}/pages/${pageA}/document`, { token: manager.token, body: { document: broken, baseRevision: a.body.page.revision } });
      const bad = await call(app, 'POST', `${O()}/pages/${pageA}/publish`, { token: manager.token });
      expect(bad.status).toBe(422);
      expect(bad.body.error.code).toBe('document_invalid');
      const fixed = await call(app, 'PUT', `${O()}/pages/${pageA}/document`, { token: manager.token, body: { document: { ...sv.body.document, sections: sv.body.document.sections.slice(0, 3) }, baseRevision: sv.body.revision } });
      expect(fixed.status).toBe(200);
      const pub = await call(app, 'POST', `${O()}/pages/${pageA}/publish`, { token: manager.token });
      expect(pub.status).toBe(200);
      const site1 = await call(app, 'GET', `/v1/public/sites/${org.slug}/${locA.slug}`);
      const home = site1.body.pages.find((p: any) => p.slug === 'home');
      expect(home.document.sections.map((s: any) => s.type)).toEqual(['hero', 'text', 'cta']);
      expect(home.document.sections[0]).not.toHaveProperty('origin');
      expect(site1.body.brand.theme.themeId).toBe('classic');
      // Switch theme: content is identical, only the theme changes.
      const th = await call(app, 'PUT', `${O()}/builder/theme`, { token: owner.token, body: { themeId: 'bistro', colorMode: 'theme' } });
      expect(th.status).toBe(200);
      const site2 = await call(app, 'GET', `/v1/public/sites/${org.slug}/${locA.slug}`);
      expect(site2.body.brand.theme.themeId).toBe('bistro');
      expect(site2.body.brand.theme.site.fonts.heading).toBe('playfair-display');
      expect(site2.body.pages.find((p: any) => p.slug === 'home').document).toEqual(home.document);
      // Location managers cannot change the network theme.
      expect((await call(app, 'PUT', `${O()}/builder/theme`, { token: manager.token, body: { themeId: 'mono' } })).status).toBe(403);
      // Restore the published version after a local edit.
      const cur = await call(app, 'GET', `${O()}/pages/${pageA}/builder`, { token: manager.token });
      const edit = await call(app, 'PUT', `${O()}/pages/${pageA}/document`, { token: manager.token, body: { document: { ...cur.body.document, sections: cur.body.document.sections.map((s: any, i: number) => (i === 1 ? { ...s, props: { ...s.props, body: 'Oops' } } : s)) }, baseRevision: cur.body.page.revision } });
      const hist = await call(app, 'GET', `${O()}/pages/${pageA}/history`, { token: manager.token });
      const live = hist.body.versions.find((v: any) => v.live);
      const restored = await call(app, 'POST', `${O()}/pages/${pageA}/restore`, { token: manager.token, body: { versionId: live.id, baseRevision: edit.body.revision } });
      expect(restored.status).toBe(200);
      expect(restored.body.document.sections[1].props.body).toBe('Local intro');
      expect(restored.body.document.sections[1].origin).toBe('local');
    });

    it('changing a page address keeps the old one working through a redirect', async () => {
      const sites = await call(app, 'GET', `${O()}/builder/sites`, { token: owner.token });
      const site = sites.body.items.find((w: any) => w.locationId === locA.id);
      const p = await call(app, 'POST', `${O()}/websites/${site.id}/builder-pages`, { token: owner.token, body: { title: 'Our team', document: { schemaVersion: 1, sections: [createSection('team', { heading: 'Teachers' })] } } });
      expect(p.status).toBe(201);
      expect(p.body.slug).toBe('our-team');
      const m = await call(app, 'PATCH', `${O()}/pages/${p.body.id}/meta`, { token: owner.token, body: { slug: 'teachers', seo: { title: 'Teachers', noindex: true } } });
      expect(m.body.slug).toBe('teachers');
      const r = await call(app, 'GET', `/v1/public/sites/redirect?brand=${org.slug}&location=${locA.slug}&slug=our-team`);
      expect(r.body.to).toBe('teachers');
      expect((await call(app, 'POST', `${O()}/websites/${site.id}/builder-pages`, { token: owner.token, body: { title: 'Book' } })).status).toBe(400);
    });

    it('migrates classic field pages (and their published version) into documents', async () => {
      const tpl = await call(app, 'POST', `${O()}/templates`, { token: owner.token, body: { name: 'Classic', fields: [{ key: 'hero_title', label: 'Hero', policy: 'editable', defaultValue: 'Classic welcome' }, { key: 'about', label: 'About', policy: 'editable', defaultValue: 'We teach.' }] } });
      const l = await createLocation(app, owner.token, org.id, { name: 'Classic' });
      await call(app, 'PATCH', `${O()}/locations/${l.id}`, { token: owner.token, body: { publiclyVisible: true, status: 'operating' } });
      const w = await call(app, 'POST', `${O()}/websites`, { token: owner.token, body: { locationId: l.id, templateId: tpl.body.id } });
      const pageId = w.body.pages[0].id;
      expect((await call(app, 'POST', `${O()}/pages/${pageId}/publish`, { token: owner.token })).status).toBe(200);
      const db = app.ctx.db;
      await db.update(pages).set({ document: null }).where(eq(pages.id, pageId));
      const [pv] = await db.select().from(pages).where(eq(pages.id, pageId));
      await db.update(pageVersions).set({ document: null }).where(eq(pageVersions.id, pv!.publishedVersionId!));
      const res = await migrateSiteDocuments(db);
      expect(res.migratedPages).toBeGreaterThanOrEqual(1);
      const site = await call(app, 'GET', `/v1/public/sites/${org.slug}/${l.slug}`);
      const home = site.body.pages.find((p: any) => p.slug === 'home');
      expect(home.document.sections[0]).toMatchObject({ type: 'hero', props: { heading: 'Classic welcome' } });
      expect(home.document.sections.some((s: any) => s.type === 'text' && s.props.body === 'We teach.')).toBe(true);
      // The classic field editor still drives the migrated document.
      await call(app, 'PATCH', `${O()}/pages/${pageId}/fields`, { token: owner.token, body: { fields: { hero_title: 'Edited classic' } } });
      const b = await call(app, 'GET', `${O()}/pages/${pageId}/builder`, { token: owner.token });
      expect(b.body.document.sections[0].props.heading).toBe('Edited classic');
      // Idempotent.
      expect((await migrateSiteDocuments(db)).migratedPages).toBe(0);
    });
  });

  describe('forms → leads, email campaigns and automations', () => {
    let formId: string;
    let templateId: string;

    it('a published form creates a routed lead with consent; spam is refused', async () => {
      const f = await call(app, 'POST', `${O()}/forms`, {
        token: owner.token, body: {
          name: 'Free trial', locationId: null,
          fields: [{ id: 'name', type: 'text', label: 'Name', required: true, maps: 'name' }, { id: 'email', type: 'email', label: 'Email', required: true, maps: 'email' }, { id: 'studio', type: 'location', label: 'Studio', required: true }],
          settings: { routing: 'visitor_choice', consents: [{ purpose: 'marketing_email', label: 'Send me news' }], tag: 'trial', successMessage: 'Thanks!' },
        },
      });
      expect(f.status).toBe(201);
      formId = f.body.id;
      expect((await call(app, 'GET', `/v1/public/forms/${formId}`)).status).toBe(404); // draft
      const pubd = await call(app, 'PUT', `${O()}/forms/${formId}`, { token: owner.token, body: { name: f.body.name, fields: f.body.fields, settings: f.body.settings, status: 'published' } });
      expect(pubd.status).toBe(200);
      const def = await call(app, 'GET', `/v1/public/forms/${formId}`);
      expect(def.body.locations.map((l: any) => l.id)).toContain(locA.id);
      const bad = await call(app, 'POST', `/v1/public/forms/${formId}/submit`, { body: { data: { name: 'A', email: 'nope', studio: locA.id } } });
      expect(bad.status).toBe(400);
      expect(bad.body.error.fields.email).toBe('Invalid');
      const fast = await call(app, 'POST', `/v1/public/forms/${formId}/submit`, { body: { data: { name: 'A', email: 'a@example.com', studio: locA.id }, startedAt: Date.now() } });
      expect(fast.status).toBe(422);
      const hp = await call(app, 'POST', `/v1/public/forms/${formId}/submit`, { body: { data: {}, website: 'http://spam' } });
      expect(hp.status).toBe(200);
      const ok = await call(app, 'POST', `/v1/public/forms/${formId}/submit`, { body: { data: { name: 'Ana Silva', email: `ana-${uid()}@example.com`, studio: locA.id }, consents: { marketing_email: true }, startedAt: Date.now() - 10_000 } });
      expect(ok.status).toBe(201);
      expect(ok.body.message).toBe('Thanks!');
      const leads = await call(app, 'GET', `${O()}/leads`, { token: manager.token });
      const lead = leads.body.items.find((l: any) => l.name === 'Ana Silva');
      expect(lead).toMatchObject({ source: 'form', locationId: locA.id });
      const subs = await call(app, 'GET', `${O()}/forms/${formId}/submissions`, { token: owner.token });
      expect(subs.body.items).toHaveLength(1);
      expect(subs.body.items[0].consents).toEqual({ marketing_email: true });
    });

    it('campaigns go only to consented contacts in scope; unsubscribe withdraws consent', async () => {
      const t = await call(app, 'POST', `${O()}/email/templates`, { token: owner.token, body: { name: 'Welcome', subject: 'Welcome {{first_name|friend}}', document: starterDocument('welcome', { heading: 'Welcome', body: 'Hi {{first_name|there}}', button: 'Book' }) } });
      expect(t.status).toBe(201);
      templateId = t.body.id;
      // A second contact without consent.
      await call(app, 'POST', `/v1/public/forms/${formId}/submit`, { body: { data: { name: 'Ben No', email: `ben-${uid()}@example.com`, studio: locA.id }, startedAt: Date.now() - 10_000 } });
      const seg = await call(app, 'POST', `${O()}/segments`, { token: owner.token, body: { name: 'Trial', scope: { kind: 'organization', id: org.id }, rules: { tags: ['trial'] } } });
      const prev = await call(app, 'POST', `${O()}/segments/preview`, { token: owner.token, body: { scope: { kind: 'organization', id: org.id }, rules: { tags: ['trial'] } } });
      expect(prev.body).toMatchObject({ matching: 2, emailable: 1 });
      await call(app, 'PUT', `${O()}/marketing/settings`, { token: owner.token, body: { postalAddress: '1 Harbour St, Toronto', tracking: { opens: false, clicks: false } } });
      const c = await call(app, 'POST', `${O()}/email/campaigns`, { token: owner.token, body: { name: 'Launch', scope: { kind: 'organization', id: org.id }, subject: 'Hello {{first_name|there}}', document: t.body.document, segmentId: seg.body.id } });
      expect(c.status).toBe(201);
      // Location managers draft but cannot send network campaigns.
      expect((await call(app, 'POST', `${O()}/email/campaigns/${c.body.id}/send`, { token: manager.token, body: {} })).status).toBe(403);
      const sent = await call(app, 'POST', `${O()}/email/campaigns/${c.body.id}/send`, { token: owner.token, body: {} });
      expect(sent.status).toBe(200);
      await app.ctx.jobs.drain();
      const rec = await call(app, 'GET', `${O()}/email/campaigns/${c.body.id}/recipients`, { token: owner.token });
      expect(rec.body.items.map((r: any) => r.status).sort()).toEqual(['sandbox', 'skipped']);
      expect(rec.body.items.find((r: any) => r.status === 'skipped').skipReason).toBe('no_consent');
      const mail = app.ctx.mailer.outbox.find((m) => m.subject === 'Hello Ana');
      expect(mail?.html).toContain('/v1/public/email/unsubscribe/');
      expect(mail?.html).toContain('1 Harbour St, Toronto');
      expect(mail?.text).toContain('Unsubscribe:');
      // Re-delivering does not send twice.
      const { deliverCampaign } = await import('../src/services/marketing.ts');
      await deliverCampaign(app.ctx, c.body.id);
      expect(app.ctx.mailer.outbox.filter((m) => m.subject === 'Hello Ana')).toHaveLength(1);
      // Unsubscribe: GET only shows a confirmation; POST withdraws consent.
      const [send] = await app.ctx.db.select().from(emailSends).where(eq(emailSends.campaignId, c.body.id));
      const token = (await app.ctx.db.select().from(emailSends).where(eq(emailSends.status, 'sandbox'))).find((r) => r.campaignId === c.body.id)!.token;
      expect(send).toBeTruthy();
      const g = await app.inject({ method: 'GET', url: `/v1/public/email/unsubscribe/${token}` });
      expect(g.statusCode).toBe(200);
      expect(g.body).toContain('<form method="post"');
      const p = await app.inject({ method: 'POST', url: `/v1/public/email/unsubscribe/${token}`, headers: { accept: 'application/json' } });
      expect(p.json()).toEqual({ ok: true });
      const after = await call(app, 'POST', `${O()}/segments/preview`, { token: owner.token, body: { scope: { kind: 'organization', id: org.id }, rules: { tags: ['trial'] } } });
      expect(after.body.emailable).toBe(0);
    });

    it('automations: one run per contact and event, delays park the run, steps never repeat, consent is re-checked', async () => {
      const graph = { nodes: [
        { id: 't', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'form.submitted', formId } },
        { id: 'd', type: 'delay', position: { x: 0, y: 100 }, config: { amount: 1, unit: 'days' } },
        { id: 'tag', type: 'action', position: { x: 0, y: 200 }, config: { action: 'add_tag', tag: 'nurtured' } },
        { id: 'mail', type: 'action', position: { x: 0, y: 300 }, config: { action: 'send_email', templateId } },
      ], edges: [{ id: '1', source: 't', target: 'd' }, { id: '2', source: 'd', target: 'tag' }, { id: '3', source: 'tag', target: 'mail' }] };
      const a = await call(app, 'POST', `${O()}/automations`, { token: owner.token, body: { name: 'Trial follow-up', scope: { kind: 'organization', id: org.id }, graph } });
      expect(a.status).toBe(201);
      expect((await call(app, 'POST', `${O()}/automations/${a.body.id}/status`, { token: manager.token, body: { status: 'active' } })).status).toBe(403);
      expect((await call(app, 'POST', `${O()}/automations/${a.body.id}/status`, { token: owner.token, body: { status: 'active' } })).status).toBe(200);
      const email = `cara-${uid()}@example.com`;
      await call(app, 'POST', `/v1/public/forms/${formId}/submit`, { body: { data: { name: 'Cara', email, studio: locA.id }, consents: { marketing_email: true }, startedAt: Date.now() - 10_000 } });
      await app.ctx.jobs.drain();
      const runs = await app.ctx.db.select().from(automationRuns).where(eq(automationRuns.automationId, a.body.id));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('waiting');
      // Replaying the same event does not start another run.
      await processMarketingEvent(app.ctx, runs[0]!.eventId!);
      await advanceRun(app.ctx, runs[0]!.id);
      expect(await app.ctx.db.select().from(automationRuns).where(eq(automationRuns.automationId, a.body.id))).toHaveLength(1);
      // Not due yet.
      expect((await app.ctx.db.select().from(automationRuns).where(eq(automationRuns.id, runs[0]!.id)))[0]!.status).toBe('waiting');
      const later = new Date(Date.now() + 25 * 3600_000);
      await Promise.all([advanceRun(app.ctx, runs[0]!.id, { now: later }), advanceRun(app.ctx, runs[0]!.id, { now: later })]);
      await advanceRun(app.ctx, runs[0]!.id, { now: later });
      const [done] = await app.ctx.db.select().from(automationRuns).where(eq(automationRuns.id, runs[0]!.id));
      expect(done!.status).toBe('completed');
      const steps = await app.ctx.db.select().from(automationSteps).where(eq(automationSteps.runId, done!.id));
      expect(steps.map((x) => `${x.nodeId}:${x.status}`).sort()).toEqual(['d:done', 'mail:done', 't:done', 'tag:done']);
      const sends = await app.ctx.db.select().from(emailSends).where(eq(emailSends.email, email));
      expect(sends).toHaveLength(1);
      const runsApi = await call(app, 'GET', `${O()}/automations/${a.body.id}/runs`, { token: owner.token });
      expect(runsApi.body.items[0].steps).toHaveLength(4);

      // Without consent the email step is skipped, and the tick resumes due runs on its own.
      const email2 = `dan-${uid()}@example.com`;
      await call(app, 'POST', `/v1/public/forms/${formId}/submit`, { body: { data: { name: 'Dan', email: email2, studio: locA.id }, startedAt: Date.now() - 10_000 } });
      await app.ctx.jobs.drain();
      await marketingTick(app.ctx, { now: new Date(Date.now() + 25 * 3600_000) });
      const r2 = (await app.ctx.db.select().from(automationRuns).where(eq(automationRuns.automationId, a.body.id))).find((r) => r.id !== done!.id)!;
      const s2 = await app.ctx.db.select().from(automationSteps).where(eq(automationSteps.runId, r2.id));
      expect(s2.find((x) => x.nodeId === 'mail')).toMatchObject({ status: 'skipped', result: { reason: 'no_consent' } });

      // Paused flows do not advance; test runs use the tester as the contact and skip delays.
      await call(app, 'POST', `${O()}/automations/${a.body.id}/status`, { token: owner.token, body: { status: 'paused' } });
      const tr = await call(app, 'POST', `${O()}/automations/${a.body.id}/test-run`, { token: owner.token, body: { locationId: locA.id } });
      expect(tr.status).toBe(200);
      expect(tr.body.status).toBe('completed');
      expect(tr.body.steps.find((x: any) => x.nodeId === 'mail').result.email).toBe('sandbox');
      expect(app.ctx.mailer.outbox.some((m) => m.to === owner.email)).toBe(true);
    });
  });
});
