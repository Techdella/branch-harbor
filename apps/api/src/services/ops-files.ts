import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import { opsFiles } from '../db/schema/index.ts';
import { randomToken } from '../lib/crypto.ts';
import { validationError } from '../lib/errors.ts';

/**
 * Private files for audits and compliance (photos, corrective-action evidence, certificates). Bytes go through the
 * asset storage service (`s.assets`: S3 / R2 when configured, Postgres otherwise). They are never public: clients
 * get short-lived signed links, issued only after the record holding the file was checked against the viewer's scope.
 */

export type FilePurpose = 'audit_photo' | 'corrective_evidence' | 'compliance_document';
export type OpsFile = typeof opsFiles.$inferSelect;

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const DOCUMENT_TYPES = [...PHOTO_TYPES, 'application/pdf'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const LINK_TTL_SECONDS = 3600;

export interface UploadInput { filename: string; contentType: string; dataBase64: string }

export async function storeFile(
  s: Services,
  db: Exec,
  f: { organizationId: string; locationId?: string | null; ownerGroupId?: string | null; purpose: FilePurpose; upload: UploadInput; uploadedBy: string | null },
): Promise<OpsFile> {
  const mime = f.upload.contentType.split(';')[0]!.trim().toLowerCase();
  const allowed = f.purpose === 'compliance_document' ? DOCUMENT_TYPES : PHOTO_TYPES;
  if (!allowed.includes(mime)) throw validationError(f.purpose === 'compliance_document' ? 'Upload a PDF or a photo' : 'Upload a photo (JPEG, PNG, WebP or HEIC)', { file: 'Unsupported type' });
  const body = Buffer.from(f.upload.dataBase64, 'base64');
  if (!body.length) throw validationError('The file is empty', { file: 'Empty' });
  if (body.length > MAX_FILE_BYTES) throw validationError('The file is larger than 10 MB', { file: 'Max 10 MB' });
  const ext = mime === 'application/pdf' ? 'pdf' : mime.split('/')[1]!.replace('jpeg', 'jpg');
  const name = f.upload.filename.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 120) || `file.${ext}`;
  const key = `${f.organizationId}/private/${f.purpose}/${randomToken(12)}.${ext}`;
  if (s.assets.mode === 's3') await s.assets.put(key, body, mime);
  const [row] = await db.insert(opsFiles).values({
    organizationId: f.organizationId, locationId: f.locationId ?? null, ownerGroupId: f.ownerGroupId ?? null, purpose: f.purpose, name, mime, size: body.length,
    sha256: createHash('sha256').update(body).digest('hex'), storage: s.assets.mode, storageKey: key, data: s.assets.mode === 'db' ? body : null, uploadedBy: f.uploadedBy,
  }).returning();
  return row!;
}

export async function readFileBytes(s: Services, f: OpsFile): Promise<Buffer | null> {
  if (f.storage === 'db') {
    const [r] = await s.db.select({ data: opsFiles.data }).from(opsFiles).where(eq(opsFiles.id, f.id));
    return r?.data ?? null;
  }
  return s.assets.get(f.storageKey);
}

/** Files of an organisation by id (metadata only, never the bytes). */
export async function filesById(db: Exec, organizationId: string, ids: string[]): Promise<Map<string, OpsFile>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const rows = await db.select({
    id: opsFiles.id, organizationId: opsFiles.organizationId, locationId: opsFiles.locationId, ownerGroupId: opsFiles.ownerGroupId, purpose: opsFiles.purpose, name: opsFiles.name,
    mime: opsFiles.mime, size: opsFiles.size, sha256: opsFiles.sha256, storage: opsFiles.storage, storageKey: opsFiles.storageKey, uploadedBy: opsFiles.uploadedBy, createdAt: opsFiles.createdAt,
  }).from(opsFiles).where(and(eq(opsFiles.organizationId, organizationId), inArray(opsFiles.id, uniq)));
  return new Map(rows.map((r) => [r.id, { ...r, data: null }]));
}

const sign = (secret: string, id: string, exp: number) => createHmac('sha256', secret).update(`ops-file:${id}:${exp}`).digest('base64url');

/** A signed, expiring link to a private file (the caller has already checked access to the record). */
export function signedFileUrl(s: Services, fileId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  return `${s.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/files/${fileId}?exp=${exp}&sig=${sign(s.cfg.JWT_SECRET, fileId, exp)}`;
}

export function verifyFileSignature(s: Services, fileId: string, exp: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const want = Buffer.from(sign(s.cfg.JWT_SECRET, fileId, exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function fileView(s: Services, f: Pick<OpsFile, 'id' | 'name' | 'mime' | 'size' | 'createdAt'>) {
  return { id: f.id, name: f.name, mime: f.mime, size: f.size, url: signedFileUrl(s, f.id), createdAt: f.createdAt.toISOString() };
}
