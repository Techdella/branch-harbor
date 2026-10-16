/**
 * Call tracking: tracking numbers per campaign or location that forward to the location, the call log with source
 * attribution, missed-call alerts that create a lead, campaign attribution and dynamic number insertion (DNI) on
 * hosted sites. Recording is off by default; it only happens where HQ enabled it for the location's jurisdiction
 * with a disclosure, which is played before the call connects (packages/shared `recordingRule`).
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { matchTrackingNumber, recordingRule, type TrafficSource } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { customers, leads, locations, organizations, trackedCalls, trackingNumbers } from '../db/schema/index.ts';
import {
  createCallTracking, forwardTwiml, hangupTwiml, sandboxNumber, signVoicePayload, statusWebhookUrl, verifyTwilioVoice, voiceWebhookUrl, type CallTrackingProvider,
} from '../integrations/call-tracking.ts';
import { randomToken } from '../lib/crypto.ts';
import { conflict, unauthorized, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { usersWithCapabilityAt } from './comms-scope.ts';
import { createRoutedLead } from './lead-routing.ts';
import { getLocalMarketingSettings } from './local-marketing.ts';
import { notify } from './notifications.ts';

export const CALLS = 'marketing.call_tracking';
type NumberRow = typeof trackingNumbers.$inferSelect;
type CallRow = typeof trackedCalls.$inferSelect;

const providers = new WeakMap<Services, CallTrackingProvider>();
export function callProvider(s: Services) {
  let p = providers.get(s);
  if (!p) providers.set(s, (p = createCallTracking(s.cfg, s.partnerFetch)));
  return p;
}
export function setCallProvider(s: Services, p: CallTrackingProvider) { providers.set(s, p); }

const e164 = (v: string) => {
  const d = v.replace(/[^0-9+]/g, '');
  return d.startsWith('+') ? d : `+${d}`;
};
const areaCode = (phone: string | null) => (phone && phone.replace(/[^0-9+]/g, '').startsWith('+1') ? phone.replace(/[^0-9]/g, '').slice(1, 4) : null);

/** Adds a tracking number for a location (bought through Twilio when live; a fictional sandbox number otherwise). */
export async function addTrackingNumber(s: Services, orgId: string, input: { locationId: string; label: string; source: string; campaignId?: string | null; forwardTo?: string | null; recordCalls: boolean; dniMatch: NumberRow['dniMatch']; isDefault: boolean; areaCode?: string | null }, userId: string) {
  const [l] = await s.db.select().from(locations).where(and(eq(locations.id, input.locationId), eq(locations.organizationId, orgId)));
  if (!l) throw validationError('Unknown location', { locationId: 'Not found' });
  const forwardTo = input.forwardTo ? e164(input.forwardTo) : l.phone ? e164(l.phone) : null;
  if (!forwardTo || forwardTo.length < 8) throw validationError('Add the location phone number (or a forwarding number) first', { forwardTo: 'Required' });
  if (input.recordCalls) {
    const settings = await getLocalMarketingSettings(s.db, orgId);
    if (!recordingRule(settings.callRecording, l.country, l.address.region)) throw conflict('recording_not_allowed', 'Call recording is not switched on for this location’s jurisdiction. HQ sets it up, with a disclosure, in the call tracking settings.');
  }
  const p = callProvider(s);
  let number: string;
  let sid: string | null = null;
  if (p.live) {
    const bought = await p.buyNumber({ country: l.country, areaCode: input.areaCode ?? areaCode(l.phone) });
    number = bought.number;
    sid = bought.sid;
  } else {
    const taken = new Set((await s.db.select({ n: trackingNumbers.number }).from(trackingNumbers).where(eq(trackingNumbers.status, 'active'))).map((x) => x.n));
    let i = Math.floor(Math.random() * 100);
    number = sandboxNumber(l.country, i, input.areaCode ?? areaCode(l.phone));
    for (let tries = 0; taken.has(number) && tries < 2000; tries++) number = sandboxNumber(l.country, ++i, tries > 100 ? null : input.areaCode ?? areaCode(l.phone));
  }
  return s.db.transaction(async (tx) => {
    if (input.isDefault) await tx.update(trackingNumbers).set({ isDefault: false }).where(and(eq(trackingNumbers.locationId, l.id), eq(trackingNumbers.status, 'active')));
    const [row] = await tx.insert(trackingNumbers).values({
      organizationId: orgId, locationId: l.id, campaignId: input.campaignId ?? null, label: input.label, source: input.source, number, mode: p.live ? 'live' : 'sandbox', externalSid: sid,
      forwardTo, recordCalls: input.recordCalls, dniMatch: input.dniMatch, isDefault: input.isDefault, createdBy: userId,
    }).returning();
    await audit(tx, { organizationId: orgId, actorUserId: userId, action: 'calls.number_added', scopeKind: 'location', scopeId: l.id, targetType: 'tracking_number', targetId: row!.id, metadata: { mode: row!.mode, source: input.source, campaignId: input.campaignId ?? null, recordCalls: input.recordCalls } });
    return row!;
  });
}

export async function releaseTrackingNumber(s: Services, n: NumberRow, userId: string) {
  if (n.status !== 'active') throw conflict('already_released', 'This number was already released');
  if (n.mode === 'live' && n.externalSid) await callProvider(s).releaseNumber(n.externalSid);
  const [u] = await s.db.update(trackingNumbers).set({ status: 'released', releasedAt: new Date(), isDefault: false }).where(eq(trackingNumbers.id, n.id)).returning();
  await audit(s.db, { organizationId: n.organizationId, actorUserId: userId, action: 'calls.number_released', scopeKind: 'location', scopeId: n.locationId, targetType: 'tracking_number', targetId: n.id });
  return u!;
}

/* ── webhooks ── */

/** Incoming call (Twilio voice webhook): logs the call and answers with TwiML that forwards it. */
export async function handleVoiceWebhook(s: Services, params: Record<string, string>, signature: string | undefined) {
  if (!verifyTwilioVoice(s.cfg, voiceWebhookUrl(s.cfg), params, signature)) throw unauthorized('Invalid webhook signature');
  const to = e164(params.To ?? '');
  const [n] = await s.db.select().from(trackingNumbers).where(and(eq(trackingNumbers.number, to), eq(trackingNumbers.status, 'active')));
  if (!n || !params.CallSid) return hangupTwiml();
  const [l] = await s.db.select().from(locations).where(eq(locations.id, n.locationId));
  const settings = await getLocalMarketingSettings(s.db, n.organizationId);
  const rule = n.recordCalls && l ? recordingRule(settings.callRecording, l.country, l.address.region) : null;
  const from = e164(params.From ?? '');
  const [prior] = await s.db.select({ id: trackedCalls.id }).from(trackedCalls).where(and(eq(trackedCalls.organizationId, n.organizationId), eq(trackedCalls.callerNumber, from))).limit(1);
  await s.db.insert(trackedCalls).values({
    organizationId: n.organizationId, locationId: n.locationId, trackingNumberId: n.id, campaignId: n.campaignId, source: n.source, callerNumber: from, callerName: params.CallerName ?? null, callerCity: params.FromCity ?? null,
    externalSid: params.CallSid, status: 'ringing', startedAt: new Date(), recorded: !!rule, sandbox: n.mode === 'sandbox', firstTimeCaller: !prior,
  }).onConflictDoNothing();
  return forwardTwiml({ forwardTo: n.forwardTo, callerId: n.number, disclosure: rule?.message ?? null, record: !!rule, actionUrl: statusWebhookUrl(s.cfg), language: l?.locale ?? null });
}

const OUTCOME: Record<string, CallRow['status']> = { completed: 'answered', answered: 'answered', 'no-answer': 'missed', canceled: 'missed', busy: 'busy', failed: 'failed' };

/** <Dial action> callback: the outcome. Missed calls alert the location and (unknown callers) create a lead. */
export async function handleStatusWebhook(s: Services, params: Record<string, string>, signature: string | undefined) {
  if (!verifyTwilioVoice(s.cfg, statusWebhookUrl(s.cfg), params, signature)) throw unauthorized('Invalid webhook signature');
  const [call] = await s.db.select().from(trackedCalls).where(eq(trackedCalls.externalSid, params.CallSid ?? ''));
  if (!call) return hangupTwiml();
  const status = OUTCOME[params.DialCallStatus ?? params.CallStatus ?? ''] ?? 'failed';
  const [u] = await s.db.update(trackedCalls).set({
    status, durationSeconds: Number(params.DialCallDuration ?? params.CallDuration ?? 0) || 0,
    ...(params.RecordingUrl && call.recorded ? { recordingUrl: params.RecordingUrl } : {}),
  }).where(and(eq(trackedCalls.id, call.id), eq(trackedCalls.status, 'ringing'))).returning();
  if (u && (status === 'missed' || status === 'busy')) await onMissedCall(s, u);
  return hangupTwiml();
}

export async function onMissedCall(s: Services, call: CallRow) {
  const [claimed] = await s.db.update(trackedCalls).set({ missedAlertedAt: new Date() }).where(and(eq(trackedCalls.id, call.id), sql`${trackedCalls.missedAlertedAt} is null`)).returning();
  if (!claimed) return;
  const settings = await getLocalMarketingSettings(s.db, call.organizationId);
  const [l] = await s.db.select().from(locations).where(eq(locations.id, call.locationId));
  const digits = call.callerNumber.replace(/[^0-9]/g, '');
  const [known] = digits.length >= 7 ? await s.db.select({ id: customers.id }).from(customers).where(and(eq(customers.organizationId, call.organizationId), sql`regexp_replace(coalesce(${customers.phone}, ''), '[^0-9]', '', 'g') like ${`%${digits.slice(-9)}`}`)).limit(1) : [];
  let leadId: string | null = null;
  if (!known && settings.missedCallLeads) {
    const lead = await createRoutedLead(s.db, {
      organizationId: call.organizationId, locationId: call.locationId, adCampaignId: call.campaignId, source: 'phone_call', kind: 'customer', name: call.callerName, phone: call.callerNumber,
      message: `Missed call to ${l?.name ?? 'the location'} (${call.source}).`, utm: { source: call.source },
    });
    leadId = lead.id;
  }
  await s.db.update(trackedCalls).set({ leadId, customerId: known?.id ?? null }).where(eq(trackedCalls.id, call.id));
  const userIds = await usersWithCapabilityAt(s.db, call.organizationId, call.locationId, CALLS, 'edit', { excludeOwners: true });
  await notify(s, { userIds, organizationId: call.organizationId, category: 'network_update', title: `Missed call at ${l?.name ?? 'your location'}`, body: `${call.callerName ?? call.callerNumber} · ${call.source}${leadId ? ' · lead created' : ''}`, data: { kind: 'missed_call', callId: call.id, leadId } });
  await audit(s.db, { organizationId: call.organizationId, actorUserId: null, actorType: 'webhook', action: 'calls.missed', scopeKind: 'location', scopeId: call.locationId, targetType: 'tracked_call', targetId: call.id, metadata: { leadId, notified: userIds.length } });
}

/** Sandbox: simulate a call to a tracking number through the same signed webhooks Twilio would send. */
export async function simulateCall(s: Services, n: NumberRow, input: { from: string; callerName?: string | null; outcome: 'answered' | 'missed' | 'busy'; durationSeconds: number }) {
  if (n.mode !== 'sandbox') throw conflict('number_live', 'Simulated calls are only available on sandbox numbers');
  const sid = `CA_sandbox_${randomToken(12)}`;
  const voice = { CallSid: sid, To: n.number, From: e164(input.from), ...(input.callerName ? { CallerName: input.callerName } : {}) };
  const twiml = await handleVoiceWebhook(s, voice, signVoicePayload(s.cfg, voiceWebhookUrl(s.cfg), voice));
  const status = { CallSid: sid, DialCallStatus: input.outcome === 'answered' ? 'completed' : input.outcome === 'busy' ? 'busy' : 'no-answer', DialCallDuration: String(input.outcome === 'answered' ? input.durationSeconds : 0) };
  await handleStatusWebhook(s, status, signVoicePayload(s.cfg, statusWebhookUrl(s.cfg), status));
  const [call] = await s.db.select().from(trackedCalls).where(eq(trackedCalls.externalSid, sid));
  return { call: call!, twiml };
}

/* ── reporting ── */

export async function callReport(db: Exec, orgId: string, locationIds: string[] | 'all', range: { from: Date; to: Date }) {
  const conds = [eq(trackedCalls.organizationId, orgId), gte(trackedCalls.startedAt, range.from), lt(trackedCalls.startedAt, range.to)];
  if (locationIds !== 'all') conds.push(locationIds.length ? inArray(trackedCalls.locationId, locationIds) : sql`false`);
  const rows = await db.select({
    source: trackedCalls.source, campaignId: trackedCalls.campaignId, locationId: trackedCalls.locationId, n: sql<number>`count(*)::int`,
    answered: sql<number>`(count(*) filter (where ${trackedCalls.status} = 'answered'))::int`, missed: sql<number>`(count(*) filter (where ${trackedCalls.status} in ('missed','busy','voicemail')))::int`,
    firstTime: sql<number>`(count(*) filter (where ${trackedCalls.firstTimeCaller}))::int`, leads: sql<number>`(count(${trackedCalls.leadId}))::int`, seconds: sql<number>`coalesce(sum(${trackedCalls.durationSeconds}), 0)::int`,
  }).from(trackedCalls).where(and(...conds)).groupBy(trackedCalls.source, trackedCalls.campaignId, trackedCalls.locationId);
  const sum = (k: 'n' | 'answered' | 'missed' | 'firstTime' | 'leads') => rows.reduce((a, r) => a + r[k], 0);
  const group = <K extends 'source' | 'campaignId' | 'locationId'>(key: K) => {
    const m = new Map<string, { key: string | null; calls: number; answered: number; missed: number; leads: number }>();
    for (const r of rows) {
      const k = (r[key] as string | null) ?? '';
      const t = m.get(k) ?? { key: (r[key] as string | null) ?? null, calls: 0, answered: 0, missed: 0, leads: 0 };
      t.calls += r.n; t.answered += r.answered; t.missed += r.missed; t.leads += r.leads;
      m.set(k, t);
    }
    return [...m.values()].sort((a, b) => b.calls - a.calls);
  };
  const answered = sum('answered');
  return {
    totals: { calls: sum('n'), answered, missed: sum('missed'), firstTimeCallers: sum('firstTime'), leads: sum('leads'), answerRate: sum('n') ? answered / sum('n') : null, avgDurationSeconds: answered ? Math.round(rows.reduce((a, r) => a + r.seconds, 0) / answered) : null },
    bySource: group('source'), byCampaign: group('campaignId'), byLocation: group('locationId'),
  };
}

/** Calls per campaign and location, for campaign reporting (ad campaigns). */
export async function callCountsByCampaign(db: Exec, orgId: string, campaignIds: string[]) {
  if (!campaignIds.length) return [];
  return db.select({ campaignId: trackedCalls.campaignId, locationId: trackedCalls.locationId, calls: sql<number>`count(*)::int`, answered: sql<number>`(count(*) filter (where ${trackedCalls.status} = 'answered'))::int` })
    .from(trackedCalls).where(and(eq(trackedCalls.organizationId, orgId), inArray(trackedCalls.campaignId, campaignIds))).groupBy(trackedCalls.campaignId, trackedCalls.locationId);
}

/* ── dynamic number insertion ── */

/** The number a visitor of a location's hosted site should see, from their UTM / referrer (null = the real number). */
export async function dniNumber(db: Exec, brand: string, locationSlug: string, src: TrafficSource) {
  const [row] = await db.select({ l: locations }).from(locations).innerJoin(organizations, eq(organizations.id, locations.organizationId))
    .where(and(eq(organizations.slug, brand), eq(locations.slug, locationSlug), eq(locations.publiclyVisible, true)));
  if (!row) return null;
  const nums = await db.select().from(trackingNumbers).where(and(eq(trackingNumbers.locationId, row.l.id), eq(trackingNumbers.status, 'active')));
  const pick = matchTrackingNumber(nums.map((n) => ({ ...n, match: n.dniMatch })), src);
  return pick ? { number: pick.number, replaces: row.l.phone } : { number: null, replaces: row.l.phone };
}

export function serializeNumber(n: NumberRow) {
  return {
    id: n.id, locationId: n.locationId, campaignId: n.campaignId, label: n.label, source: n.source, number: n.number, mode: n.mode, forwardTo: n.forwardTo, recordCalls: n.recordCalls,
    dniMatch: n.dniMatch, isDefault: n.isDefault, status: n.status, createdAt: n.createdAt.toISOString(), releasedAt: n.releasedAt?.toISOString() ?? null,
  };
}

export function serializeCall(c: CallRow, leadStatus?: string | null) {
  return {
    id: c.id, locationId: c.locationId, trackingNumberId: c.trackingNumberId, campaignId: c.campaignId, source: c.source, callerNumber: c.callerNumber, callerName: c.callerName, callerCity: c.callerCity,
    status: c.status, startedAt: c.startedAt.toISOString(), durationSeconds: c.durationSeconds, recorded: c.recorded, recordingUrl: c.recordingUrl, sandbox: c.sandbox, leadId: c.leadId, leadStatus: leadStatus ?? null,
    customerId: c.customerId, firstTimeCaller: c.firstTimeCaller, notes: c.notes, followedUpAt: c.followedUpAt?.toISOString() ?? null,
  };
}

export async function leadStatuses(db: Exec, ids: Array<string | null>) {
  const list = ids.filter((x): x is string => !!x);
  return list.length ? new Map((await db.select({ id: leads.id, status: leads.status }).from(leads).where(inArray(leads.id, list))).map((l) => [l.id, l.status])) : new Map<string, string>();
}

export const recentCalls = (db: Exec, conds: Parameters<typeof and>, limit: number) => db.select().from(trackedCalls).where(and(...conds)).orderBy(desc(trackedCalls.startedAt)).limit(limit);
