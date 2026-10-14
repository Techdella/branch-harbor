import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/** Locale detection and prefixing (Accept-Language, NEXT_LOCALE cookie). */
export default createMiddleware(routing);

export const config = {
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
