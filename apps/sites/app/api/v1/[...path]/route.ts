import { type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';

/**
 * Same-origin proxy for the customer-facing public API, so browser calls work on every custom domain
 * without CORS. Only /v1/public/* is forwarded; nothing authenticated passes through here.
 */
async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (path[0] !== 'public' || path.some((p) => p === '..' || p.includes('/'))) {
    return Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
  }
  const target = `${API_URL}/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  const ct = req.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  // Forward one visitor IP so per-visitor rate limits keep working. Take it from the right of the
  // chain (entries appended by our own load balancers), never the client-controlled left side.
  headers['x-forwarded-for'] = clientIp(req.headers.get('x-forwarded-for'));
  try {
    const res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    return new Response(await res.text(), { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: { code: 'api_unreachable', message: 'The service is unreachable. Please try again.' } }, { status: 503 });
  }
}

/** Number of trusted proxies in front of this app (default 1: one load balancer). */
const TRUSTED_HOPS = Math.max(1, Number(process.env.SITES_TRUSTED_PROXY_HOPS ?? '1') || 1);

function clientIp(chain: string | null): string {
  const hops = (chain ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - TRUSTED_HOPS] ?? hops[0] ?? '127.0.0.1';
}

export const GET = forward;
export const POST = forward;
