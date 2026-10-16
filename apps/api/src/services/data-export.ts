import { crc32, deflateRawSync } from 'node:zlib';
import { and, desc, eq, getTableColumns, isNull, lt } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Services } from '../context.ts';
import * as schema from '../db/schema/index.ts';
import { dataExports, organizations, roleAssignments, users } from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { audit } from './audit.ts';
import { ownerEmails } from './billing.ts';
import { sendBillingEmails } from './billing-emails.ts';

/**
 * Free data export (Settings → Export your data, owner only). A background job writes one CSV per core table, scoped
 * to the organisation, into a ZIP. The owner gets an email with a download link that works for 7 days; the export is
 * also listed in Settings while it is valid. Secrets (password hashes, tokens, encrypted credentials) are never
 * exported. Bytes go to object storage when S3/R2 is configured, otherwise into Postgres.
 */

export const EXPORT_TTL_DAYS = 7;
const DAY = 86_400_000;

/** File name → table. Only rows of the organisation are exported (tables without an organisation column are skipped). */
const EXPORT_TABLES: [string, PgTable][] = [
  ['locations', schema.locations], ['regions', schema.regions], ['owner_groups', schema.ownerGroups],
  ['customers', schema.customers], ['consent_records', schema.consentRecords], ['leads', schema.leads], ['sales_deals', schema.salesDeals],
  ['class_bookings', schema.classBookings], ['appointments', schema.appointments], ['registrations', schema.registrations], ['memberships', schema.memberships],
  ['orders', schema.orders], ['food_orders', schema.foodOrders], ['hospitality_reservations', schema.hospReservations],
  ['products', schema.products], ['services', schema.services], ['form_submissions', schema.formSubmissions],
  ['payments', schema.paymentReferences], ['refunds', schema.refunds], ['invoices', schema.financeInvoices], ['royalty_statements', schema.royaltyStatements],
  ['franchise_prospects', schema.franchiseProspects], ['franchise_agreements', schema.franchiseAgreements],
  ['realty_listings', schema.realtyListings], ['realty_enquiries', schema.realtyEnquiries],
  ['branchharbor_invoices', schema.billingInvoices],
];

/** Columns never exported. */
const SECRET = /(password|secret|token|hash|encrypted|credential|api_?key)/i;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Guard against spreadsheet formula injection, then quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/** Minimal ZIP writer (deflate), enough for a handful of CSV files. */
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(f.data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

/** Builds the CSV files for an organisation. */
export async function buildExportFiles(s: Services, orgId: string): Promise<{ name: string; data: Buffer; rows: number }[]> {
  const out: { name: string; data: Buffer; rows: number }[] = [];
  const add = (name: string, rows: Record<string, unknown>[], columns?: string[]) => out.push({ name: `${name}.csv`, data: Buffer.from(toCsv(rows, columns), 'utf8'), rows: rows.length });
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw notFound('Organisation');
  const orgCols = Object.keys(org).filter((k) => !SECRET.test(k));
  add('organization', [org as unknown as Record<string, unknown>], orgCols);
  // People: team members with their roles and scopes (never password hashes).
  const people = await s.db.select({ userId: users.id, name: users.name, email: users.email, role: roleAssignments.role, scopeKind: roleAssignments.scopeKind, scopeId: roleAssignments.scopeId, since: roleAssignments.createdAt })
    .from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).where(eq(roleAssignments.organizationId, orgId));
  add('people', people, ['userId', 'name', 'email', 'role', 'scopeKind', 'scopeId', 'since']);
  for (const [name, table] of EXPORT_TABLES) {
    const cols = getTableColumns(table) as Record<string, { name: string }>;
    const orgCol = (cols as Record<string, unknown>).organizationId;
    if (!orgCol) continue;
    const keep = Object.entries(cols).filter(([k, c]) => !SECRET.test(k) && !SECRET.test(c.name)).map(([k]) => k);
    const rows = (await s.db.select().from(table as never).where(eq(orgCol as never, orgId))) as Record<string, unknown>[];
    add(name, rows, keep);
  }
  return out;
}

const README = (orgName: string, files: { name: string; rows: number }[]) => [
  `BranchHarbor data export for ${orgName}`,
  `Created ${new Date().toISOString()}`,
  '',
  'One CSV file per table (UTF-8, comma-separated, first row = column names). Money amounts are integers in minor',
  'units (e.g. cents) with their currency in the same row. Timestamps are ISO 8601 in UTC.',
  '',
  ...files.map((f) => `${f.name}: ${f.rows} rows`),
  '',
].join('\r\n');

export async function requestExport(s: Services, orgId: string, actor: { userId: string; ip?: string | null }) {
  const running = await s.db.select({ id: dataExports.id }).from(dataExports).where(and(eq(dataExports.organizationId, orgId), eq(dataExports.status, 'running')));
  if (running.length) throw new AppError(409, 'export_running', 'An export is already being prepared. You will get an email when it is ready.');
  const [row] = await s.db.insert(dataExports).values({ organizationId: orgId, requestedBy: actor.userId, status: 'queued' }).returning();
  await audit(s.db, { organizationId: orgId, actorUserId: actor.userId, ip: actor.ip ?? null, action: 'data_export.requested', scopeKind: 'organization', scopeId: orgId, targetType: 'data_export', targetId: row!.id });
  await s.jobs.enqueue('data-export.build', { exportId: row!.id });
  return row!;
}

/** Background job: builds the ZIP, stores it, emails the download link. */
export async function buildExport(s: Services, exportId: string): Promise<void> {
  const [ex] = await s.db.select().from(dataExports).where(eq(dataExports.id, exportId));
  if (!ex || ex.status === 'ready') return;
  await s.db.update(dataExports).set({ status: 'running' }).where(eq(dataExports.id, ex.id));
  try {
    const [org] = await s.db.select({ name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, ex.organizationId));
    const files = await buildExportFiles(s, ex.organizationId);
    const bytes = zip([{ name: 'README.txt', data: Buffer.from(README(org?.name ?? '', files), 'utf8') }, ...files]);
    const fileName = `branchharbor-${org?.slug ?? 'export'}-${new Date().toISOString().slice(0, 10)}.zip`;
    const token = randomToken(24);
    const key = `exports/${ex.organizationId}/${ex.id}.zip`;
    let storageKey: string | null = null;
    if (s.assets.mode === 's3') {
      await s.assets.put(key, bytes, 'application/zip');
      storageKey = key;
    }
    const expiresAt = new Date(Date.now() + EXPORT_TTL_DAYS * DAY);
    await s.db.update(dataExports).set({
      status: 'ready', fileName, sizeBytes: bytes.length, files: files.map((f) => ({ name: f.name, rows: f.rows })), tokenHash: sha256(token), storageKey, content: storageKey ? null : bytes,
      expiresAt, completedAt: new Date(), error: null,
    }).where(eq(dataExports.id, ex.id));
    const link = `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/exports/${ex.id}/download?token=${token}`;
    const [requester] = await s.db.select({ email: users.email, name: users.name, locale: users.locale }).from(users).where(eq(users.id, ex.requestedBy));
    const to = requester ? [requester] : await ownerEmails(s.db, ex.organizationId);
    await sendBillingEmails(s, to, 'data-export', { kind: 'export_ready', business: org?.name ?? 'BranchHarbor', files: files.length, sizeKb: Math.ceil(bytes.length / 1024), expiresOn: expiresAt, link });
    await audit(s.db, { organizationId: ex.organizationId, actorUserId: null, actorType: 'system', action: 'data_export.ready', scopeKind: 'organization', scopeId: ex.organizationId, targetType: 'data_export', targetId: ex.id, metadata: { files: files.length, bytes: bytes.length } });
  } catch (err) {
    s.log.error({ err, exportId }, '[export] failed');
    await s.db.update(dataExports).set({ status: 'failed', error: (err as Error).message.slice(0, 500), completedAt: new Date() }).where(eq(dataExports.id, ex.id));
  }
}

export function serializeExport(e: typeof dataExports.$inferSelect, now = Date.now()) {
  const expired = !!e.expiresAt && e.expiresAt.getTime() <= now;
  return {
    id: e.id, status: expired && e.status === 'ready' ? 'expired' : e.status, fileName: e.fileName, sizeBytes: e.sizeBytes, files: e.files,
    expiresAt: e.expiresAt?.toISOString() ?? null, completedAt: e.completedAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString(), error: e.status === 'failed' ? 'The export failed. Try again.' : null,
  };
}

export async function listExports(s: Services, orgId: string) {
  const rows = await s.db.select().from(dataExports).where(eq(dataExports.organizationId, orgId)).orderBy(desc(dataExports.createdAt)).limit(10);
  return rows.map((r) => serializeExport(r));
}

/** Bytes of a ready, unexpired export; checks the emailed token or the caller's org membership (done by the route). */
export async function exportBytes(s: Services, exportId: string, check: { token?: string; orgId?: string }): Promise<{ fileName: string; bytes: Buffer }> {
  const [e] = await s.db.select().from(dataExports).where(eq(dataExports.id, exportId));
  if (!e || e.status !== 'ready') throw notFound('Export');
  if (check.orgId && e.organizationId !== check.orgId) throw notFound('Export');
  if (!check.orgId && (!check.token || !e.tokenHash || sha256(check.token) !== e.tokenHash)) throw notFound('Export');
  if (!e.expiresAt || e.expiresAt.getTime() <= Date.now()) throw new AppError(410, 'export_expired', 'This download link has expired. Request a new export from Settings.');
  const bytes = e.storageKey ? await s.assets.get(e.storageKey) : e.content;
  if (!bytes) throw notFound('Export file');
  return { fileName: e.fileName ?? 'branchharbor-export.zip', bytes: Buffer.from(bytes) };
}

/** Deletes expired export files (keeps the row for the history). */
export async function purgeExpiredExports(s: Services) {
  const rows = await s.db.select().from(dataExports).where(and(eq(dataExports.status, 'ready'), lt(dataExports.expiresAt, new Date()), isNull(dataExports.error)));
  for (const r of rows) {
    if (r.storageKey) await s.assets.remove(r.storageKey).catch(() => undefined);
    await s.db.update(dataExports).set({ content: null, storageKey: null, error: 'expired' }).where(eq(dataExports.id, r.id));
  }
}
