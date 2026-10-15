/**
 * Unified inbox: inbound webhooks (verified + idempotent) become conversations per channel account (one inbox per
 * location, plus HQ), linked to a customer or — for unknown contacts — a routed lead. Outbound replies respect the
 * contact's opt-out and consent, the WhatsApp / Meta 24-hour customer-service window and approved templates.
 */
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { OPT_IN_KEYWORDS, OPT_OUT_KEYWORDS, marketingConsentPurpose, windowState, type InboxChannelKey } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  commsChannelAccounts, commsConversations, commsMessages, commsOptOuts, commsWhatsappTemplates, consentRecords, customers, users, webhookEvents,
} from '../db/schema/index.ts';
import { parseWebhook, sendOutbound, verifyWebhook, type CommsProvider, type InboundMessage } from '../integrations/comms-channels.ts';
import { decrypt } from '../lib/crypto.ts';
import { AppError, conflict, unauthorized } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { createRoutedLead } from './lead-routing.ts';

export type ConversationRow = typeof commsConversations.$inferSelect;
export type MessageRow = typeof commsMessages.$inferSelect;
export type ChannelAccountRow = typeof commsChannelAccounts.$inferSelect;

const PROVIDER_EVENT = (p: CommsProvider) => `comms_${p}`;

/** Verify, parse and ingest a provider webhook. Throws 401 on a bad signature (before anything is read for it). */
export async function handleCommsWebhook(s: Services, provider: CommsProvider, raw: Buffer, headers: Record<string, string | string[] | undefined>) {
  if (!verifyWebhook(s.cfg, provider, raw, headers)) throw unauthorized('Invalid webhook signature');
  let parsed;
  try {
    parsed = parseWebhook(provider, raw, headers);
  } catch {
    throw new AppError(400, 'invalid_payload', 'The webhook payload could not be read');
  }
  const results: Array<{ eventKey: string; outcome: 'ingested' | 'duplicate' | 'unknown_recipient'; conversationId?: string; messageId?: string }> = [];
  for (const m of parsed.messages) results.push({ eventKey: m.eventKey, ...(await ingestInbound(s, m)) });
  return { received: true, results, ignored: parsed.ignored };
}

/** Find a customer by the contact's handle (phone or email) in the organisation, preferring the inbox's location. */
async function matchCustomer(db: Exec, orgId: string, locationId: string | null, channel: InboxChannelKey, handle: string) {
  if (channel === 'instagram' || channel === 'messenger') return null;
  const col = channel === 'email' ? sql`lower(${customers.email})` : sql`regexp_replace(coalesce(${customers.phone}, ''), '[^0-9+]', '', 'g')`;
  const value = channel === 'email' ? handle.toLowerCase() : handle.replace(/[^0-9+]/g, '');
  const rows = await db.select().from(customers).where(and(eq(customers.organizationId, orgId), isNull(customers.erasedAt), sql`${col} = ${value}`)).limit(5);
  return rows.find((c) => c.locationId === locationId) ?? rows[0] ?? null;
}

export async function ingestInbound(s: Services, m: InboundMessage): Promise<{ outcome: 'ingested' | 'duplicate' | 'unknown_recipient'; conversationId?: string; messageId?: string }> {
  return s.db.transaction(async (tx) => {
    // Idempotency: one row per provider message id; a replayed webhook is acknowledged and ignored.
    const [ev] = await tx.insert(webhookEvents).values({ provider: PROVIDER_EVENT(m.provider), eventId: m.eventKey, type: `${m.channel}.inbound`, payload: { to: m.to, from: m.from } })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.eventId] }).returning({ id: webhookEvents.id });
    if (!ev) return { outcome: 'duplicate' as const };
    const [acct] = await tx.select().from(commsChannelAccounts).where(and(eq(commsChannelAccounts.channel, m.channel), eq(commsChannelAccounts.address, m.to), eq(commsChannelAccounts.active, true)));
    if (!acct) {
      await tx.update(webhookEvents).set({ status: 'ignored', error: 'No inbox for this address', processedAt: new Date() }).where(eq(webhookEvents.id, ev.id));
      return { outcome: 'unknown_recipient' as const };
    }
    const orgId = acct.organizationId;
    const now = m.at > new Date() ? new Date() : m.at;
    const word = m.body.trim().toUpperCase();
    const optingOut = (m.channel === 'sms' || m.channel === 'whatsapp') && (OPT_OUT_KEYWORDS as readonly string[]).includes(word);
    const optingIn = (m.channel === 'sms' || m.channel === 'whatsapp') && (OPT_IN_KEYWORDS as readonly string[]).includes(word);

    let [conv] = await tx.select().from(commsConversations).where(and(eq(commsConversations.channelAccountId, acct.id), eq(commsConversations.handle, m.from)));
    const slaDue = new Date(Date.now() + s.cfg.INBOX_REPLY_SLA_MINUTES * 60_000);
    if (!conv) {
      const customer = await matchCustomer(tx, orgId, acct.locationId, m.channel, m.from);
      let leadId: string | null = null;
      if (!customer && !optingOut) {
        const lead = await createRoutedLead(tx, {
          organizationId: orgId, locationId: acct.locationId, source: m.channel, kind: 'customer', name: m.name ?? null,
          email: m.channel === 'email' ? m.from : null, phone: m.channel === 'sms' || m.channel === 'whatsapp' ? m.from : null, message: m.body.slice(0, 2000),
        });
        leadId = lead.id;
      }
      [conv] = await tx.insert(commsConversations).values({
        organizationId: orgId, locationId: acct.locationId, channelAccountId: acct.id, channel: m.channel, handle: m.from, contactName: m.name ?? customer?.name ?? null,
        customerId: customer?.id ?? null, leadId, subject: m.subject ?? null, status: 'open', lastInboundAt: now, lastMessageAt: now, lastMessagePreview: m.body.slice(0, 140), unread: 1,
        replyDueAt: optingOut ? null : slaDue,
      }).returning();
    } else {
      [conv] = await tx.update(commsConversations).set({
        status: conv.status === 'closed' || conv.status === 'pending' ? 'open' : conv.status, lastInboundAt: now, lastMessageAt: now, lastMessagePreview: m.body.slice(0, 140),
        unread: sql`${commsConversations.unread} + 1`, replyDueAt: conv.replyDueAt ?? (optingOut ? null : slaDue), contactName: conv.contactName ?? m.name ?? null, subject: conv.subject ?? m.subject ?? null, updatedAt: new Date(),
      }).where(eq(commsConversations.id, conv.id)).returning();
    }
    const [msg] = await tx.insert(commsMessages).values({ organizationId: orgId, conversationId: conv!.id, direction: 'inbound', body: m.body, externalId: m.eventKey, status: 'received', createdAt: now, meta: { provider: m.provider } }).returning();

    if (optingOut || optingIn) {
      if (optingOut) await tx.insert(commsOptOuts).values({ organizationId: orgId, channel: m.channel, handle: m.from, source: `keyword:${word}` }).onConflictDoNothing();
      else await tx.delete(commsOptOuts).where(and(eq(commsOptOuts.organizationId, orgId), eq(commsOptOuts.channel, m.channel), eq(commsOptOuts.handle, m.from)));
      if (conv!.customerId) {
        await tx.insert(consentRecords).values({ organizationId: orgId, customerId: conv!.customerId, purpose: marketingConsentPurpose(m.channel), version: 'keyword', granted: optingIn, source: `${m.channel}_keyword` });
      }
      await audit(tx, { organizationId: orgId, actorUserId: null, actorType: 'webhook', action: optingOut ? 'inbox.opted_out' : 'inbox.opted_in', scopeKind: acct.locationId ? 'location' : 'organization', scopeId: acct.locationId ?? orgId, targetType: 'conversation', targetId: conv!.id, metadata: { channel: m.channel } });
    }
    await tx.update(webhookEvents).set({ status: 'processed', organizationId: orgId, processedAt: new Date() }).where(eq(webhookEvents.id, ev.id));
    return { outcome: 'ingested' as const, conversationId: conv!.id, messageId: msg!.id };
  });
}

/* ── outbound ── */

export async function isOptedOut(db: Exec, orgId: string, channel: string, handle: string) {
  const [o] = await db.select({ id: commsOptOuts.id }).from(commsOptOuts).where(and(eq(commsOptOuts.organizationId, orgId), eq(commsOptOuts.channel, channel), eq(commsOptOuts.handle, handle)));
  return !!o;
}

/** Latest marketing consent for a customer on a channel: true / false / null (never asked). */
export async function marketingConsent(db: Exec, customerId: string | null, channel: InboxChannelKey): Promise<boolean | null> {
  if (!customerId) return null;
  const [c] = await db.select({ granted: consentRecords.granted }).from(consentRecords)
    .where(and(eq(consentRecords.customerId, customerId), eq(consentRecords.purpose, marketingConsentPurpose(channel)))).orderBy(desc(consentRecords.recordedAt)).limit(1);
  return c ? c.granted : null;
}

export interface ReplyPolicy {
  optedOut: boolean;
  consent: boolean | null;
  window: { open: boolean; closesAt: string | null };
  /** What a free-form reply needs right now. */
  canReply: boolean;
  needsTemplate: boolean;
  blockedReason: null | 'contact_opted_out' | 'consent_required' | 'messaging_window_closed';
}

/**
 * Outbound rules for a conversation:
 *  - a contact who opted out (STOP) can't be messaged on that channel;
 *  - a conversation the contact never wrote in is proactive marketing: it needs their recorded consent;
 *  - WhatsApp outside the 24-hour window needs an approved template; Messenger / Instagram can't be messaged.
 */
export async function replyPolicy(db: Exec, conv: ConversationRow): Promise<ReplyPolicy> {
  const optedOut = await isOptedOut(db, conv.organizationId, conv.channel, conv.handle);
  const consent = await marketingConsent(db, conv.customerId, conv.channel);
  const window = windowState(conv.lastInboundAt);
  const meta = conv.channel === 'instagram' || conv.channel === 'messenger';
  let blockedReason: ReplyPolicy['blockedReason'] = null;
  if (optedOut) blockedReason = 'contact_opted_out';
  else if (!conv.lastInboundAt && consent !== true) blockedReason = 'consent_required';
  else if (meta && !window.open) blockedReason = 'messaging_window_closed';
  const needsTemplate = conv.channel === 'whatsapp' && !window.open;
  return { optedOut, consent, window, canReply: !blockedReason && !needsTemplate, needsTemplate: !blockedReason && needsTemplate, blockedReason };
}

export async function sendInConversation(s: Services, conv: ConversationRow, input: { body?: string; templateId?: string | null; authorUserId: string; ip?: string }) {
  const policy = await replyPolicy(s.db, conv);
  if (policy.blockedReason === 'contact_opted_out') throw conflict('contact_opted_out', 'This contact opted out of messages on this channel');
  if (policy.blockedReason === 'consent_required') throw conflict('consent_required', 'This contact has not agreed to receive messages on this channel');
  if (policy.blockedReason === 'messaging_window_closed') throw conflict('messaging_window_closed', 'The 24-hour messaging window has closed. Wait for the contact to write again.');
  let template: typeof commsWhatsappTemplates.$inferSelect | undefined;
  if (input.templateId) {
    if (conv.channel !== 'whatsapp') throw conflict('template_not_supported', 'Templates are only used on WhatsApp');
    [template] = await s.db.select().from(commsWhatsappTemplates).where(and(eq(commsWhatsappTemplates.id, input.templateId), eq(commsWhatsappTemplates.organizationId, conv.organizationId)));
    if (!template) throw conflict('template_not_found', 'Template not found');
    if (template.status !== 'approved') throw conflict('template_not_approved', 'Only templates approved by WhatsApp can be sent');
  } else if (policy.needsTemplate) {
    throw conflict('whatsapp_template_required', 'More than 24 hours since the contact last wrote: send an approved WhatsApp template', { windowClosedAt: policy.window.closesAt });
  }
  const body = template ? template.body : (input.body ?? '').trim();
  if (!body) throw new AppError(400, 'validation_failed', 'Write a message', { body: 'Required' });
  const [acct] = await s.db.select().from(commsChannelAccounts).where(eq(commsChannelAccounts.id, conv.channelAccountId));
  const pageToken = acct?.credentialsEncrypted ? decrypt(acct.credentialsEncrypted, s.cfg.ENCRYPTION_KEY) : null;
  const r = await sendOutbound(s, { channel: conv.channel, accountMode: acct?.mode ?? 'sandbox', accountAddress: acct?.address ?? '', pageToken, to: conv.handle, body, subject: conv.subject, template: template ? { name: template.name, language: template.language } : null });
  return s.db.transaction(async (tx) => {
    const [msg] = await tx.insert(commsMessages).values({
      organizationId: conv.organizationId, conversationId: conv.id, direction: 'outbound', body, templateId: template?.id ?? null, authorUserId: input.authorUserId, externalId: r.externalId ?? null, status: r.status, error: r.error ?? null,
    }).returning();
    if (r.status !== 'failed') {
      await tx.update(commsConversations).set({ lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 140), unread: 0, firstReplyAt: conv.firstReplyAt ?? new Date(), replyDueAt: null, updatedAt: new Date() }).where(eq(commsConversations.id, conv.id));
    }
    await audit(tx, { organizationId: conv.organizationId, actorUserId: input.authorUserId, action: 'inbox.message_sent', scopeKind: conv.locationId ? 'location' : 'organization', scopeId: conv.locationId ?? conv.organizationId, targetType: 'conversation', targetId: conv.id, metadata: { status: r.status, templateId: template?.id ?? null, channel: conv.channel }, ip: input.ip ?? null });
    return msg!;
  });
}

export async function addNote(db: Exec, conv: ConversationRow, body: string, authorUserId: string) {
  const [msg] = await db.insert(commsMessages).values({ organizationId: conv.organizationId, conversationId: conv.id, direction: 'note', body, authorUserId, status: 'note' }).returning();
  return msg!;
}

/* ── serializers ── */

export async function serializeConversations(db: Exec, rows: ConversationRow[]) {
  const ids = [...new Set(rows.map((r) => r.assignedUserId).filter((x): x is string => !!x))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(or(...ids.map((id) => eq(users.id, id)))) : [];
  const now = Date.now();
  return rows.map((c) => ({
    id: c.id, locationId: c.locationId, channel: c.channel, channelAccountId: c.channelAccountId, handle: c.handle, contactName: c.contactName, customerId: c.customerId, leadId: c.leadId, subject: c.subject, status: c.status,
    assignedUser: c.assignedUserId ? { id: c.assignedUserId, name: people.find((p) => p.id === c.assignedUserId)?.name ?? null } : null,
    lastMessageAt: c.lastMessageAt.toISOString(), lastInboundAt: c.lastInboundAt?.toISOString() ?? null, lastMessagePreview: c.lastMessagePreview, unread: c.unread,
    replyDueAt: c.replyDueAt?.toISOString() ?? null, slaBreached: !!c.replyDueAt && c.replyDueAt.getTime() < now && c.status !== 'closed', firstReplyAt: c.firstReplyAt?.toISOString() ?? null,
    window: windowState(c.lastInboundAt),
  }));
}

export async function serializeMessages(db: Exec, rows: MessageRow[]) {
  const ids = [...new Set(rows.map((r) => r.authorUserId).filter((x): x is string => !!x))];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(or(...ids.map((id) => eq(users.id, id)))) : [];
  return rows.map((m) => ({
    id: m.id, direction: m.direction, body: m.body, status: m.status, error: m.error, templateId: m.templateId, createdAt: m.createdAt.toISOString(),
    author: m.authorUserId ? { id: m.authorUserId, name: people.find((p) => p.id === m.authorUserId)?.name ?? null } : null,
  }));
}
