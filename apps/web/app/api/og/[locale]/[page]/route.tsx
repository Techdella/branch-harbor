import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { marinaFigureSvg } from '@bh/icons';
import { hasLocale } from 'next-intl';
import { routing } from '@/i18n/routing';
import { PAGE_IDS, isPageId, pageCopy } from '@/lib/seo';

/**
 * OpenGraph / Twitter card image per page and locale (1200×630), prerendered at build time.
 *
 * Arabic cards use the English copy: the image renderer (Satori) does not shape Arabic script, so
 * Arabic text would render as disconnected letters. The brand mark and layout are the same.
 */
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) => PAGE_IDS.map((page) => ({ locale, page })));
}

const SIZE = { width: 1200, height: 630 };
const fontDir = path.join(process.cwd(), 'assets', 'fonts');
/** Marina waving from the harbour, on the /marina card (the renderer draws SVG images from data URIs). */
const MARINA_FIGURE = `data:image/svg+xml;base64,${Buffer.from(marinaFigureSvg('happy', 'wave')).toString('base64')}`;

export async function GET(_req: Request, { params }: { params: Promise<{ locale: string; page: string }> }) {
  const { locale, page } = await params;
  if (!hasLocale(routing.locales, locale) || !isPageId(page)) return new Response('Not found', { status: 404 });

  const copyLocale = locale === 'ar' ? 'en' : locale;
  const [copy, bold, semi] = await Promise.all([
    pageCopy(copyLocale, page),
    readFile(path.join(fontDir, 'PlusJakartaSans_800ExtraBold.ttf')),
    readFile(path.join(fontDir, 'PlusJakartaSans_600SemiBold.ttf')),
  ]);
  const headline = copy.headline.length > 90 ? `${copy.headline.slice(0, 88).trimEnd()}…` : copy.headline;
  const kicker = page === 'home' ? copy.description.split(/[.;]/)[0] : copy.title;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: '#F3F2EE', padding: 36, fontFamily: 'Jakarta' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#FFFFFF', borderRadius: 40, padding: '56px 64px', position: 'relative' }}>
          {page === 'marina' && (
            <img src={MARINA_FIGURE} alt="" width={400} height={317} style={{ position: 'absolute', right: 40, bottom: 0 }} />
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <svg width="64" height="64" viewBox="0 0 40 40">
              <rect width="40" height="40" rx="12" fill="#141414" />
              <path d="M11 11v18M29 11v18M11 20h18" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" fill="none" />
              <path d="M20 20 20 11" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" opacity="0.35" />
              <circle cx="20" cy="20" r="4.2" fill="#D6F26B" />
            </svg>
            <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-0.04em', color: '#141414' }}>BranchHarbor</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div style={{ display: 'flex' }}>
              <div style={{ fontSize: 26, fontWeight: 600, color: '#141414', border: '2px solid #E2E1DC', borderRadius: 999, padding: '8px 22px', maxWidth: 900 }}>{kicker}</div>
            </div>
            <div style={{ fontSize: headline.length > 55 ? 60 : 76, fontWeight: 800, lineHeight: 1.04, letterSpacing: '-0.045em', color: '#141414', maxWidth: page === 'marina' ? 640 : 1000 }}>{headline}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 24, fontWeight: 600, color: '#6B6B66' }}>branchharbor.com</div>
            {page !== 'marina' && <div style={{ width: 56, height: 56, borderRadius: 999, background: '#D6F26B' }} />}
          </div>
        </div>
      </div>
    ),
    {
      ...SIZE,
      fonts: [
        { name: 'Jakarta', data: bold, weight: 800, style: 'normal' },
        { name: 'Jakarta', data: semi, weight: 600, style: 'normal' },
      ],
      headers: { 'Cache-Control': 'public, max-age=86400, immutable' },
    },
  );
}
