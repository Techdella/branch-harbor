/**
 * Local social (Rallio / SOCi-style content calendar): HQ publishes approved posts to a network calendar; each
 * location localises one with a click (tokens such as {location}, {city} and {booking_link} are filled from its own
 * listing) and schedules it on its own connected accounts. The scheduled post is an ordinary local social post, so
 * the existing dispatcher publishes it through the network adapters (sandbox unless the account was connected
 * through OAuth). HQ already approved the text: an unedited post needs no further approval; an edited one follows
 * the location's marketing tier like any local post.
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { fillSocialTemplate, localPostNeedsApproval, missingSocialTokens, socialPostIssues, type SocialNetworkKey } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { listingProfiles, locations, organizations, socialCalendarAdoptions, socialCalendarItems, socialPosts } from '../db/schema/index.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { postableAccounts, tierOf } from './social.ts';

type ItemRow = typeof socialCalendarItems.$inferSelect;

/** Token values for a location: its name, city, phone, booking link and website (from Listings), and the brand. */
export async function tokenValues(db: Exec, orgId: string, locationId: string) {
  const [l] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, orgId)));
  if (!l) throw notFound('Location');
  const [p] = await db.select().from(listingProfiles).where(eq(listingProfiles.locationId, locationId));
  const [o] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  return { location: l, values: { location: l.name, city: l.address.city, phone: l.phone, booking_link: p?.bookingUrl ?? null, website: p?.websiteUrl ?? null, brand: o?.name ?? null } };
}

export function itemVisibleTo(item: ItemRow, locationId: string) {
  return item.audience === 'all' || item.locationIds.includes(locationId);
}

/** Preview of a calendar item for a location: localised text, missing tokens, the accounts it would post to. */
export async function localise(s: Services, item: ItemRow, locationId: string) {
  const { values } = await tokenValues(s.db, item.organizationId, locationId);
  const accounts = (await postableAccounts(s.db, item.organizationId, locationId)).filter((a) => a.status !== 'disconnected' && (!item.networks.length || item.networks.includes(a.network)));
  return { body: fillSocialTemplate(item.body, values), missing: missingSocialTokens(item.body, values), accounts: accounts.map((a) => ({ id: a.id, network: a.network, handle: a.handle, mode: a.mode, ownerKind: a.ownerKind })) };
}

/**
 * One-click localise and schedule: creates the location's social post on its own accounts at the suggested time (or
 * the time chosen within the item's window). Edited text is only allowed when HQ allowed edits.
 */
export async function adoptItem(s: Services, item: ItemRow, input: { locationId: string; accountIds?: string[]; scheduledAt?: Date | null; body?: string | null }, userId: string) {
  if (item.status !== 'published') throw conflict('item_not_published', 'This post is not in the calendar');
  if (!itemVisibleTo(item, input.locationId)) throw notFound('Calendar post');
  const preview = await localise(s, item, input.locationId);
  const edited = !!input.body && input.body.trim() !== preview.body.trim();
  if (edited && !item.allowEdits) throw conflict('edits_not_allowed', 'HQ locked the text of this post; only the location details are filled in');
  const body = edited ? input.body!.trim() : preview.body;
  const left = missingSocialTokens(body, {});
  if (left.length) throw conflict('missing_details', `Fill in ${left.join(', ')} for this location first (Listings)`, { tokens: left });
  const accounts = input.accountIds?.length ? preview.accounts.filter((a) => input.accountIds!.includes(a.id)) : preview.accounts;
  if (!accounts.length) throw conflict('no_accounts', 'Connect a social account for this location first');
  for (const a of accounts) {
    const issues = socialPostIssues(a.network as SocialNetworkKey, { body, media: item.media, link: item.link });
    if (issues.length) throw validationError(`Not valid for ${a.network}: ${issues.join(', ')}`, { body: issues.join(',') });
  }
  const when = input.scheduledAt ?? item.suggestedAt;
  if (when.getTime() < Date.now() - 60_000) throw validationError('Choose a time in the future', { scheduledAt: 'In the past' });
  const { location } = await tokenValues(s.db, item.organizationId, input.locationId);
  const needsApproval = edited && localPostNeedsApproval(tierOf(location), accounts.some((a) => a.ownerKind === 'hq'));
  return s.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(socialCalendarAdoptions).where(and(eq(socialCalendarAdoptions.itemId, item.id), eq(socialCalendarAdoptions.locationId, input.locationId)));
    if (existing?.status === 'scheduled' && existing.postId) {
      const [p] = await tx.select({ status: socialPosts.status }).from(socialPosts).where(eq(socialPosts.id, existing.postId));
      if (p && !['cancelled', 'failed', 'rejected'].includes(p.status)) throw conflict('already_scheduled', 'This post is already scheduled for the location');
    }
    const [post] = await tx.insert(socialPosts).values({
      organizationId: item.organizationId, locationId: input.locationId, body, media: item.media, link: item.link, accountIds: accounts.map((a) => a.id), scheduledAt: when,
      status: needsApproval ? 'pending_approval' : 'scheduled', needsApproval, authorUserId: userId,
    }).returning();
    await tx.insert(socialCalendarAdoptions).values({ organizationId: item.organizationId, itemId: item.id, locationId: input.locationId, postId: post!.id, status: 'scheduled', adoptedBy: userId })
      .onConflictDoUpdate({ target: [socialCalendarAdoptions.itemId, socialCalendarAdoptions.locationId], set: { postId: post!.id, status: 'scheduled', adoptedBy: userId } });
    await audit(tx, { organizationId: item.organizationId, actorUserId: userId, action: 'social.calendar_adopted', scopeKind: 'location', scopeId: input.locationId, targetType: 'social_post', targetId: post!.id, metadata: { itemId: item.id, edited, needsApproval, accounts: accounts.length } });
    return post!;
  });
}

export async function skipItem(s: Services, item: ItemRow, locationId: string, userId: string) {
  if (!itemVisibleTo(item, locationId)) throw notFound('Calendar post');
  await s.db.insert(socialCalendarAdoptions).values({ organizationId: item.organizationId, itemId: item.id, locationId, status: 'skipped', adoptedBy: userId })
    .onConflictDoUpdate({ target: [socialCalendarAdoptions.itemId, socialCalendarAdoptions.locationId], set: { status: 'skipped', adoptedBy: userId }, setWhere: sql`${socialCalendarAdoptions.postId} is null` });
  return { ok: true };
}

/** Calendar for a period with adoption per location (HQ: counts across the network; locations: their own status). */
export async function calendar(db: Exec, orgId: string, opts: { from: Date; to: Date; includeDrafts: boolean; locationIds: string[] | 'all' }) {
  const items = await db.select().from(socialCalendarItems).where(and(eq(socialCalendarItems.organizationId, orgId), gte(socialCalendarItems.suggestedAt, opts.from), lt(socialCalendarItems.suggestedAt, opts.to),
    opts.includeDrafts ? inArray(socialCalendarItems.status, ['draft', 'published']) : eq(socialCalendarItems.status, 'published'))).orderBy(asc(socialCalendarItems.suggestedAt));
  const ids = items.map((i) => i.id);
  const adoptions = ids.length ? await db.select({ a: socialCalendarAdoptions, postStatus: socialPosts.status, scheduledAt: socialPosts.scheduledAt }).from(socialCalendarAdoptions).leftJoin(socialPosts, eq(socialPosts.id, socialCalendarAdoptions.postId))
    .where(and(inArray(socialCalendarAdoptions.itemId, ids), opts.locationIds === 'all' ? undefined : opts.locationIds.length ? inArray(socialCalendarAdoptions.locationId, opts.locationIds) : sql`false`)) : [];
  const visible = (i: ItemRow) => opts.locationIds === 'all' || opts.locationIds.some((l) => itemVisibleTo(i, l));
  return items.filter(visible).map((i) => ({
    ...serializeItem(i),
    adoptions: adoptions.filter((x) => x.a.itemId === i.id).map((x) => ({ locationId: x.a.locationId, status: x.a.status, postId: x.a.postId, postStatus: x.postStatus ?? null, scheduledAt: x.scheduledAt?.toISOString() ?? null })),
  }));
}

export function serializeItem(i: ItemRow) {
  return {
    id: i.id, title: i.title, body: i.body, media: i.media, link: i.link, networks: i.networks, suggestedAt: i.suggestedAt.toISOString(), allowEdits: i.allowEdits, audience: i.audience, locationIds: i.locationIds,
    status: i.status, publishedAt: i.publishedAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString(),
  };
}

export async function loadItem(db: Exec, orgId: string, id: string) {
  const [i] = await db.select().from(socialCalendarItems).where(and(eq(socialCalendarItems.id, id), eq(socialCalendarItems.organizationId, orgId)));
  if (!i) throw notFound('Calendar post');
  return i;
}


