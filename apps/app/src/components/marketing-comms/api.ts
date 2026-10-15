/**
 * Client for the marketing & sales communication endpoints (inbox, contacts, segments, sales pipeline, social, ad
 * campaigns). Live API only: no sample data.
 */
import type { InboxChannelKey, SocialNetworkKey } from '@bh/shared';
import { http } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';

const o = () => `/orgs/${orgId()}`;

export interface Person { id: string; name: string | null }
export interface MoneyV { amount: number; currency: string }

export interface ChannelAccount { id: string; locationId: string | null; channel: InboxChannelKey; address: string; displayName: string; mode: 'live' | 'sandbox'; active: boolean }
export interface Conversation {
  id: string; locationId: string | null; channel: InboxChannelKey; channelAccountId: string; handle: string; contactName: string | null; customerId: string | null; leadId: string | null; subject: string | null;
  status: 'open' | 'pending' | 'closed'; assignedUser: Person | null; lastMessageAt: string; lastInboundAt: string | null; lastMessagePreview: string | null; unread: number;
  replyDueAt: string | null; slaBreached: boolean; window: { open: boolean; closesAt: string | null };
}
export interface Message { id: string; direction: 'inbound' | 'outbound' | 'note'; body: string; status: string; error: string | null; templateId: string | null; createdAt: string; author: Person | null }
export interface ReplyPolicy { optedOut: boolean; consent: boolean | null; window: { open: boolean; closesAt: string | null }; canReply: boolean; needsTemplate: boolean; blockedReason: null | 'contact_opted_out' | 'consent_required' | 'messaging_window_closed' }
export interface ConversationDetail { conversation: Conversation; messages: Message[]; policy: ReplyPolicy; customer: { id: string; name: string; email: string | null; phone: string | null } | null; lead: { id: string; name: string | null; status: string; source: string } | null; canReply: boolean }
export interface WaTemplate { id: string; name: string; language: string; category: string; body: string; status: 'pending' | 'approved' | 'rejected' }
export interface CannedReply { id: string; locationId: string | null; title: string; body: string }
export interface Segment { id: string; locationId: string | null; name: string; rules: Record<string, unknown>; count: number }
export interface Contact { id: string; name: string; email: string | null; phone: string | null; locationId: string | null; lastActivityAt: string | null; consent: { email: boolean | null; sms: boolean | null; whatsapp: boolean | null }; tags: string[] }

export const inboxApi = {
  channels: () => http.get<{ items: ChannelAccount[]; hq: boolean }>(`${o()}/inbox/channels`),
  addChannel: (b: { channel: InboxChannelKey; locationId: string | null; address: string; displayName: string }) => http.post<ChannelAccount>(`${o()}/inbox/channels`, b),
  simulate: (id: string, b: { from: string; name?: string; body: string; subject?: string }) => http.post<{ results: Array<{ outcome: string; conversationId?: string }> }>(`${o()}/inbox/channels/${id}/simulate`, b),
  conversations: (q: { status: string; channel?: string; inbox?: 'all' | 'hq'; locationIds?: string; assigned?: string; q?: string }) =>
    http.get<{ items: Conversation[]; hq: boolean; counts: Array<{ status: string; n: number; overdue: number }> }>(`${o()}/inbox/conversations`, q),
  conversation: (id: string) => http.get<ConversationDetail>(`${o()}/inbox/conversations/${id}`),
  update: (id: string, b: { status?: string; assignedUserId?: string | null }) => http.patch<Conversation>(`${o()}/inbox/conversations/${id}`, b),
  read: (id: string) => http.post(`${o()}/inbox/conversations/${id}/read`),
  send: (id: string, b: { kind: 'reply' | 'note'; body?: string; templateId?: string }) => http.post<Message>(`${o()}/inbox/conversations/${id}/messages`, b),
  assignees: (locationId: string | null) => http.get<{ items: Person[] }>(`${o()}/inbox/assignees`, { locationId: locationId ?? undefined }),
  canned: (locationId: string | null) => http.get<{ items: CannedReply[] }>(`${o()}/inbox/canned-replies`, { locationId: locationId ?? undefined }),
  templates: () => http.get<{ items: WaTemplate[] }>(`${o()}/inbox/whatsapp-templates`),
  segments: () => http.get<{ items: Segment[] }>(`${o()}/segments`),
  contacts: (q: { q?: string; locationId?: string; tag?: string }) => http.get<{ items: Contact[]; count: number; tags: string[] }>(`${o()}/contacts`, q),
};

/* ── sales ── */

export interface Lead { id: string; kind: 'customer' | 'course'; name: string | null; email: string | null; phone: string | null; message: string | null; source: string; status: string; locationId: string | null; adCampaignId: string | null; assignedUser: Person | null; createdAt: string; postalCode: string | null; courseId?: string | null; campaign?: string | null; notes?: string | null }
export interface Stage { id: string; name: string; position: number; outcome: 'open' | 'won' | 'lost'; probability: number }
export interface Deal { id: string; locationId: string; stageId: string; title: string; customerName: string | null; value: MoneyV; owner: Person | null; expectedCloseOn: string | null; closedAt: string | null; openTasks: number }
export interface RoutingRule { id: string; kind: string; name: string; position: number; conditions: { sources?: string[]; locationIds?: string[]; countries?: string[]; postalPrefixes?: string[]; campaignIds?: string[] }; action: { type: 'location' | 'users' | 'location_team'; locationId?: string; userIds?: string[] }; active: boolean }

export const salesApi = {
  leads: (q: { kind: 'customer' | 'course'; status?: string; locationId?: string; assigned?: string }) => http.get<{ items: Lead[] }>(`${o()}/sales/leads`, q),
  addLead: (b: Record<string, unknown>) => http.post<Lead>(`${o()}/sales/leads`, b),
  updateLead: (id: string, b: { status?: string }) => http.patch<Lead>(`${o()}/sales/leads/${id}`, b),
  convert: (id: string) => http.post<{ dealId: string }>(`${o()}/sales/leads/${id}/convert`, {}),
  deals: () => http.get<{ stages: Stage[]; items: Deal[] }>(`${o()}/sales/deals`),
  moveDeal: (id: string, stageId: string) => http.patch<Deal>(`${o()}/sales/deals/${id}`, { stageId }),
  rules: (kind: 'customer' | 'course') => http.get<{ items: RoutingRule[] }>(`${o()}/sales/routing-rules`, { kind }),
  testRule: (b: Record<string, unknown>) => http.post<{ ruleName: string | null; locationId: string | null; assignedUserName: string | null; reason: string }>(`${o()}/sales/routing-rules/test`, b),
};

/* ── social ── */

export interface SocialAccount { id: string; ownerKind: 'hq' | 'location'; locationId: string | null; network: SocialNetworkKey; handle: string; mode: 'live' | 'sandbox'; status: string; grants: Array<{ id: string; locationId: string; access: string; grantedAt: string; revokedAt: string | null; revokeReason: string | null }> }
export interface SocialPost { id: string; locationId: string | null; body: string; media: Array<{ url: string }>; accountIds: string[]; scheduledAt: string | null; status: string; needsApproval: boolean; author: Person; decidedBy: Person | null; decisionComment: string | null; results: Array<{ accountId: string; status: string; error?: string | null }> }

export const socialApi = {
  accounts: () => http.get<{ items: SocialAccount[]; hq: boolean }>(`${o()}/social/accounts`),
  addAccount: (b: { network: SocialNetworkKey; handle: string; ownerKind: 'hq' | 'location'; locationId: string | null }) => http.post<SocialAccount>(`${o()}/social/accounts`, b),
  grant: (id: string, locationId: string, access: string) => http.post<SocialAccount>(`${o()}/social/accounts/${id}/grants`, { locationId, access }),
  revoke: (id: string, grantId: string) => http.post(`${o()}/social/accounts/${id}/grants/${grantId}/revoke`, { reason: 'revoked' }),
  revokeLocation: (locationId: string) => http.post<{ grantsRevoked: number; postsCancelled: number }>(`${o()}/social/handover/revoke-location`, { locationId, reason: 'termination' }),
  postable: (locationId: string | null) => http.get<{ items: SocialAccount[]; tier: string | null; approvesOwnPosts: boolean }>(`${o()}/social/postable-accounts`, { locationId: locationId ?? undefined }),
  posts: (q: { from?: string; to?: string; status?: string }) => http.get<{ items: SocialPost[]; canApprove: boolean }>(`${o()}/social/posts`, q),
  create: (b: { locationId: string | null; body: string; media: Array<{ url: string }>; accountIds: string[]; scheduledAt: string | null; submit: boolean }) => http.post<SocialPost>(`${o()}/social/posts`, b),
  decide: (id: string, decision: 'approve' | 'reject', comment?: string) => http.post<SocialPost>(`${o()}/social/posts/${id}/decision`, { decision, comment }),
  cancel: (id: string) => http.post<SocialPost>(`${o()}/social/posts/${id}/cancel`, {}),
};

/* ── campaigns ── */

export interface CampaignLocation { locationId: string; name: string; city: string | null; locationStatus: string; budget: MoneyV; radiusKm: number; spend: MoneyV; impressions: number; clicks: number; leads: number; costPerLead: MoneyV | null }
export interface AdCampaign {
  id: string; kind: 'network' | 'coming_soon' | 'local' | 'course'; name: string; objective: string; platforms: string[]; status: string; startsOn: string | null; endsOn: string | null;
  creative: { headline: string; body: string; imageUrl?: string | null; cta?: string | null }; comingSoon: { openingDate: string; presaleOffer: string } | null; approvalId: string | null; leadFormPath: string | null;
  totals: Array<{ currency: string; budget: number; spend: number; leads: number; costPerLead: number | null }>; locations: CampaignLocation[];
}

export const campaignsApi = {
  list: () => http.get<{ items: AdCampaign[]; canCreateNetwork: boolean }>(`${o()}/ad-campaigns`),
  get: (id: string) => http.get<AdCampaign>(`${o()}/ad-campaigns/${id}`),
  comingSoonLocations: () => http.get<{ items: Array<{ id: string; name: string; status: string; currency: string; city: string | null; openingDate: string | null }> }>(`${o()}/ad-campaigns/coming-soon-locations`),
  create: (b: Record<string, unknown>) => http.post<AdCampaign>(`${o()}/ad-campaigns`, b),
  createLocal: (b: Record<string, unknown>) => http.post<AdCampaign>(`${o()}/ad-campaigns/local`, b),
  setStatus: (id: string, status: string) => http.patch<AdCampaign>(`${o()}/ad-campaigns/${id}`, { status }),
  results: (id: string, b: { locationId: string; day: string; spendMinor: number; currency: string; impressions: number; clicks: number }) => http.post(`${o()}/ad-campaigns/${id}/results`, b),
};
