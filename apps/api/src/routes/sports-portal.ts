/**
 * Guardian portal.
 *  - Customer websites: emailed sign-in link → short-lived portal session token sent in the request BODY
 *    (the sites proxy forwards /v1/public/* only and no auth headers).
 *  - App (/v1/me/sports): signed-in account; guardian records matched by account or verified email.
 * Guardians only ever see participants with a verified relationship to them.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { publicContactSchema, sportsAbsenceReasons } from '@bh/shared';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { registrations, sportsInstalments, users } from '../db/schema/index.ts';
import { notFound } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { payInstalment, registerParticipant, withdrawRegistration } from '../services/sports-core.ts';
import {
  acceptGuardianInvitation, assertGuardianOf, createPortalSession, guardianIdsForUser, guardianMessages, guardianOverview, inviteGuardian, openPortalSession, portalGuardian,
  raiseDispute, reportAbsence, requestPortalLink, sendGuardianMessage, verifyRegistrantRelationships,
} from '../services/sports-guardians.ts';
import { secured } from './_common.ts';

const tokenBody = z.object({ portalToken: z.string().min(20) });
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const sportsPortalRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  const limited = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  /** Instalment that belongs to a registration of a participant these guardians represent. */
  const ownInstalment = async (guardianIds: string[], instalmentId: string) => {
    const [row] = await s.db.select({ i: sportsInstalments, r: registrations }).from(sportsInstalments).innerJoin(registrations, eq(registrations.id, sportsInstalments.registrationId)).where(eq(sportsInstalments.id, instalmentId));
    if (!row) throw notFound('Instalment');
    await assertGuardianOf(s.db, guardianIds, row.r.participantCustomerId);
    return row;
  };
  const ownRegistration = async (guardianIds: string[], registrationId: string) => {
    const [r] = await s.db.select().from(registrations).where(eq(registrations.id, registrationId));
    if (!r) throw notFound('Registration');
    await assertGuardianOf(s.db, guardianIds, r.participantCustomerId);
    return r;
  };

  app.post('/public/sports/portal/request-link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } }, schema: { tags: ['sports'], summary: 'Email a guardian portal sign-in link. Same response whether or not the email is known.', body: z.object({ locationId: z.uuid(), email: z.email() }) } }, async (req, reply) => {
    return reply.code(202).send(await requestPortalLink(s, req.body.locationId, req.body.email));
  });

  app.post('/public/sports/portal/session', { config: limited, schema: { tags: ['sports'], body: z.object({ token: z.string().min(10) }) } }, async (req) => openPortalSession(s, req.body.token));

  app.post('/public/sports/portal/overview', { config: limited, schema: { tags: ['sports'], summary: 'Participants, schedules, balances, forms and messages for the signed-in guardian.', body: tokenBody } }, async (req) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    return { guardian: { id: guardian.id, name: guardian.name, email: guardian.email }, ...(await guardianOverview(s, [guardian])) };
  });

  app.post('/public/sports/portal/absences', { config: limited, schema: { tags: ['sports'], body: tokenBody.extend({ participantId: z.uuid(), sessionId: z.uuid(), reason: z.enum(sportsAbsenceReasons), note: z.string().max(300).optional() }) } }, async (req, reply) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    return reply.code(201).send(await reportAbsence(s, [guardian.id], req.body));
  });

  app.post('/public/sports/portal/instalments/:id/pay', { config: limited, schema: { tags: ['sports'], params: z.object({ id: z.uuid() }), body: tokenBody } }, async (req) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    await ownInstalment([guardian.id], req.params.id);
    return payInstalment(s, req.params.id);
  });

  app.post('/public/sports/portal/messages', { config: limited, schema: { tags: ['sports'], body: tokenBody.extend({ locationId: z.uuid().optional() }) } }, async (req) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    return { items: await guardianMessages(s, [guardian.id], req.body.locationId) };
  });

  app.post('/public/sports/portal/messages/send', { config: limited, schema: { tags: ['sports'], body: tokenBody.extend({ locationId: z.uuid(), body: z.string().min(1).max(4000) }) } }, async (req, reply) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    return reply.code(201).send(await sendGuardianMessage(s, [guardian], req.body.locationId, req.body.body));
  });

  app.post('/public/sports/portal/invitations', { config: limited, schema: { tags: ['sports'], summary: 'A verified guardian invites a second guardian by email. Accepting the emailed link verifies them.', body: tokenBody.extend({ participantId: z.uuid(), email: z.email(), name: z.string().max(120).optional(), relationship: z.string().min(2).max(40).default('parent') }) } }, async (req, reply) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    await assertGuardianOf(s.db, [guardian.id], req.body.participantId);
    return reply.code(201).send(await inviteGuardian(s, { organizationId: guardian.organizationId, participantId: req.body.participantId, invitedByCustomerId: guardian.id, invitedByUserId: null, email: req.body.email, name: req.body.name, relationship: req.body.relationship }));
  });

  app.post('/public/sports/invitations/accept', { config: limited, schema: { tags: ['sports'], body: z.object({ token: z.string().min(10), name: z.string().max(120).optional() }) } }, async (req) => {
    const r = await acceptGuardianInvitation(s, req.body.token, { name: req.body.name });
    return createPortalSession(s, r.organizationId, r.guardian.id);
  });

  app.post('/public/sports/portal/disputes', { config: limited, schema: { tags: ['sports'], summary: 'Dispute another guardian\'s relationship to your participant; their access is suspended until the club resolves it.', body: tokenBody.extend({ relationshipId: z.uuid(), reason: z.string().min(10).max(1000) }) } }, async (req, reply) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    return reply.code(201).send(await raiseDispute(s, { relationshipId: req.body.relationshipId, reason: req.body.reason, byGuardianIds: [guardian.id], organizationId: guardian.organizationId }));
  });

  app.post('/public/sports/portal/registrations/:id/withdraw', { config: limited, schema: { tags: ['sports'], params: z.object({ id: z.uuid() }), body: tokenBody.extend({ reason: z.string().min(3).max(500) }) } }, async (req) => {
    const { guardian } = await portalGuardian(s.db, req.body.portalToken);
    const r = await ownRegistration([guardian.id], req.params.id);
    return withdrawRegistration(s, r, { userId: null, guardianId: guardian.id }, req.body.reason);
  });

  /* ---------------- Signed-in app guardians ---------------- */
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);
    const mine = async (userId: string) => {
      const gs = await guardianIdsForUser(s.db, userId);
      await verifyRegistrantRelationships(s.db, gs.map((g) => g.id));
      return gs;
    };

    priv.get('/me/sports', { schema: { tags: ['sports'], security: secured, summary: 'Guardian overview across organisations (verified relationships only).' } }, async (req) => guardianOverview(s, await mine(req.user!.id)));

    priv.post('/me/sports/absences', { schema: { tags: ['sports'], security: secured, body: z.object({ participantId: z.uuid(), sessionId: z.uuid(), reason: z.enum(sportsAbsenceReasons), note: z.string().max(300).optional() }) } }, async (req, reply) => {
      return reply.code(201).send(await reportAbsence(s, (await mine(req.user!.id)).map((g) => g.id), req.body));
    });

    priv.post('/me/sports/instalments/:id/pay', { schema: { tags: ['sports'], security: secured, params: z.object({ id: z.uuid() }) } }, async (req) => {
      await ownInstalment((await mine(req.user!.id)).map((g) => g.id), req.params.id);
      return payInstalment(s, req.params.id);
    });

    priv.get('/me/sports/messages', { schema: { tags: ['sports'], security: secured, querystring: z.object({ locationId: z.uuid().optional() }) } }, async (req) => ({ items: await guardianMessages(s, (await mine(req.user!.id)).map((g) => g.id), req.query.locationId) }));

    priv.post('/me/sports/messages', { schema: { tags: ['sports'], security: secured, body: z.object({ locationId: z.uuid(), body: z.string().min(1).max(4000) }) } }, async (req, reply) => reply.code(201).send(await sendGuardianMessage(s, await mine(req.user!.id), req.body.locationId, req.body.body)));

    priv.post('/me/sports/invitations', { schema: { tags: ['sports'], security: secured, body: z.object({ participantId: z.uuid(), email: z.email(), name: z.string().max(120).optional(), relationship: z.string().min(2).max(40).default('parent') }) } }, async (req, reply) => {
      const gs = await mine(req.user!.id);
      const hit = await assertGuardianOf(s.db, gs.map((g) => g.id), req.body.participantId);
      return reply.code(201).send(await inviteGuardian(s, { organizationId: hit.rel.organizationId, participantId: req.body.participantId, invitedByCustomerId: hit.rel.guardianCustomerId, invitedByUserId: req.user!.id, email: req.body.email, name: req.body.name, relationship: req.body.relationship }));
    });

    priv.post('/me/sports/invitations/accept', { schema: { tags: ['sports'], security: secured, body: z.object({ token: z.string().min(10) }) } }, async (req) => {
      const r = await acceptGuardianInvitation(s, req.body.token, { userId: req.user!.id });
      return { accepted: true, guardianId: r.guardian.id };
    });

    priv.post('/me/sports/disputes', { schema: { tags: ['sports'], security: secured, body: z.object({ relationshipId: z.uuid(), reason: z.string().min(10).max(1000) }) } }, async (req, reply) => {
      return reply.code(201).send(await raiseDispute(s, { relationshipId: req.body.relationshipId, reason: req.body.reason, byGuardianIds: (await mine(req.user!.id)).map((g) => g.id), byUserId: req.user!.id }));
    });

    priv.post('/me/sports/programmes/:id/registrations', {
      schema: { tags: ['sports'], security: secured, params: z.object({ id: z.uuid() }), body: z.object({ guardian: publicContactSchema.optional(), participant: z.object({ name: z.string().min(1).max(120), dateOfBirth: dateStr }), relationship: z.string().max(40).default('parent'), answers: z.record(z.string(), z.unknown()).default({}), feePlanId: z.uuid().optional(), acceptRefundPolicy: z.literal(true), absenceAlerts: z.boolean().optional() }) },
    }, async (req, reply) => {
      const [acct] = await s.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, req.user!.id));
      const contact = req.body.guardian ?? { name: acct?.name ?? 'Guardian', email: acct?.email ?? req.user!.email };
      const r = await registerParticipant(s, { programmeId: req.params.id, guardian: contact, participant: req.body.participant, relationship: req.body.relationship, answers: req.body.answers, feePlanId: req.body.feePlanId, acceptRefundPolicy: req.body.acceptRefundPolicy, absenceAlerts: req.body.absenceAlerts, userId: req.user!.id, source: 'app' });
      return reply.code(201).send({ registration: { id: r.registration.id, status: r.registration.status }, payment: r.payment, instalments: r.instalments, nextStep: r.nextStep });
    });
  });
};

