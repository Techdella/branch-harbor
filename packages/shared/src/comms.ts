/**
 * Marketing & sales communications: shared rules for the unified inbox, social publishing and ad campaigns.
 * Enforced by the API; clients use them for previews and to explain why an action is unavailable.
 */

export const INBOX_CHANNELS = ['email', 'sms', 'whatsapp', 'instagram', 'messenger'] as const;
export type InboxChannelKey = (typeof INBOX_CHANNELS)[number];

export const CONVERSATION_STATUSES = ['open', 'pending', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Customer-service window: WhatsApp (and Meta Messenger / Instagram) allow free-form replies only within 24 hours of
 * the contact's last message. Outside it, WhatsApp needs an approved template and Meta channels can't be messaged.
 */
export const SERVICE_WINDOW_HOURS = 24;

/** Keywords that opt a contact out of SMS / WhatsApp, and back in. */
export const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'ARRET', 'BAJA', 'ABMELDEN', 'PARAR'] as const;
export const OPT_IN_KEYWORDS = ['START', 'UNSTOP', 'YES'] as const;

/** Consent purpose recorded for marketing on a channel (consent_records.purpose). */
export const marketingConsentPurpose = (channel: InboxChannelKey) => `marketing_${channel}`;

export function windowState(lastInboundAt: Date | string | null | undefined, now = new Date()) {
  if (!lastInboundAt) return { open: false, closesAt: null as string | null };
  const closes = new Date(new Date(lastInboundAt).getTime() + SERVICE_WINDOW_HOURS * 3600_000);
  return { open: closes > now, closesAt: closes.toISOString() };
}

/* ── Social ── */

export const SOCIAL_NETWORKS = ['facebook', 'instagram', 'linkedin', 'google_business'] as const;
export type SocialNetworkKey = (typeof SOCIAL_NETWORKS)[number];

/** Per-network limits used for previews and validation. */
export const SOCIAL_LIMITS: Record<SocialNetworkKey, { maxChars: number; mediaRequired: boolean; maxMedia: number; links: boolean }> = {
  facebook: { maxChars: 63206, mediaRequired: false, maxMedia: 10, links: true },
  instagram: { maxChars: 2200, mediaRequired: true, maxMedia: 10, links: false },
  linkedin: { maxChars: 3000, mediaRequired: false, maxMedia: 9, links: true },
  google_business: { maxChars: 1500, mediaRequired: false, maxMedia: 1, links: true },
};

/** Problems with a post for one network (empty = fine). */
export function socialPostIssues(network: SocialNetworkKey, post: { body: string; media: unknown[]; link?: string | null }): Array<'too_long' | 'media_required' | 'too_many_media' | 'empty'> {
  const l = SOCIAL_LIMITS[network];
  const out: Array<'too_long' | 'media_required' | 'too_many_media' | 'empty'> = [];
  if (!post.body.trim() && !post.media.length) out.push('empty');
  if (post.body.length > l.maxChars) out.push('too_long');
  if (l.mediaRequired && !post.media.length) out.push('media_required');
  if (post.media.length > l.maxMedia) out.push('too_many_media');
  return out;
}

/**
 * Local marketing tier of a location (location settings `marketingTier`): who runs local marketing and whether its
 * social posts need HQ approval. managed = HQ runs it, every local post is approved; standard = posts on HQ-owned
 * accounts are approved; flexible = the location posts within brand rules without approval.
 */
export const MARKETING_TIERS = ['managed', 'standard', 'flexible'] as const;
export type MarketingTier = (typeof MARKETING_TIERS)[number];

export function localPostNeedsApproval(tier: MarketingTier, targetsHqOwnedAccount: boolean): boolean {
  if (tier === 'managed') return true;
  if (tier === 'standard') return targetsHqOwnedAccount;
  return false;
}

/* ── Ad campaigns ── */

export const AD_CAMPAIGN_KINDS = ['network', 'coming_soon', 'local', 'course'] as const;
export type AdCampaignKind = (typeof AD_CAMPAIGN_KINDS)[number];
export const AD_PLATFORMS = ['meta', 'google', 'linkedin'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/**
 * Split each currency's total evenly over the locations budgeted in that currency (integer minor units; the
 * remainder goes one unit at a time to the first locations, so the parts always add up to the total).
 */
export function splitBudget(locations: ReadonlyArray<{ id: string; currency: string }>, totals: Readonly<Record<string, number>>): Map<string, { budgetMinor: number; currency: string }> {
  const out = new Map<string, { budgetMinor: number; currency: string }>();
  const byCurrency = new Map<string, string[]>();
  for (const l of locations) byCurrency.set(l.currency, [...(byCurrency.get(l.currency) ?? []), l.id]);
  for (const [cur, ids] of byCurrency) {
    const total = totals[cur];
    if (total === undefined) continue;
    const base = Math.floor(total / ids.length);
    let rest = total - base * ids.length;
    for (const id of ids) {
      out.set(id, { budgetMinor: base + (rest > 0 ? 1 : 0), currency: cur });
      if (rest > 0) rest--;
    }
  }
  return out;
}
