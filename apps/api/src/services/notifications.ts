import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Permission, Role, ScopeKind } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { consentRecords, customers, locations, pushNotifications, pushTokens, roleAssignments, users } from '../db/schema/index.ts';
import { hasPermissionInScope, type ScopeChain } from '../domain/scope.ts';
import { loadOrgAssignments, resolveScopeChain } from './authz.ts';

export type PushCategory = 'order_status' | 'approval_request' | 'cover_request' | 'waitlist_promotion' | 'class_update' | 'network_update';

/**
 * Preference purposes (append-only consent records, `POST /v1/me/consents`). Push is transactional,
 * so it is on by default; a user who withdrew the purpose (granted=false) receives nothing in it.
 */
export const PUSH_PURPOSE: Record<PushCategory, 'push_updates' | 'push_work'> = {
  order_status: 'push_updates',
  waitlist_promotion: 'push_updates',
  approval_request: 'push_work',
  cover_request: 'push_work',
  class_update: 'push_updates',
  network_update: 'push_work',
};

export interface NotifyInput {
  userIds: string[];
  organizationId: string | null;
  category: PushCategory;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Queue a push notification (runs in the background so requests are never delayed by Expo). */
export async function notify(s: Services, input: NotifyInput) {
  const userIds = [...new Set(input.userIds.filter(Boolean))];
  if (!userIds.length) return;
  await s.jobs.enqueue('push.send', { ...input, userIds });
}

/** Deliver now: honours preferences, sends to every registered device and logs one row per user. */
export async function deliverPush(s: Services, input: NotifyInput) {
  const purpose = PUSH_PURPOSE[input.category];
  const results: Array<{ userId: string; status: string }> = [];
  for (const userId of input.userIds) {
    const [u] = await s.db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId));
    if (!u || u.deletedAt) continue;
    const [pref] = await s.db.select({ granted: consentRecords.granted }).from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.purpose, purpose))).orderBy(desc(consentRecords.recordedAt)).limit(1);
    const base = { organizationId: input.organizationId, userId, category: input.category, title: input.title, body: input.body, data: input.data ?? {} };
    if (pref && !pref.granted) {
      await s.db.insert(pushNotifications).values({ ...base, status: 'skipped_preference' });
      results.push({ userId, status: 'skipped_preference' });
      continue;
    }
    const tokens = await s.db.select({ token: pushTokens.token }).from(pushTokens).where(eq(pushTokens.userId, userId));
    if (!tokens.length) {
      await s.db.insert(pushNotifications).values({ ...base, status: 'skipped_no_token' });
      results.push({ userId, status: 'skipped_no_token' });
      continue;
    }
    let status = s.push.mode === 'live' ? 'sent' : 'sandbox';
    let error: string | null = null;
    try {
      const r = await s.push.send(tokens.map((t) => ({ to: t.token, title: input.title, body: input.body, data: { category: input.category, ...(input.data ?? {}) } })));
      const failed = r.tickets.filter((t) => t.status === 'error');
      if (failed.length === tokens.length) {
        status = 'failed';
        error = failed[0]?.message ?? 'Delivery failed';
      }
      // Expo reports devices that uninstalled the app; stop sending to them.
      const gone = r.tickets.map((t, i) => (t.status === 'error' && t.details?.error === 'DeviceNotRegistered' ? tokens[i]!.token : null)).filter((x): x is string => !!x);
      if (gone.length) await s.db.delete(pushTokens).where(inArray(pushTokens.token, gone));
    } catch (err) {
      status = 'failed';
      error = (err as Error).message;
      s.log.error({ err, userId }, '[push] send failed');
    }
    await s.db.insert(pushNotifications).values({ ...base, status, tokenCount: tokens.length, error });
    results.push({ userId, status });
  }
  return results;
}

/** Users holding `permission` at a location (optionally also `alsoPermission`), e.g. who can approve. */
export async function usersWithPermissionAt(db: Exec, organizationId: string, locationId: string | null, permission: Permission, alsoPermission?: Permission): Promise<string[]> {
  const chain: ScopeChain = locationId
    ? await resolveScopeChain(db, { organizationId, kind: 'location', id: locationId }).catch(() => ({ organizationId, kind: 'organization' as const }))
    : { organizationId, kind: 'organization' };
  const byUser = await loadOrgAssignments(db, organizationId);
  return [...byUser.entries()].filter(([, a]) => hasPermissionInScope(a, permission, chain) && (!alsoPermission || hasPermissionInScope(a, alsoPermission, chain))).map(([id]) => id);
}

/**
 * Who should get an approval or notification (coverage fallback): the people whose role handles it — anyone holding
 * the permission there other than owners, who hold everything. When nobody does (the responsible role is empty, e.g.
 * nobody handles royalties yet), it goes to the owners instead, so nothing waits unseen.
 */
export async function responsibleUsersAt(db: Exec, organizationId: string, locationId: string | null, permission: Permission, alsoPermission?: Permission): Promise<{ userIds: string[]; fallback: boolean }> {
  const holders = await usersWithPermissionAt(db, organizationId, locationId, permission, alsoPermission);
  const owners = new Set((await db.select({ userId: roleAssignments.userId }).from(roleAssignments)
    .where(and(eq(roleAssignments.organizationId, organizationId), eq(roleAssignments.role, 'org_owner')))).map((r) => r.userId));
  const responsible = holders.filter((id) => !owners.has(id));
  return responsible.length ? { userIds: responsible, fallback: false } : { userIds: [...owners], fallback: true };
}

/** The signed-in account behind a customer record: linked user, or a verified account with the same email. */
export async function userIdsForCustomer(db: Exec, customerId: string | null): Promise<string[]> {
  if (!customerId) return [];
  const [c] = await db.select({ userId: customers.userId, email: customers.email }).from(customers).where(eq(customers.id, customerId));
  if (!c) return [];
  if (c.userId) return [c.userId];
  if (!c.email) return [];
  const rows = await db.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${c.email.toLowerCase()}`, sql`${users.emailVerifiedAt} is not null`, isNull(users.deletedAt)));
  return rows.map((r) => r.id);
}
