/**
 * Inbound webhooks for the unified inbox. Raw bodies are kept for signature verification; every channel is verified
 * before anything is read for it and stored once per provider message id (idempotent).
 */
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { CommsProvider } from '../integrations/comms-channels.ts';
import { forbidden } from '../lib/errors.ts';
import { handleCommsWebhook } from '../services/comms-inbox.ts';

export const commsWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(['application/json', 'application/x-www-form-urlencoded'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const route = (path: string, provider: CommsProvider, summary: string) =>
    app.post(path, { config: { rateLimit: false }, schema: { tags: ['webhooks'], summary } }, async (req) =>
      handleCommsWebhook(s, provider, (req.body as Buffer) ?? Buffer.alloc(0), req.headers as Record<string, string | string[] | undefined>));

  route('/webhooks/comms/twilio', 'twilio', 'Twilio inbound SMS (X-Twilio-Signature, idempotent per MessageSid)');
  route('/webhooks/comms/whatsapp', 'whatsapp', 'WhatsApp Cloud API messages (X-Hub-Signature-256, idempotent per message id)');
  route('/webhooks/comms/meta', 'meta', 'Messenger and Instagram messages (X-Hub-Signature-256, idempotent per mid)');
  route('/webhooks/comms/email/postmark', 'postmark', 'Postmark inbound email (basic auth, idempotent per MessageID)');
  route('/webhooks/comms/email/resend', 'resend', 'Resend inbound email (Svix signature, idempotent per email id)');

  // Meta webhook subscription handshake (WhatsApp, Messenger, Instagram).
  const verify = z.object({ 'hub.mode': z.string().optional(), 'hub.verify_token': z.string().optional(), 'hub.challenge': z.string().optional() });
  for (const p of ['/webhooks/comms/whatsapp', '/webhooks/comms/meta']) {
    app.get(p, { schema: { tags: ['webhooks'], summary: 'Meta webhook verification (hub.challenge)', querystring: verify } }, async (req, reply) => {
      const q = req.query;
      if (q['hub.mode'] !== 'subscribe' || !s.cfg.META_WEBHOOK_VERIFY_TOKEN || q['hub.verify_token'] !== s.cfg.META_WEBHOOK_VERIFY_TOKEN) throw forbidden('Verification token mismatch');
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    });
  }
};
