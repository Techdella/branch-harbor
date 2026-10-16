/**
 * Receiving deliveries and self-checks on the phone (`/v1/orgs/:orgId/supply|self-checks`). The server filters
 * everything to the person's scope: a location sees its own orders and today's checks, never another franchisee's.
 */
import type { AuditAnswer, AuditSection, PoLine } from '@bh/shared';
import { http } from '@/lib/http';
import { selectedAccountId } from '@/lib/live';

export interface PoSummary {
  id: string; number: string; status: string; locationId: string; locationName: string | null; supplierName: string | null; currency: string; totalMinor: number; lines: PoLine[];
  expectedDeliveryDate: string | null; late: boolean; packs: { ordered: number; received: number; damaged: number }; supplierReference: string | null; notes: string;
  can?: { receive: boolean };
}
export interface ReceiveLine { itemId: string; received: number; damaged: number; issue: string | null; note: string }
export interface RunSummary { id: string; scheduleName: string; locationName: string | null; date: string; dueAt: string; late: boolean; status: 'due' | 'in_progress' | 'completed' | 'missed'; passed: boolean | null; answered: number; questionCount: number; canFill?: boolean; completedBy: { name: string | null } | null }
export interface RunDetail extends RunSummary { checklist: { name: string; sections: AuditSection[]; passThreshold: number }; answers: Record<string, AuditAnswer>; failedItems: Array<{ questionId: string; text: string; critical: boolean }>; criticalFailed: boolean | null; canFill: boolean }
export interface SOrg { id: string; name: string; caps: string[] }

interface MeOrg { id: string; name: string; access?: { capabilities: string[] } }

export const holdsSuppliers = (caps: readonly string[] | undefined) => (caps ?? []).includes('operations.suppliers:view');
export const holdsSelfChecks = (caps: readonly string[] | undefined) => (caps ?? []).includes('operations.self_checks:view');

/** Business accounts with suppliers or self-checks; the active account first. */
export async function supplyOrgs(): Promise<SOrg[]> {
  const me = await http<{ organizations: MeOrg[] }>('GET', '/auth/me');
  const active = selectedAccountId();
  return me.organizations
    .filter((o) => holdsSuppliers(o.access?.capabilities) || holdsSelfChecks(o.access?.capabilities))
    .sort((a, b) => Number(b.id === active) - Number(a.id === active))
    .map((o) => ({ id: o.id, name: o.name, caps: o.access?.capabilities ?? [] }));
}

const o = (orgId: string) => `/orgs/${orgId}`;
export const supplyApi = {
  deliveries: async (orgId: string) => (await http<{ items: PoSummary[] }>('GET', `${o(orgId)}/supply/orders?status=open&limit=50`)).items,
  order: (orgId: string, id: string) => http<PoSummary>('GET', `${o(orgId)}/supply/orders/${id}`),
  receive: (orgId: string, id: string, lines: ReceiveLine[], note: string, closeShort: boolean) => http<PoSummary & { inventory: Array<{ itemId: string; units: number }> }>('POST', `${o(orgId)}/supply/orders/${id}/receive`, { lines, note, closeShort }),
  today: async (orgId: string) => (await http<{ items: RunSummary[] }>('GET', `${o(orgId)}/self-checks/today`)).items,
  run: (orgId: string, id: string) => http<RunDetail>('GET', `${o(orgId)}/self-checks/runs/${id}`),
  saveRun: (orgId: string, id: string, answers: Record<string, AuditAnswer>) => http<{ savedAt: string }>('PUT', `${o(orgId)}/self-checks/runs/${id}/answers`, { answers }),
  completeRun: (orgId: string, id: string, answers: Record<string, AuditAnswer>, note?: string) => http<RunDetail>('POST', `${o(orgId)}/self-checks/runs/${id}/complete`, { answers, note }),
  uploadRunPhoto: (orgId: string, id: string, file: { filename: string; contentType: string; dataBase64: string }) => http<{ id: string; url: string }>('POST', `${o(orgId)}/self-checks/runs/${id}/photos`, file),
};
