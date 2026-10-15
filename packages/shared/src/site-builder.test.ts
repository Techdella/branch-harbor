import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTION_TYPES, applyGovernedEdit, createSection, instantiateMaster, legacyFieldsToDocument, mergeMasterIntoPage, publicDocument, resetSectionToHq, validatePageDocument,
  type PageDocument,
} from './site-document.ts';
import { SITE_THEMES, THEME_FAMILIES, resolveTheme, themeContrastReport, themesForFamily, contrastRatio } from './site-themes.ts';
import { personalise, unknownTokens, starterDocument } from './email-document.ts';
import { AUTOMATION_TEMPLATES, automationTemplate, validateAutomationGraph } from './automation.ts';
import { validateSubmission } from './marketing-forms.ts';

const doc = (...sections: PageDocument['sections']): PageDocument => ({ schemaVersion: 1, sections });

test('section library has at least 20 types including industry blocks', () => {
  assert.ok(SECTION_TYPES.length >= 20);
  for (const t of ['class_schedule', 'programmes', 'services', 'product_grid', 'menu', 'listings', 'rooms']) assert.ok(SECTION_TYPES.includes(t as never), t);
});

test('page document validation: drafts are lenient, publishing is strict, unsafe links are refused', () => {
  const hero = createSection('hero');
  assert.equal(validatePageDocument(doc(hero)).ok, true);
  const strict = validatePageDocument(doc(hero), 'publish');
  assert.equal(strict.ok, false);
  assert.deepEqual(strict.issues.map((i) => i.code), ['required']);
  const bad = createSection('hero', { heading: 'Hi', ctaHref: 'javascript:alert(1)', image: 'http://x.example/a.png' });
  const r = validatePageDocument(doc(bad), 'publish');
  assert.deepEqual(r.issues.map((i) => i.path).sort(), ['props.ctaHref', 'props.image']);
  const dup = validatePageDocument(doc(hero, { ...hero }));
  assert.ok(dup.issues.some((i) => i.code === 'duplicate_id'));
  assert.ok(validatePageDocument({ sections: [{ id: 'x', type: 'nope', props: {} }] }).issues.some((i) => i.code === 'unknown_type'));
  assert.equal(validatePageDocument({ sections: 'x' }).ok, false);
});

test('testimonials must be confirmed as business-supplied before publishing', () => {
  const s = createSection('testimonials', { items: [{ quote: 'Lovely', author: 'Ana', role: '' }] });
  assert.ok(validatePageDocument(doc(s), 'publish').issues.some((i) => i.code === 'testimonials_unconfirmed'));
  assert.equal(validatePageDocument(doc({ ...s, props: { ...s.props, confirmed: true } }), 'publish').ok, true);
});

test('governance: locked sections are not editable or removable by a location; approval sections are diverted', () => {
  const master = doc(
    { ...createSection('hero', { heading: 'Brand' }), lock: 'locked' },
    { ...createSection('text', { body: 'HQ text' }), lock: 'editable' },
    { ...createSection('cta', { heading: 'Offer' }), lock: 'approval' },
  );
  const page = instantiateMaster(master);
  const [hero, text, cta] = page.sections as [PageDocument['sections'][0], PageDocument['sections'][0], PageDocument['sections'][0]];
  assert.deepEqual(page.sections.map((s) => s.origin), ['locked', 'hq', 'approval']);
  // Location edits everything and deletes the locked hero.
  const incoming = doc({ ...text, props: { ...text.props, body: 'Local text' } }, { ...cta, props: { ...cta.props, heading: '50% off' } }, createSection('faq'));
  const r = applyGovernedEdit(page, incoming, { canHq: false, canApprove: false });
  assert.deepEqual(r.rejected.map((x) => x.reason), ['locked_removed']);
  assert.equal(r.document.sections[0]!.id, hero.id);
  assert.equal(r.document.sections[0]!.props.heading, 'Brand');
  assert.equal(r.document.sections.find((s) => s.id === text.id)!.origin, 'local');
  assert.equal(r.document.sections.find((s) => s.id === cta.id)!.props.heading, 'Offer');
  assert.deepEqual(r.approvals.map((a) => a.props.heading), ['50% off']);
  assert.equal(r.document.sections.at(-1)!.origin, 'local');
  // Editing locked content is refused.
  const r2 = applyGovernedEdit(page, doc({ ...hero, props: { ...hero.props, heading: 'Mine' } }, text, cta), { canHq: false, canApprove: false });
  assert.deepEqual(r2.rejected.map((x) => x.reason), ['locked']);
  assert.equal(r2.document.sections[0]!.props.heading, 'Brand');
  // An approver applies approval sections directly.
  const r3 = applyGovernedEdit(page, doc(hero, text, { ...cta, props: { ...cta.props, heading: 'Now' } }), { canHq: false, canApprove: true });
  assert.equal(r3.approvals.length, 0);
  assert.equal(r3.document.sections[2]!.props.heading, 'Now');
  // Reset a local override to HQ.
  const reset = resetSectionToHq(r.document, text.id)!;
  assert.equal(reset.sections.find((s) => s.id === text.id)!.props.body, 'HQ text');
});

test('HQ master updates flow to inherited sections and keep local overrides', () => {
  const master = doc({ ...createSection('hero', { heading: 'A' }), lock: 'locked' }, { ...createSection('text', { body: 'B' }), lock: 'editable' }, { ...createSection('text', { body: 'C' }), lock: 'editable' });
  const page = instantiateMaster(master);
  const local = { ...page, sections: page.sections.map((s, i) => (i === 2 ? { ...s, origin: 'local' as const, props: { ...s.props, body: 'mine' } } : s)) };
  const next = doc(
    { ...master.sections[0]!, props: { ...master.sections[0]!.props, heading: 'A2' } },
    { ...master.sections[1]!, props: { ...master.sections[1]!.props, body: 'B2' } },
    { ...master.sections[2]!, props: { ...master.sections[2]!.props, body: 'C2' } },
    { ...createSection('cta', { heading: 'new' }), lock: 'editable' },
  );
  const m = mergeMasterIntoPage(next, local);
  assert.deepEqual(m.document.sections.map((s) => s.props.heading || s.props.body), ['A2', 'B2', 'mine', 'new']);
  assert.equal(m.keptLocal, 1);
  assert.equal(m.added, 1);
  assert.equal(m.document.sections[2]!.hq!.props.body, 'C2');
});

test('public document strips hidden sections and governance metadata', () => {
  const s = { ...createSection('text', { body: 'x' }), origin: 'local' as const, hq: { props: {} }, pending: { approvalId: 'a', props: {} } };
  const p = publicDocument(doc(s, { ...createSection('faq'), hidden: true }));
  assert.equal(p.sections.length, 1);
  assert.equal('hq' in p.sections[0]!, false);
  assert.equal('pending' in p.sections[0]!, false);
});

test('legacy template fields migrate into a document', () => {
  const d = legacyFieldsToDocument({ hero_title: 'Welcome', offer: 'First class free', about: 'We teach yoga', hero_image: 'javascript:x' }, { industry: 'studios', slug: 'home' });
  assert.equal(d.sections[0]!.props.heading, 'Welcome');
  assert.equal(d.sections[0]!.props.image, '');
  assert.ok(d.sections.some((s) => s.type === 'class_schedule'));
  assert.equal(validatePageDocument(d).ok, true);
});

test('theme library: ≥12 distinct themes, ≥8 per industry family, every palette passes WCAG AA', () => {
  assert.ok(SITE_THEMES.length >= 12);
  assert.equal(new Set(SITE_THEMES.map((t) => `${t.fonts.heading}/${t.fonts.body}/${t.layout.hero}/${t.light.primary}`)).size, SITE_THEMES.length);
  for (const f of THEME_FAMILIES) assert.ok(themesForFamily(f).length >= 8, `${f}: ${themesForFamily(f).length}`);
  for (const t of SITE_THEMES) {
    for (const scheme of ['light', 'dark'] as const) {
      const failing = themeContrastReport(t[scheme]).filter((r) => !r.ok);
      assert.deepEqual(failing, [], `${t.id} ${scheme}`);
    }
  }
});

test('brand colour overrides stay accessible in light and dark', () => {
  for (const c of ['#FFE800', '#00A3FF', '#141414', '#F5F5F5', '#E4002B']) {
    for (const id of ['classic', 'pulse', 'bistro']) {
      const r = resolveTheme(id, { colorMode: 'brand', primaryColor: c });
      for (const scheme of ['light', 'dark'] as const) {
        const p = r[scheme];
        assert.ok(contrastRatio(p.onPrimary, p.primary) >= 4.5, `${id} ${c} ${scheme} button`);
        assert.ok(contrastRatio(p.link, p.bg) >= 4.5, `${id} ${c} ${scheme} link`);
      }
    }
  }
});

test('email personalisation tokens use fallbacks and escape values', () => {
  assert.equal(personalise('Hi {{first_name|there}}!', {}), 'Hi there!');
  assert.equal(personalise('Hi {{ first_name | there }}', { first_name: '<b>Ana</b>' }, (s) => s.replace(/</g, '&lt;')), 'Hi &lt;b>Ana&lt;/b>');
  const d = starterDocument('announcement', { heading: 'H {{nope}}', body: 'B', button: 'Go' });
  assert.deepEqual(unknownTokens(d), ['nope']);
});

test('automation templates are valid graphs; structural problems are reported', () => {
  for (const k of AUTOMATION_TEMPLATES) assert.equal(validateAutomationGraph(automationTemplate(k, { sms: 'x', task: 'y', tag: 'z' })).ok, true, k);
  const bad = validateAutomationGraph({ nodes: [{ id: 'a', type: 'delay', config: { amount: 1, unit: 'days' } }], edges: [] });
  assert.ok(bad.issues.some((i) => i.code === 'no_trigger'));
  const cyc = validateAutomationGraph({ nodes: [{ id: 't', type: 'trigger', config: { event: 'lead.created' } }, { id: 'd', type: 'delay', config: { amount: 1, unit: 'days' } }], edges: [{ id: '1', source: 't', target: 'd' }, { id: '2', source: 'd', target: 'd' }] });
  assert.ok(cyc.issues.some((i) => i.code === 'cycle'));
});

test('form submissions are validated per field type', () => {
  const fields = [
    { id: 'email', type: 'email' as const, label: 'Email', help: '', required: true, options: [], maps: 'email' as const },
    { id: 'size', type: 'select' as const, label: 'Size', help: '', required: false, options: ['S', 'M'], maps: 'none' as const },
    { id: 'ok', type: 'checkbox' as const, label: 'OK', help: '', required: true, options: [], maps: 'none' as const },
  ];
  const r = validateSubmission(fields, { email: 'nope', size: 'XL' });
  assert.deepEqual(r.errors, { email: 'invalid', size: 'invalid', ok: 'required' });
  assert.equal(validateSubmission(fields, { email: 'a@b.co', ok: true }).ok, true);
});
