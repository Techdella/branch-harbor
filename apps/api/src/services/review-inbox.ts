/**
 * Review responses in the unified inbox: every Google review becomes an inbox conversation of type `review` in the
 * location's inbox (one per review), with a reply SLA (negative reviews sooner). Replies written in the inbox are
 * published through the reviews service — the same approval policy, the same Google call, the same audit — and the
 * conversation follows the reply's status wherever it was written (Reviews screen or inbox).
 */
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { NEGATIVE_REVIEW_MAX_RATING, fillReplyTemplate, pickReplyTemplates, reviewReplyDueAt } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { commsChannelAccounts, commsConversations, commsMessages, locations, organizations, reviewReplyTemplates, reviews } from '../db/schema/index.ts';
import { conflict, forbidden, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { getLocalMarketingSettings } from './local-marketing.ts';
import { effectiveSettings, emitReviewEvent, onReviewEvent, publishReply, replyNeedsApproval, type ReviewRow } from './reviews.ts';

type ConversationRow = typeof commsConversations.$inferSelect;
const stars = (n: number) => '★'.repeat(n) + '☆'.repeat(5 - n);

/** The location's "Google reviews" inbox (created on first use; sandbox when the review came from a sandbox source). */
async function reviewAccount(tx: Exec, review: ReviewRow) {
  const address = `google-reviews:${review.locationId}`;
  const [acct] = await tx.insert(commsChannelAccounts).values({ organizationId: review.organizationId, locationId: review.locationId, channel: 'review', address, displayName: 'Google reviews', mode: review.sandbox ? 'sandbox' : 'live' })
    .onConflictDoNothing().returning();
  if (acct) return acct;
  const [existing] = await tx.select().from(commsChannelAccounts).where(and(eq(commsChannelAccounts.channel, 'review'), eq(commsChannelAccounts.address, address)));
  return existing!;
}

/** Creates the inbox conversation for a Google review (idempotent: one conversation per review). */
export async function deliverReviewToInbox(s: Services, review: ReviewRow): Promise<string | null> {
  if (review.source !== 'google') return null;
  if (review.conversationId) return review.conversationId;
  const sla = (await getLocalMarketingSettings(s.db, review.organizationId)).reviewSla;
  return s.db.transaction(async (tx) => {
    const acct = await reviewAccount(tx, review);
    const handle = `review:${review.id}`;
    const answered = review.replyStatus === 'published';
    const body = `${stars(review.rating)} (${review.rating}/5)${review.comment ? `\n\n${review.comment}` : ''}`;
    const [conv] = await tx.insert(commsConversations).values({
      organizationId: review.organizationId, locationId: review.locationId, channelAccountId: acct.id, channel: 'review', handle, contactName: review.authorName ?? 'Google user',
      subject: `${review.rating}/5 Google review`, status: answered ? 'closed' : 'open', lastInboundAt: review.reviewedAt, lastMessageAt: review.repliedAt ?? review.reviewedAt,
      lastMessagePreview: (review.replyText && answered ? review.replyText : body).slice(0, 140), unread: answered ? 0 : 1,
      replyDueAt: answered ? null : reviewReplyDueAt(review.reviewedAt, review.rating, sla, NEGATIVE_REVIEW_MAX_RATING), firstReplyAt: answered ? review.repliedAt : null,
    }).onConflictDoNothing().returning();
    const c = conv ?? (await tx.select().from(commsConversations).where(and(eq(commsConversations.channelAccountId, acct.id), eq(commsConversations.handle, handle))))[0]!;
    if (conv) {
      await tx.insert(commsMessages).values({ organizationId: review.organizationId, conversationId: c.id, direction: 'inbound', body, status: 'received', createdAt: review.reviewedAt, meta: { source: 'google_review', reviewId: review.id, rating: review.rating } });
      if (answered && review.replyText) {
        await tx.insert(commsMessages).values({ organizationId: review.organizationId, conversationId: c.id, direction: 'outbound', body: review.replyText, status: review.sandbox ? 'sandboxed' : 'sent', createdAt: review.repliedAt ?? new Date(), meta: { reviewReply: true, reviewId: review.id, external: review.replyExternal } });
      }
    }
    await tx.update(reviews).set({ conversationId: c.id }).where(eq(reviews.id, review.id));
    return c.id;
  });
}

/** Keeps the conversation in step with the reply: pending approval, published (sent / sandboxed), failed or rejected. */
export async function syncReplyToConversation(s: Services, review: ReviewRow) {
  if (review.source !== 'google' || !review.conversationId) return;
  const [conv] = await s.db.select().from(commsConversations).where(eq(commsConversations.id, review.conversationId));
  if (!conv) return;
  const status = review.replyStatus === 'published' ? (review.sandbox ? 'sandboxed' : 'sent') : review.replyStatus;
  if (!['sent', 'sandboxed', 'failed', 'pending_approval', 'rejected'].includes(status)) return;
  await s.db.transaction(async (tx) => {
    // One reply message per reply attempt: update the latest pending one, otherwise add one.
    const [pending] = await tx.select().from(commsMessages).where(and(eq(commsMessages.conversationId, conv.id), eq(commsMessages.direction, 'outbound'), eq(commsMessages.status, 'pending_approval'))).orderBy(desc(commsMessages.createdAt)).limit(1);
    const values = { body: review.replyText ?? '', status, error: review.replyError, authorUserId: review.replyBy, meta: { reviewReply: true, reviewId: review.id, decisionNote: review.replyDecisionNote } };
    if (pending) await tx.update(commsMessages).set(values).where(eq(commsMessages.id, pending.id));
    else if (status !== 'rejected') await tx.insert(commsMessages).values({ organizationId: conv.organizationId, conversationId: conv.id, direction: 'outbound', ...values });
    const published = status === 'sent' || status === 'sandboxed';
    await tx.update(commsConversations).set({
      status: published ? 'closed' : status === 'pending_approval' ? 'pending' : 'open',
      ...(published ? { replyDueAt: null, firstReplyAt: conv.firstReplyAt ?? new Date(), unread: 0 } : {}),
      lastMessageAt: new Date(), lastMessagePreview: (review.replyText ?? '').slice(0, 140), updatedAt: new Date(),
    }).where(eq(commsConversations.id, conv.id));
  });
}

onReviewEvent(async (s, e) => {
  if (e.type === 'received') await deliverReviewToInbox(s, e.review);
  else await syncReplyToConversation(s, e.review);
});

/** The review behind a `review` conversation. */
export async function reviewForConversation(db: Exec, conv: ConversationRow) {
  if (conv.channel !== 'review') return null;
  const [r] = await db.select().from(reviews).where(and(eq(reviews.conversationId, conv.id), eq(reviews.organizationId, conv.organizationId)));
  return r ?? null;
}

/**
 * A reply written in the inbox: saved on the review and published (or sent for HQ approval when the policy says so),
 * exactly as from Reviews. `isApprover` = organisation-wide Reviews publish (HQ never waits for itself).
 */
export async function replyFromInbox(s: Services, conv: ConversationRow, input: { text: string; userId: string; canReply: boolean; isApprover: boolean; templateId?: string | null }) {
  const review = await reviewForConversation(s.db, conv);
  if (!review) throw notFound('Review');
  if (!input.canReply) throw forbidden('Replying to reviews needs Reviews (edit) at this location');
  if (review.replyStatus === 'pending_approval' && !input.isApprover) throw conflict('awaiting_approval', 'This reply is waiting for HQ approval');
  const text = input.text.trim();
  if (text.length < 2) throw conflict('no_reply', 'Write a reply first');
  const now = new Date();
  const st = await effectiveSettings(s.db, conv.organizationId, review.locationId);
  const base = { replyText: text, replyAiSuggested: false, replyBy: input.userId, replyError: null, replySubmittedAt: now, updatedAt: now };
  let row: ReviewRow;
  if (replyNeedsApproval(st.replyApproval, review.rating) && !input.isApprover) {
    [row] = await s.db.update(reviews).set({ ...base, replyStatus: 'pending_approval', replyDecidedBy: null, replyDecisionNote: null }).where(eq(reviews.id, review.id)).returning() as [ReviewRow];
    await audit(s.db, { organizationId: conv.organizationId, actorUserId: input.userId, action: 'reviews.reply_submitted', scopeKind: 'location', scopeId: review.locationId, targetType: 'review', targetId: review.id, metadata: { via: 'inbox', templateId: input.templateId ?? null } });
    await emitReviewEvent(s, { type: 'reply_changed', review: row });
  } else {
    const [u] = await s.db.update(reviews).set(base).where(eq(reviews.id, review.id)).returning();
    row = await publishReply(s, u!, input.userId);
  }
  return row;
}

/** Reply templates that fit a review (location's own first, then the reviewer's language), filled for this review. */
export async function templatesForReview(db: Exec, review: ReviewRow) {
  const rows = await db.select().from(reviewReplyTemplates).where(and(eq(reviewReplyTemplates.organizationId, review.organizationId), or(isNull(reviewReplyTemplates.locationId), eq(reviewReplyTemplates.locationId, review.locationId))));
  const [loc] = await db.select({ name: locations.name }).from(locations).where(eq(locations.id, review.locationId));
  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, review.organizationId));
  const firstName = review.authorName?.split(' ')[0] ?? '';
  return pickReplyTemplates(rows, review.rating, review.language).map((t) => ({ id: t.id, name: t.name, body: fillReplyTemplate(t.body, { first_name: firstName, location: loc?.name ?? '', business: org?.name ?? '' }) }));
}

/** Back-fill: Google reviews stored before the inbox integration get their conversation. */
export async function backfillReviewConversations(s: Services, orgId: string) {
  const rows = await s.db.select().from(reviews).where(and(eq(reviews.organizationId, orgId), eq(reviews.source, 'google'), isNull(reviews.conversationId))).limit(500);
  for (const r of rows) await deliverReviewToInbox(s, r);
  return rows.length;
}

