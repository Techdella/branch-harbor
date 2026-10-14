import { and, count, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { appointments, customers, intakeForms, intakeResponses, locations, type IntakeQuestion } from '../db/schema/index.ts';
import { sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, hasPerm, requireLocationPerm, requirePerm } from '../services/authz.ts';
import { idParams, orgParams, secured } from './_common.ts';

type Form = typeof intakeForms.$inferSelect;

/**
 * Wellness intake forms. Administrative questions only (contact preferences, goals, accessibility needs,
 * consent) — BranchHarbor is not a clinical record system. Responses record the form and consent versions
 * they answered and are excluded from BranchHarbor AI context by default.
 */
const question = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  label: z.string().trim().min(1).max(300),
  type: z.enum(['text', 'longtext', 'yes_no', 'choice', 'date']),
  required: z.boolean().default(false),
  options: z.array(z.string().min(1).max(120)).max(30).optional(),
  help: z.string().max(300).optional(),
});

const formFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  serviceIds: z.array(z.uuid()).max(100),
  questions: z.array(question).min(1).max(60),
  consentVersion: z.string().trim().min(1).max(40),
  consentText: z.string().trim().min(10).max(4000),
  status: z.enum(['draft', 'active', 'archived']),
};
const formBody = z.object({ ...formFields, locationId: z.uuid().nullable().optional(), serviceIds: formFields.serviceIds.default([]), status: formFields.status.default('draft') });
/** PATCH: no defaults, omitted fields stay as they are. */
const formPatch = z.object(formFields).partial();

const consentInput = z.object({ accepted: z.literal(true), version: z.string().min(1) });

/** Validate answers against the form: required answered, choices from the list, nothing unexpected. */
export function validateAnswers(questions: IntakeQuestion[], answers: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const v = answers[q.id];
    const empty = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    if (empty) {
      if (q.required) errors[`answers.${q.id}`] = 'Required';
      continue;
    }
    if (q.type === 'yes_no' && typeof v !== 'boolean') errors[`answers.${q.id}`] = 'Answer yes or no';
    if ((q.type === 'text' || q.type === 'longtext') && (typeof v !== 'string' || v.length > (q.type === 'text' ? 300 : 4000))) errors[`answers.${q.id}`] = 'Invalid text';
    if (q.type === 'choice' && (typeof v !== 'string' || !(q.options ?? []).includes(v))) errors[`answers.${q.id}`] = 'Choose one of the options';
    if (q.type === 'date' && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))) errors[`answers.${q.id}`] = 'Use YYYY-MM-DD';
  }
  for (const k of Object.keys(answers)) if (!questions.some((q) => q.id === k)) errors[`answers.${k}`] = 'Unknown question';
  return errors;
}

const serializeForm = (f: Form, extra: { responses?: number; locationName?: string | null } = {}) => ({
  ...f, createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(), scope: f.locationId ? 'location' : 'network',
  responses: extra.responses ?? 0, locationName: extra.locationName ?? null, aiContext: 'excluded' as const,
});

export const intakeFormRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;

  const insertResponse = async (form: Form, input: { locationId: string; appointmentId: string | null; customerId: string | null; answers: Record<string, unknown>; consentVersion: string; actorUserId: string | null }) => {
    if (form.status !== 'active') throw conflict('form_not_active', 'This form is not accepting responses');
    if (input.consentVersion !== form.consentVersion) throw conflict('consent_version_changed', 'The consent statement changed. Review it and submit again.', { currentVersion: form.consentVersion });
    const errors = validateAnswers(form.questions, input.answers);
    if (Object.keys(errors).length) throw validationError('Some answers need attention', errors);
    return s.db.transaction(async (tx) => {
      const [r] = await tx.insert(intakeResponses).values({
        organizationId: form.organizationId, locationId: input.locationId, formId: form.id, formVersion: form.version, customerId: input.customerId, appointmentId: input.appointmentId,
        answers: input.answers, consentVersion: form.consentVersion, consentGivenAt: new Date(),
      }).returning();
      await audit(tx, { organizationId: form.organizationId, actorUserId: input.actorUserId, actorType: input.actorUserId ? 'user' : 'system', action: 'intake.submitted', scopeKind: 'location', scopeId: input.locationId, targetType: 'intake_response', targetId: r!.id, metadata: { formId: form.id, formVersion: form.version, consentVersion: form.consentVersion } });
      return r!;
    });
  };

  // ───────── Public (customer completes the form for their appointment) ─────────
  app.get('/public/wellness/:locationId/intake-forms', {
    schema: { tags: ['wellness'], summary: 'Active intake forms for a location (optionally for one service)', params: z.object({ locationId: z.uuid() }), querystring: z.object({ serviceId: z.uuid().optional() }) },
  }, async (req) => {
    const [loc] = await s.db.select().from(locations).where(and(eq(locations.id, req.params.locationId), eq(locations.publiclyVisible, true), isNull(locations.archivedAt)));
    if (!loc) throw notFound('Location');
    const rows = await s.db.select().from(intakeForms).where(and(eq(intakeForms.organizationId, loc.organizationId), eq(intakeForms.status, 'active'), or(isNull(intakeForms.locationId), eq(intakeForms.locationId, loc.id))));
    const sid = req.query.serviceId;
    return { items: rows.filter((f) => !sid || !f.serviceIds.length || f.serviceIds.includes(sid)).map((f) => ({ id: f.id, name: f.name, description: f.description, version: f.version, questions: f.questions, consent: { version: f.consentVersion, text: f.consentText } })) };
  });

  app.post('/public/wellness/intake-forms/:id/responses', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['wellness'], summary: 'Submit an intake form for an appointment (manage token from the booking confirmation)', params: z.object({ id: z.uuid() }),
      body: z.object({ appointmentId: z.uuid(), manageToken: z.string().min(10), answers: z.record(z.string(), z.unknown()), consent: consentInput }),
    },
  }, async (req, reply) => {
    const [form] = await s.db.select().from(intakeForms).where(eq(intakeForms.id, req.params.id));
    if (!form) throw notFound('Form');
    const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, req.body.appointmentId), eq(appointments.organizationId, form.organizationId)));
    if (!a || a.manageTokenHash !== sha256(req.body.manageToken)) throw notFound('Appointment');
    if (form.locationId && form.locationId !== a.locationId) throw validationError('This form is for another location', { appointmentId: 'Wrong location' });
    const r = await insertResponse(form, { locationId: a.locationId, appointmentId: a.id, customerId: a.customerId, answers: req.body.answers, consentVersion: req.body.consent.version, actorUserId: null });
    return reply.code(201).send({ id: r.id, formVersion: r.formVersion, consentVersion: r.consentVersion, submittedAt: r.submittedAt.toISOString() });
  });

  // ───────── Business ─────────
  await app.register(async (_priv) => {
    const priv = _priv.withTypeProvider<ZodTypeProvider>();
    priv.addHook('preHandler', authenticate);

    const requireFormEditor = async (req: Parameters<typeof requirePerm>[0], orgId: string, locationId: string | null | undefined) => {
      if (locationId) {
        await requireLocationPerm(req, s.db, orgId, locationId, 'operations.write');
        await requireLocationPerm(req, s.db, orgId, locationId, 'locations.read');
      } else await requirePerm(req, s.db, 'templates.write', { organizationId: orgId, kind: 'organization', id: orgId });
    };

    priv.get('/orgs/:orgId/wellness/intake-forms', { schema: { tags: ['wellness'], security: secured, params: orgParams } }, async (req) => {
      const { orgId } = req.params;
      const allowed = await authorisedLocations(req, s.db, orgId, 'operations.read');
      const rows = (await s.db.select().from(intakeForms).where(eq(intakeForms.organizationId, orgId))).filter((f) => !f.locationId || allowed === 'all' || allowed.has(f.locationId));
      const counts = rows.length ? await s.db.select({ formId: intakeResponses.formId, n: count() }).from(intakeResponses).where(inArray(intakeResponses.formId, rows.map((f) => f.id))).groupBy(intakeResponses.formId) : [];
      const locs = await s.db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, orgId));
      return { items: rows.sort((a, b) => a.name.localeCompare(b.name)).map((f) => serializeForm(f, { responses: counts.find((c) => c.formId === f.id)?.n ?? 0, locationName: locs.find((l) => l.id === f.locationId)?.name ?? null })) };
    });

    priv.post('/orgs/:orgId/wellness/intake-forms', { schema: { tags: ['wellness'], security: secured, params: orgParams, body: formBody } }, async (req, reply) => {
      const { orgId } = req.params;
      const b = req.body;
      await requireFormEditor(req, orgId, b.locationId);
      const ids = b.questions.map((q) => q.id);
      if (new Set(ids).size !== ids.length) throw validationError('Question ids must be unique', { questions: 'Duplicate id' });
      for (const [i, q] of b.questions.entries()) if (q.type === 'choice' && !(q.options?.length)) throw validationError('Choice questions need options', { [`questions.${i}.options`]: 'Required' });
      const [f] = await s.db.insert(intakeForms).values({ ...b, locationId: b.locationId ?? null, description: b.description ?? null, organizationId: orgId, createdBy: req.user!.id }).returning();
      await audit(s.db, { organizationId: orgId, ...actor(req), action: 'intake_form.created', targetType: 'intake_form', targetId: f!.id });
      return reply.code(201).send(serializeForm(f!));
    });

    const loadForm = async (orgId: string, id: string) => {
      const [f] = await s.db.select().from(intakeForms).where(and(eq(intakeForms.id, id), eq(intakeForms.organizationId, orgId)));
      if (!f) throw notFound('Form');
      return f;
    };

    priv.patch('/orgs/:orgId/wellness/intake-forms/:id', {
      schema: { tags: ['wellness'], security: secured, params: idParams, body: formPatch, summary: 'Edit a form; changing questions or consent creates a new version' },
    }, async (req) => {
      const f = await loadForm(req.params.orgId, req.params.id);
      await requireFormEditor(req, f.organizationId, f.locationId);
      const b = req.body;
      const bump = b.questions !== undefined || b.consentText !== undefined || b.consentVersion !== undefined;
      if (b.consentText !== undefined && b.consentText !== f.consentText && (b.consentVersion ?? f.consentVersion) === f.consentVersion) {
        throw validationError('Give the changed consent statement a new version', { consentVersion: 'Must change when the consent text changes' });
      }
      const [u] = await s.db.update(intakeForms).set({ ...b, version: bump ? f.version + 1 : f.version, updatedAt: new Date() }).where(eq(intakeForms.id, f.id)).returning();
      await audit(s.db, { organizationId: f.organizationId, ...actor(req), action: 'intake_form.updated', targetType: 'intake_form', targetId: f.id, metadata: { version: u!.version } });
      return serializeForm(u!);
    });

    priv.get('/orgs/:orgId/wellness/intake-forms/:id/responses', {
      schema: { tags: ['wellness'], security: secured, params: idParams, summary: 'Responses to a form in locations where you can read customer records (never included in AI context)' },
    }, async (req) => {
      const f = await loadForm(req.params.orgId, req.params.id);
      const allowed = await authorisedLocations(req, s.db, f.organizationId, 'customers.read');
      const rows = await s.db.select({ r: intakeResponses, c: { id: customers.id, name: customers.name } }).from(intakeResponses).leftJoin(customers, eq(customers.id, intakeResponses.customerId))
        .where(eq(intakeResponses.formId, f.id)).orderBy(desc(intakeResponses.submittedAt)).limit(500);
      return { items: rows.filter((x) => allowed === 'all' || allowed.has(x.r.locationId)).map(({ r, c }) => ({ ...r, customer: c?.id ? c : null, submittedAt: r.submittedAt.toISOString(), consentGivenAt: r.consentGivenAt.toISOString() })) };
    });

    priv.post('/orgs/:orgId/wellness/intake-forms/:id/responses', {
      schema: {
        tags: ['wellness'], security: secured, params: idParams, summary: 'Front desk records a response on the client’s behalf (client consent still required)',
        body: z.object({ appointmentId: z.uuid().optional(), customerId: z.uuid().optional(), locationId: z.uuid(), answers: z.record(z.string(), z.unknown()), consent: consentInput }),
      },
    }, async (req, reply) => {
      const f = await loadForm(req.params.orgId, req.params.id);
      const loc = await requireLocationPerm(req, s.db, f.organizationId, req.body.locationId, 'operations.write');
      if (!(await hasPerm(req, s.db, 'customers.write', { organizationId: f.organizationId, kind: 'location', id: loc.id }))) throw validationError('You need customer access at this location', { locationId: 'customers.write required' });
      let customerId = req.body.customerId ?? null;
      if (req.body.appointmentId) {
        const [a] = await s.db.select().from(appointments).where(and(eq(appointments.id, req.body.appointmentId), eq(appointments.locationId, loc.id)));
        if (!a) throw notFound('Appointment');
        customerId = a.customerId;
      }
      const r = await insertResponse(f, { locationId: loc.id, appointmentId: req.body.appointmentId ?? null, customerId, answers: req.body.answers, consentVersion: req.body.consent.version, actorUserId: req.user!.id });
      return reply.code(201).send({ ...r, submittedAt: r.submittedAt.toISOString(), consentGivenAt: r.consentGivenAt.toISOString() });
    });
  });
};
