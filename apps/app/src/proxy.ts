import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic auth guard (Next 16 Proxy). With the live API (NEXT_PUBLIC_USE_MOCKS=false), app routes need a
 * session: the client sets a non-secret `bh_session` marker cookie on this origin when it holds a session
 * (the real refresh token is an httpOnly cookie on the API origin, which this server can't read).
 * No marker → redirect to /sign-in?next=… before rendering. The client-side guard in AppContext covers
 * expired or revoked sessions, and the API enforces every permission regardless.
 *
 * Sample mode (the default) is unaffected.
 */
const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS !== 'false';

export function proxy(request: NextRequest) {
  if (USE_MOCKS) return NextResponse.next();
  if (request.cookies.get('bh_session')?.value === '1') return NextResponse.next();
  const url = request.nextUrl.clone();
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.pathname = '/sign-in';
  url.search = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  return NextResponse.redirect(url);
}

export const config = {
  // App routes only: auth pages, Next internals and static files are never guarded.
  matcher: ['/', '/overview/:path*', '/locations/:path*', '/ops/:path*', '/customers/:path*', '/marketing/:path*', '/websites/:path*', '/payments/:path*', '/team/:path*', '/reports/:path*', '/connections/:path*', '/settings/:path*', '/community/:path*', '/onboarding/:path*'],
};
