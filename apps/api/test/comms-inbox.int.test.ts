import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { commsConversations, commsMessages, customers, leads } from '../src/db/schema/index.ts';
import { postmarkAuthHeader, sandboxSecret, signMeta, signSvix, signTwilio, twilioWebhookUrl, webhookSecret } from '../src/integrations/comms-channels.ts';
import { call, createLocation, createOrg, hasDb, makeApp, memberWithRole, uid, verifiedUser } from './helpers.ts';

describe.skipIf(!hasDb)('unified inbox: webhook verification + idempotency per channel, WhatsApp window, consent and scope (DB)', () => {
  let app: FastifyInstance;
  let owner: { token: string; userId: string };
  let mgrA: { token: string; userId: string };
  let orgId: string;
  let locA: any;
  let locB: any;
  const ch: Record<string, any> = {};
  const n = uid();
  const SMS_A = `+1416555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const WA_A = `wa-${n}`;
  const PAGE_B = `page-${n}`;
  const IG_B = `ig-${n}`;
  const HQ_MAIL = `hq-${n}@inbox.example.com`;
  let secret: string;

  const twilio = (params: Record<string, string>, sig?: string) =>
    app.inject({ method: 'POST', url: '/v1/webhooks/comms/twilio', payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig ?? signTwilio(secret, twilioWebhookUrl(app.ctx.cfg), params) } });
  const metaPost = (url: string, body: unknown, sig?: string) => {
    const raw = JSON.stringify(body);
    return app.inject({ method: 'POST', url, payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig ?? signMeta(secret, raw) } });
  };
  const waBody = (id: string, from: string, text: string) => ({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: { metadata: { phone_number_id: WA_A }, contacts: [{ wa_id: from, profile: { name: 'Wanda' } }], messages: [{ id, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
  const convOf = async (handle: string) => (await app.ctx.db.select().from(commsConversations).where(eq(commsConversations.handle, handle)))[0]!;
  const msgCount = async (convId: string) => (await app.ctx.db.select().from(commsMessages).where(eq(commsMessages.conversationId, convId))).length;
  const reply = (token: string, convId: string, body: Record<string, unknown>) => call(app, 'POST', `/v1/orgs/${orgId}/inbox/conversations/${convId}/messages`, { token, body });

  beforeAll(async () => {
    app = await makeApp();
    secret = sandboxSecret(app.ctx.cfg);
    owner = await verifiedUser(app, 'Olive Owner');
    orgId = (await createOrg(app, owner.token)).id;
    locA = await createLocation(app, owner.token, orgId, { name: 'Annex' });
    locB = await createLocation(app, owner.token, orgId, { name: 'Kitsilano' });
    mgrA = await memberWithRole(app, owner.token, orgId, 'location_manager', { kind: 'location', id: locA.id }, 'Mia Manager');
    const add = async (body: Record<string, unknown>) => {
      const r = await call(app, 'POST', `/v1/orgs/${orgId}/inbox/channels`, { token: owner.token, body });
      expect(r.status).toBe(201);
      expect(r.body.mode).toBe('sandbox');
      return r.body;
    };
    ch.sms = await add({ channel: 'sms', locationId: locA.id, address: SMS_A, displayName: 'Annex SMS' });
    ch.wa = await add({ channel: 'whatsapp', locationId: locA.id, address: WA_A, displayName: 'Annex WhatsApp' });
    ch.msgr = await add({ channel: 'messenger', locationId: locB.id, address: PAGE_B, displayName: 'Kits page' });
    ch.ig = await add({ channel: 'instagram', locationId: locB.id, address: IG_B, displayName: 'Kits IG' });
    ch.email = await add({ channel: 'email', locationId: null, address: HQ_MAIL, displayName: 'HQ inbox' });
  });
  afterAll(async () => { await app?.close(); });

  it('uses the sandbox secret when no provider secret is configured (never an empty secret)', () => {
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    for (const p of ['twilio', 'whatsapp', 'meta', 'postmark'] as const) expect(webhookSecret(app.ctx.cfg, p)).toEqual({ secret, live: false });
  });

  it('SMS (Twilio): rejects a bad signature, ingests a signed message once, and replays are idempotent', async () => {
    const from = '+14165550199';
    const params = { MessageSid: `SM${uid()}`, From: from, To: SMS_A, Body: 'Hi, do you have parking?' };
    expect((await twilio(params, 'bm90LXZhbGlk')).statusCode).toBe(401);
    expect((await twilio({ ...params, Body: 'tampered' }, signTwilio(secret, twilioWebhookUrl(app.ctx.cfg), params))).statusCode).toBe(401);
    const ok = await twilio(params);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results[0].outcome).toBe('ingested');
    const again = await twilio(params);
    expect(again.json().results[0].outcome).toBe('duplicate');
    const conv = await convOf(from);
    expect(conv.locationId).toBe(locA.id);
    expect(await msgCount(conv.id)).toBe(1);
    // An unknown contact becomes a lead at the inbox's location, linked to the conversation.
    const [lead] = await app.ctx.db.select().from(leads).where(eq(leads.id, conv.leadId!));
    expect(lead).toMatchObject({ source: 'sms', phone: from, locationId: locA.id });
    expect(conv.replyDueAt).toBeTruthy();
  });

  it('WhatsApp Cloud API: X-Hub-Signature-256 verified, idempotent per message id', async () => {
    const body = waBody(`wamid.${uid()}`, '447700900123', 'Can I book a trial?');
    expect((await metaPost('/v1/webhooks/comms/whatsapp', body, 'sha256=00')).statusCode).toBe(401);
    expect((await metaPost('/v1/webhooks/comms/whatsapp', body)).json().results[0].outcome).toBe('ingested');
    expect((await metaPost('/v1/webhooks/comms/whatsapp', body)).json().results[0].outcome).toBe('duplicate');
    // Delivery statuses are acknowledged and ignored.
    const statuses = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: WA_A }, statuses: [{ id: 'x', status: 'delivered' }] } }] }] };
    expect((await metaPost('/v1/webhooks/comms/whatsapp', statuses)).json()).toMatchObject({ results: [], ignored: 1 });
    expect(await msgCount((await convOf('447700900123')).id)).toBe(1);
  });

  it('Messenger and Instagram (Meta): signed, idempotent, echoes ignored', async () => {
    const mid = `m_${uid()}`;
    const page = { object: 'page', entry: [{ id: PAGE_B, messaging: [{ sender: { id: 'psid-1' }, recipient: { id: PAGE_B }, timestamp: Date.now(), message: { mid, text: 'Hello from Messenger' } }, { sender: { id: PAGE_B }, recipient: { id: 'psid-1' }, message: { mid: `${mid}e`, text: 'echo', is_echo: true } }] }] };
    expect((await metaPost('/v1/webhooks/comms/meta', page, signMeta('wrong-secret', JSON.stringify(page)))).statusCode).toBe(401);
    const r = (await metaPost('/v1/webhooks/comms/meta', page)).json();
    expect(r.results).toHaveLength(1);
    expect(r.ignored).toBe(1);
    expect((await metaPost('/v1/webhooks/comms/meta', page)).json().results[0].outcome).toBe('duplicate');
    const ig = { object: 'instagram', entry: [{ id: IG_B, messaging: [{ sender: { id: 'igsid-1' }, recipient: { id: IG_B }, timestamp: Date.now(), message: { mid: `ig_${uid()}`, text: 'DM' } }] }] };
    expect((await metaPost('/v1/webhooks/comms/meta', ig)).json().results[0].outcome).toBe('ingested');
    expect((await convOf('igsid-1')).channel).toBe('instagram');
  });

  it('email (Postmark basic auth and Resend Svix): verified and idempotent', async () => {
    const pm = JSON.stringify({ MessageID: `pm-${uid()}`, From: 'Ana <ana@example.com>', FromName: 'Ana', To: HQ_MAIL, OriginalRecipient: HQ_MAIL, Subject: 'Franchise question', TextBody: 'Hello HQ' });
    const send = (auth: string) => app.inject({ method: 'POST', url: '/v1/webhooks/comms/email/postmark', payload: pm, headers: { 'content-type': 'application/json', authorization: auth } });
    expect((await send(postmarkAuthHeader('nope'))).statusCode).toBe(401);
    expect((await send(postmarkAuthHeader(secret))).json().results[0].outcome).toBe('ingested');
    expect((await send(postmarkAuthHeader(secret))).json().results[0].outcome).toBe('duplicate');
    const conv = await convOf('ana@example.com');
    expect(conv).toMatchObject({ locationId: null, subject: 'Franchise question' });

    const rsecret = webhookSecret(app.ctx.cfg, 'resend').secret;
    const raw = JSON.stringify({ type: 'email.received', data: { email_id: `re-${uid()}`, from: 'ben@example.com', to: [HQ_MAIL], subject: 'Hi', text: 'Via Resend' } });
    const id = `msg_${uid()}`;
    const resend = (ts: string, sig?: string) => app.inject({ method: 'POST', url: '/v1/webhooks/comms/email/resend', payload: raw, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig ?? signSvix(rsecret, id, ts, raw) } });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await resend(old)).statusCode).toBe(401); // outside the replay window
    const now = String(Math.floor(Date.now() / 1000));
    expect((await resend(now, 'v1,AAAA')).statusCode).toBe(401);
    expect((await resend(now)).json().results[0].outcome).toBe('ingested');
    expect((await resend(now)).json().results[0].outcome).toBe('duplicate');
  });

  it('messages to an address with no inbox are acknowledged but not stored', async () => {
    const r = await twilio({ MessageSid: `SM${uid()}`, From: '+15550000000', To: '+19999999999', Body: 'hello?' });
    expect(r.statusCode).toBe(200);
    expect(r.json().results[0].outcome).toBe('unknown_recipient');
  });

  it('simulate inbound (sandbox) goes through the same signed webhook path', async () => {
    const r = await call(app, 'POST', `/v1/orgs/${orgId}/inbox/channels/${ch.sms.id}/simulate`, { token: mgrA.token, body: { from: '+14165550123', name: 'Sim Contact', body: 'Simulated hello', messageId: 'SMsim1' } });
    expect(r.status).toBe(200);
    expect(r.body.results[0].outcome).toBe('ingested');
    const dup = await call(app, 'POST', `/v1/orgs/${orgId}/inbox/channels/${ch.sms.id}/simulate`, { token: mgrA.token, body: { from: '+14165550123', body: 'Simulated hello', messageId: 'SMsim1' } });
    expect(dup.body.results[0].outcome).toBe('duplicate');
    // A location manager can't simulate on another location's channel.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/inbox/channels/${ch.msgr.id}/simulate`, { token: mgrA.token, body: { from: 'psid-9', body: 'hello' } })).status).toBe(403);
  });

  it('WhatsApp 24-hour window: free text inside, approved template required outside', async () => {
    const conv = await convOf('447700900123');
    const inside = await reply(mgrA.token, conv.id, { body: 'Yes! Tomorrow 7am works.' });
    expect(inside.status).toBe(201);
    expect(inside.body.status).toBe('sandboxed'); // sandbox never claims delivery
    await app.ctx.db.update(commsConversations).set({ lastInboundAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(commsConversations.id, conv.id));
    const outside = await reply(mgrA.token, conv.id, { body: 'Still interested?' });
    expect(outside.status).toBe(409);
    expect(outside.body.error.code).toBe('whatsapp_template_required');
    const tpl = await call(app, 'POST', `/v1/orgs/${orgId}/inbox/whatsapp-templates`, { token: owner.token, body: { name: `follow_up_${uid()}`, body: 'Hi! Still keen on a trial class? Reply YES to book.' } });
    expect(tpl.body.status).toBe('pending');
    expect((await reply(mgrA.token, conv.id, { templateId: tpl.body.id })).body.error.code).toBe('template_not_approved');
    // Only HQ (organisation-wide inbox) records template reviews.
    expect((await call(app, 'POST', `/v1/orgs/${orgId}/inbox/whatsapp-templates/${tpl.body.id}/review`, { token: mgrA.token, body: { status: 'approved' } })).status).toBe(403);
    await call(app, 'POST', `/v1/orgs/${orgId}/inbox/whatsapp-templates/${tpl.body.id}/review`, { token: owner.token, body: { status: 'approved' } });
    const sent = await reply(mgrA.token, conv.id, { templateId: tpl.body.id });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ templateId: tpl.body.id, status: 'sandboxed' });
    const detail = await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations/${conv.id}`, { token: mgrA.token });
    expect(detail.body.policy).toMatchObject({ needsTemplate: true, canReply: false });
  });

  it('Messenger outside the window cannot be messaged; notes are always allowed', async () => {
    const conv = await convOf('psid-1');
    await app.ctx.db.update(commsConversations).set({ lastInboundAt: new Date(Date.now() - 30 * 3600_000) }).where(eq(commsConversations.id, conv.id));
    expect((await reply(owner.token, conv.id, { body: 'Sorry for the delay' })).body.error.code).toBe('messaging_window_closed');
    const note = await reply(owner.token, conv.id, { kind: 'note', body: 'Customer asked about parking' });
    expect(note.status).toBe(201);
    expect(note.body.direction).toBe('note');
  });

  it('consent: STOP opts the contact out (outbound blocked), START opts back in', async () => {
    const from = '+14165550199';
    const conv = await convOf(from);
    expect((await reply(mgrA.token, conv.id, { body: 'Yes, free parking behind the studio.' })).status).toBe(201);
    await twilio({ MessageSid: `SM${uid()}`, From: from, To: SMS_A, Body: 'STOP' });
    const blocked = await reply(mgrA.token, conv.id, { body: 'One more thing…' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('contact_opted_out');
    await twilio({ MessageSid: `SM${uid()}`, From: from, To: SMS_A, Body: 'start' });
    expect((await reply(mgrA.token, conv.id, { body: 'Welcome back' })).status).toBe(201);
  });

  it('consent: broadcasts skip contacts without consent for the channel and those who opted out', async () => {
    const mk = async (name: string, phone: string) => (await app.ctx.db.insert(customers).values({ organizationId: orgId, locationId: locA.id, name, phone }).returning())[0]!;
    const yes = await mk('Consent Yes', '+14165551001');
    const no = await mk('Consent Never', '+14165551002');
    const stop = await mk('Consent Stop', '+14165551003');
    for (const c of [yes, no, stop]) await call(app, 'PUT', `/v1/orgs/${orgId}/contacts/${c.id}/tags`, { token: mgrA.token, body: { tags: ['spring-promo'] } });
    for (const c of [yes, stop]) expect((await call(app, 'POST', `/v1/orgs/${orgId}/contacts/${c.id}/consent`, { token: mgrA.token, body: { channel: 'sms', granted: true } })).status).toBe(201);
    await twilio({ MessageSid: `SM${uid()}`, From: stop.phone!, To: SMS_A, Body: 'STOP' });
    const seg = await call(app, 'POST', `/v1/orgs/${orgId}/segments`, { token: mgrA.token, body: { name: 'Spring promo', locationId: locA.id, rules: { tagsAny: ['spring-promo'] } } });
    expect(seg.status).toBe(201);
    const preview = await call(app, 'POST', `/v1/orgs/${orgId}/segments/preview`, { token: mgrA.token, body: { rules: { tagsAny: ['spring-promo'], consentChannel: 'sms' } } });
    expect(preview.body.count).toBe(1); // STOP recorded consent withdrawal for the known customer
    const b = await call(app, 'POST', `/v1/orgs/${orgId}/inbox/broadcasts`, { token: mgrA.token, body: { segmentId: seg.body.id, channelAccountId: ch.sms.id, body: 'Spring offer: 20% off packs' } });
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ matched: 3, sandboxed: 1, sent: 0, skippedNoConsent: 1, skippedOptedOut: 1 });
    // A proactive conversation without consent can't be replied to from the inbox either.
    const [conv] = await app.ctx.db.insert(commsConversations).values({ organizationId: orgId, locationId: locA.id, channelAccountId: ch.sms.id, channel: 'sms', handle: no.phone!, customerId: no.id, status: 'open' }).returning();
    expect((await reply(mgrA.token, conv!.id, { body: 'Hello!' })).body.error.code).toBe('consent_required');
  });

  it('scope: a location sees only its own inbox; HQ sees the network, HQ-only or chosen locations', async () => {
    const mine = await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations?status=all`, { token: mgrA.token });
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((c: any) => c.locationId === locA.id)).toBe(true);
    expect(mine.body.hq).toBe(false);
    const other = await convOf('psid-1');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations/${other.id}`, { token: mgrA.token })).status).toBe(403);
    expect((await reply(mgrA.token, other.id, { kind: 'note', body: 'sneaky' })).status).toBe(403);
    const hqConv = await convOf('ana@example.com');
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations/${hqConv.id}`, { token: mgrA.token })).status).toBe(403);
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations?inbox=hq`, { token: mgrA.token })).body.items).toEqual([]);
    // Choosing another location doesn't widen a location's scope.
    expect((await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations?status=all&locationIds=${locB.id}`, { token: mgrA.token })).body.items).toEqual([]);

    const all = await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations?status=all`, { token: owner.token });
    const locs = new Set(all.body.items.map((c: any) => c.locationId));
    expect(locs).toEqual(new Set([locA.id, locB.id, null]));
    const hq = await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations?status=all&inbox=hq`, { token: owner.token });
    expect(hq.body.items.every((c: any) => c.locationId === null)).toBe(true);
    const chosen = await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations?status=all&locationIds=${locB.id}`, { token: owner.token });
    expect(chosen.body.items.every((c: any) => c.locationId === locB.id)).toBe(true);

    // Staff without the Inbox module are refused the whole area.
    const staff = await memberWithRole(app, owner.token, orgId, 'staff', { kind: 'location', id: locA.id });
    const denied = await call(app, 'GET', `/v1/orgs/${orgId}/inbox/conversations`, { token: staff.token });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('module_not_available');
  });

  it('assignment is limited to people with inbox access there; closing clears the SLA', async () => {
    const conv = await convOf('+14165550123');
    const bad = await call(app, 'PATCH', `/v1/orgs/${orgId}/inbox/conversations/${conv.id}`, { token: owner.token, body: { assignedUserId: '00000000-0000-4000-8000-000000000000' } });
    expect(bad.status).toBe(400);
    const ok = await call(app, 'PATCH', `/v1/orgs/${orgId}/inbox/conversations/${conv.id}`, { token: owner.token, body: { assignedUserId: mgrA.userId, status: 'closed' } });
    expect(ok.body).toMatchObject({ status: 'closed', assignedUser: { id: mgrA.userId, name: 'Mia Manager' }, replyDueAt: null });
    // A new inbound message reopens it.
    await call(app, 'POST', `/v1/orgs/${orgId}/inbox/channels/${ch.sms.id}/simulate`, { token: owner.token, body: { from: '+14165550123', body: 'One more question' } });
    expect((await convOf('+14165550123')).status).toBe('open');
  });
});
