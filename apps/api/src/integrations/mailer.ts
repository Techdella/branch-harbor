import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag?: string;
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
      if (mode === 'postmark' && cfg.POSTMARK_SERVER_TOKEN) {
        const res = await fetch('https://api.postmarkapp.com/email', {
          method: 'POST',
          headers: { 'X-Postmark-Server-Token': cfg.POSTMARK_SERVER_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ From: cfg.EMAIL_FROM, To: msg.to, Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html, Tag: msg.tag, MessageStream: 'outbound' }),
        });
        if (!res.ok) throw new Error(`Postmark send failed: ${res.status}`);
        const body = (await res.json()) as { MessageID?: string };
        return { id: body.MessageID ?? null, delivered: true };
      }
      if (mode === 'resend' && cfg.RESEND_API_KEY) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: cfg.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html, tags: msg.tag ? [{ name: 'category', value: msg.tag }] : undefined }),
        });
        if (!res.ok) throw new Error(`Resend send failed: ${res.status}`);
        const body = (await res.json()) as { id?: string };
        return { id: body.id ?? null, delivered: true };
      }
      if (outbox.length > 500) outbox.shift();
      outbox.push(msg);
      log.info({ to: msg.to, subject: msg.subject, tag: msg.tag }, '[email:disabled] message logged, not sent');
      return { id: null, delivered: false };
    },
  };
}
