/**
 * Audits and compliance documents on mobile (`/v1/orgs/:orgId/audits|compliance`). The server filters everything to
 * the person's scope: auditors see the audits in their region or locations, franchise owners and managers see their
 * own locations' reports, corrective actions and compliance status.
 */
import type { AuditAnswer, AuditSection } from '@bh/shared';
import { http } from '@/lib/http';
import { selectedAccountId } from '@/lib/live';

export interface FileRef { id: string; url: string }
export interface AuditSummary {
  id: string; locationId: string; locationName: string | null; name: string; purpose: string; status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled'; dueDate: string; overdue: boolean;
  auditor: { id: string; name: string | null } | null; scorePct: number | null; passed: boolean | null; criticalFailed: boolean | null; openActions: number; overdueActions: number; completedAt: string | null;
}
export interface ActionItem {
  id: string; auditId: string; locationId: string; locationName: string | null; questionId: string; sectionTitle: string; title: string; reason: string; critical: boolean; auditorNote: string | null;
  dueDate: string; status: 'open' | 'submitted' | 'verified'; overdue: boolean; responseNote: string | null; evidence: FileRef[]; reviewNote: string | null;
}
export interface AuditDetail extends AuditSummary {
  timeZone: string; summary: string | null; reauditDueDate: string | null; passThreshold: number;
  checklist: { name: string; sections: AuditSection[]; passThreshold: number };
  answers: Record<string, AuditAnswer & { photos?: FileRef[] }>;
  actions: ActionItem[];
  permissions: { conduct: boolean; manage: boolean; respond: boolean; verify: boolean };
}
export interface MatrixRow { location: { id: string; name: string; ownerGroupName: string | null }; cells: Array<{ requirementId: string; state: string; expiresOn: string | null; daysLeft: number | null }>; compliant: number; applicable: number }
export interface Requirement { id: string; name: string; category: string; coverageType: string | null; minAmount: { amountMinor: number; currency: string } | null; appliesTo: 'location' | 'owner_group'; requiresExpiry: boolean }
export interface Matrix { today: string; requirements: Requirement[]; rows: MatrixRow[]; can: { upload: boolean } }
export interface Upload { filename: string; contentType: string; dataBase64: string }
export interface QOrg { id: string; name: string; caps: string[] }

interface MeOrg { id: string; name: string; roles: { role: string }[]; access?: { capabilities: string[] } }

export const holdsAudits = (caps: readonly string[] | undefined) => (caps ?? []).includes('operations.audits:view');
export const holdsCompliance = (caps: readonly string[] | undefined) => (caps ?? []).includes('legal.compliance_documents:view');

/** Business accounts with audits or compliance documents; the active account first. */
export async function qualityOrgs(): Promise<QOrg[]> {
  const me = await http<{ organizations: MeOrg[] }>('GET', '/auth/me');
  const active = selectedAccountId();
  return me.organizations
    .filter((o) => holdsAudits(o.access?.capabilities) || holdsCompliance(o.access?.capabilities))
    .sort((a, b) => Number(b.id === active) - Number(a.id === active))
    .map((o) => ({ id: o.id, name: o.name, caps: o.access?.capabilities ?? [] }));
}

const o = (orgId: string) => `/orgs/${orgId}`;
export const qualityApi = {
  audits: async (orgId: string, q = '') => (await http<{ items: AuditSummary[] }>('GET', `${o(orgId)}/audits${q}`)).items,
  audit: (orgId: string, id: string) => http<AuditDetail>('GET', `${o(orgId)}/audits/${id}`),
  saveAnswers: (orgId: string, id: string, answers: Record<string, AuditAnswer>) => http<{ revision: number; savedAt: string }>('PUT', `${o(orgId)}/audits/${id}/answers`, { answers }),
  uploadPhoto: (orgId: string, id: string, file: Upload) => http<FileRef>('POST', `${o(orgId)}/audits/${id}/photos`, file),
  complete: (orgId: string, id: string, summary: string | null, answers: Record<string, AuditAnswer>) => http<AuditDetail>('POST', `${o(orgId)}/audits/${id}/complete`, { summary: summary || undefined, answers }),
  actions: async (orgId: string) => (await http<{ items: ActionItem[] }>('GET', `${o(orgId)}/audits/actions?status=active`)).items,
  uploadEvidence: (orgId: string, id: string, file: Upload) => http<FileRef>('POST', `${o(orgId)}/audits/actions/${id}/evidence`, file),
  submitAction: (orgId: string, id: string, note: string, evidenceFileIds: string[]) => http<ActionItem>('POST', `${o(orgId)}/audits/actions/${id}/submit`, { note, evidenceFileIds }),
  verifyAction: (orgId: string, id: string, decision: 'verify' | 'reopen', note?: string) => http<ActionItem>('POST', `${o(orgId)}/audits/actions/${id}/verify`, { decision, note }),
  matrix: (orgId: string) => http<Matrix>('GET', `${o(orgId)}/compliance/matrix`),
  uploadDocument: (orgId: string, body: Record<string, unknown>) => http<{ id: string; status: string }>('POST', `${o(orgId)}/compliance/documents`, body),
};
