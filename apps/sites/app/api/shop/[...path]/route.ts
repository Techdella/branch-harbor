import { type NextRequest } from 'next/server';
import { API_URL } from '@/lib/config';

/**
 * Same-origin proxy for the storefront: public commerce routes, sandbox payment confirmation, customer sign-in and the
 * signed-in customer's own orders (/me/commerce). The customer's bearer token and the checkout Idempotency-Key are
 * forwarded; nothing else from the business API is reachable through here.
 */
const ALLOWED = [/^public\/commerce\//, /^public\/payments\/[0-9a-f-]{36}\/sandbox-confirm$/, /^auth\/login$/, /^me\/commerce(\/|$)/];

async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const joined = path.map(encodeURIComponent).join('/');
  if (path.some((p) => p === '..' || p.includes('/')) || !ALLOWED.some((r) => r.test(path.join('/')))) {
    return Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
  }
  const headers: Record<string, string> = { accept: 'application/json', 'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '127.0.0.1' };
  for (const h of ['content-type', 'authorization', 'idempotency-key']) { const v = req.headers.get(h); if (v) headers[h] = v; }
  // Sign-in from the storefront: the token comes back in the body (no API cookies on the shop's domain).
  if (path.join('/') === 'auth/login') headers['x-bh-client'] = 'mobile';
  try {
    const res = await fetch(`${API_URL}/v1/${joined}${req.nextUrl.search}`, { method: req.method, headers, body: req.method === 'GET' ? undefined : await req.text(), cache: 'no-store', signal: AbortSignal.timeout(15000) });
    let text = await res.text();
    if (path.join('/') === 'auth/login' && res.ok) {
      // Only the short-lived access token is passed to the browser; the refresh token stays out of page storage.
      const j = JSON.parse(text) as { accessToken?: string; user?: { name?: string; email?: string } };
      text = JSON.stringify({ accessToken: j.accessToken, user: j.user ? { name: j.user.name, email: j.user.email } : null });
    }
    return new Response(text, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ error: { code: 'api_unreachable', message: 'The service is unreachable. Please try again.' } }, { status: 503 });
  }
}

export const GET = forward;
export const POST = forward;
