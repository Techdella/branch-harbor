/**
 * Social publishing: HQ-owned accounts with posting rights handed over to locations (revocable), local posts that
 * need HQ approval depending on the location's marketing tier, and a dispatcher that publishes due posts through
 * the network adapters. Sandbox accounts never claim a post went live.
 */
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import { MARKETING_TIERS, type MarketingTier, type SocialNetworkKey } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { locations, socialAccountGrants, socialAccounts, socialPosts, type SocialPublishResult } from '../db/schema/index.ts';
import { publishToNetwork } from '../integrations/social.ts';
import { decrypt } from '../lib/crypto.ts';
import { audit } from './audit.ts';

export type SocialAccountRow = typeof socialAccounts.$inferSelect;
export type SocialPostRow = typeof socialPosts.$inferSelect;

export function tierOf(loc: { settings: Record<string, unknown> | null }): MarketingTier {
  const t = (loc.settings ?? {}).marketingTier;
  return (MARKETING_TIERS as readonly string[]).includes(t as string) ? (t as MarketingTier) : 'standard';
}

/** Can a location post on this account? Its own account, or an HQ account with an active posting grant. */
export async function locationMayPost(db: Exec, account: SocialAccountRow, locationId: string): Promise<boolean> {
  if (account.ownerKind === 'location') return account.locationId === locationId;
  const [g] = await db.select({ access: socialAccountGrants.access }).from(socialAccountGrants)
    .where(and(eq(socialAccountGrants.accountId, account.id), eq(socialAccountGrants.locationId, locationId), isNull(socialAccountGrants.revokedAt)));
  return !!g && (g.access === 'post' || g.access === 'post_insights');
}

/** Accounts a location can post on. */
export async function postableAccounts(db: Exec, orgId: string, locationId: string) {
  const own = await db.select().from(socialAccounts).where(and(eq(socialAccounts.organizationId, orgId), eq(socialAccounts.ownerKind, 'location'), eq(socialAccounts.locationId, locationId)));
  const grants = await db.select({ accountId: socialAccountGrants.accountId }).from(socialAccountGrants)
    .where(and(eq(socialAccountGrants.organizationId, orgId), eq(socialAccountGrants.locationId, locationId), isNull(socialAccountGrants.revokedAt), inArray(socialAccountGrants.access, ['post', 'post_insights'])));
  const hq = grants.length ? await db.select().from(socialAccounts).where(inArray(socialAccounts.id, grants.map((g) => g.accountId))) : [];
  return [...own, ...hq];
}

/** Publish one post now (it must already be claimed as `publishing`). */
export async function publishPost(s: Services, post: SocialPostRow): Promise<SocialPostRow> {
  const accounts = post.accountIds.length ? await s.db.select().from(socialAccounts).where(inArray(socialAccounts.id, post.accountIds)) : [];
  const results: SocialPublishResult[] = [];
  for (const id of post.accountIds) {
    const a = accounts.find((x) => x.id === id);
    const at = new Date().toISOString();
    if (!a || a.status === 'disconnected') { results.push({ accountId: id, network: a?.network ?? 'unknown', status: 'failed', error: 'Account not connected', at }); continue; }
    // Rights are re-checked at publish time: a revoked handover cancels the post on that account.
    if (post.locationId && !(await locationMayPost(s.db, a, post.locationId))) { results.push({ accountId: id, network: a.network, status: 'cancelled', error: 'Posting rights were revoked', at }); continue; }
    const token = a.credentialsEncrypted ? decrypt(a.credentialsEncrypted, s.cfg.ENCRYPTION_KEY) : null;
    const r = await publishToNetwork(s.cfg, { network: a.network as SocialNetworkKey, mode: a.mode, externalId: a.externalId, token, body: post.body, media: post.media, link: post.link });
    results.push({ accountId: id, network: a.network, status: r.status, externalId: r.externalId ?? null, error: r.error ?? null, at });
  }
  const live = results.filter((r) => r.status === 'published').length;
  const sandboxed = results.filter((r) => r.status === 'sandboxed').length;
  const ok = live + sandboxed;
  const status = ok === results.length ? (live ? 'published' : 'sandboxed') : ok > 0 ? 'partially_published' : results.every((r) => r.status === 'cancelled') ? 'cancelled' : 'failed';
  const [u] = await s.db.update(socialPosts).set({ status, results, publishedAt: ok ? new Date() : null, updatedAt: new Date() }).where(eq(socialPosts.id, post.id)).returning();
  await audit(s.db, { organizationId: post.organizationId, actorUserId: null, actorType: 'system', action: 'social.post_published', scopeKind: post.locationId ? 'location' : 'organization', scopeId: post.locationId ?? post.organizationId, targetType: 'social_post', targetId: post.id, metadata: { status, results: results.map((r) => ({ accountId: r.accountId, status: r.status })) } });
  return u!;
}

/** Claim and publish every scheduled post that is due (safe to run concurrently: the claim is atomic). */
export async function publishDuePosts(s: Services, now = new Date()) {
  const due = await s.db.select({ id: socialPosts.id }).from(socialPosts).where(and(eq(socialPosts.status, 'scheduled'), lte(socialPosts.scheduledAt, now))).limit(50);
  let n = 0;
  for (const d of due) {
    const [claimed] = await s.db.update(socialPosts).set({ status: 'publishing', updatedAt: new Date() }).where(and(eq(socialPosts.id, d.id), eq(socialPosts.status, 'scheduled'))).returning();
    if (!claimed) continue;
    await publishPost(s, claimed);
    n++;
  }
  return n;
}

/**
 * Access handover on termination: revoke every posting grant a location holds on HQ accounts and take the
 * location's pending / scheduled posts off those accounts (posts left with no account are cancelled).
 */
export async function revokeLocationSocialAccess(db: Exec, orgId: string, locationId: string, by: string, reason: string) {
  const revoked = await db.update(socialAccountGrants).set({ revokedAt: new Date(), revokedBy: by, revokeReason: reason })
    .where(and(eq(socialAccountGrants.organizationId, orgId), eq(socialAccountGrants.locationId, locationId), isNull(socialAccountGrants.revokedAt))).returning();
  const hqIds = new Set(revoked.map((g) => g.accountId));
  const posts = await db.select().from(socialPosts).where(and(eq(socialPosts.organizationId, orgId), eq(socialPosts.locationId, locationId), inArray(socialPosts.status, ['draft', 'pending_approval', 'scheduled'])));
  let cancelled = 0;
  let trimmed = 0;
  for (const p of posts) {
    const keep = p.accountIds.filter((id) => !hqIds.has(id));
    if (keep.length === p.accountIds.length) continue;
    if (keep.length) {
      await db.update(socialPosts).set({ accountIds: keep, updatedAt: new Date() }).where(eq(socialPosts.id, p.id));
      trimmed++;
    } else {
      await db.update(socialPosts).set({ status: 'cancelled', decisionComment: reason, updatedAt: new Date() }).where(eq(socialPosts.id, p.id));
      cancelled++;
    }
  }
  await audit(db, { organizationId: orgId, actorUserId: by, action: 'social.access_revoked', scopeKind: 'location', scopeId: locationId, targetType: 'location', targetId: locationId, metadata: { reason, grants: revoked.length, postsCancelled: cancelled, postsTrimmed: trimmed } });
  return { grantsRevoked: revoked.length, postsCancelled: cancelled, postsTrimmed: trimmed };
}

export async function locationRow(db: Exec, orgId: string, id: string) {
  const [l] = await db.select().from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
  return l ?? null;
}
