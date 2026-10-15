import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { RULES_DISCLAIMER, franchiseEnquirySchema } from '@bh/shared';
import { consentRecords, franchiseDeliveries, franchiseTerritories, organizations } from '../db/schema/index.ts';
import { AppError, notFound, validationError } from '../lib/errors.ts';
import { ESIGN_DISCLAIMER } from '../integrations/esign.ts';
import { completeSignature, createEnquiry, deliveryByToken, franchiseSettings, prospectCompliance, signReceipt, signatureByToken } from '../services/franchise.ts';

const tags = ['public', 'franchise'];
const tokenParams = z.object({ token: z.string().min(20).max(200) });

/**
 * Public franchise routes used by BranchHarbor-hosted brand sites: the "Own a franchise" enquiry form, the disclosure
 * e-receipt and the built-in agreement signature. Tokens are single-purpose; only their hashes are stored.
 */
export const franchisePublicRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const brandOrg = async (brand: string) => {
    const [org] = await s.db.select().from(organizations).where(eq(organizations.slug, brand));
    if (!org || org.status !== 'active' || org.deletedAt || org.model !== 'network') throw notFound('Brand');
    return org;
  };

  app.get('/public/franchise/:brand', {
    schema: { tags, params: z.object({ brand: z.string().min(1).max(80) }), summary: 'Configuration of the brand’s “Own a franchise” enquiry form (enabled, open territories)' },
  }, async (req) => {
    const org = await brandOrg(req.params.brand);
    const fs = franchiseSettings(org);
    if (!fs.enquiryFormEnabled) return { enabled: false as const, brand: { name: org.name } };
    const terr = await s.db.select().from(franchiseTerritories).where(and(eq(franchiseTerritories.organizationId, org.id), eq(franchiseTerritories.showOnSite, true), inArray(franchiseTerritories.status, ['available']))).orderBy(asc(franchiseTerritories.country), asc(franchiseTerritories.name));
    return {
      enabled: true as const, brand: { name: org.name }, currency: org.defaultCurrency, homeCountry: org.country,
      territories: terr.map((t) => ({ id: t.id, name: t.name, country: t.country, region: t.region })),
      countries: [...new Set([org.country, ...terr.map((t) => t.country)])],
    };
  });

  app.post('/public/franchise/:brand/enquiries', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    schema: { tags, params: z.object({ brand: z.string().min(1).max(80) }), body: franchiseEnquirySchema, summary: 'Submit a franchise enquiry from the brand site. Lands in the franchisor’s pipeline.' },
  }, async (req, reply) => {
    const org = await brandOrg(req.params.brand);
    if (!franchiseSettings(org).enquiryFormEnabled) throw notFound('Form');
    const b = req.body;
    if (b.website) return reply.code(201).send({ status: 'received' as const });
    if (!(await s.botCheck.verify(b.turnstileToken, req.ip))) throw validationError('Security check failed. Please try again.', { turnstileToken: 'Security check failed' });
    const p = await createEnquiry(s, org, { ...b, source: 'brand_site', utm: b.utm });
    await s.db.insert(consentRecords).values({ email: b.email, purpose: 'marketing_email', version: '2026-10', granted: b.marketingConsent, source: 'franchise_enquiry', ip: req.ip });
    void p;
    return reply.code(201).send({ status: 'received' as const });
  });

  /* ------------------------------ disclosure ------------------------------ */

  app.get('/public/franchise/disclosures/:token', { schema: { tags, params: tokenParams, summary: 'The disclosure document waiting for a signed receipt' } }, async (req) => {
    const { d, doc, p, org } = await deliveryByToken(s.db, req.params.token);
    if (!d.openedAt) await s.db.update(franchiseDeliveries).set({ openedAt: new Date() }).where(eq(franchiseDeliveries.id, d.id));
    return {
      brand: { name: org.name }, prospectName: p.name, kind: d.kind,
      document: { title: doc.title, version: doc.version, fileName: doc.fileName, sizeBytes: doc.sizeBytes, sha256: doc.sha256 },
      deliveredAt: d.deliveredAt.toISOString(), receiptSignedAt: d.receiptSignedAt?.toISOString() ?? null, receiptName: d.receiptName,
    };
  });

  app.get('/public/franchise/disclosures/:token/document', { schema: { tags, params: tokenParams } }, async (req, reply) => {
    const { doc } = await deliveryByToken(s.db, req.params.token);
    return reply.header('content-type', doc.contentType).header('content-disposition', `inline; filename="${doc.fileName.replace(/["\\\r\n]/g, '_')}"`).header('cache-control', 'private, no-store').send(Buffer.from(doc.contentBase64, 'base64'));
  });

  app.post('/public/franchise/disclosures/:token/receipt', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { tags, params: tokenParams, body: z.object({ name: z.string().trim().min(2).max(120), acknowledge: z.literal(true) }), summary: 'Sign the receipt: records the time, IP address and typed name. It confirms receipt only, not an agreement.' },
  }, async (req) => {
    const r = await signReceipt(s, req.params.token, req.body.name, req.ip, req.headers['user-agent'] ?? null);
    return { receiptSignedAt: r.receiptSignedAt.toISOString(), alreadySigned: r.alreadySigned, earliestSigningAt: r.compliance.earliestSigningAt };
  });

  /* ------------------------------- agreement ------------------------------ */

  app.get('/public/franchise/agreements/:token', { schema: { tags, params: tokenParams, summary: 'Agreement waiting for signature, with whether it can be signed yet' } }, async (req) => {
    const { sig, doc, p, org } = await signatureByToken(s.db, req.params.token);
    const c = await prospectCompliance(s.db, p);
    return {
      brand: { name: org.name }, signerName: p.name, status: sig.status, signedAt: sig.signedAt?.toISOString() ?? null,
      document: { title: doc.title, version: doc.version, fileName: doc.fileName, sizeBytes: doc.sizeBytes },
      canSign: sig.status === 'sent' && c.canSign, earliestSigningAt: c.earliestSigningAt,
      // Prospect-facing: when it can be signed, never the franchisor's registration details.
      waitingUntil: c.signingBlockers.filter((b) => b.code === 'waiting_period' || b.code === 'changed_terms_waiting').map((b) => b.until).filter(Boolean).sort().pop() ?? null,
      otherwiseBlocked: c.signingBlockers.some((b) => b.code !== 'waiting_period' && b.code !== 'changed_terms_waiting'),
      disclaimer: ESIGN_DISCLAIMER, rulesDisclaimer: RULES_DISCLAIMER,
    };
  });

  app.get('/public/franchise/agreements/:token/document', { schema: { tags, params: tokenParams } }, async (req, reply) => {
    const { doc } = await signatureByToken(s.db, req.params.token);
    return reply.header('content-type', doc.contentType).header('content-disposition', `inline; filename="${doc.fileName.replace(/["\\\r\n]/g, '_')}"`).header('cache-control', 'private, no-store').send(Buffer.from(doc.contentBase64, 'base64'));
  });

  app.post('/public/franchise/agreements/:token/sign', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    schema: { tags, params: tokenParams, body: z.object({ name: z.string().trim().min(2).max(120), accept: z.literal(true) }), summary: 'Sign the agreement (built-in signature). Refused with 409 franchise_blocked while a waiting period or registration requirement is outstanding.' },
  }, async (req) => {
    const { sig } = await signatureByToken(s.db, req.params.token);
    let r;
    try {
      r = await completeSignature(s, sig.id, { name: req.body.name, ip: req.ip, userAgent: req.headers['user-agent'] ?? null, actorUserId: null });
    } catch (err) {
      // Prospects see when they can sign, never the franchisor's internal compliance details.
      if (err instanceof AppError && err.code === 'franchise_blocked') {
        const blockers = ((err.details as { blockers?: Array<{ code: string; until: string | null }> } | undefined)?.blockers ?? []);
        const until = blockers.map((b) => b.until).filter((x): x is string => !!x).sort().pop() ?? null;
        throw new AppError(409, 'franchise_blocked', until ? `This agreement can be signed from ${until.slice(0, 10)}.` : 'This agreement cannot be signed yet. The franchisor will contact you.', undefined, { waitingUntil: until });
      }
      throw err;
    }
    return { status: 'signed' as const, signedAt: new Date().toISOString(), coolingOffEndsAt: r.compliance.coolingOffEndsAt };
  });
};
