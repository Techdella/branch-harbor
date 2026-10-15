import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_LOCALES } from './locale.ts';
import { DEFAULT_REVIEW_TEMPLATES, REVIEW_SMS_OPT_OUT, averageRating, fillReviewTemplate, resolveReviewTemplate, reviewSettingsSchema } from './reviews.ts';

test('review-request copy exists in every site locale and keeps the link placeholder', () => {
  for (const l of SUPPORTED_LOCALES) {
    assert.ok(DEFAULT_REVIEW_TEMPLATES[l].subject.length > 5, l);
    assert.ok(DEFAULT_REVIEW_TEMPLATES[l].body.includes('{link}'), l);
    assert.ok(REVIEW_SMS_OPT_OUT[l].includes('STOP'), l);
  }
});

test('templates resolve location override, then organisation, then default; tokens fill', () => {
  const r = resolveReviewTemplate('fr-CA', { fr: { subject: 'Loc', body: '' } }, { fr: { subject: 'Org', body: 'Org {link}' } });
  assert.equal(r.locale, 'fr');
  assert.equal(r.subject, 'Loc');
  assert.equal(r.body, 'Org {link}');
  assert.equal(resolveReviewTemplate('xx').locale, 'en');
  assert.equal(fillReviewTemplate('Hi {name} {link} {other}', { name: 'Ana', link: 'https://x' }), 'Hi Ana https://x {other}');
});

test('settings default to off, email, 90-day cap and marketing consent; links must be https', () => {
  const s = reviewSettingsSchema.parse({});
  assert.equal(s.enabled, false);
  assert.equal(s.channel, 'email');
  assert.equal(s.frequencyCapDays, 90);
  assert.equal(s.consentMode, 'marketing');
  assert.equal(reviewSettingsSchema.safeParse({ links: [{ kind: 'google', url: 'http://g.page/r/x' }] }).success, false);
  assert.equal(averageRating([5, 4, 4]), 4.3);
  assert.equal(averageRating([]), null);
});
