/**
 * Inbox channel adapters: webhook signature verification and payload parsing per provider, plus outbound sending.
 *
 * Providers and how their webhooks are authenticated:
 *  - Twilio SMS            X-Twilio-Signature = base64(HMAC-SHA1(auth token, URL + sorted form params))
 *  - WhatsApp Cloud API    X-Hub-Signature-256 = sha256=hex(HMAC-SHA256(app secret, raw body))
 *  - Messenger / Instagram X-Hub-Signature-256 (Meta app secret), same scheme
 *  - Postmark inbound      HTTP basic auth on the webhook URL (inbound:<POSTMARK_INBOUND_TOKEN>)
 *  - Resend inbound        Svix headers (svix-id, svix-timestamp, svix-signature v1,<base64 HMAC-SHA256>)
 *
 * Without provider credentials a channel runs in sandbox: webhooks must be signed with the sandbox secret (derived
 * from ENCRYPTION_KEY unless COMMS_SANDBOX_SECRET is set), which is how "simulate inbound" works, and outbound
 * messages are recorded as `sandboxed` — never reported as delivered.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config.ts';
import type { InboxChannel } from '../db/schema/comms.ts';
import type { Services } from '../context.ts';

export type CommsProvider = 'twilio' | 'whatsapp' | 'meta' | 'postmark' | 'resend';

export interface InboundMessage {
  provider: CommsProvider;
  /** Provider's unique message / event id (idempotency key). */
  eventKey: string;
  channel: InboxChannel;
  /** The business address the message was sent to (matched against comms_channel_accounts.address). */
  to: string;
  /** The contact's handle. */
  from: string;
  name?: string | null;
  subject?: string | null;
  body: string;
  at: Date;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  /** Events that carry no message (delivery statuses, echoes) — acknowledged and ignored. */
  ignored: number;
}

export const sandboxSecret = (cfg: Config) => cfg.COMMS_SANDBOX_SECRET ?? createHash('sha256').update(`bh-comms-sandbox:${cfg.ENCRYPTION_KEY}`).digest('hex');

/** Live provider secret when configured, otherwise the sandbox secret. */
export function webhookSecret(cfg: Config, provider: CommsProvider): { secret: string; live: boolean } {
  const live = (v: string | undefined) => (v ? { secret: v, live: true } : { secret: sandboxSecret(cfg), live: false });
  switch (provider) {
    case 'twilio': return live(cfg.TWILIO_AUTH_TOKEN);
    case 'whatsapp': return live(cfg.WHATSAPP_APP_SECRET ?? cfg.META_APP_SECRET);
    case 'meta': return live(cfg.META_APP_SECRET);
    case 'postmark': return live(cfg.POSTMARK_INBOUND_TOKEN);
    case 'resend': return cfg.RESEND_WEBHOOK_SECRET ? { secret: cfg.RESEND_WEBHOOK_SECRET, live: true } : { secret: `whsec_${Buffer.from(sandboxSecret(cfg)).toString('base64')}`, live: false };
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/* ── signing (providers do this; we use it for sandbox simulation and tests) ── */

export const twilioWebhookUrl = (cfg: Config) => `${cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/webhooks/comms/twilio`;

export function signTwilio(secret: string, url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', secret).update(Buffer.from(data, 'utf8')).digest('base64');
}
export const signMeta = (secret: string, raw: Buffer | string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
export const postmarkAuthHeader = (token: string) => `Basic ${Buffer.from(`inbound:${token}`).toString('base64')}`;
export function signSvix(secret: string, id: string, timestamp: string, raw: Buffer | string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${raw.toString()}`).digest('base64')}`;
}

/* ── verification ── */

type Headers = Record<string, string | string[] | undefined>;
const h = (headers: Headers, name: string) => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export function verifyWebhook(cfg: Config, provider: CommsProvider, raw: Buffer, headers: Headers, now = Date.now()): boolean {
  const { secret } = webhookSecret(cfg, provider);
  switch (provider) {
    case 'twilio': {
      const sig = h(headers, 'x-twilio-signature');
      if (!sig) return false;
      const params = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
      return safeEqual(sig, signTwilio(secret, twilioWebhookUrl(cfg), params));
    }
    case 'whatsapp':
    case 'meta': {
      const sig = h(headers, 'x-hub-signature-256');
      return !!sig && safeEqual(sig, signMeta(secret, raw));
    }
    case 'postmark': {
      const auth = h(headers, 'authorization');
      return !!auth && safeEqual(auth, postmarkAuthHeader(secret));
    }
    case 'resend': {
      const id = h(headers, 'svix-id');
      const ts = h(headers, 'svix-timestamp');
      const sigs = h(headers, 'svix-signature');
      if (!id || !ts || !sigs) return false;
      if (Math.abs(now / 1000 - Number(ts)) > 300) return false; // replay window
      const expected = signSvix(secret, id, ts, raw);
      return sigs.split(' ').some((s) => safeEqual(s, expected));
    }
  }
}

/* ── parsing ── */

const stripWa = (v: string) => v.replace(/^whatsapp:/, '');
const emailOf = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

export function parseWebhook(provider: CommsProvider, raw: Buffer, headers: Headers): ParsedWebhook {
  switch (provider) {
    case 'twilio': {
      const p = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
      if (!p.MessageSid || !p.From || !p.To) return { messages: [], ignored: 1 };
      // Delivery status callbacks carry MessageStatus without a Body.
      if (p.Body === undefined && p.MessageStatus) return { messages: [], ignored: 1 };
      const wa = p.From.startsWith('whatsapp:');
      return { messages: [{ provider, eventKey: p.MessageSid, channel: wa ? 'whatsapp' : 'sms', to: stripWa(p.To), from: stripWa(p.From), name: p.ProfileName ?? null, body: p.Body ?? '', at: new Date() }], ignored: 0 };
    }
    case 'whatsapp': {
      const j = JSON.parse(raw.toString('utf8') || '{}') as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string }; contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>; messages?: Array<{ id: string; from: string; timestamp?: string; type?: string; text?: { body?: string } }>; statuses?: unknown[] } }> }> };
      const out: InboundMessage[] = [];
      let ignored = 0;
      for (const e of j.entry ?? []) for (const c of e.changes ?? []) {
        const v = c.value ?? {};
        ignored += v.statuses?.length ?? 0;
        for (const m of v.messages ?? []) {
          const name = v.contacts?.find((x) => x.wa_id === m.from)?.profile?.name ?? v.contacts?.[0]?.profile?.name ?? null;
          out.push({ provider, eventKey: m.id, channel: 'whatsapp', to: v.metadata?.phone_number_id ?? '', from: m.from, name, body: m.type === 'text' || !m.type ? (m.text?.body ?? '') : `[${m.type}]`, at: m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date() });
        }
      }
      return { messages: out, ignored };
    }
    case 'meta': {
      const j = JSON.parse(raw.toString('utf8') || '{}') as { object?: string; entry?: Array<{ id?: string; messaging?: Array<{ sender?: { id?: string }; recipient?: { id?: string }; timestamp?: number; message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: unknown[] } }> }> };
      const channel: InboxChannel = j.object === 'instagram' ? 'instagram' : 'messenger';
      const out: InboundMessage[] = [];
      let ignored = 0;
      for (const e of j.entry ?? []) for (const m of e.messaging ?? []) {
        if (!m.message?.mid || m.message.is_echo || !m.sender?.id) { ignored++; continue; }
        out.push({ provider, eventKey: m.message.mid, channel, to: m.recipient?.id ?? e.id ?? '', from: m.sender.id, body: m.message.text ?? (m.message.attachments?.length ? '[attachment]' : ''), at: m.timestamp ? new Date(m.timestamp) : new Date() });
      }
      return { messages: out, ignored };
    }
    case 'postmark': {
      const j = JSON.parse(raw.toString('utf8') || '{}') as { MessageID?: string; From?: string; FromName?: string; To?: string; OriginalRecipient?: string; Subject?: string; TextBody?: string; StrippedTextReply?: string; Date?: string };
      if (!j.MessageID || !j.From) return { messages: [], ignored: 1 };
      const to = emailOf(j.OriginalRecipient || (j.To ?? '').split(',')[0] || '');
      return { messages: [{ provider, eventKey: j.MessageID, channel: 'email', to, from: emailOf(j.From), name: j.FromName ?? null, subject: j.Subject ?? null, body: (j.StrippedTextReply || j.TextBody || '').trim(), at: j.Date ? new Date(j.Date) : new Date() }], ignored: 0 };
    }
    case 'resend': {
      const j = JSON.parse(raw.toString('utf8') || '{}') as { type?: string; data?: { email_id?: string; from?: string; to?: string[] | string; subject?: string; text?: string; created_at?: string } };
      if (j.type !== 'email.received' || !j.data?.from) return { messages: [], ignored: 1 };
      const to = Array.isArray(j.data.to) ? j.data.to[0] ?? '' : j.data.to ?? '';
      return { messages: [{ provider, eventKey: j.data.email_id ?? h(headers, 'svix-id') ?? '', channel: 'email', to: emailOf(to), from: emailOf(j.data.from), subject: j.data.subject ?? null, body: (j.data.text ?? '').trim(), at: j.data.created_at ? new Date(j.data.created_at) : new Date() }], ignored: 0 };
    }
  }
}

/** Builds and signs a provider-format webhook for a simulated inbound message (sandbox channels only). */
export function buildSandboxWebhook(cfg: Config, m: { channel: InboxChannel; to: string; from: string; name?: string | null; subject?: string | null; body: string; id: string }): { provider: CommsProvider; raw: Buffer; headers: Record<string, string> } {
  const secret = sandboxSecret(cfg);
  switch (m.channel) {
    case 'sms': {
      const params: Record<string, string> = { MessageSid: m.id, From: m.from, To: m.to, Body: m.body, ...(m.name ? { ProfileName: m.name } : {}) };
      return { provider: 'twilio', raw: Buffer.from(new URLSearchParams(params).toString()), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signTwilio(secret, twilioWebhookUrl(cfg), params) } };
    }
    case 'whatsapp': {
      const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'sandbox', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: m.to }, contacts: [{ wa_id: m.from, profile: { name: m.name ?? m.from } }], messages: [{ id: m.id, from: m.from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: m.body } }] } }] }] }));
      return { provider: 'whatsapp', raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(secret, raw) } };
    }
    case 'instagram':
    case 'messenger': {
      const raw = Buffer.from(JSON.stringify({ object: m.channel === 'instagram' ? 'instagram' : 'page', entry: [{ id: m.to, time: Date.now(), messaging: [{ sender: { id: m.from }, recipient: { id: m.to }, timestamp: Date.now(), message: { mid: m.id, text: m.body } }] }] }));
      return { provider: 'meta', raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(secret, raw) } };
    }
    case 'email': {
      const raw = Buffer.from(JSON.stringify({ MessageID: m.id, From: m.name ? `${m.name} <${m.from}>` : m.from, FromName: m.name ?? '', To: m.to, OriginalRecipient: m.to, Subject: m.subject ?? '', TextBody: m.body, Date: new Date().toISOString() }));
      return { provider: 'postmark', raw, headers: { 'content-type': 'application/json', authorization: postmarkAuthHeader(secret) } };
    }
  }
}

/* ── outbound ── */

export interface OutboundResult { status: 'sent' | 'sandboxed' | 'failed'; externalId?: string | null; error?: string | null }

export interface OutboundInput {
  channel: InboxChannel;
  /** Channel account mode and decrypted provider token (Meta page token). */
  accountMode: string;
  accountAddress: string;
  pageToken?: string | null;
  to: string;
  body: string;
  subject?: string | null;
  template?: { name: string; language: string } | null;
}

/** True when the platform has credentials to send on this channel. */
export function channelLive(s: Pick<Services, 'cfg' | 'messaging' | 'mailer'>, channel: InboxChannel, hasPageToken = false): boolean {
  switch (channel) {
    case 'sms': return s.messaging.smsEnabled;
    case 'whatsapp': return s.messaging.whatsappEnabled;
    case 'email': return s.mailer.mode !== 'log';
    case 'instagram':
    case 'messenger': return !!(s.cfg.META_APP_ID && s.cfg.META_APP_SECRET && hasPageToken);
  }
}

export async function sendOutbound(s: Services, m: OutboundInput): Promise<OutboundResult> {
  if (m.accountMode !== 'live' || !channelLive(s, m.channel, !!m.pageToken)) {
    s.log.info({ channel: m.channel, to: m.to }, '[inbox:sandbox] outbound message recorded, not sent');
    return { status: 'sandboxed' };
  }
  try {
    switch (m.channel) {
      case 'sms': {
        const r = await s.messaging.sendSms(m.to, m.body);
        return r.delivered ? { status: 'sent' } : { status: 'failed', error: 'SMS provider refused the message' };
      }
      case 'whatsapp': {
        if (!m.template) {
          const r = await s.messaging.sendWhatsApp(m.to, m.body);
          return r.delivered ? { status: 'sent' } : { status: 'failed', error: 'WhatsApp refused the message' };
        }
        const res = await fetch(`https://graph.facebook.com/v21.0/${s.cfg.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${s.cfg.WHATSAPP_CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: m.to, type: 'template', template: { name: m.template.name, language: { code: m.template.language } } }),
        });
        const j = (await res.json().catch(() => ({}))) as { messages?: Array<{ id?: string }> };
        return res.ok ? { status: 'sent', externalId: j.messages?.[0]?.id ?? null } : { status: 'failed', error: `WhatsApp template send failed (${res.status})` };
      }
      case 'email': {
        const subject = m.subject ? (/^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`) : 'Your message';
        const r = await s.mailer.send({ to: m.to, subject, text: m.body, tag: 'inbox-reply' });
        return r.delivered ? { status: 'sent', externalId: r.id } : { status: 'sandboxed' };
      }
      case 'instagram':
      case 'messenger': {
        const res = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(m.pageToken!)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: { id: m.to }, messaging_type: 'RESPONSE', message: { text: m.body } }),
        });
        const j = (await res.json().catch(() => ({}))) as { message_id?: string };
        return res.ok ? { status: 'sent', externalId: j.message_id ?? null } : { status: 'failed', error: `Meta send failed (${res.status})` };
      }
    }
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}
