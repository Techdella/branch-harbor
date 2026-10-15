import { createHash, createHmac } from 'node:crypto';
import type { Config } from '../config.ts';

/**
 * Object storage for the brand asset library. S3 / Cloudflare R2 when S3_* is configured (SigV4 PUT/DELETE, public
 * URL from S3_PUBLIC_URL); otherwise bytes are kept in Postgres (`asset_blobs`) and served by the API — the sandbox
 * mode, fine for development and small libraries.
 */
export interface AssetStore {
  readonly mode: 's3' | 'db';
  put(key: string, body: Buffer, contentType: string): Promise<{ url: string | null }>;
  remove(key: string): Promise<void>;
  /** Read an object back (used when no public bucket URL is configured). */
  get(key: string): Promise<Buffer | null>;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, v: string) => createHmac('sha256', k).update(v).digest();

function sign(cfg: Config, method: string, url: URL, body: Buffer, contentType?: string) {
  const region = cfg.S3_REGION || 'auto';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha(body);
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...(contentType ? { 'content-type': contentType } : {}) };
  const signed = Object.keys(headers).sort();
  const canonical = [method, url.pathname, url.searchParams.toString(), signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${cfg.S3_SECRET_ACCESS_KEY}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` };
}

export function createAssetStore(cfg: Config, fetchImpl: typeof fetch = fetch): AssetStore {
  const configured = !!(cfg.S3_BUCKET && cfg.S3_ACCESS_KEY_ID && cfg.S3_SECRET_ACCESS_KEY && (cfg.S3_ENDPOINT || cfg.S3_REGION !== 'auto'));
  if (!configured) {
    return { mode: 'db', async put() { return { url: null }; }, async remove() {}, async get() { return null; } };
  }
  const endpoint = (cfg.S3_ENDPOINT ?? `https://s3.${cfg.S3_REGION}.amazonaws.com`).replace(/\/$/, '');
  const objectUrl = (key: string) => new URL(`${endpoint}/${cfg.S3_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`);
  return {
    mode: 's3',
    async put(key, body, contentType) {
      const url = objectUrl(key);
      const res = await fetchImpl(url, { method: 'PUT', headers: sign(cfg, 'PUT', url, body, contentType), body: new Uint8Array(body) });
      if (!res.ok) throw new Error(`Object storage upload failed (${res.status})`);
      return { url: cfg.S3_PUBLIC_URL ? `${cfg.S3_PUBLIC_URL.replace(/\/$/, '')}/${key}` : null };
    },
    async remove(key) {
      const url = objectUrl(key);
      await fetchImpl(url, { method: 'DELETE', headers: sign(cfg, 'DELETE', url, Buffer.alloc(0)) }).catch(() => undefined);
    },
    async get(key) {
      const url = objectUrl(key);
      const res = await fetchImpl(url, { method: 'GET', headers: sign(cfg, 'GET', url, Buffer.alloc(0)) });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    },
  };
}
