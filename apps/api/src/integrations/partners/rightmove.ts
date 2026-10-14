/**
 * Rightmove Real Time Datafeed (RTDF v1.4.1) client.
 *  - POST {base}/v1/property/sendpropertydetails   (add/update; Agent_Ref identifies the listing)
 *  - POST {base}/v1/property/removeproperty        (archive on Rightmove)
 *  - POST {base}/v1/property/getbranchpropertylist (reconciliation; used as the connection test)
 * Authentication is mutual TLS with the client certificate Rightmove issues to the feed provider (PKCS#12 here).
 * Production base: https://adfapi.rightmove.co.uk — Rightmove issues separate test URLs for the beta phase.
 * Responses carry { success, message, errors[], warnings[], property: { rightmove_id, rightmove_url, change_type } }.
 */
import { request } from 'node:https';
import { PartnerHttpError, requestJson, type FetchLike } from './http.ts';

export const RIGHTMOVE_PRODUCTION_URL = 'https://adfapi.rightmove.co.uk';

/** A fetch-compatible transport presenting the Rightmove client certificate. */
export function mtlsFetch(pfxBase64: string, passphrase?: string): FetchLike {
  const pfx = Buffer.from(pfxBase64, 'base64');
  return (url, init = {}) => new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers, pfx, passphrase, minVersion: 'TLSv1.2', signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
      });
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

export interface RightmoveResult { ok: boolean; rightmoveId: string | null; url: string | null; changeType: string | null; warnings: string[]; errors: string[]; message: string | null }

function result(d: Record<string, unknown>): RightmoveResult {
  const prop = (d.property ?? {}) as Record<string, unknown>;
  const list = (x: unknown, code: string, desc: string) => (Array.isArray(x) ? (x as Array<Record<string, unknown>>).map((e) => `${e[code] ?? ''} ${e[desc] ?? ''}`.trim()) : []);
  return {
    ok: d.success === true || d.success === 'true', rightmoveId: prop.rightmove_id != null ? String(prop.rightmove_id) : null, url: (prop.rightmove_url as string) ?? null,
    changeType: (prop.change_type as string) ?? null, warnings: list(d.warnings, 'warning_code', 'warning_description'), errors: list(d.errors, 'error_code', 'error_description'),
    message: (d.message as string) ?? null,
  };
}

export function createRightmoveClient(opts: { fetch: FetchLike; baseUrl?: string }) {
  const base = (opts.baseUrl || RIGHTMOVE_PRODUCTION_URL).replace(/\/$/, '');
  const post = async (path: string, body: unknown) => {
    try {
      return result((await requestJson('Rightmove', opts.fetch, `${base}${path}`, { body, timeoutMs: 30_000 })).data);
    } catch (err) {
      // RTDF returns 4xx with a JSON body describing the errors; surface them.
      if (err instanceof PartnerHttpError && err.body && typeof err.body === 'object') {
        const r = result(err.body as Record<string, unknown>);
        if (r.errors.length) return { ...r, ok: false };
      }
      throw err;
    }
  };
  return {
    base,
    sendProperty: (body: unknown) => post('/v1/property/sendpropertydetails', body),
    removeProperty: (body: unknown) => post('/v1/property/removeproperty', body),
    branchPropertyList: (networkId: number, branchId: number) => post('/v1/property/getbranchpropertylist', { network: { network_id: networkId }, branch: { branch_id: branchId } }),
  };
}
