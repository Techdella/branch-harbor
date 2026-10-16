import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag?: string;
  /** Sender display name (e.g. the brand); the address stays the verified EMAIL_FROM. */
  fromName?: string | null;
  replyTo?: string | null;
  /** Files sent with the message (e.g. a purchase order PDF and CSV). Base64 content, so messages stay JSON for the queue. */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  contentBase64: string;
}

/** Attachments: at most 10 files and 10 MB in total (both providers accept more; the queue and inboxes may not). */
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function checkAttachments(list: EmailAttachment[] | undefined): EmailAttachment[] {
  if (!list?.length) return [];
  if (list.length > MAX_ATTACHMENTS) throw new Error(`Too many attachments (${list.length}, at most ${MAX_ATTACHMENTS})`);
  const bytes = list.reduce((n, a) => n + Math.floor((a.contentBase64.length * 3) / 4), 0);
  if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`Attachments too large (${bytes} bytes, at most ${MAX_ATTACHMENT_BYTES})`);
  // A file name is a header value: keep it to one safe line.
  return list.map((a) => ({ ...a, filename: a.filename.replace(/[\r\n"\\/]/g, '_').slice(0, 120) || 'attachment' }));
}

/** `"Name" <address>` with the display name made safe for the header; the bare address when no name is given. */
export function fromHeader(address: string, name?: string | null): string {
  const bare = address.replace(/^.*<([^>]+)>.*$/, '$1').trim();
  const clean = name?.replace(/["\r\n<>]/g, '').trim();
  return clean ? `"${clean}" <${bare}>` : address;
}

export interface Mailer {
  readonly mode: 'postmark' | 'resend' | 'log';
  send(msg: EmailMessage): Promise<{ id: string | null; delivered: boolean }>;
  /** Messages captured in log mode (dev/test only). */
  readonly outbox: EmailMessage[];
}

/** Email adapter. Postmark or Resend when configured; otherwise logs (never crashes). */
export function createMailer(cfg: Config, log: FastifyBaseLogger): Mailer {
  const mode = cfg.EMAIL_PROVIDER ?? (cfg.POSTMARK_SERVER_TOKEN ? 'postmark' : cfg.RESEND_API_KEY ? 'resend' : 'log');
  const outbox: EmailMessage[] = [];
  if (mode === 'log') log.warn('[email] No POSTMARK_SERVER_TOKEN or RESEND_API_KEY — email disabled, messages are logged only');

  return {
    mode,
    outbox,
    async send(msg) {
      const attachments = checkAttachments(msg.attachments);
      if (mode === 'postmark' && cfg.POSTMARK_SERVER_TOKEN) {
        const res = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { 'X-Postmark-Server-Token': cfg.POSTMARK_SERVER_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            From: fromHeader(cfg.EMAIL_FROM, msg.fromName), ReplyTo: msg.replyTo ?? undefined, To: msg.to, Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, Tag: msg.tag, MessageStream: 'outbound',
            ...(attachments.length ? { Attachments: attachments.map((a) => ({ Name: a.filename, Content: a.contentBase64, ContentType: a.contentType })) } : {}),
          }),
        });
        if (!res.ok) throw new Error(`Postmark send failed: ${res.status}`);
        const body = (await res.json()) as { MessageID?: string };
        return { id: body.MessageID ?? null, delivered: true };
      }
      if (mode === 'resend' && cfg.RESEND_API_KEY) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromHeader(cfg.EMAIL_FROM, msg.fromName), reply_to: msg.replyTo ?? undefined, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html, tags: msg.tag ? [{ name: 'category', value: msg.tag }] : undefined,
            ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.contentBase64, content_type: a.contentType })) } : {}),
          }),
        });
        if (!res.ok) throw new Error(`Resend send failed: ${res.status}`);
        const body = (await res.json()) as { id?: string };
        return { id: body.id ?? null, delivered: true };
      }
      if (outbox.length > 500) outbox.shift();
      outbox.push(attachments.length ? { ...msg, attachments } : msg);
      log.info({ to: msg.to, subject: msg.subject, tag: msg.tag, attachments: attachments.map((a) => a.filename) }, '[email:disabled] message logged, not sent');
      return { id: null, delivered: false };
    },
  };
}
