/**
 * Demo data for marketing & sales communications (demo site only), added to the Northlight Yoga International
 * franchisor: location inboxes (SMS, WhatsApp, Instagram, Messenger) and the HQ email inbox, templates and canned
 * replies, tags, consents and segments, lead routing, course leads for instructors, the customer pipeline, HQ-owned
 * social accounts handed over to studios, and network / coming-soon / course / local ad campaigns.
 *
 * Every channel and social account is in sandbox: nothing here is sent or published. Called from seed-demo.ts after
 * seedNorthlight; additive only.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { splitBudget } from '@bh/shared';
import type { Db } from './client.ts';
import * as t from './schema/index.ts';

const MAIL = 'northlight.demo.branchharbor.com';
const hours = (h: number) => new Date(Date.now() - h * 3600_000);
const dayStr = (offset: number) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

export async function seedComms({ db, orgId }: { db: Db; orgId: string }) {
  const locs = await db.select().from(t.locations).where(eq(t.locations.organizationId, orgId));
  const L = Object.fromEntries(locs.map((l) => [l.code, l])) as Record<string, (typeof locs)[number]>;
  const people = await db.select().from(t.users).where(inArray(t.users.email, ['elena.marsh', 'hannah.cho', 'priyanka.shah', 'sofia.lindqvist', 'marcus.bell', 'mia.rossi', 'noah.williams', 'oliver.grant', 'liam.oconnor', 'theo.laurent'].map((x) => `${x}@${MAIL}`)));
  const U = Object.fromEntries(people.map((p) => [p.email.split('@')[0]!, p])) as Record<string, (typeof people)[number]>;
  const custs = await db.select().from(t.customers).where(eq(t.customers.organizationId, orgId));
  const custAt = (code: string) => custs.filter((c) => c.locationId === L[code]!.id);

  // ── Inbox channels (sandbox) ──
  const [annexSms, annexWa, kitsIg, kitsMsgr, hackneySms, hqEmail] = await db.insert(t.commsChannelAccounts).values([
    { organizationId: orgId, locationId: L['TOR-AX']!.id, channel: 'sms', address: '+14165550190', displayName: 'Toronto Annex · SMS', mode: 'sandbox', createdBy: U['elena.marsh']!.id },
    { organizationId: orgId, locationId: L['TOR-AX']!.id, channel: 'whatsapp', address: 'nl-wa-annex', displayName: 'Toronto Annex · WhatsApp', mode: 'sandbox', createdBy: U['elena.marsh']!.id },
    { organizationId: orgId, locationId: L['YVR-KT']!.id, channel: 'instagram', address: 'nl-ig-kits', displayName: 'Kitsilano · Instagram', mode: 'sandbox', createdBy: U['priyanka.shah']!.id },
    { organizationId: orgId, locationId: L['YVR-KT']!.id, channel: 'messenger', address: 'nl-fb-kits', displayName: 'Kitsilano · Messenger', mode: 'sandbox', createdBy: U['priyanka.shah']!.id },
    { organizationId: orgId, locationId: L['LON-HK']!.id, channel: 'sms', address: '+442079460210', displayName: 'London Hackney · SMS', mode: 'sandbox', createdBy: U['elena.marsh']!.id },
    { organizationId: orgId, locationId: null, channel: 'email', address: `hello@${MAIL}`, displayName: 'HQ · hello@', mode: 'sandbox', createdBy: U['elena.marsh']!.id },
  ]).returning();

  const annexCusts = custAt('TOR-AX');
  const isa = annexCusts[0]!;
  await db.update(t.customers).set({ phone: '+14165550111' }).where(eq(t.customers.id, isa.id));
  const threads: Array<{ acct: NonNullable<typeof annexSms>; handle: string; name: string; customerId?: string; subject?: string; status?: string; msgs: Array<[number, 'inbound' | 'outbound' | 'note', string]>; assign?: string }> = [
    { acct: annexSms!, handle: '+14165550111', name: isa.name, customerId: isa.id, msgs: [[30, 'inbound', 'Hi! Is the 6:30am Northlight Flow full tomorrow?'], [29.5, 'outbound', 'Morning! Two spots left — want me to hold one?'], [2, 'inbound', 'Yes please, and can I bring a friend for the intro month?']], assign: 'mia.rossi' },
    { acct: annexWa!, handle: '16475550123', name: 'Jordan Pike', msgs: [[1, 'inbound', 'Hello, do you have showers and towel service?']] },
    { acct: annexWa!, handle: '16475550177', name: 'Kai Mendes', msgs: [[40, 'inbound', 'Can I freeze my membership for 3 weeks?'], [39, 'note', 'Policy allows one freeze per year — check his history.']] },
    { acct: kitsIg!, handle: 'ig-user-8812', name: 'yogi.on.4th', msgs: [[5, 'inbound', 'Love the new hot room! Any beginner classes this weekend?']] },
    { acct: kitsMsgr!, handle: 'psid-5531', name: 'Hana Sato', status: 'pending', msgs: [[50, 'inbound', 'Do you offer corporate packages?'], [49, 'outbound', 'We do! I’ve passed your details to our sales team.']] },
    { acct: hackneySms!, handle: '+447700900456', name: 'Theo Walsh', msgs: [[3, 'inbound', 'Running 10 min late for 6:30, can I still come in?']] },
    { acct: hqEmail!, handle: 'r.ahmed@example.com', name: 'Rana Ahmed', subject: 'Franchise opportunity in Calgary', msgs: [[20, 'inbound', 'Hi, I’d like to learn more about opening a Northlight studio in Calgary. Is there a territory available?']] },
  ];
  for (const th of threads) {
    const last = th.msgs[th.msgs.length - 1]!;
    const lastIn = [...th.msgs].reverse().find((m) => m[1] === 'inbound')!;
    const replied = th.msgs.some((m) => m[1] === 'outbound');
    let leadId: string | null = null;
    if (!th.customerId) {
      const [lead] = await db.insert(t.leads).values({ organizationId: orgId, locationId: th.acct.locationId, source: th.acct.channel, name: th.name, phone: th.acct.channel === 'sms' || th.acct.channel === 'whatsapp' ? th.handle : null, email: th.acct.channel === 'email' ? th.handle : null, message: th.msgs[0]![2], createdAt: hours(th.msgs[0]![0]) }).returning();
      leadId = lead!.id;
    }
    const [conv] = await db.insert(t.commsConversations).values({
      organizationId: orgId, locationId: th.acct.locationId, channelAccountId: th.acct.id, channel: th.acct.channel, handle: th.handle, contactName: th.name, customerId: th.customerId ?? null, leadId, subject: th.subject ?? null,
      status: th.status ?? 'open', assignedUserId: th.assign ? U[th.assign]!.id : null, lastInboundAt: hours(lastIn[0]), lastMessageAt: hours(last[0]), lastMessagePreview: last[2].slice(0, 140),
      unread: last[1] === 'inbound' ? 1 : 0, replyDueAt: last[1] === 'inbound' ? new Date(hours(last[0]).getTime() + 4 * 3600_000) : null, firstReplyAt: replied ? hours(th.msgs.find((m) => m[1] === 'outbound')![0]) : null, createdAt: hours(th.msgs[0]![0]),
    }).returning();
    await db.insert(t.commsMessages).values(th.msgs.map(([h, dir, body]) => ({ organizationId: orgId, conversationId: conv!.id, direction: dir, body, status: dir === 'inbound' ? 'received' : dir === 'note' ? 'note' : 'sandboxed', authorUserId: dir === 'inbound' ? null : U['mia.rossi']!.id, createdAt: hours(h) })));
  }

  await db.insert(t.commsWhatsappTemplates).values([
    { organizationId: orgId, name: 'class_reminder', category: 'utility', body: 'Hi! A reminder about your class tomorrow at Northlight. Reply here if you need to change it.', status: 'approved', createdBy: U['priyanka.shah']!.id },
    { organizationId: orgId, name: 'follow_up_trial', category: 'marketing', body: 'Hi! How was your first class at Northlight? Reply YES and we’ll hold a spot in your next one.', status: 'approved', createdBy: U['priyanka.shah']!.id },
    { organizationId: orgId, name: 'intro_month_offer', category: 'marketing', body: 'Intro month: 30 days unlimited hot yoga. Reply to claim yours.', status: 'pending', createdBy: U['priyanka.shah']!.id },
  ]);
  await db.insert(t.commsCannedReplies).values([
    { organizationId: orgId, locationId: null, title: 'Intro month', body: 'Our intro month is 30 days of unlimited classes. You can start any day — just book your first class online.', createdBy: U['hannah.cho']!.id },
    { organizationId: orgId, locationId: null, title: 'What to bring', body: 'Bring water, a towel and a mat (or rent one at the desk). Arrive 10 minutes early for your first class.', createdBy: U['hannah.cho']!.id },
    { organizationId: orgId, locationId: L['TOR-AX']!.id, title: 'Annex parking', body: 'Free street parking on Brunswick Ave after 6pm; Green P lot at Bloor & Spadina.', createdBy: U['mia.rossi']!.id },
  ]);

  // ── Contacts: tags, consent, segments ──
  for (const [i, c] of custs.entries()) {
    const tags = [i % 3 === 0 ? 'intro-month' : null, i % 4 === 0 ? 'hot-flow' : null, i % 5 === 0 ? 'teacher-training-interest' : null].filter((x): x is string => !!x);
    if (tags.length) await db.insert(t.contactTags).values(tags.map((tag) => ({ organizationId: orgId, customerId: c.id, tag })));
    if (i % 2 === 0) await db.insert(t.consentRecords).values([{ organizationId: orgId, customerId: c.id, email: c.email, purpose: 'marketing_email', version: 'v1', granted: true, source: 'signup' }, ...(i % 4 === 0 ? [{ organizationId: orgId, customerId: c.id, email: c.email, purpose: 'marketing_sms', version: 'v1', granted: true, source: 'signup' }] : [])]);
  }
  await db.insert(t.contactSegments).values([
    { organizationId: orgId, locationId: null, name: 'Lapsed 10+ days (email OK)', rules: { lapsedForDays: 10, consentChannel: 'email' }, createdBy: U['hannah.cho']!.id },
    { organizationId: orgId, locationId: null, name: 'Teacher training interest', rules: { tagsAny: ['teacher-training-interest'] }, createdBy: U['priyanka.shah']!.id },
    { organizationId: orgId, locationId: L['TOR-AX']!.id, name: 'Annex intro-month members', rules: { locationIds: [L['TOR-AX']!.id], tagsAny: ['intro-month'] }, createdBy: U['mia.rossi']!.id },
  ]);

  // ── Lead routing ──
  await db.insert(t.leadRoutingRules).values([
    { organizationId: orgId, kind: 'customer', name: 'Vancouver West (V6) → Kitsilano team', position: 0, conditions: { postalPrefixes: ['V6'] }, action: { type: 'location_team', locationId: L['YVR-KT']!.id }, createdBy: U['grace.kim']?.id ?? U['elena.marsh']!.id },
    { organizationId: orgId, kind: 'customer', name: 'Vancouver East (V5) → Main Street', position: 1, conditions: { postalPrefixes: ['V5'] }, action: { type: 'location', locationId: L['YVR-MS']!.id }, createdBy: U['elena.marsh']!.id },
    { organizationId: orgId, kind: 'customer', name: 'Instagram DMs → Kitsilano', position: 2, conditions: { sources: ['instagram'] }, action: { type: 'location', locationId: L['YVR-KT']!.id }, createdBy: U['elena.marsh']!.id },
    { organizationId: orgId, kind: 'course', name: 'UK course leads → Marcus', position: 0, conditions: { countries: ['GB', 'IE'] }, action: { type: 'users', userIds: [U['marcus.bell']!.id] }, createdBy: U['sofia.lindqvist']!.id },
  ]);

  // ── Ad campaigns ──
  const operating = locs.filter((l) => l.status === 'operating').sort((a, b) => a.name.localeCompare(b.name));
  const totals = { CAD: 450000, USD: 150000, GBP: 120000 };
  const split = splitBudget(operating, totals);
  const [network] = await db.insert(t.adCampaigns).values({ organizationId: orgId, kind: 'network', name: 'Intro month — autumn', objective: 'leads', platforms: ['meta', 'google'], status: 'active', startsOn: dayStr(-14), endsOn: dayStr(16), creative: { headline: 'Intro month: 30 days unlimited', body: 'Hot yoga for a brighter you. Start any day.', cta: 'Sign up', imageUrl: null }, budgetTotals: totals, createdBy: U['priyanka.shah']!.id }).returning();
  await db.insert(t.adCampaignLocations).values(operating.map((l) => ({ organizationId: orgId, campaignId: network!.id, locationId: l.id, budgetMinor: split.get(l.id)!.budgetMinor, currency: l.currency, radiusKm: 6, geo: l.geo ?? null })));
  for (const [i, l] of operating.entries()) {
    for (let d = -10; d < 0; d++) {
      const spend = 900 + ((i * 7 + d * 3) % 5) * 150;
      const [r] = await db.insert(t.adCampaignResults).values({ organizationId: orgId, campaignId: network!.id, locationId: l.id, day: dayStr(d), spendMinor: spend, currency: l.currency, impressions: 1800 + i * 120, clicks: 40 + i * 3, platformLeads: 1 + (i % 2), source: 'manual', enteredBy: U['priyanka.shah']!.id }).returning();
      await db.insert(t.marketingFundSpendEvents).values({ organizationId: orgId, campaignId: network!.id, locationId: l.id, resultId: r!.id, amountMinor: spend, currency: l.currency, occurredOn: dayStr(d), source: 'manual' });
    }
    const lc = custAt(l.code).slice(0, 2);
    await db.insert(t.leads).values(lc.map((c, j) => ({ organizationId: orgId, locationId: l.id, adCampaignId: network!.id, source: 'ad_campaign', name: `${c.name.split(' ')[0]} (ad lead ${j + 1})`, email: `adlead-${j}-${l.code.toLowerCase()}@example.com`, status: j ? 'contacted' : 'new', createdAt: hours(24 * (j + 1)) })));
  }
  const dub = L['DUB-PB']!;
  await db.update(t.locations).set({ settings: { ...(dub.settings ?? {}), openingDate: dayStr(75) } }).where(eq(t.locations.id, dub.id));
  const [coming] = await db.insert(t.adCampaigns).values({
    organizationId: orgId, kind: 'coming_soon', name: 'Dublin Portobello — opening soon', objective: 'leads', platforms: ['meta'], status: 'active', startsOn: dayStr(-7), endsOn: dayStr(75),
    creative: { headline: 'Hot yoga is coming to Portobello', body: 'Join the founding members before we open.', cta: 'Get the offer' },
    comingSoon: { openingDate: dayStr(75), presaleOffer: 'Founding membership: 3 months for €99', formFields: ['name', 'email', 'phone'], consentText: 'Send me news and offers about the opening. I can unsubscribe at any time.' },
    budgetTotals: { EUR: 200000 }, createdBy: U['priyanka.shah']!.id,
  }).returning();
  await db.insert(t.adCampaignLocations).values({ organizationId: orgId, campaignId: coming!.id, locationId: dub.id, budgetMinor: 200000, currency: 'EUR', radiusKm: 5 });
  await db.insert(t.leads).values(['Aoife Byrne', 'Cian Doyle', 'Saoirse Kelly'].map((n, i) => ({ organizationId: orgId, locationId: dub.id, adCampaignId: coming!.id, source: 'coming_soon', name: n, email: `${n.toLowerCase().replace(' ', '.')}@example.com`, country: 'IE', createdAt: hours(10 + i * 20) })));

  const [course] = await db.insert(t.adCampaigns).values({ organizationId: orgId, kind: 'course', name: 'Teacher training 2027', objective: 'leads', platforms: ['meta', 'linkedin'], status: 'active', startsOn: dayStr(-20), endsOn: dayStr(40), creative: { headline: 'Become a Northlight teacher', body: '200-hour hot yoga teacher training, spring 2027.', cta: 'Learn more' }, comingSoon: null, budgetTotals: { CAD: 120000 }, createdBy: U['priyanka.shah']!.id }).returning();
  await db.insert(t.adCampaignLocations).values({ organizationId: orgId, campaignId: course!.id, locationId: L['TOR-AX']!.id, budgetMinor: 120000, currency: 'CAD', radiusKm: 40 });
  await db.insert(t.leads).values([
    { organizationId: orgId, kind: 'course', locationId: L['TOR-AX']!.id, adCampaignId: course!.id, source: 'course_campaign', name: 'Nadia Petrov', email: 'nadia.p@example.com', country: 'CA', assignedUserId: U['sofia.lindqvist']!.id, message: 'Can I do the training part-time?' },
    { organizationId: orgId, kind: 'course', locationId: L['TOR-AX']!.id, adCampaignId: course!.id, source: 'course_campaign', name: 'Ben Okoro', email: 'ben.okoro@example.com', country: 'CA', assignedUserId: U['sofia.lindqvist']!.id, status: 'contacted' },
    { organizationId: orgId, kind: 'course', locationId: null, adCampaignId: course!.id, source: 'course_campaign', name: 'Grace Whitfield', email: 'grace.w@example.com', country: 'GB', assignedUserId: U['marcus.bell']!.id },
  ]);

  // Local campaign waiting for budget approval (Hackney franchisee → approvals inbox).
  const hk = L['LON-HK']!;
  const [local] = await db.insert(t.adCampaigns).values({ organizationId: orgId, kind: 'local', name: 'Hackney — Mare Street flyers + Meta boost', platforms: ['meta'], status: 'pending_approval', startsOn: dayStr(7), endsOn: dayStr(20), creative: { headline: 'Hot yoga on Mare Street', body: 'First class free for Hackney locals.' }, budgetTotals: { GBP: 45000 }, createdBy: U['oliver.grant']!.id }).returning();
  await db.insert(t.adCampaignLocations).values({ organizationId: orgId, campaignId: local!.id, locationId: hk.id, budgetMinor: 45000, currency: 'GBP', radiusKm: 3 });
  const [legacy] = await db.insert(t.campaigns).values({ organizationId: orgId, scopeKind: 'location', scopeId: hk.id, name: local!.name, channel: 'meta_ads', status: 'pending_approval', content: { adSpend: { durationDays: 14, startsOn: dayStr(7), description: 'Local boost before half-term' }, adCampaignId: local!.id }, budgetMinor: 45000, currency: 'GBP', createdBy: U['oliver.grant']!.id }).returning();
  const [ap] = await db.insert(t.approvals).values({ organizationId: orgId, locationId: hk.id, targetType: 'ad_spend', targetId: legacy!.id, title: local!.name, payload: { campaignId: legacy!.id, adCampaignId: local!.id, channel: 'meta_ads', durationDays: 14, startsOn: dayStr(7) }, amountMinor: 45000, currency: 'GBP', requestedBy: U['oliver.grant']!.id, requestComment: 'Local boost before half-term' }).returning();
  await db.update(t.adCampaigns).set({ approvalCampaignId: legacy!.id, approvalId: ap!.id }).where(eq(t.adCampaigns.id, local!.id));

  // ── Sales pipeline ──
  const stageNames = [['New', 'open', 10], ['Contacted', 'open', 25], ['Trial booked', 'open', 50], ['Offer sent', 'open', 70], ['Won', 'won', 100], ['Lost', 'lost', 0]] as const;
  const stages = await db.insert(t.salesStages).values(stageNames.map(([name, outcome, probability], i) => ({ organizationId: orgId, name, outcome, probability, position: i }))).returning();
  const kitsCusts = custAt('YVR-KT');
  const deals = await db.insert(t.salesDeals).values([
    { organizationId: orgId, locationId: L['YVR-KT']!.id, stageId: stages[2]!.id, title: 'Corporate wellness — Hana Sato (12 staff)', valueMinor: 360000, currency: 'CAD', ownerUserId: U['mia.rossi']!.id, expectedCloseOn: dayStr(21), createdBy: U['mia.rossi']!.id },
    { organizationId: orgId, locationId: L['YVR-KT']!.id, stageId: stages[1]!.id, title: `Annual membership — ${kitsCusts[0]?.name ?? 'Member'}`, customerId: kitsCusts[0]?.id ?? null, valueMinor: 189000, currency: 'CAD', ownerUserId: U['mia.rossi']!.id, createdBy: U['mia.rossi']!.id },
    { organizationId: orgId, locationId: L['LON-HK']!.id, stageId: stages[3]!.id, title: 'Studio buy-out — birthday class', valueMinor: 35000, currency: 'GBP', ownerUserId: U['noah.williams']!.id, createdBy: U['noah.williams']!.id },
    { organizationId: orgId, locationId: L['TOR-AX']!.id, stageId: stages[4]!.id, title: '10-class pack — team offsite', valueMinor: 52000, currency: 'CAD', ownerUserId: U['elena.marsh']!.id, closedAt: hours(30), createdBy: U['elena.marsh']!.id },
  ]).returning();
  await db.insert(t.salesActivities).values([
    { organizationId: orgId, dealId: deals[0]!.id, type: 'call', body: 'Spoke to Hana: wants Tue/Thu lunchtime classes for the team.', doneAt: hours(26), createdBy: U['mia.rossi']!.id },
    { organizationId: orgId, dealId: deals[0]!.id, type: 'task', body: 'Send corporate pricing PDF', dueAt: new Date(Date.now() + 86400_000), assignedUserId: U['mia.rossi']!.id, createdBy: U['mia.rossi']!.id },
    { organizationId: orgId, dealId: deals[2]!.id, type: 'email', body: 'Sent buy-out quote (£350).', doneAt: hours(5), createdBy: U['noah.williams']!.id },
  ]);

  // ── Social: HQ-owned accounts handed over to studios ──
  const [igHq, fbHq, liHq, gbpKits] = await db.insert(t.socialAccounts).values([
    { organizationId: orgId, ownerKind: 'hq', network: 'instagram', handle: '@northlightyoga', mode: 'sandbox', connectedBy: U['priyanka.shah']!.id },
    { organizationId: orgId, ownerKind: 'hq', network: 'facebook', handle: 'Northlight Yoga', mode: 'sandbox', connectedBy: U['priyanka.shah']!.id },
    { organizationId: orgId, ownerKind: 'hq', network: 'linkedin', handle: 'Northlight Yoga International', mode: 'sandbox', connectedBy: U['priyanka.shah']!.id },
    { organizationId: orgId, ownerKind: 'location', locationId: L['YVR-KT']!.id, network: 'google_business', handle: 'Northlight Kitsilano', mode: 'sandbox', connectedBy: U['liam.oconnor']!.id },
  ]).returning();
  await db.insert(t.socialAccountGrants).values([
    { organizationId: orgId, accountId: igHq!.id, locationId: L['YVR-KT']!.id, access: 'post', grantedBy: U['priyanka.shah']!.id },
    { organizationId: orgId, accountId: fbHq!.id, locationId: L['YVR-KT']!.id, access: 'post_insights', grantedBy: U['priyanka.shah']!.id },
    { organizationId: orgId, accountId: igHq!.id, locationId: L['LON-HK']!.id, access: 'post', grantedBy: U['priyanka.shah']!.id },
    { organizationId: orgId, accountId: fbHq!.id, locationId: L['PDX-PR']!.id, access: 'post', grantedBy: U['priyanka.shah']!.id, revokedAt: hours(72), revokedBy: U['elena.marsh']!.id, revokeReason: 'Owner change' },
  ]);
  const img = 'https://images.unsplash.com/photo-1599901860904-17e6ed7083a0?w=1080';
  await db.insert(t.socialPosts).values([
    { organizationId: orgId, locationId: null, body: 'Intro month is back: 30 days of unlimited hot yoga at every Northlight studio. 🔥', media: [{ url: img, alt: 'Students in a heated flow class' }], accountIds: [igHq!.id, fbHq!.id], scheduledAt: new Date(Date.now() + 2 * 86400_000), status: 'scheduled', authorUserId: U['priyanka.shah']!.id },
    { organizationId: orgId, locationId: null, body: 'We’re hiring instructor-trainers for our 2027 teacher training. Join the team.', accountIds: [liHq!.id], scheduledAt: new Date(Date.now() + 4 * 86400_000), status: 'scheduled', authorUserId: U['hannah.cho']!.id },
    { organizationId: orgId, locationId: L['YVR-KT']!.id, body: 'Sunrise Flow is back on Saturdays at 7am in Kits — see you on the mat!', media: [{ url: img }], accountIds: [igHq!.id], scheduledAt: new Date(Date.now() + 86400_000), status: 'pending_approval', needsApproval: true, authorUserId: U['mia.rossi']!.id },
    { organizationId: orgId, locationId: L['YVR-KT']!.id, body: 'New: Hot Pilates at lunchtime, Mon–Fri 12pm.', accountIds: [gbpKits!.id], scheduledAt: hours(20), status: 'sandboxed', authorUserId: U['mia.rossi']!.id, publishedAt: hours(20), results: [{ accountId: gbpKits!.id, network: 'google_business', status: 'sandboxed', at: hours(20).toISOString() }] },
    { organizationId: orgId, locationId: null, body: 'Thank you Toronto for 5 years of heat and community.', media: [{ url: img }], accountIds: [igHq!.id], scheduledAt: hours(48), status: 'sandboxed', authorUserId: U['theo.laurent']!.id, decidedBy: U['priyanka.shah']!.id, decidedAt: hours(50), publishedAt: hours(48), results: [{ accountId: igHq!.id, network: 'instagram', status: 'sandboxed', at: hours(48).toISOString() }] },
  ]);

  // Location tiers: Toronto Annex is HQ-run (managed), Kitsilano standard, Portland flexible.
  for (const [code, tier] of [['TOR-AX', 'managed'], ['YVR-KT', 'standard'], ['PDX-PR', 'flexible']] as const) {
    const l = L[code]!;
    await db.update(t.locations).set({ settings: { ...(l.settings ?? {}), marketingTier: tier } }).where(and(eq(t.locations.id, l.id), eq(t.locations.organizationId, orgId)));
  }

  return { channels: 6, conversations: threads.length, campaigns: 4, socialAccounts: 4, sandbox: true, smsAddress: annexSms!.address, waAddress: annexWa!.address };
}
