import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_LOCALES } from './locale.ts';
import { effectiveCapabilities, templateCapabilities } from './access.ts';
import {
  DEFAULT_LISTING_POLICY, DEFAULT_RECORDING_DISCLOSURE, coopAllowance, coopPeriodBounds, coopReimbursable, diffListing, fillReplyTemplate, fillSocialTemplate, listingHealth,
  localMarketingSettingsSchema, matchTrackingNumber, mergeSpecialHours, missingSocialTokens, pickReplyTemplates, recordingRule, resolveLocalAsset, reviewReplyDueAt, specialHourSchema,
  type ListingSnapshot,
} from './local-marketing.ts';

const base: ListingSnapshot = {
  name: 'Northlight Queen West', address: { line1: '812 Queen St W', city: 'Toronto', region: 'ON', postalCode: 'M6J 1G1', country: 'CA' }, phone: '+1 416 555 0142',
  hours: [{ day: 1, opens: '06:00', closes: '21:00' }, { day: 2, opens: '06:00', closes: '21:00' }], specialHours: [{ date: '2026-12-25', closed: true }],
  categories: { primary: 'Yoga studio', additional: ['Gym'] }, description: 'x'.repeat(90), photos: [], websiteUrl: 'https://northlight.example/queen-west', bookingUrl: null, attributes: { wheelchair_accessible: true },
};

test('drift ignores formatting a directory adds but catches real edits', () => {
  const theirs: ListingSnapshot = { ...base, name: '  NORTHLIGHT  queen west', phone: '(416) 555-0142', hours: [...base.hours].reverse(), websiteUrl: 'https://northlight.example/queen-west/' };
  assert.deepEqual(diffListing(base, theirs, 'google'), []);
  const edited: ListingSnapshot = { ...base, hours: [{ day: 1, opens: '07:00', closes: '21:00' }, base.hours[1]!], categories: { primary: 'Gym', additional: [] } };
  assert.deepEqual(diffListing(base, edited, 'google'), ['hours', 'categories']);
  // Bing has no attributes; photos are not compared for Google.
  assert.deepEqual(diffListing(base, { ...base, attributes: {}, photos: [{ url: 'https://x.example/a.jpg', kind: 'other', alt: '' }] }, 'bing'), ['photos']);
  // Past special hours never count as drift.
  assert.deepEqual(diffListing(base, { ...base, specialHours: [] }, 'google', '2027-01-01'), []);
});

test('special hours: closed or both times; bulk merge replaces the same date', () => {
  assert.equal(specialHourSchema.safeParse({ date: '2026-12-24', closed: false, opens: '09:00' }).success, false);
  assert.equal(specialHourSchema.safeParse({ date: '2026-12-24', closed: false, opens: '09:00', closes: '14:00' }).success, true);
  const merged = mergeSpecialHours([{ date: '2026-12-25', closed: false, opens: '10:00', closes: '12:00' }, { date: '2026-01-01', closed: true }], [{ date: '2026-12-25', closed: true }]);
  assert.deepEqual(merged.map((m) => [m.date, m.closed]), [['2026-01-01', true], ['2026-12-25', true]]);
});

test('listing health: weights sum to 100 and failing checks are reported', () => {
  const full = listingHealth({ listing: { ...base, bookingUrl: 'https://x.example/book', photos: [1, 2, 3].map((i) => ({ url: `https://x.example/${i}.jpg`, kind: 'other' as const, alt: '' })) }, syncs: [{ provider: 'google', status: 'synced' }], openDrifts: 0, pendingChanges: 0, missingHolidayDates: 0 });
  assert.equal(full.score, 100);
  const weak = listingHealth({ listing: base, syncs: [{ provider: 'google', status: 'drift' }], openDrifts: 1, pendingChanges: 0, missingHolidayDates: 2 });
  assert.deepEqual(weak.checks.filter((c) => !c.ok).map((c) => c.key), ['holidayHours', 'photos', 'booking', 'synced', 'noDrift']);
  assert.equal(weak.score, 100 - 10 - 7 - 5 - 10 - 10);
});

test('co-op periods, allowances and reimbursement caps', () => {
  assert.deepEqual(coopPeriodBounds('quarter', '2026-11-15'), { start: '2026-10-01', end: '2027-01-01', key: '2026-Q4' });
  assert.deepEqual(coopPeriodBounds('month', '2026-12-31'), { start: '2026-12-01', end: '2027-01-01', key: '2026-12' });
  assert.equal(coopAllowance({ basis: 'fund_percent', percentBps: 2500, fixedMinor: 0 }, 400_00), 100_00);
  assert.equal(coopAllowance({ basis: 'fixed', percentBps: 0, fixedMinor: 750_00 }, 0), 750_00);
  // Spent more than approved: capped at the approved budget, then 50% match.
  assert.deepEqual(coopReimbursable({ spentMinor: 1200_00, approvedMinor: 1000_00, matchRatioBps: 5000, remainingMinor: 2000_00 }), { eligibleMinor: 1000_00, reimbursableMinor: 500_00, cappedByAllowance: false });
  // Allowance left is the final cap.
  assert.deepEqual(coopReimbursable({ spentMinor: 800_00, approvedMinor: 1000_00, matchRatioBps: 10_000, remainingMinor: 300_00 }), { eligibleMinor: 800_00, reimbursableMinor: 300_00, cappedByAllowance: true });
});

test('dynamic number insertion picks the most specific rule, then the default', () => {
  const rules = [
    { id: 'default', isDefault: true, match: {} },
    { id: 'google', isDefault: false, match: { utmSource: 'google' } },
    { id: 'google-cpc-spring', isDefault: false, match: { utmSource: 'google', utmCampaign: 'spring' } },
    { id: 'yelp', isDefault: false, match: { referrerHost: 'yelp.com' } },
  ];
  assert.equal(matchTrackingNumber(rules, { utmSource: 'Google', utmCampaign: 'spring' })?.id, 'google-cpc-spring');
  assert.equal(matchTrackingNumber(rules, { utmSource: 'google', utmCampaign: 'autumn' })?.id, 'google');
  assert.equal(matchTrackingNumber(rules, { referrerHost: 'm.yelp.com' })?.id, 'yelp');
  assert.equal(matchTrackingNumber(rules, {})?.id, 'default');
  assert.equal(matchTrackingNumber(rules.slice(1), {}), null);
});

test('call recording is off unless enabled for the jurisdiction with a disclosure', () => {
  const s = localMarketingSettingsSchema.parse({});
  assert.equal(s.callRecording.enabled, false);
  assert.equal(recordingRule(s.callRecording, 'US', 'CA'), null);
  const on = { enabled: true, jurisdictions: { 'US-CA': { message: DEFAULT_RECORDING_DISCLOSURE.en }, GB: { message: DEFAULT_RECORDING_DISCLOSURE['en-GB'] } } };
  assert.ok(recordingRule(on, 'US', 'ca'));
  assert.equal(recordingRule(on, 'US', 'WA'), null);
  assert.ok(recordingRule(on, 'GB', 'England'));
  for (const l of SUPPORTED_LOCALES) assert.ok(DEFAULT_RECORDING_DISCLOSURE[l].length > 10, l);
});

test('settings default the listing policy and the review SLA', () => {
  const s = localMarketingSettingsSchema.parse({ listingPolicy: { hours: 'location_approval' } });
  assert.equal(s.listingPolicy.hours, 'location_approval');
  assert.equal(s.listingPolicy.name, DEFAULT_LISTING_POLICY.name);
  assert.deepEqual(s.reviewSla, { positiveHours: 48, negativeHours: 12 });
  assert.equal(reviewReplyDueAt(new Date('2026-10-01T00:00:00Z'), 1, s.reviewSla).toISOString(), '2026-10-01T12:00:00.000Z');
  assert.equal(reviewReplyDueAt(new Date('2026-10-01T00:00:00Z'), 5, s.reviewSla).toISOString(), '2026-10-03T00:00:00.000Z');
});

test('reply and social templates fill tokens; location templates and the reviewer language come first', () => {
  assert.equal(fillReplyTemplate('Thanks {first_name}! See you at {location}. {x}', { first_name: 'Ana', location: 'Mitte' }), 'Thanks Ana! See you at Mitte. {x}');
  const picked = pickReplyTemplates([
    { id: 'hq-en', minRating: 4, maxRating: 5, locale: 'en', locationId: null },
    { id: 'hq-de', minRating: 4, maxRating: 5, locale: 'de', locationId: null },
    { id: 'neg', minRating: 1, maxRating: 2, locale: 'en', locationId: null },
    { id: 'loc', minRating: 1, maxRating: 5, locale: null, locationId: 'l1' },
  ], 5, 'de-DE');
  assert.deepEqual(picked.map((p) => p.id), ['loc', 'hq-de', 'hq-en']);
  assert.equal(fillSocialTemplate('Come to {location} in {city} {phone}', { location: 'Mitte', city: 'Berlin', phone: null }), 'Come to Mitte in Berlin {phone}');
  assert.deepEqual(missingSocialTokens('Book: {booking_link} {city}', { city: 'Berlin' }), ['booking_link']);
});

test('local asset templates keep locked fields and cap lengths', () => {
  const fields = [
    { key: 'headline', label: 'Headline', locked: true, default: 'Find your calm', maxLength: 40, x: 10, y: 10, size: 32 },
    { key: 'offer', label: 'Offer', locked: false, default: 'First class free', maxLength: 10, x: 10, y: 60, size: 20 },
  ];
  const r = resolveLocalAsset(fields, { headline: 'Cheap yoga!!', offer: 'Two weeks unlimited' });
  assert.deepEqual(r.values, { headline: 'Find your calm', offer: 'Two weeks' });
  assert.deepEqual(r.rejected.sort(), ['headline', 'offer']);
});

test('local marketing grants: franchise owners submit co-op claims but never decide; HQ marketing has everything', () => {
  const fo = effectiveCapabilities({ role: 'franchise_owner', scopeKind: 'owner_group' }, 'studios');
  assert.ok(fo.has('marketing.coop:edit') && !fo.has('marketing.coop:publish'));
  assert.ok(fo.has('marketing.listings:edit') && !fo.has('marketing.listings:publish'));
  assert.ok(fo.has('marketing.call_tracking:view'));
  const cmo = templateCapabilities('cmo', 'studios');
  for (const c of ['marketing.listings:publish', 'marketing.coop:publish', 'marketing.call_tracking:publish']) assert.ok(cmo.has(c as never), c);
  assert.ok(!templateCapabilities('staff', 'studios').has('marketing.listings:view'));
  // Independent businesses never see the co-op module (network only) but do get listings.
  assert.ok(templateCapabilities('org_owner', 'foods').has('marketing.listings:publish'));
});
