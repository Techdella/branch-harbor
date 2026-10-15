/**
 * The AI assistant on mobile (`/v1/orgs/:orgId/ai/*`). Answers come back whole (`/ai/ask`), then tables, action cards
 * and sources render natively. Every tool runs on the server as the signed-in person.
 */
import type { AiActionCard, AiBlock, AiCitation, BriefingItem } from '@bh/shared';
import { http } from '@/lib/http';

export interface AskResult {
  conversationId: string;
  text: string;
  blocks: AiBlock[];
  citations: AiCitation[];
  actions: AiActionCard[];
  notices: Array<{ code: string; message: string }>;
}
export interface Briefing { date: string; summary: string | null; items: BriefingItem[] }

export const holdsAssistant = (caps: readonly string[] | undefined) => (caps ?? []).includes('ai.assistant:view');

const o = (orgId: string) => `/orgs/${orgId}/ai`;
export const marinaApi = {
  ask: (orgId: string, message: string, conversationId: string | null) => http<AskResult>('POST', `${o(orgId)}/ask`, { message, conversationId, channel: 'mobile', screen: { path: '/mobile' } }),
  briefing: (orgId: string) => http<Briefing>('GET', `${o(orgId)}/briefing`),
  actions: (orgId: string) => http<{ mine: AiActionCard[]; toApprove: AiActionCard[] }>('GET', `${o(orgId)}/actions`),
  confirm: (orgId: string, id: string) => http<AiActionCard>('POST', `${o(orgId)}/actions/${id}/confirm`, { edits: {} }),
  cancel: (orgId: string, id: string) => http<AiActionCard>('POST', `${o(orgId)}/actions/${id}/cancel`, {}),
};
