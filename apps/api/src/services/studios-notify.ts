import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { consentRecords, customers, studioCustomerNotifications } from '../db/schema/index.ts';
import { notify, userIdsForCustomer } from './notifications.ts';

/**
 * Customer notifications for schedule changes, written to an outbox in the SAME transaction as the
 * change (so a rolled-back change never notifies anyone, and a committed change always has its
 * notifications recorded) and dispatched afterwards.
 *
 * Consent rules per channel:
 *  - email: service message about a booked class; sent unless the customer withdrew `class_updates_email`.
 *  - sms: opt-in only — requires a granted `class_updates_sms` consent and a phone number.
 *  - push: to the customer's signed-in account; delivery honours the account's `push_updates` preference.
 */
export const CLASS_UPDATE_PURPOSES = { email: 'class_updates_email', sms: 'class_updates_sms' } as const;

export type NotificationKind = 'class_changed' | 'class_cancelled' | 'instructor_changed' | 'membership_payment_failed' | 'membership_changed' | 'fee_charged';

export interface OutboxMessage {
  organizationId: string;
  locationId: string;
  customerIds: string[];
  occurrenceId?: string | null;
  seriesId?: string | null;
  kind: NotificationKind;
  subject: string;
  body: string;
}

/** Latest consent decision per purpose for a set of customers. */
export async function latestConsents(db: Exec, customerIds: string[], purposes: string[]): Promise<Map<string, Map<string, boolean>>> {
  const out = new Map<string, Map<string, boolean>>();
  if (!customerIds.length) return out;
  const rows = await db.select({ customerId: consentRecords.customerId, purpose: consentRecords.purpose, granted: consentRecords.granted }).from(consentRecords)
    .where(and(inArray(consentRecords.customerId, customerIds), inArray(consentRecords.purpose, purposes))).orderBy(desc(consentRecords.recordedAt));
  for (const r of rows) {
    if (!r.customerId) continue;
    const m = out.get(r.customerId) ?? new Map<string, boolean>();
    if (!m.has(r.purpose)) m.set(r.purpose, r.granted);
    out.set(r.customerId, m);
  }
  return out;
}

/** Queue messages inside the caller's transaction. Returns the batch id (null when nobody is affected). */
export async function enqueueCustomerNotifications(tx: Exec, m: OutboxMessage): Promise<{ batchId: string | null; customers: number }> {
  const ids = [...new Set(m.customerIds)];
  if (!ids.length) return { batchId: null, customers: 0 };
  const batchId = crypto.randomUUID();
  const rows = ids.flatMap((customerId) => (['email', 'sms', 'push'] as const).map((channel) => ({
    organizationId: m.organizationId, locationId: m.locationId, customerId, occurrenceId: m.occurrenceId ?? null, seriesId: m.seriesId ?? null,
    kind: m.kind, channel, subject: m.subject, body: m.body, status: 'queued', batchId,
  })));
  for (let i = 0; i < rows.length; i += 500) await tx.insert(studioCustomerNotifications).values(rows.slice(i, i + 500));
  return { batchId, customers: ids.length };
}

/** Send queued messages (optionally one batch). Each row ends as sent / skipped_* / failed. */
export async function dispatchCustomerNotifications(s: Services, batchId?: string | null) {
  const rows = await s.db.select().from(studioCustomerNotifications)
    .where(and(eq(studioCustomerNotifications.status, 'queued'), batchId ? eq(studioCustomerNotifications.batchId, batchId) : sql`true`)).limit(2000);
  if (!rows.length) return { sent: 0, skipped: 0 };
  const custIds = [...new Set(rows.map((r) => r.customerId))];
  const custs = new Map((await s.db.select().from(customers).where(inArray(customers.id, custIds))).map((c) => [c.id, c]));
  const consents = await latestConsents(s.db, custIds, Object.values(CLASS_UPDATE_PURPOSES));
  let sent = 0;
  let skipped = 0;
  for (const r of rows) {
    const c = custs.get(r.customerId);
    const pref = consents.get(r.customerId);
    let status = 'sent';
    try {
      if (!c || c.erasedAt) status = 'skipped_no_contact';
      else if (r.channel === 'email') {
        if (!c.email) status = 'skipped_no_contact';
        else if (pref?.get(CLASS_UPDATE_PURPOSES.email) === false) status = 'skipped_no_consent';
        else await s.jobs.enqueue('email.send', { to: c.email, subject: r.subject, text: `Hi ${c.name.split(' ')[0]},\n\n${r.body}\n`, tag: `studios-${r.kind}` });
      } else if (r.channel === 'sms') {
        if (pref?.get(CLASS_UPDATE_PURPOSES.sms) !== true) status = 'skipped_no_consent';
        else if (!c.phone) status = 'skipped_no_contact';
        else await s.messaging.sendSms(c.phone, `${r.subject}: ${r.body}`.slice(0, 320));
      } else {
        const users = await userIdsForCustomer(s.db, c.id);
        if (!users.length) status = 'skipped_no_contact';
        else await notify(s, { userIds: users, organizationId: r.organizationId, category: 'class_update', title: r.subject, body: r.body, data: { occurrenceId: r.occurrenceId, url: 'branchharbor://customer/bookings' } });
      }
    } catch (err) {
      s.log.warn({ err, id: r.id }, '[studios] customer notification failed');
      status = 'failed';
    }
    if (status === 'sent') sent++;
    else skipped++;
    await s.db.update(studioCustomerNotifications).set({ status, sentAt: status === 'sent' ? new Date() : null }).where(eq(studioCustomerNotifications.id, r.id));
  }
  return { sent, skipped };
}
