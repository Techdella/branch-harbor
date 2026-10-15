/**
 * Automation engine. Durable and idempotent:
 * - business events land in `marketing_events` (unique per org/type/key) and start one run per automation and
 *   contact (`automation_runs` unique per automation/contact/trigger key);
 * - each node executes at most once per run: the step row (unique per run/node) is committed BEFORE the side
 *   effect, so a crash or a duplicated job never repeats an email, text or webhook;
 * - delays park the run (`waiting` + `next_run_at`); a tick (interval runner, or BullMQ when Redis is configured)
 *   resumes due runs; texts and WhatsApp respect the location's quiet hours;
 * - every channel re-checks the contact's consent at send time (an unsubscribe stops further messages).
 */
import { createHmac } from 'node:crypto';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { delayMs, emailDocumentSchema, nextNode, personalise, type ActionConfig, type AutomationGraph, type AutomationNode, type ConditionConfig } from '@bh/shared';
import { locationsInScope } from './authz.ts';
import type { Services } from '../context.ts';
import {
  automationRuns, automationSteps, automations, campaigns, classBookings, contactTags, customers, emailTemplates, foodOrders, leads, locations, marketingEvents,
  marketingTasks, memberships, organizations, contactSegments,
} from '../db/schema/index.ts';
import { localDateParts, zonedToUtc } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { notify, usersWithPermissionAt } from './notifications.ts';
import { addTag, emitMarketingEvent, hasConsent, marketingSettingsOf, parseRules, personalValues, removeTag, segmentMembers, sendMarketingEmail, type CustomerRow } from './marketing.ts';

type RunRow = typeof automationRuns.$inferSelect;
type AutomationRow = typeof automations.$inferSelect;

const STOP_COPY: Record<string, string> = { en: 'Reply STOP to opt out.', fr: 'Répondez STOP pour vous désabonner.', es: 'Responde STOP para darte de baja.', de: 'Antworten Sie STOP zum Abmelden.', pt: 'Responda STOP para sair.', nl: 'Antwoord STOP om af te melden.', it: 'Rispondi STOP per annullare.', ar: 'أرسل STOP لإلغاء الاشتراك.' };

async function scopeCovers(s: Services, a: AutomationRow, locationId: string | null): Promise<boolean> {
  if (a.scopeKind === 'organization') return true;
  if (!locationId) return false;
  if (a.scopeKind === 'location') return a.scopeId === locationId;
  const inScope = await locationsInScope(s.db, a.organizationId, a.scopeKind, a.scopeId);
  return inScope === 'all' || inScope.has(locationId);
}

/** Start runs for one event (idempotent). */
export async function processMarketingEvent(s: Services, eventId: string) {
  const [ev] = await s.db.select().from(marketingEvents).where(eq(marketingEvents.id, eventId));
  if (!ev || ev.processedAt) return { runs: [] as string[] };
  const flows = await s.db.select().from(automations).where(and(eq(automations.organizationId, ev.organizationId), eq(automations.triggerEvent, ev.type), eq(automations.status, 'active')));
  const runIds: string[] = [];
  for (const a of flows) {
    const trig = a.graph.nodes.find((n) => n.type === 'trigger');
    if (!trig || trig.type !== 'trigger') continue;
    if (trig.config.formId && ev.data.formId !== trig.config.formId) continue;
    if (trig.config.tag && ev.data.tag !== trig.config.tag) continue;
    if (!(await scopeCovers(s, a, ev.locationId))) continue;
    // Opening soon targets everyone who signed up for that location.
    const contacts = ev.type === 'location.opening_soon' && !ev.customerId
      ? (await s.db.select({ id: customers.id }).from(customers).where(and(eq(customers.organizationId, ev.organizationId), eq(customers.locationId, ev.locationId!), isNull(customers.erasedAt)))).map((c) => c.id)
      : ev.customerId ? [ev.customerId] : [];
    for (const customerId of contacts) {
      const [run] = await s.db.insert(automationRuns).values({
        organizationId: ev.organizationId, automationId: a.id, automationVersion: a.version, customerId, locationId: ev.locationId, eventId: ev.id, triggerKey: `${ev.type}:${ev.key}`,
        currentNodeId: trig.id, context: { event: ev.data, eventType: ev.type },
      }).onConflictDoNothing().returning({ id: automationRuns.id });
      if (run) runIds.push(run.id);
    }
  }
  await s.db.update(marketingEvents).set({ processedAt: new Date() }).where(eq(marketingEvents.id, ev.id));
  for (const id of runIds) await s.jobs.enqueue('automation.advance', { runId: id });
  return { runs: runIds };
}

interface Contact { customer: CustomerRow | null; email: string | null; phone: string | null; name: string; locale: string | null }

async function contactOf(s: Services, run: RunRow): Promise<Contact> {
  if (run.customerId) {
    const [c] = await s.db.select().from(customers).where(eq(customers.id, run.customerId));
    if (c && !c.erasedAt) return { customer: c, email: c.email, phone: c.phone, name: c.name, locale: c.locale };
    return { customer: null, email: null, phone: null, name: '', locale: null };
  }
  const t = (run.context.tester ?? {}) as { email?: string; name?: string; phone?: string };
  return { customer: null, email: t.email ?? null, phone: t.phone ?? null, name: t.name ?? '', locale: null };
}

async function evaluateCondition(s: Services, run: RunRow, c: ConditionConfig, contact: Contact): Promise<boolean> {
  switch (c.kind) {
    case 'consent':
      return run.test ? true : !!contact.customer && hasConsent(s.db, contact.customer.id, c.purpose);
    case 'location':
      return !!run.locationId && c.locationIds.includes(run.locationId);
    case 'tag': {
      if (!contact.customer) return false;
      const [t] = await s.db.select().from(contactTags).where(and(eq(contactTags.customerId, contact.customer.id), eq(contactTags.tag, c.tag)));
      return !!t;
    }
    case 'segment': {
      if (!contact.customer) return false;
      const [seg] = await s.db.select().from(contactSegments).where(and(eq(contactSegments.id, c.segmentId), eq(contactSegments.organizationId, run.organizationId)));
      if (!seg) return false;
      const members = await segmentMembers(s.db, run.organizationId, parseRules(seg.rules), 'all');
      return members.some((m) => m.id === contact.customer!.id);
    }
    case 'field': {
      const ev = (run.context.event ?? {}) as Record<string, unknown>;
      const raw = c.field.startsWith('contact.') ? ({ email: contact.email, phone: contact.phone, locale: contact.locale, name: contact.name } as Record<string, unknown>)[c.field.slice(8)] : ev[c.field.slice(6)];
      const v = raw === null || raw === undefined ? '' : String(raw);
      switch (c.op) {
        case 'exists': return v !== '';
        case 'not_exists': return v === '';
        case 'eq': return v.toLowerCase() === c.value.toLowerCase();
        case 'neq': return v.toLowerCase() !== c.value.toLowerCase();
        case 'contains': return v.toLowerCase().includes(c.value.toLowerCase());
        case 'gt': return Number(v) > Number(c.value);
        case 'lt': return Number(v) < Number(c.value);
      }
    }
  }
  return false;
}

/** If now is inside the location's quiet hours, the instant they end; otherwise null. */
async function quietUntil(s: Services, run: RunRow, now: Date): Promise<Date | null> {
  const [org] = await s.db.select({ settings: organizations.settings, tz: organizations.defaultTimeZone }).from(organizations).where(eq(organizations.id, run.organizationId));
  const [loc] = run.locationId ? await s.db.select({ tz: locations.timeZone }).from(locations).where(eq(locations.id, run.locationId)) : [];
  const tz = loc?.tz ?? org?.tz ?? 'UTC';
  const q = marketingSettingsOf({ settings: org?.settings ?? {} }).quietHours;
  const { date, time } = localDateParts(now, tz);
  const inQuiet = q.start > q.end ? time >= q.start || time < q.end : time >= q.start && time < q.end;
  if (!inQuiet) return null;
  const endDate = q.start > q.end && time >= q.start ? new Date(zonedToUtc(date, '12:00', tz).getTime() + 86_400_000) : zonedToUtc(date, '12:00', tz);
  return zonedToUtc(localDateParts(endDate, tz).date, q.end, tz);
}

const sign = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

async function executeAction(s: Services, run: RunRow, node: AutomationNode & { type: 'action' }, contact: Contact, stepId: string): Promise<{ status: 'done' | 'skipped' | 'failed'; result: Record<string, unknown> }> {
  const cfg = node.config as ActionConfig;
  const [org] = await s.db.select({ name: organizations.name, locale: organizations.defaultLocale }).from(organizations).where(eq(organizations.id, run.organizationId));
  const [loc] = run.locationId ? await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, run.locationId)) : [];
  const values = personalValues(contact.customer ?? { name: contact.name, email: contact.email }, { locationName: loc?.name, businessName: org!.name });
  switch (cfg.action) {
    case 'send_email': {
      if (!cfg.templateId) return { status: 'skipped', result: { reason: 'no_template' } };
      const [tpl] = await s.db.select().from(emailTemplates).where(and(eq(emailTemplates.id, cfg.templateId), eq(emailTemplates.organizationId, run.organizationId)));
      if (!tpl) return { status: 'failed', result: { reason: 'template_missing' } };
      const r = await sendMarketingEmail(s, { organizationId: run.organizationId, customer: contact.customer, to: run.test ? contact.email ?? undefined : undefined, locationId: run.locationId, document: emailDocumentSchema.parse(tpl.document), subject: cfg.subject || tpl.subject, preheader: tpl.preheader, automationStepId: stepId, test: run.test });
      return { status: r.status === 'skipped' ? 'skipped' : r.status === 'failed' ? 'failed' : 'done', result: { email: r.status, reason: r.skipReason ?? null, sendId: r.sendId } };
    }
    case 'send_sms':
    case 'send_whatsapp': {
      const purpose = cfg.action === 'send_sms' ? 'marketing_sms' : 'marketing_whatsapp';
      if (!contact.phone) return { status: 'skipped', result: { reason: 'no_phone' } };
      if (!run.test && (!contact.customer || !(await hasConsent(s.db, contact.customer.id, purpose)))) return { status: 'skipped', result: { reason: 'no_consent' } };
      const lang = (contact.locale ?? org!.locale).split('-')[0]!;
      const body = personalise(cfg.body, values) + (cfg.action === 'send_sms' ? ` ${STOP_COPY[lang] ?? STOP_COPY.en}` : '');
      const r = cfg.action === 'send_sms' ? await s.messaging.sendSms(contact.phone, body) : await s.messaging.sendWhatsApp(contact.phone, body);
      return { status: 'done', result: { delivered: r.delivered, sandbox: !r.delivered } };
    }
    case 'add_tag':
      if (!contact.customer) return { status: 'skipped', result: { reason: 'no_contact' } };
      await addTag(s, run.organizationId, contact.customer.id, cfg.tag, `${run.id}:${node.id}`);
      return { status: 'done', result: { tag: cfg.tag } };
    case 'remove_tag':
      if (!contact.customer) return { status: 'skipped', result: { reason: 'no_contact' } };
      await removeTag(s.db, contact.customer.id, cfg.tag);
      return { status: 'done', result: { tag: cfg.tag } };
    case 'create_task': {
      const [t] = await s.db.insert(marketingTasks).values({ organizationId: run.organizationId, locationId: run.locationId, customerId: contact.customer?.id ?? null, title: personalise(cfg.title, values), dueAt: new Date(Date.now() + cfg.dueInDays * 86_400_000), source: 'automation', sourceId: run.id }).returning();
      return { status: 'done', result: { taskId: t!.id } };
    }
    case 'notify_staff': {
      const userIds = await usersWithPermissionAt(s.db, run.organizationId, run.locationId, 'customers.read');
      await notify(s, { userIds, organizationId: run.organizationId, category: 'approval_request', title: org!.name, body: personalise(cfg.message, values), data: { automationId: run.automationId, runId: run.id } });
      return { status: 'done', result: { notified: userIds.length } };
    }
    case 'send_review_request': {
      // Reviews: the location's review-request settings apply (frequency cap, opt-outs, consent, quiet hours).
      if (!run.locationId) return { status: 'skipped', result: { reason: 'no_location' } };
      if (run.test) return { status: 'skipped', result: { reason: 'test_run' } };
      if (!contact.customer) return { status: 'skipped', result: { reason: 'no_contact' } };
      const { queueReviewRequest, deliverRequest } = await import('./reviews.ts');
      const req = await queueReviewRequest(s, {
        organizationId: run.organizationId, locationId: run.locationId, customerId: contact.customer.id, source: 'automation', triggerKey: `automation:${run.id}:${node.id}`, sendAt: new Date(),
        channel: cfg.channel === 'default' ? null : cfg.channel, automationRunId: run.id,
      });
      if (!req) return { status: 'skipped', result: { reason: 'already_sent' } };
      const o = await deliverRequest(s, req.id);
      return { status: o.status === 'skipped' ? 'skipped' : o.status === 'failed' ? 'failed' : 'done', result: { requestId: req.id, outcome: o.status, reason: o.reason ?? null } };
    }
    case 'webhook': {
      const body = JSON.stringify({ type: 'automation.step', automationId: run.automationId, runId: run.id, test: run.test, event: run.context.eventType ?? null, contact: contact.customer ? { id: contact.customer.id, name: contact.customer.name, email: contact.customer.email } : null, sentAt: new Date().toISOString() });
      try {
        const res = await s.partnerFetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-branchharbor-signature': sign(`${s.cfg.JWT_SECRET}:${run.automationId}`, body), 'idempotency-key': `${run.id}:${node.id}` }, body, signal: AbortSignal.timeout(5000) });
        return res.ok ? { status: 'done', result: { status: res.status } } : { status: 'failed', result: { status: res.status } };
      } catch (err) {
        return { status: 'failed', result: { error: (err as Error).message.slice(0, 200) } };
      }
    }
  }
}

/**
 * Advance a run as far as it can go now. `fastForward` (test runs) treats delays as elapsed and ignores quiet hours.
 * Concurrency: the run row is locked (FOR NO KEY UPDATE SKIP LOCKED, which still lets the step claim's foreign key
 * check through) per node; a second worker simply returns.
 */
export async function advanceRun(s: Services, runId: string, opts: { now?: Date; fastForward?: boolean } = {}) {
  for (let i = 0; i < 100; i++) {
    const now = opts.now ?? new Date();
    const outcome = await s.db.transaction(async (tx) => {
      const [run] = await tx.select().from(automationRuns).where(eq(automationRuns.id, runId)).for('no key update', { skipLocked: true });
      if (!run || !['active', 'waiting'].includes(run.status)) return 'stop' as const;
      if (run.status === 'waiting' && run.nextRunAt && run.nextRunAt > now && !opts.fastForward) return 'stop' as const;
      const [a] = await tx.select().from(automations).where(eq(automations.id, run.automationId));
      if (!a || a.status === 'archived') { await tx.update(automationRuns).set({ status: 'stopped', finishedAt: now, error: 'automation_archived' }).where(eq(automationRuns.id, run.id)); return 'stop' as const; }
      if (a.status !== 'active' && !run.test) return 'stop' as const; // paused: stays put until resumed
      const graph: AutomationGraph = a.graph;
      const node = graph.nodes.find((n) => n.id === run.currentNodeId);
      if (!node) { await tx.update(automationRuns).set({ status: 'failed', finishedAt: now, error: 'node_removed' }).where(eq(automationRuns.id, run.id)); return 'stop' as const; }
      const moveTo = async (next: AutomationNode | null) => {
        if (!next) await tx.update(automationRuns).set({ status: 'completed', currentNodeId: null, nextRunAt: null, finishedAt: now }).where(eq(automationRuns.id, run.id));
        else await tx.update(automationRuns).set({ status: 'active', currentNodeId: next.id, nextRunAt: null }).where(eq(automationRuns.id, run.id));
        return next ? ('continue' as const) : ('stop' as const);
      };
      const [existing] = await tx.select().from(automationSteps).where(and(eq(automationSteps.runId, run.id), eq(automationSteps.nodeId, node.id)));
      const contact = await contactOf(s, run);

      if (node.type === 'trigger') {
        if (!existing) await tx.insert(automationSteps).values({ organizationId: run.organizationId, runId: run.id, nodeId: node.id, nodeType: 'trigger', status: 'done', result: { event: run.context.eventType ?? null }, finishedAt: now }).onConflictDoNothing();
        return moveTo(nextNode(graph, node.id));
      }
      if (node.type === 'condition') {
        let branch = (existing?.result.branch as 'yes' | 'no' | undefined);
        if (!branch) {
          branch = (await evaluateCondition(s, run, node.config, contact)) ? 'yes' : 'no';
          await tx.insert(automationSteps).values({ organizationId: run.organizationId, runId: run.id, nodeId: node.id, nodeType: 'condition', status: 'done', result: { branch }, finishedAt: now }).onConflictDoNothing();
        }
        return moveTo(nextNode(graph, node.id, branch));
      }
      if (node.type === 'delay') {
        if (!existing) {
          const resumeAt = opts.fastForward ? now : new Date(now.getTime() + delayMs(node.config));
          await tx.insert(automationSteps).values({ organizationId: run.organizationId, runId: run.id, nodeId: node.id, nodeType: 'delay', status: 'waiting', result: { resumeAt: resumeAt.toISOString() } });
          if (!opts.fastForward) { await tx.update(automationRuns).set({ status: 'waiting', nextRunAt: resumeAt }).where(eq(automationRuns.id, run.id)); return 'stop' as const; }
        } else if (existing.status === 'waiting' && new Date(String(existing.result.resumeAt)) > now && !opts.fastForward) {
          await tx.update(automationRuns).set({ status: 'waiting', nextRunAt: new Date(String(existing.result.resumeAt)) }).where(eq(automationRuns.id, run.id));
          return 'stop' as const;
        }
        await tx.update(automationSteps).set({ status: 'done', finishedAt: now }).where(and(eq(automationSteps.runId, run.id), eq(automationSteps.nodeId, node.id)));
        return moveTo(nextNode(graph, node.id));
      }
      // Action
      if (existing) {
        // Already claimed by an earlier attempt: never run the side effect again.
        if (existing.status === 'running') await tx.update(automationSteps).set({ status: 'failed', result: { ...existing.result, reason: 'interrupted' }, finishedAt: now }).where(eq(automationSteps.id, existing.id));
        return moveTo(nextNode(graph, node.id));
      }
      if (!opts.fastForward && (node.config.action === 'send_sms' || node.config.action === 'send_whatsapp')) {
        const until = await quietUntil(s, run, now);
        if (until) { await tx.update(automationRuns).set({ status: 'waiting', nextRunAt: until }).where(eq(automationRuns.id, run.id)); return 'stop' as const; }
      }
      // Claim outside the run transaction so the claim survives a crash during the side effect (at most once).
      const [claim] = await s.db.insert(automationSteps).values({ organizationId: run.organizationId, runId: run.id, nodeId: node.id, nodeType: 'action', status: 'running', result: { action: node.config.action } }).onConflictDoNothing().returning();
      if (!claim) return moveTo(nextNode(graph, node.id));
      const r = await executeAction(s, run, node as AutomationNode & { type: 'action' }, contact, claim.id).catch((err: Error) => ({ status: 'failed' as const, result: { error: err.message.slice(0, 200) } }));
      await s.db.update(automationSteps).set({ status: r.status, result: { action: node.config.action, ...r.result }, finishedAt: new Date() }).where(eq(automationSteps.id, claim.id));
      return moveTo(nextNode(graph, node.id));
    });
    if (outcome === 'stop') return;
  }
}

/** Start a test run: the person testing is the contact, delays are skipped, consent checks are bypassed for their own address. */
export async function testRun(s: Services, a: AutomationRow, tester: { userId: string; email: string; name: string; phone?: string | null }, locationId: string | null) {
  const trig = a.graph.nodes.find((n) => n.type === 'trigger');
  const [run] = await s.db.insert(automationRuns).values({ organizationId: a.organizationId, automationId: a.id, automationVersion: a.version, customerId: null, locationId, triggerKey: `test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, currentNodeId: trig?.id ?? null, test: true, context: { tester, eventType: a.triggerEvent, event: {} } }).returning();
  await advanceRun(s, run!.id, { fastForward: true });
  return run!.id;
}

// ───────── Ticks: due runs, recovery and time-based triggers ─────────

const since = (a: AutomationRow, windowDays = 2) => new Date(Math.max(a.activatedAt?.getTime() ?? Date.now(), Date.now() - windowDays * 86_400_000));

/** Derive events from business records for active flows (idempotent keys, nothing older than activation). */
export async function scanTriggers(s: Services, now = new Date()) {
  const flows = await s.db.select().from(automations).where(eq(automations.status, 'active'));
  let emitted = 0;
  const emit = async (e: Parameters<typeof emitMarketingEvent>[1]) => { if (await emitMarketingEvent(s, e)) emitted++; };
  for (const a of flows) {
    const from = since(a);
    const org = a.organizationId;
    switch (a.triggerEvent) {
      case 'lead.created': {
        const rows = await s.db.select().from(leads).where(and(eq(leads.organizationId, org), gte(leads.createdAt, from), isNotNull(leads.customerId)));
        for (const l of rows) await emit({ organizationId: org, type: 'lead.created', key: `lead:${l.id}`, customerId: l.customerId, locationId: l.locationId, data: { source: l.source } });
        break;
      }
      case 'booking.created':
      case 'booking.cancelled':
      case 'class.missed': {
        const col = a.triggerEvent === 'booking.created' ? classBookings.confirmedAt : classBookings.cancelledAt;
        const rows = a.triggerEvent === 'class.missed'
          ? await s.db.select().from(classBookings).where(and(eq(classBookings.organizationId, org), eq(classBookings.status, 'no_show'), gte(classBookings.createdAt, new Date(from.getTime() - 14 * 86_400_000))))
          : await s.db.select().from(classBookings).where(and(eq(classBookings.organizationId, org), gte(col, from)));
        for (const b of rows) await emit({ organizationId: org, type: a.triggerEvent, key: `booking:${b.id}`, customerId: b.customerId, locationId: b.locationId, data: { status: b.status } });
        break;
      }
      case 'order.completed': {
        const rows = await s.db.select().from(foodOrders).where(and(eq(foodOrders.organizationId, org), inArray(foodOrders.status, ['collected', 'delivered', 'served']), gte(foodOrders.updatedAt, from), isNotNull(foodOrders.customerId)));
        for (const o of rows) await emit({ organizationId: org, type: 'order.completed', key: `food_order:${o.id}`, customerId: o.customerId, locationId: o.locationId, data: { status: o.status } });
        break;
      }
      case 'membership.expiring': {
        const days = (a.graph.nodes.find((n) => n.type === 'trigger')?.config as { daysBefore?: number }).daysBefore ?? 7;
        const rows = await s.db.select().from(memberships).where(and(eq(memberships.organizationId, org), inArray(memberships.status, ['active', 'grace']), isNotNull(memberships.endsAt), gte(memberships.endsAt, now), lte(memberships.endsAt, new Date(now.getTime() + days * 86_400_000))));
        for (const m of rows) await emit({ organizationId: org, type: 'membership.expiring', key: `membership:${m.id}:${m.endsAt!.toISOString().slice(0, 10)}`, customerId: m.customerId, locationId: m.locationId, data: { plan: m.plan } });
        break;
      }
      case 'customer.birthday': {
        const md = now.toISOString().slice(5, 10);
        const rows = await s.db.select().from(customers).where(and(eq(customers.organizationId, org), isNull(customers.erasedAt), sql`substring(${customers.dateOfBirth} from 6 for 5) = ${md}`));
        for (const c of rows) await emit({ organizationId: org, type: 'customer.birthday', key: `birthday:${c.id}:${now.getUTCFullYear()}`, customerId: c.id, locationId: c.locationId });
        break;
      }
      case 'location.opening_soon': {
        const days = (a.graph.nodes.find((n) => n.type === 'trigger')?.config as { daysBefore?: number }).daysBefore ?? 14;
        const rows = await s.db.select().from(locations).where(and(eq(locations.organizationId, org), isNull(locations.archivedAt), or(eq(locations.status, 'opening_soon'), eq(locations.status, 'onboarding'))));
        for (const l of rows) {
          const opening = typeof l.settings.openingDate === 'string' ? new Date(`${l.settings.openingDate}T00:00:00Z`) : null;
          if (!opening || Number.isNaN(opening.getTime())) continue;
          const diff = (opening.getTime() - now.getTime()) / 86_400_000;
          if (diff >= 0 && diff <= days) await emit({ organizationId: org, type: 'location.opening_soon', key: `opening:${l.id}:${l.settings.openingDate}`, customerId: null, locationId: l.id, data: { openingDate: l.settings.openingDate } });
        }
        break;
      }
    }
  }
  return { emitted };
}

let lastScan = 0;

/** One housekeeping pass: unprocessed events, due runs, queued campaigns, scheduled pages and (every 15 min) trigger scans. */
export async function marketingTick(s: Services, opts: { now?: Date; forceScan?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const pending = await s.db.select({ id: marketingEvents.id }).from(marketingEvents).where(and(isNull(marketingEvents.processedAt), lte(marketingEvents.createdAt, new Date(now.getTime() - 30_000)))).orderBy(asc(marketingEvents.createdAt)).limit(200);
  for (const e of pending) await processMarketingEvent(s, e.id);
  const due = await s.db.select({ id: automationRuns.id }).from(automationRuns).where(and(inArray(automationRuns.status, ['waiting', 'active']), or(isNull(automationRuns.nextRunAt), lte(automationRuns.nextRunAt, now)))).limit(500);
  for (const r of due) await advanceRun(s, r.id, { now });
  const active = await s.db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.channel, 'email'), eq(campaigns.status, 'active')));
  const { deliverCampaign } = await import('./marketing.ts');
  for (const c of active) await deliverCampaign(s, c.id);
  const scheduled = await s.db.select({ id: campaigns.id, content: campaigns.content }).from(campaigns).where(and(eq(campaigns.channel, 'email'), eq(campaigns.status, 'scheduled'), lte(campaigns.startsAt, now)));
  for (const c of scheduled) {
    const [claimed] = await s.db.update(campaigns).set({ status: 'active', updatedAt: new Date() }).where(and(eq(campaigns.id, c.id), eq(campaigns.status, 'scheduled'))).returning();
    if (claimed) await deliverCampaign(s, c.id);
  }
  const { runScheduledPublishes } = await import('./site-builder.ts');
  await runScheduledPublishes(s, now);
  if (opts.forceScan || Date.now() - lastScan > 15 * 60_000) {
    lastScan = Date.now();
    await scanTriggers(s, now);
  }
}

export async function recordAutomationAudit(s: Services, a: AutomationRow, actorUserId: string, action: string, metadata: Record<string, unknown> = {}) {
  await audit(s.db, { organizationId: a.organizationId, actorUserId, action, scopeKind: a.scopeKind, scopeId: a.scopeId, targetType: 'automation', targetId: a.id, metadata });
}
