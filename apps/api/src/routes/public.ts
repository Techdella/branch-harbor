import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { demoRequestSchema, INDUSTRY_META, INDUSTRIES, LAUNCH_COUNTRIES, SUPPORTED_CURRENCIES, SUPPORTED_LOCALES, apiError } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { consentRecords, demoRequests, locations, organizations } from '../db/schema/index.ts';
import { CONNECTOR_CATALOG } from '../integrations/connectors.ts';
import { notFound, validationError } from '../lib/errors.ts';
import { demoRequestCopy } from '../lib/demoRequestCopy.ts';

export const publicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  app.post('/public/demo-requests', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    schema: {
      tags: ['public'], summary: 'Submit a demo / pilot enquiry from the marketing site', body: demoRequestSchema,
      response: { 201: z.object({ id: z.string(), status: z.literal('received'), nextStep: z.string() }), 400: apiError, 429: apiError },
    },
  }, async (req, reply) => {
    const b = req.body;
    if (!(await s.botCheck.verify(b.turnstileToken, req.ip))) {
      throw validationError('Security check failed. Please try again.', { turnstileToken: 'Security check failed. Please try again.' });
    }
    const row = await s.db.transaction(async (tx) => {
      const [row] = await tx.insert(demoRequests).values({
        name: b.name, email: b.email, business: b.business, industry: b.industry, locationCount: b.locationCount, country: b.country,
        existingWebsite: b.existingWebsite || null, primaryDifficulty: b.primaryDifficulty ?? null, phone: b.phone ?? null, existingSystems: b.existingSystems ?? null,
        locale: b.locale, marketingConsent: b.marketingConsent, ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
      }).returning({ id: demoRequests.id });
      await tx.insert(consentRecords).values({ email: b.email, purpose: 'marketing_email', version: '2026-10', granted: b.marketingConsent, source: 'demo_request', ip: req.ip });
      return row!;
    });
    await s.jobs.enqueue('demo-request.notify', { id: row.id });
    // Confirmation explains the next step without inventing a response deadline.
    return reply.code(201).send({ id: row.id, status: 'received' as const, nextStep: demoRequestCopy(b.locale).nextStep });
  });

  app.get('/public/industries', {
    schema: { tags: ['public'], summary: 'Industries with release status (every industry is available for sign-up)' },
  }, async () => ({
    items: INDUSTRIES.map((k) => INDUSTRY_META[k]),
    countries: LAUNCH_COUNTRIES,
    currencies: SUPPORTED_CURRENCIES,
    locales: SUPPORTED_LOCALES,
  }));

  app.get('/public/integrations', { schema: { tags: ['public'], summary: 'Integration compatibility catalogue with honest support status' } }, async () => ({ items: CONNECTOR_CATALOG }));

  app.get('/public/locations/:orgSlug', {
    schema: {
      tags: ['public'], summary: 'Location finder: customer-visible locations for an organisation',
      params: z.object({ orgSlug: z.string().min(1) }),
      querystring: z.object({ country: z.string().length(2).optional(), q: z.string().max(80).optional(), near: z.string().regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional().describe('lat,lng — sorts by distance when locations have coordinates') }),
    },
  }, async (req) => {
    const [org] = await s.db.select().from(organizations).where(and(eq(organizations.slug, req.params.orgSlug), isNull(organizations.deletedAt)));
    if (!org) throw notFound('Business');
    const conds = [eq(locations.organizationId, org.id), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)];
    if (req.query.country) conds.push(eq(locations.country, req.query.country.toUpperCase()));
    if (req.query.q) conds.push(sql`(${locations.name} ilike ${'%' + req.query.q + '%'} or ${locations.address}->>'city' ilike ${'%' + req.query.q + '%'})`);
    const rows = await s.db.select().from(locations).where(and(...conds)).orderBy(locations.name);
    let items = rows.map((l) => ({
      id: l.id, slug: l.slug, name: l.name, address: l.address, country: l.country, timeZone: l.timeZone, currency: l.currency, locale: l.locale,
      phone: l.phone, email: l.email, hours: l.hours, status: l.status, geo: l.geo, distanceKm: null as number | null,
    }));
    if (req.query.near) {
      const [lat, lng] = req.query.near.split(',').map(Number) as [number, number];
      const rad = (d: number) => (d * Math.PI) / 180;
      items = items.map((i) => {
        if (!i.geo) return i;
        const dLat = rad(i.geo.lat - lat), dLng = rad(i.geo.lng - lng);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(i.geo.lat)) * Math.sin(dLng / 2) ** 2;
        return { ...i, distanceKm: Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10 };
      }).sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    }
    return { organization: { name: org.name, slug: org.slug, industry: org.industry }, items };
  });
};
