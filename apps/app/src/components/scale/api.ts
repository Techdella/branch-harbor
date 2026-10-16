'use client';

/**
 * Network data platform (`/v1/orgs/:orgId/sales-connectors|imports|launches|benchmarks`): POS and booking sales
 * connectors with each location's gross-sales source and the reconciliation; the import wizard; bulk location launch;
 * opt-in network benchmarks. Live API only; money is integer minor units with its currency, never combined.
 */
import type { BenchmarkMetric, ImportEntity, SalesConnectorProvider, SalesSourceKind } from '@bh/shared';
import { http, type Query } from '@/lib/http/client';
import { orgId } from '@/lib/http/workspace';

export { downloadCsv, readUpload, useQuality as useScale, useQualityAction as useScaleAction, type Upload } from '../quality/api';

export interface CatalogEntry { provider: SalesConnectorProvider; name: string; flow: 'oauth' | 'partner_grant' | 'activation_link'; industries: string[]; configFields: string[]; mode: 'live' | 'sandbox' }
export interface ConnectionVM {
  id: string; locationId: string; provider: SalesConnectorProvider; name: string; flow: CatalogEntry['flow']; status: 'pending_authorisation' | 'connected' | 'error' | 'authorization_expired' | 'disconnected';
  mode: 'sandbox' | 'live'; config: Record<string, unknown>; activationUrl: string | null; externalAccountName: string | null; lastSyncAt: string | null; lastSyncStatus: string | null; lastError: string | null; createdAt: string;
}
export interface SourceVM { locationId: string; source: SalesSourceKind; explicit: boolean; connectionId: string | null; varianceThresholdBps: number; note: string | null; updatedAt: string | null }
export interface ConnectorLocationVM {
  id: string; name: string; code: string; currency: string; timeZone: string; status: string; paymentsEnabled: boolean; ownerGroupName: string | null;
  source: SourceVM; connections: ConnectionVM[]; can: { edit: boolean; publish: boolean };
}
export interface ConnectorsVM { catalog: CatalogEntry[]; locations: ConnectorLocationVM[]; can: { edit: boolean; publish: boolean; export: boolean } }
export interface RunVM { id: string; trigger: string; status: string; fromDate: string; toDate: string; daysWritten: number; daysUnchanged: number; ordersSeen: number; sandbox: boolean; error: string | null; finishedAt: string | null; createdAt: string }
export interface Variance { diffMinor: number; pct: number | null; flagged: boolean }
export interface ReconRow {
  location: { id: string; name: string; code: string; currency: string; ownerGroupName: string | null };
  source: SourceVM;
  branchharbor: { grossMinor: number; refundsMinor: number; taxMinor: number; tipsMinor: number; netMinor: number; payments: number };
  connectors: Array<{ connectionId: string; provider: string; status: string; mode: string; grossMinor: number; refundsMinor: number; taxMinor: number; tipsMinor: number; netMinor: number; orders: number; daysSynced: number; missingDays: number; sandbox: boolean; foreign: Record<string, number>; lastSyncAt: string | null }>;
  selfReported: Array<{ id: string; periodStart: string; periodEnd: string; status: string; currency: string; grossMinor: number; refundsMinor: number; taxMinor: number; comparison: { provider: string; observedMinor: number; reportedMinor: number; variance: Variance; sandbox: boolean } | null }>;
  flags: string[];
}
export interface ReconVM { from: string; to: string; frequency: string; rows: ReconRow[]; can: { export: boolean } }

export interface ImportFieldVM { key: string; type: string; required: boolean; values: string[] | null }
export interface ImportCatalogVM { industry: string; entities: Array<{ key: ImportEntity; fields: ImportFieldVM[]; allowed: boolean; orgWide: boolean }>; templates: Array<{ key: string; vendor: string; entity: ImportEntity; columns: string[] }>; roles: string[] }
export interface RowErrorVM { row: number; field: string; code: string; message: string }
export interface BatchVM {
  id: string; entity: ImportEntity; templateKey: string | null; filename: string; format: 'csv' | 'xlsx'; status: 'uploaded' | 'validated' | 'queued' | 'running' | 'completed' | 'failed' | 'rolled_back'; dryRun: boolean;
  headers: string[]; mapping: Record<string, number | null>; options: Record<string, unknown>; totalRows: number; validRows: number; errorRows: number; processedRows: number;
  createdCount: number; updatedCount: number; skippedCount: number; progressPct: number; errors: RowErrorVM[]; error: string | null; canUndo: boolean; undoUntil: string | null; finishedAt: string | null; createdAt: string; sample?: string[][];
}
export interface PreviewVM {
  batch: BatchVM; counts: { total: number; valid: number; invalid: number; create: number; update: number; skip: number };
  preview: Array<{ row: number; action: 'create' | 'update' | 'skip' | 'error'; summary: string; errors: RowErrorVM[]; data: Record<string, unknown> }>;
  roles: Array<{ title: string; role: string }>;
}

export interface LaunchRowVM { name: string; code: string; address_line1: string; city: string; country: string; time_zone: string; currency: string; [k: string]: string | null | undefined }
export interface LaunchStepVM { status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; detail?: string | null; at?: string | null }
export interface LaunchVM {
  id: string; name: string; templateId: string | null; siteMode: 'publish' | 'draft'; locationStatus: string; inviteStaff: boolean; status: 'queued' | 'running' | 'completed' | 'completed_with_errors';
  total: number; done: number; failed: number; progressPct: number; startedAt: string | null; finishedAt: string | null; createdAt: string;
  items?: Array<{ id: string; row: number; name: string; code: string; status: 'queued' | 'running' | 'done' | 'failed'; steps: Record<string, LaunchStepVM>; locationId: string | null; pageId: string | null; invitations: number; error: string | null }>;
}

export interface BenchmarkMetricVM {
  metric: BenchmarkMetric; currency: string | null; you: number | null; locations: number; percentile: number | null; status: 'ok' | 'cohort_too_small' | 'no_data';
  cohort: { scope: 'region' | 'industry'; size: number; p10: number; p25: number; p50: number; p75: number; p90: number } | null;
}
export interface BenchmarksVM { period: string; industry: string; region: string; minCohort: number; optedIn: boolean; settings: { optIn: boolean; optedInAt: string | null }; metrics: BenchmarkMetricVM[]; can: { manage: boolean } }

const o = (p: string) => `/orgs/${orgId()}${p}`;

export const scaleApi = {
  connectors: () => http.get<ConnectorsVM>(o('/sales-connectors')),
  connect: (body: { locationId: string; provider: SalesConnectorProvider; config: Record<string, unknown> }) => http.post<{ connection: ConnectionVM; authorizeUrl: string | null; activationUrl: string | null }>(o('/sales-connectors'), body),
  connection: (id: string) => http.get<{ connection: ConnectionVM; runs: RunVM[] }>(o(`/sales-connectors/${id}`)),
  reconnect: (id: string) => http.post<{ connection: ConnectionVM; authorizeUrl: string | null; activationUrl: string | null }>(o(`/sales-connectors/${id}/reconnect`)),
  externalLocations: (id: string) => http.get<{ items: Array<{ id: string; name: string }>; sandbox: boolean; error?: string }>(o(`/sales-connectors/${id}/external-locations`)),
  configure: (id: string, config: Record<string, unknown>) => http.patch<ConnectionVM>(o(`/sales-connectors/${id}`), { config }),
  sync: (id: string, body: { from?: string; to?: string } = {}) => http.post<RunVM>(o(`/sales-connectors/${id}/sync`), body),
  disconnect: (id: string) => http.del<ConnectionVM>(o(`/sales-connectors/${id}`)),
  setSource: (locationId: string, body: { source: SalesSourceKind; connectionId?: string | null; varianceThresholdBps?: number }) => http.put<SourceVM & { openStatements: number }>(o(`/sales-connectors/sources/${locationId}`), body),
  reconciliation: (q: Query) => http.get<ReconVM>(o('/sales-connectors/reconciliation'), q),

  importCatalog: () => http.get<ImportCatalogVM>(o('/imports/catalog')),
  imports: () => http.get<{ items: BatchVM[] }>(o('/imports')),
  batch: (id: string) => http.get<BatchVM>(o(`/imports/${id}`)),
  upload: (body: { entity: ImportEntity; filename: string; dataBase64: string; templateKey?: string | null }) => http.post<BatchVM>(o('/imports'), body),
  mapping: (id: string, mapping: Record<string, number | null>, options: Record<string, unknown>) => http.put<PreviewVM>(o(`/imports/${id}/mapping`), { mapping, options }),
  run: (id: string, dryRun: boolean) => http.post<BatchVM>(o(`/imports/${id}/run`), { dryRun }),
  rollback: (id: string) => http.post<BatchVM & { undone: number }>(o(`/imports/${id}/rollback`)),

  launches: () => http.get<{ items: LaunchVM[]; templates: Array<{ id: string; name: string }>; can: { edit: boolean; publish: boolean } }>(o('/launches')),
  launch: (id: string) => http.get<LaunchVM>(o(`/launches/${id}`)),
  parseLaunch: (body: { filename: string; dataBase64: string }) => http.post<{ rows: LaunchRowVM[]; errors: Array<{ row: number; errors: Array<{ field: string; message: string }> }>; valid: number }>(o('/launches/parse'), body),
  startLaunch: (body: { name: string; templateId: string | null; siteMode: 'publish' | 'draft'; locationStatus: string; inviteStaff: boolean; rows: LaunchRowVM[] }) => http.post<LaunchVM>(o('/launches'), body),
  retryLaunch: (id: string) => http.post<{ retried: number }>(o(`/launches/${id}/retry`)),

  benchmarks: (period?: string) => http.get<BenchmarksVM>(o('/benchmarks'), period ? { period } : {}),
  setBenchmarks: (optIn: boolean) => http.put<{ optIn: boolean }>(o('/benchmarks/settings'), { optIn }),
};
