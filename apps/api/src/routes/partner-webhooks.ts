/**
 * Unauthenticated partner endpoints: signed webhooks (raw body kept for HMAC verification) and signed hosted
 * property feeds. Every webhook is signature-verified before anything is read from the database for it, and
 * stored once per provider event key (idempotent).
 */
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notFound } from '../lib/errors.ts';
import { handleDeliverectWebhook, handleUberWebhook } from '../services/foods-partners.ts';
import { hostedFeed } from '../services/realty-portals.ts';

export const partnerWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/uber-direct', {
    config: { rateLimit: false },
    schema: { tags: ['webhooks'], summary: 'Uber Direct delivery status / courier webhooks (x-uber-signature HMAC-SHA256, idempotent per event id)' },
  }, async (req) => handleUberWebhook(s, (req.body as Buffer) ?? Buffer.alloc(0), req.headers as Record<string, unknown>));

  app.post('/webhooks/deliverect', {
    config: { rateLimit: false },
    schema: { tags: ['webhooks'], summary: 'Deliverect order / cancellation / busy-mode webhooks (x-server-authorization-hmac-sha256, idempotent per channel order)' },
  }, async (req) => handleDeliverectWebhook(s, (req.body as Buffer) ?? Buffer.alloc(0), req.headers as Record<string, unknown>));

  app.get('/feeds/realty/:connectionId/:file', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: { tags: ['realty'], summary: 'Signed hosted property feed for pull-based portals (idealista, Zillow/RESO XML, REAXML). The token is per office and rotatable.', params: z.object({ connectionId: z.uuid(), file: z.string().max(80) }) },
  }, async (req, reply) => {
    const token = req.params.file.replace(/\.(xml|json)$/, '');
    const r = await hostedFeed(s, req.params.connectionId, token);
    if (!r) throw notFound('Feed');
    if ('disabled' in r) return reply.code(410).send({ error: { code: 'feed_disabled', message: 'This feed has been switched off by the business' } });
    return reply.header('Cache-Control', 'no-store').type(r.format === 'xml' ? 'application/xml; charset=utf-8' : 'application/json; charset=utf-8').send(r.content);
  });
};
