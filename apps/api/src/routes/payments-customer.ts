/**
 * Customer card entry and saved cards (hosted sites, mobile app), card updates, fee consent, the "complete your
 * payment" link for off-session charges that need SCA, and staff controls for automatic charging.
 * Responses never contain secret keys; client secrets are only returned to the holder of the payment flow.
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { appointments, classBookings, customers, foodMealPlanSubscriptions, locations, organizations, paymentConsents, paymentReferences, users, wellnessAppointmentCharges } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound, unauthorized } from '../lib/errors.ts';
import { authenticate, requireUser } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { findOrCreateCustomer } from '../services/customers.ts';
import {
  automationSettings, cardOnFile, clientConfigFor, consentToSaveCard, feePolicyFor, listOffSessionCharges, paymentClientView, recordFeeConsent, removeSavedCard, runAutoFeeCharges,
  runInstalmentAutoCharges, sandboxCompleteSetup, SAVE_PURPOSES, startCardSetup, verifyPaymentActionToken, type SavePurpose,
} from '../services/payments-saved.ts';
import { portalGuardian } from '../services/sports-guardians.ts';
import { portalCustomer } from '../services/studios-portal.ts';
import { orgParams, secured } from './_common.ts';

const SESSION_HEADER = 'x-bh-customer-session';
const purposes = z.array(z.enum(SAVE_PURPOSES as [SavePurpose, ...SavePurpose[]])).min(1).max(4);
const consentBody = { purposes: purposes.optional(), text: z.string().max(2000).optional(), locale: z.string().max(10).optional() };

export const paymentCustomerRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const tags = ['payments'];
  const limited = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  // Automatic fee and instalment charging (every 10 minutes in long-running servers; never in tests).
  if (s.cfg.NODE_ENV !== 'test') {
    const tick = () => {
      void runAutoFeeCharges(s).catch((err) => s.log.error({ err }, '[payments] auto fee sweep failed'));
      void runInstalmentAutoCharges(s).catch((err) => s.log.error({ err }, '[payments] instalment sweep failed'));
    };
    const timer = setInterval(tick, 10 * 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  const loadPayment = async (id: string) => {
    const [p] = await s.db.select().from(paymentReferences).where(eq(paymentReferences.id, id));
    if (!p) throw notFound('Payment');
    return p;
  };
  const publicLocation = async (locationId: string) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    return loc;
  };

  app.get('/public/payments/config', {
    schema: { tags, summary: 'Card entry configuration for a location: publishable key and connected account (direct charges). No secrets.', querystring: z.object({ locationId: z.uuid() }) },
  }, async (req) => {
    const loc = await publicLocation(req.query.locationId);
    return clientConfigFor(s, loc.organizationId, loc.id);
  });

  app.get('/public/payments/:paymentId', {
    config: limited,
    schema: { tags, summary: 'Payment state for polling + card entry configuration (publishable key, connected account, save-card options). Never the client secret.', params: z.object({ paymentId: z.uuid() }) },
  }, async (req) => paymentClientView(s, await loadPayment(req.params.paymentId)));

  app.post('/public/payments/:paymentId/save-card', {
    config: limited,
    schema: {
      tags, summary: 'Customer consent to keep the card (renewals / instalments / fee charging): attaches the Stripe Customer and setup_future_usage before confirmation',
      params: z.object({ paymentId: z.uuid() }), body: z.object({ purposes, text: z.string().max(2000).optional(), locale: z.string().max(10).optional(), source: z.enum(['web', 'app']).default('web') }),
    },
  }, async (req) => consentToSaveCard(s, await loadPayment(req.params.paymentId), { ...req.body, ip: req.ip }));

  app.get('/public/payments/:paymentId/action', {
    config: limited,
    schema: { tags, summary: 'Complete a payment that needs the customer (3-D Secure on an automatic charge). Signed link from the email.', params: z.object({ paymentId: z.uuid() }), querystring: z.object({ token: z.string().min(20) }) },
  }, async (req) => {
    if (!verifyPaymentActionToken(s.cfg, req.params.paymentId, req.query.token)) throw notFound('Payment');
    const p = await loadPayment(req.params.paymentId);
    const view = await paymentClientView(s, p);
    const open = ['created', 'requires_action', 'failed'].includes(p.state);
    return { ...view, clientSecret: open ? p.clientSecret : null };
  });

  const bookingFor = async (targetType: 'class_booking' | 'appointment', targetId: string) => targetType === 'class_booking'
    ? (await s.db.select({ org: classBookings.organizationId, loc: classBookings.locationId, customer: classBookings.customerId, hash: classBookings.manageTokenHash }).from(classBookings).where(eq(classBookings.id, targetId)))[0]
    : (await s.db.select({ org: appointments.organizationId, loc: appointments.locationId, customer: appointments.customerId, hash: appointments.manageTokenHash }).from(appointments).where(eq(appointments.id, targetId)))[0];

  app.get('/public/payments/fee-policy', {
    config: limited,
    schema: { tags, summary: 'Late-cancel / no-show fee policy of a booking and whether fee charging was agreed (manage token)', querystring: z.object({ targetType: z.enum(['class_booking', 'appointment']), targetId: z.uuid(), manageToken: z.string().min(10) }) },
  }, async (req) => {
    const row = await bookingFor(req.query.targetType, req.query.targetId);
    if (!row || !row.hash || row.hash !== sha256(req.query.manageToken)) throw notFound('Booking');
    const policy = await feePolicyFor(s.db, req.query.targetType, req.query.targetId);
    const [c] = await s.db.select({ id: paymentConsents.id }).from(paymentConsents).where(and(eq(paymentConsents.targetType, req.query.targetType), eq(paymentConsents.targetId, req.query.targetId), eq(paymentConsents.purpose, 'fees'), isNull(paymentConsents.revokedAt)));
    const [o] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, row.org));
    return { policy, consented: !!c, business: o?.name ?? '' };
  });

  app.post('/public/payments/fee-consent', {
    config: limited,
    schema: {
      tags, summary: 'Consent at booking to automatic late-cancel / no-show fee charging to the saved card (booking manage token or studio portal session)',
      body: z.object({ targetType: z.enum(['class_booking', 'appointment']), targetId: z.uuid(), manageToken: z.string().min(10).optional(), text: z.string().max(2000).optional(), locale: z.string().max(10).optional() }),
    },
  }, async (req, reply) => {
    const b = req.body;
    const row = b.targetType === 'class_booking'
      ? (await s.db.select({ org: classBookings.organizationId, loc: classBookings.locationId, customer: classBookings.customerId, hash: classBookings.manageTokenHash }).from(classBookings).where(eq(classBookings.id, b.targetId)))[0]
      : (await s.db.select({ org: appointments.organizationId, loc: appointments.locationId, customer: appointments.customerId, hash: appointments.manageTokenHash }).from(appointments).where(eq(appointments.id, b.targetId)))[0];
    if (!row) throw notFound('Booking');
    let ok = !!b.manageToken && !!row.hash && row.hash === sha256(b.manageToken);
    if (!ok) {
      const session = req.headers[SESSION_HEADER] as string | undefined;
      const p = session ? await portalCustomer(s, session).catch(() => null) : null;
      ok = !!p && p.customer.id === row.customer;
    }
    if (!ok) throw notFound('Booking');
    return reply.code(201).send(await recordFeeConsent(s, { organizationId: row.org, locationId: row.loc, customerId: row.customer, targetType: b.targetType, targetId: b.targetId, text: b.text, locale: b.locale, ip: req.ip }));
  });

  app.post('/public/payments/setup/:setupIntentId/sandbox-complete', {
    schema: { tags, summary: 'SANDBOX ONLY: simulate the customer saving a card (ok / decline / sca test cards for later charges)', params: z.object({ setupIntentId: z.string().min(5).max(80) }), body: z.object({ paymentCustomerId: z.uuid(), token: z.string().min(20), card: z.enum(['ok', 'decline', 'sca']).default('ok') }) },
  }, async (req) => sandboxCompleteSetup(s, req.params.setupIntentId, req.body.paymentCustomerId, req.body.token, req.body.card));

  // ── Studio customer portal (hosted site sign-in) ──
  const portal = async (req: FastifyRequest) => portalCustomer(s, req.headers[SESSION_HEADER] as string | undefined);
  app.get('/public/studios/account/payment-method', { schema: { tags, summary: 'My saved card at this location (brand, last 4, expiry) and what it may be used for', querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const p = await portal(req);
    const loc = await publicLocation(req.query.locationId);
    if (loc.organizationId !== p.organizationId) throw notFound('Location');
    return { ...(await cardOnFile(s, loc.organizationId, loc.id, p.customer.id)), config: await clientConfigFor(s, loc.organizationId, loc.id) };
  });
  app.post('/public/studios/account/payment-method/setup', { config: limited, schema: { tags, summary: 'Add or update my card (SetupIntent on the location account); renewals in grace are retried with it', body: z.object({ locationId: z.uuid(), ...consentBody }) } }, async (req, reply) => {
    const p = await portal(req);
    const loc = await publicLocation(req.body.locationId);
    if (loc.organizationId !== p.organizationId) throw notFound('Location');
    return reply.code(201).send(await startCardSetup(s, { organizationId: loc.organizationId, locationId: loc.id, customerId: p.customer.id, purposes: req.body.purposes, text: req.body.text, locale: req.body.locale, ip: req.ip }));
  });
  app.post('/public/studios/account/payment-method/remove', { schema: { tags, body: z.object({ locationId: z.uuid() }) } }, async (req) => {
    const p = await portal(req);
    const loc = await publicLocation(req.body.locationId);
    if (loc.organizationId !== p.organizationId) throw notFound('Location');
    return removeSavedCard(s, loc.organizationId, loc.id, p.customer.id);
  });

  // ── Sports guardian portal ──
  app.post('/public/sports/portal/payment-method', { config: limited, schema: { tags, summary: 'Guardian: saved card for automatic instalments at this location', body: z.object({ portalToken: z.string().min(20), locationId: z.uuid() }) } }, async (req) => {
    const { guardian, organizationId } = await portalGuardian(s.db, req.body.portalToken);
    const loc = await publicLocation(req.body.locationId);
    if (loc.organizationId !== organizationId) throw notFound('Location');
    return { ...(await cardOnFile(s, organizationId, loc.id, guardian.id)), config: await clientConfigFor(s, organizationId, loc.id) };
  });
  app.post('/public/sports/portal/payment-method/setup', { config: limited, schema: { tags, summary: 'Guardian: add or update the card used for automatic instalments', body: z.object({ portalToken: z.string().min(20), locationId: z.uuid(), ...consentBody }) } }, async (req, reply) => {
    const { guardian, organizationId } = await portalGuardian(s.db, req.body.portalToken);
    const loc = await publicLocation(req.body.locationId);
    if (loc.organizationId !== organizationId) throw notFound('Location');
    return reply.code(201).send(await startCardSetup(s, { organizationId, locationId: loc.id, customerId: guardian.id, purposes: req.body.purposes ?? ['instalments'], text: req.body.text, locale: req.body.locale, ip: req.ip }));
  });

  // ── Meal plan manage link ──
  app.post('/public/foods/meal-plans/subscriptions/:id/payment-method/setup', { config: limited, schema: { tags, summary: 'Update the card for a meal plan (manage token); a past-due week is retried with it', params: z.object({ id: z.uuid() }), body: z.object({ token: z.string().min(10), ...consentBody }) } }, async (req, reply) => {
    const [sub] = await s.db.select().from(foodMealPlanSubscriptions).where(eq(foodMealPlanSubscriptions.id, req.params.id));
    if (!sub || sub.tokenHash !== sha256(req.body.token) || !sub.customerId) throw notFound('Subscription');
    return reply.code(201).send(await startCardSetup(s, { organizationId: sub.organizationId, locationId: sub.locationId, customerId: sub.customerId, purposes: req.body.purposes ?? ['renewals'], text: req.body.text, locale: req.body.locale, ip: req.ip }));
  });
  app.post('/public/foods/meal-plans/subscriptions/:id/payment-method', { config: limited, schema: { tags, params: z.object({ id: z.uuid() }), body: z.object({ token: z.string().min(10) }) } }, async (req) => {
    const [sub] = await s.db.select().from(foodMealPlanSubscriptions).where(eq(foodMealPlanSubscriptions.id, req.params.id));
    if (!sub || sub.tokenHash !== sha256(req.body.token) || !sub.customerId) throw notFound('Subscription');
    return { ...(await cardOnFile(s, sub.organizationId, sub.locationId, sub.customerId)), config: await clientConfigFor(s, sub.organizationId, sub.locationId) };
  });

  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    // ── Signed-in customers (mobile app) ──
    const myCustomer = async (req: FastifyRequest, organizationId: string, locationId: string, create: boolean) => {
      const u0 = requireUser(req);
      const [u] = await s.db.select().from(users).where(eq(users.id, u0.id));
      if (!u || u.deletedAt) throw unauthorized();
      const owns = u.emailVerifiedAt ? or(eq(customers.userId, u.id), sql`lower(${customers.email}) = ${u.email.toLowerCase()}`) : eq(customers.userId, u.id);
      const [c] = await s.db.select({ id: customers.id }).from(customers).where(and(owns, isNull(customers.erasedAt), eq(customers.organizationId, organizationId)));
      if (c) return c.id;
      if (!create) return null;
      if (!u.emailVerifiedAt) throw conflict('email_not_verified', 'Verify your email to save a card');
      const created = await findOrCreateCustomer(s.db, organizationId, locationId, { name: u.name, email: u.email }, 'app');
      await s.db.update(customers).set({ userId: u.id }).where(and(eq(customers.id, created.id), isNull(customers.userId)));
      return created.id;
    };
    priv.get('/me/payment-methods', { schema: { tags: ['me'], security: secured, summary: 'My saved card at a location (for the app account screen)', querystring: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const loc = await publicLocation(req.query.locationId);
      const id = await myCustomer(req, loc.organizationId, loc.id, false);
      const config = await clientConfigFor(s, loc.organizationId, loc.id);
      if (!id) return { card: null, purposes: [], config };
      return { ...(await cardOnFile(s, loc.organizationId, loc.id, id)), config };
    });
    priv.post('/me/payment-methods/setup', { schema: { tags: ['me'], security: secured, summary: 'Add or update my card at a location (SetupIntent for PaymentSheet)', body: z.object({ locationId: z.uuid(), ...consentBody }) } }, async (req, reply) => {
      const loc = await publicLocation(req.body.locationId);
      const id = (await myCustomer(req, loc.organizationId, loc.id, true))!;
      return reply.code(201).send(await startCardSetup(s, { organizationId: loc.organizationId, locationId: loc.id, customerId: id, purposes: req.body.purposes, text: req.body.text, locale: req.body.locale, ip: req.ip, source: 'app' }));
    });
    priv.post('/me/payment-methods/remove', { schema: { tags: ['me'], security: secured, body: z.object({ locationId: z.uuid() }) } }, async (req) => {
      const loc = await publicLocation(req.body.locationId);
      const id = await myCustomer(req, loc.organizationId, loc.id, false);
      if (!id) return { removed: false };
      return removeSavedCard(s, loc.organizationId, loc.id, id);
    });

    // ── Staff ──
    const settingsBody = z.object({ autoChargeFees: z.boolean().optional(), feeChargeDelayHours: z.number().int().min(0).max(24 * 14).optional(), autoChargeInstalments: z.boolean().optional() });
    priv.get('/orgs/:orgId/payments/automation', { schema: { tags, security: secured, params: orgParams, summary: 'Automatic charging settings (fees, instalments)' } }, async (req) => {
      await requirePerm(req, s.db, 'payments.read', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
      const [o] = await s.db.select().from(organizations).where(eq(organizations.id, req.params.orgId));
      if (!o) throw notFound('Organisation');
      return { ...automationSettings(o), providerMode: s.payments.mode };
    });
    priv.put('/orgs/:orgId/payments/automation', { schema: { tags, security: secured, params: orgParams, summary: 'Turn automatic fee / instalment charging on or off, and the waive window before fees are charged', body: settingsBody } }, async (req) => {
      await requirePerm(req, s.db, 'billing.manage', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
      const [o] = await s.db.select().from(organizations).where(eq(organizations.id, req.params.orgId));
      if (!o) throw notFound('Organisation');
      const next = { ...automationSettings(o), ...Object.fromEntries(Object.entries(req.body).filter(([, v]) => v !== undefined)) };
      await s.db.update(organizations).set({ settings: sql`${organizations.settings} || ${JSON.stringify({ paymentAutomation: next })}::jsonb` }).where(eq(organizations.id, o.id));
      await audit(s.db, { organizationId: o.id, ...actor(req), action: 'payments.automation_updated', scopeKind: 'organization', scopeId: o.id, metadata: next });
      return next;
    });
    priv.get('/orgs/:orgId/payments/off-session-charges', {
      schema: { tags, security: secured, params: orgParams, summary: 'Automatic charges (fees, instalments) and their outcome — failures stay visible here', querystring: z.object({ state: z.string().optional(), kind: z.enum(['studio_fee', 'wellness_fee', 'sports_instalment']).optional() }) },
    }, async (req) => {
      const allowed = await authorisedLocations(req, s.db, req.params.orgId, 'payments.read');
      return { items: await listOffSessionCharges(s.db, req.params.orgId, allowed === 'all' ? 'all' : [...allowed], req.query) };
    });
    priv.post('/orgs/:orgId/payments/automation/run', { schema: { tags, security: secured, params: orgParams, summary: 'Run automatic fee and instalment charging now for this organisation' } }, async (req) => {
      await requirePerm(req, s.db, 'billing.manage', { organizationId: req.params.orgId, kind: 'organization', id: req.params.orgId });
      return { fees: await runAutoFeeCharges(s, new Date(), { organizationId: req.params.orgId }), instalments: await runInstalmentAutoCharges(s, new Date(), { organizationId: req.params.orgId }) };
    });
    priv.post('/orgs/:orgId/wellness/charges/:appointmentId/waive', {
      schema: { tags: ['wellness'], security: secured, params: z.object({ orgId: z.uuid(), appointmentId: z.uuid() }), summary: 'Waive an outstanding late-cancel / no-show fee before it is charged', body: z.object({ reason: z.string().trim().min(3).max(200) }) },
    }, async (req) => {
      const [c] = await s.db.select().from(wellnessAppointmentCharges).where(and(eq(wellnessAppointmentCharges.appointmentId, req.params.appointmentId), eq(wellnessAppointmentCharges.organizationId, req.params.orgId)));
      if (!c) throw notFound('Fee');
      await requireLocationPerm(req, s.db, c.organizationId, c.locationId, 'operations.write');
      if (c.status !== 'outstanding') throw conflict('fee_not_due', `Fee is ${c.status}`);
      await s.db.update(wellnessAppointmentCharges).set({ status: 'waived', outstandingMinor: 0 }).where(eq(wellnessAppointmentCharges.id, c.id));
      await audit(s.db, { organizationId: c.organizationId, ...actor(req), action: 'fee.waived', scopeKind: 'location', scopeId: c.locationId, targetType: 'wellness_charge', targetId: c.id, metadata: { reason: req.body.reason, amount: c.outstandingMinor, currency: c.currency } });
      return { appointmentId: c.appointmentId, status: 'waived' };
    });
  });
};
