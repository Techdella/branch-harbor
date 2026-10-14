import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { collectionProducts, collections, commerceTranslations, connections, locationListings, locations, orderFulfilments, orders, organizations, paymentReferences, products, returns, users, webhookEvents } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { AppError, notFound, unauthorized, unavailable } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { otherStoresStock, storefrontProducts } from '../services/commerce-catalogue.ts';
import {
  activeTaxRates, createCheckout, expireOrder, expireReservations, externalCommerce, findGiftCard, fulfilmentConfig, locationMap, orderTransfer, priceCart, serializeOrder, serializeQuote,
  type OrderRow,
} from '../services/commerce-orders.ts';
import { createReturn, creditBalances, returnWindow, serializeReturn } from '../services/commerce-returns.ts';
import { credentialsOf } from '../services/connections.ts';
import { ingestWooOrder, verifyWooSignature, type WooOrder } from '../services/commerce-woo.ts';
import { secured } from './_common.ts';

const tags = ['commerce-storefront'];
const slugParam = z.string().min(1).max(80);
const cartLines = z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(99) })).min(1).max(50);
const address = z.object({ line1: z.string().trim().min(1).max(200), line2: z.string().max(200).optional(), city: z.string().trim().min(1).max(100), region: z.string().max(100).optional(), postalCode: z.string().trim().min(1).max(20), country: z.string().length(2) });
const fulfilment = z.object({ method: z.enum(['pickup', 'local_delivery', 'shipping']), collectLocationId: z.uuid().optional(), address: address.optional() });

export const commerceStorefrontRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  async function storeBySlugs(brandSlug: string, locationSlug: string) {
    const [org] = await s.db.select().from(organizations).where(and(eq(organizations.slug, brandSlug), isNull(organizations.deletedAt), ne(organizations.status, 'suspended')));
    if (!org) throw notFound('Store');
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.organizationId, org.id), eq(locations.slug, locationSlug), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Store');
    return { org, loc };
  }
  async function storeById(locationId: string) {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Store');
    return loc;
  }

  // ───────── Storefront ─────────

  app.get('/public/commerce/:brandSlug/:locationSlug/storefront', {
    schema: { tags, summary: 'Storefront for one store: checkout mode (native or external system), fulfilment options, configured taxes and collections', params: z.object({ brandSlug: slugParam, locationSlug: slugParam }), querystring: z.object({ locale: z.string().max(10).optional() }) },
  }, async (req) => {
    const { org, loc } = await storeBySlugs(req.params.brandSlug, req.params.locationSlug);
    const cfg = await fulfilmentConfig(s.db, loc.id);
    const ext = await externalCommerce(s.db, org.id, loc.id);
    const rates = await activeTaxRates(s.db, loc.id);
    const others = await s.db.select().from(locations).where(and(eq(locations.organizationId, org.id), ne(locations.id, loc.id), eq(locations.publiclyVisible, true), isNull(locations.archivedAt), eq(locations.currency, loc.currency)));
    const collectAt = [];
    for (const o of others) { const c = await fulfilmentConfig(s.db, o.id); if (c.pickupEnabled && c.crossLocationPickup && !(await externalCommerce(s.db, org.id, o.id))) collectAt.push({ id: o.id, name: o.name, slug: o.slug, address: o.address }); }
    const listed = await s.db.select({ productId: locationListings.productId }).from(locationListings).where(and(eq(locationListings.locationId, loc.id), eq(locationListings.status, 'listed')));
    const cs = await s.db.select().from(collections).where(and(eq(collections.organizationId, org.id), eq(collections.status, 'active'))).orderBy(asc(collections.position), asc(collections.title));
    const members = cs.length ? await s.db.select().from(collectionProducts).where(inArray(collectionProducts.collectionId, cs.map((c) => c.id))) : [];
    const trs = cs.length && req.query.locale ? await s.db.select().from(commerceTranslations).where(and(eq(commerceTranslations.entityType, 'collection'), inArray(commerceTranslations.entityId, cs.map((c) => c.id)))) : [];
    const pickLocale = (id: string) => { const l = req.query.locale!; return trs.find((t) => t.entityId === id && t.locale === l) ?? trs.find((t) => t.entityId === id && t.locale === l.split('-')[0]); };
    const money = (amount: number) => ({ amount, currency: loc.currency });
    return {
      brand: { name: org.name, slug: org.slug },
      location: { id: loc.id, name: loc.name, slug: loc.slug, currency: loc.currency, locale: loc.locale, timeZone: loc.timeZone, country: loc.country, address: loc.address },
      checkout: ext ? { mode: 'external' as const, provider: ext.provider, url: ext.url } : { mode: cfg.storefrontEnabled ? ('native' as const) : ('disabled' as const), provider: null, url: null },
      paymentsEnabled: loc.paymentsEnabled, sandboxPayments: s.payments.mode === 'sandbox',
      fulfilment: {
        pickup: { enabled: cfg.pickupEnabled, instructions: cfg.pickupInstructions, readyMinutes: cfg.pickupReadyMinutes },
        localDelivery: { enabled: cfg.localDeliveryEnabled, fee: money(cfg.deliveryFeeMinor), freeOver: cfg.freeDeliveryOverMinor !== null ? money(cfg.freeDeliveryOverMinor) : null, servesPostcodes: cfg.deliveryPostcodes },
        shipping: { enabled: cfg.shippingEnabled, fee: money(cfg.shippingFeeMinor), countries: cfg.shippingCountries },
        collectAt,
      },
      taxes: rates.map((r) => ({ name: r.name, rateBps: r.rateBps, inclusive: r.inclusive })), taxConfigured: rates.length > 0,
      reservationMinutes: cfg.reservationMinutes, returnWindowDays: cfg.returnWindowDays,
      collections: cs.map((c) => {
        const t = req.query.locale ? pickLocale(c.id) : undefined;
        return { id: c.id, slug: c.slug, title: t?.fields.title || c.title, description: t?.fields.description ?? c.description, imageUrl: c.imageUrl, productCount: members.filter((m) => m.collectionId === c.id && listed.some((l) => l.productId === m.productId)).length };
      }).filter((c) => c.productCount > 0),
    };
  });

  app.get('/public/commerce/:brandSlug/:locationSlug/products', {
    schema: { tags, summary: 'Products listed at this store (distributed snapshot), with local price and stock band; filter by collection or search', params: z.object({ brandSlug: slugParam, locationSlug: slugParam }), querystring: z.object({ collection: z.string().max(80).optional(), q: z.string().max(100).optional(), locale: z.string().max(10).optional() }) },
  }, async (req, reply) => {
    const { loc } = await storeBySlugs(req.params.brandSlug, req.params.locationSlug);
    await expireReservations(s, { locationId: loc.id }).catch(() => {});
    reply.header('cache-control', 'no-store');
    return { location: { id: loc.id, name: loc.name, currency: loc.currency }, items: await storefrontProducts(s.db, loc, { locale: req.query.locale, collectionSlug: req.query.collection, q: req.query.q }) };
  });

  app.get('/public/commerce/:brandSlug/:locationSlug/products/:product', {
    schema: { tags, summary: 'Product page: variants with this store’s price and stock band, and availability at sibling stores', params: z.object({ brandSlug: slugParam, locationSlug: slugParam, product: slugParam }), querystring: z.object({ locale: z.string().max(10).optional() }) },
  }, async (req) => {
    const { org, loc } = await storeBySlugs(req.params.brandSlug, req.params.locationSlug);
    const ref = req.params.product;
    const isUuid = /^[0-9a-f-]{36}$/i.test(ref);
    const [p] = await s.db.select().from(products).where(and(eq(products.organizationId, org.id), isUuid ? or(eq(products.id, ref), eq(products.slug, ref)) : eq(products.slug, ref)));
    if (!p) throw notFound('Product');
    const [item] = await storefrontProducts(s.db, loc, { locale: req.query.locale, productId: p.id });
    if (!item) throw notFound('Product');
    return { ...item, location: { id: loc.id, name: loc.name, currency: loc.currency }, otherStores: await otherStoresStock(s.db, loc, p.id) };
  });

  // ───────── Cart & checkout ─────────

  app.post('/public/commerce/locations/:locationId/quote', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Price a cart: lines, fulfilment fee, configured taxes only, gift card / credit, amount due. Nothing is reserved.', params: z.object({ locationId: z.uuid() }), body: z.object({ lines: cartLines, fulfilment, giftCardCode: z.string().max(40).optional() }) },
  }, async (req) => {
    const loc = await storeById(req.params.locationId);
    const ext = await externalCommerce(s.db, loc.organizationId, loc.id);
    if (ext) throw new AppError(409, 'external_checkout', `Orders for ${loc.name} are taken on the store's ${ext.provider} site.`, undefined, { provider: ext.provider, url: ext.url });
    return serializeQuote(await priceCart(s.db, loc.organizationId, loc, req.body));
  });

  app.post('/public/commerce/locations/:locationId/checkout', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags, summary: 'Place an order: reserves stock for the payment window and creates the payment. Send Idempotency-Key to make retries safe.',
      params: z.object({ locationId: z.uuid() }),
      body: z.object({ lines: cartLines, fulfilment, contact: z.object({ name: z.string().trim().min(1).max(120), email: z.email(), phone: z.string().max(40).optional(), marketingConsent: z.boolean().optional() }), giftCardCode: z.string().max(40).optional(), notes: z.string().max(500).optional(), expectedTotalMinor: z.number().int().min(0).optional() }),
    },
  }, async (req, reply) => {
    const loc = await storeById(req.params.locationId);
    const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, 120) : null;
    const r = await createCheckout(s, loc, { ...req.body, idempotencyKey: key, userId: req.user?.id ?? null });
    const names = await locationMap(s.db, loc.organizationId);
    return reply.code(r.duplicate ? 200 : 201).send({ order: serializeOrder(r.order, { locations: names }), manageToken: r.manageToken, payment: r.payment, duplicate: r.duplicate });
  });

  // ───────── Order status (token) ─────────

  async function orderByToken(id: string, token: string) {
    const [o] = await s.db.select().from(orders).where(eq(orders.id, id));
    if (!o || !o.manageTokenHash || o.manageTokenHash !== sha256(token)) throw notFound('Order');
    return o;
  }

  async function publicOrder(o: OrderRow) {
    const [fs, transfer, rs, names] = await Promise.all([
      s.db.select().from(orderFulfilments).where(eq(orderFulfilments.orderId, o.id)), orderTransfer(s.db, o.id),
      s.db.select().from(returns).where(eq(returns.orderId, o.id)).orderBy(desc(returns.createdAt)), locationMap(s.db, o.organizationId),
    ]);
    const [p] = o.paymentId ? await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, o.paymentId)) : [];
    const win = await returnWindow(s.db, o);
    const returned = new Map<string, number>();
    for (const r of rs) if (r.status !== 'rejected') for (const l of r.lines) returned.set(l.variantId, (returned.get(l.variantId) ?? 0) + l.quantity);
    const [loc] = await s.db.select().from(locations).where(eq(locations.id, o.fulfilmentLocationId ?? o.locationId));
    const [org] = await s.db.select({ name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, o.organizationId));
    const paidish = ['paid', 'partially_refunded'].includes(o.paymentStatus) && o.source === 'native';
    const cfg = await fulfilmentConfig(s.db, loc!.id);
    return {
      ...serializeOrder(o, { locations: names, fulfilments: fs, transfer }),
      brand: org, store: { id: loc!.id, name: loc!.name, slug: loc!.slug, address: loc!.address, timeZone: loc!.timeZone, phone: loc!.phone, pickupInstructions: cfg.pickupInstructions },
      payment: p ? { id: p.id, state: p.state, sandbox: p.sandbox === 1, clientSecret: o.status === 'pending_payment' ? p.clientSecret : null } : null,
      returns: rs.map((r) => serializeReturn(r)),
      returnPolicy: { days: win.days, endsAt: win.endsAt.toISOString(), open: win.open && paidish },
      returnable: paidish && win.open ? o.lines.filter((l) => !l.unmapped).map((l) => ({ variantId: l.variantId, name: l.name, max: l.quantity - (returned.get(l.variantId) ?? 0) })).filter((l) => l.max > 0) : [],
      cancellable: o.status === 'pending_payment',
    };
  }

  app.get('/public/commerce/orders/:id', {
    schema: { tags, summary: 'Order confirmation & status for the customer (manage token)', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
  }, async (req, reply) => {
    const o = await orderByToken(req.params.id, req.query.token);
    if (o.status === 'pending_payment' && o.reservationExpiresAt && o.reservationExpiresAt < new Date()) await expireReservations(s, { locationId: o.locationId });
    const [fresh] = await s.db.select().from(orders).where(eq(orders.id, o.id));
    reply.header('cache-control', 'no-store');
    return publicOrder(fresh!);
  });

  app.post('/public/commerce/orders/:id/cancel', {
    schema: { tags, summary: 'Cancel an unpaid order (releases the reserved stock)', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
  }, async (req) => {
    const o = await orderByToken(req.params.id, req.query.token);
    if (o.status !== 'pending_payment') throw new AppError(409, 'order_not_cancellable', 'This order can no longer be cancelled online. Contact the store.');
    const u = await s.db.transaction(async (tx) => expireOrder(tx, o, 'Cancelled by the customer', 'cancelled'));
    if (o.paymentId) {
      const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, o.paymentId));
      if (p && ['created', 'requires_action'].includes(p.state)) {
        await s.payments.cancelPaymentIntent(p.externalId, p.connectedAccountId).catch(() => {});
        await s.db.update(paymentReferences).set({ state: 'cancelled', updatedAt: new Date() }).where(eq(paymentReferences.id, p.id));
      }
    }
    return publicOrder(u);
  });

  const returnBody = z.object({ lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1), reason: z.string().max(200).optional() })).min(1), reason: z.string().max(500).optional() });

  app.post('/public/commerce/orders/:id/returns', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Request a return within the store’s return window', params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }), body: returnBody },
  }, async (req, reply) => {
    const o = await orderByToken(req.params.id, req.query.token);
    const r = await createReturn(s.db, o, { ...req.body, via: 'customer', by: null });
    return reply.code(201).send(serializeReturn(r));
  });

  app.post('/public/commerce/gift-cards/balance', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags, summary: 'Check a gift card / store credit balance', body: z.object({ brandSlug: slugParam, code: z.string().min(6).max(40) }) },
  }, async (req) => {
    const [org] = await s.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, req.body.brandSlug));
    const card = org ? await findGiftCard(s.db, org.id, req.body.code) : null;
    if (!card || card.status !== 'active') throw notFound('Gift card');
    return { kind: card.kind, last4: card.codeLast4, balance: { amount: card.balanceMinor, currency: card.currency }, expiresAt: card.expiresAt?.toISOString() ?? null };
  });

  // ───────── Signed-in customer ─────────

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const me = async (req: Parameters<typeof requireUser>[0]) => {
      const u = requireUser(req);
      const [row] = await s.db.select().from(users).where(eq(users.id, u.id));
      if (!row || row.deletedAt) throw unauthorized();
      return row;
    };
    /** Orders placed while signed in, or (verified email only) with the same email. */
    const mine = (u: typeof users.$inferSelect) => (u.emailVerifiedAt ? or(eq(orders.userId, u.id), sql`lower(${orders.customerEmail}) = ${u.email.toLowerCase()}`)! : eq(orders.userId, u.id));

    priv.get('/me/commerce/orders', { schema: { tags: ['me'], security: secured, summary: 'My shop orders across brands (account or verified email)' } }, async (req) => {
      const u = await me(req);
      const rows = await s.db.select().from(orders).where(and(mine(u), inArray(orders.source, ['native', 'exchange']))).orderBy(desc(orders.createdAt)).limit(100);
      const out = [];
      for (const o of rows) {
        const names = await locationMap(s.db, o.organizationId);
        const [org] = await s.db.select({ name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, o.organizationId));
        out.push({ ...serializeOrder(o, { locations: names }), brand: org });
      }
      return { items: out };
    });

    priv.get('/me/commerce/orders/:id', { schema: { tags: ['me'], security: secured, params: z.object({ id: z.uuid() }) } }, async (req) => {
      const u = await me(req);
      const [o] = await s.db.select().from(orders).where(and(eq(orders.id, req.params.id), mine(u)));
      if (!o) throw notFound('Order');
      return publicOrder(o);
    });

    priv.post('/me/commerce/orders/:id/returns', { schema: { tags: ['me'], security: secured, params: z.object({ id: z.uuid() }), body: returnBody } }, async (req, reply) => {
      const u = await me(req);
      const [o] = await s.db.select().from(orders).where(and(eq(orders.id, req.params.id), mine(u)));
      if (!o) throw notFound('Order');
      return reply.code(201).send(serializeReturn(await createReturn(s.db, o, { ...req.body, via: 'customer', by: u.id })));
    });

    priv.get('/me/commerce/credit', { schema: { tags: ['me'], security: secured, summary: 'My gift card and store credit balances, per currency (verified email)' } }, async (req) => {
      const u = await me(req);
      if (!u.emailVerifiedAt) return { cards: [], totals: [], note: 'Verify your email to see store credit' };
      return creditBalances(s.db, null, u.email);
    });
  });
};

/** POST /v1/webhooks/woocommerce/:connectionId — raw body, HMAC verified, idempotent per delivery and per order. */
export const commerceWebhookRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/webhooks/woocommerce/:connectionId', {
    config: { rateLimit: false },
    schema: { tags: ['webhooks'], summary: 'WooCommerce order webhook (signature-verified; retries never duplicate orders)', params: z.object({ connectionId: z.uuid() }) },
  }, async (req, reply) => {
    const [c] = await s.db.select().from(connections).where(and(eq(connections.id, req.params.connectionId), eq(connections.provider, 'woocommerce')));
    if (!c) throw notFound('Connection');
    const secret = credentialsOf(s, c)?.webhookSecret;
    if (!secret) throw unavailable('webhooks_disabled', 'This connection has no webhook secret configured');
    const raw = req.body as Buffer;
    const sig = req.headers['x-wc-webhook-signature'];
    if (!verifyWooSignature(raw, typeof sig === 'string' ? sig : undefined, secret)) throw new AppError(401, 'invalid_signature', 'Webhook signature verification failed');
    const topic = String(req.headers['x-wc-webhook-topic'] ?? '');
    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return reply.code(200).send({ received: true, status: 'ignored', note: 'Not an order payload (ping)' }); }
    if (!topic.startsWith('order.') || !body || typeof body !== 'object' || !('line_items' in body)) return reply.code(200).send({ received: true, status: 'ignored' });
    const delivery = String(req.headers['x-wc-webhook-delivery-id'] ?? sha256(raw.toString('utf8')));
    const [evt] = await s.db.insert(webhookEvents).values({ provider: 'woocommerce', eventId: `${c.id}:${delivery}`, type: topic, payload: { id: (body as WooOrder).id, status: (body as WooOrder).status }, organizationId: c.organizationId })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] }).returning();
    if (!evt) return reply.code(200).send({ received: true, duplicate: true, status: 'ignored' });
    const r = await ingestWooOrder(s, c, body as WooOrder);
    await s.db.update(webhookEvents).set({ status: r.outcome === 'error' ? 'failed' : 'processed', error: r.error ?? null, processedAt: new Date() }).where(eq(webhookEvents.id, evt.id));
    return reply.code(200).send({ received: true, duplicate: false, ...r });
  });
};
