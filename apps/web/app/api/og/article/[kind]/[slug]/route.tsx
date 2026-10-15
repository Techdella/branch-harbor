import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import { ARTICLE_KINDS, getArticle, getArticles, type ArticleKind } from '@/lib/articles';
import { INDUSTRIES } from '@/content/industries';

/** OpenGraph / Twitter card per blog post and guide (1200×630), prerendered at build time. Articles are English. */
export const dynamic = 'force-static';
export const dynamicParams = false;

export function generateStaticParams() {
  return ARTICLE_KINDS.flatMap((kind) => getArticles(kind).map((a) => ({ kind, slug: a.slug })));
}

const fontDir = path.join(process.cwd(), 'assets', 'fonts');

export async function GET(_req: Request, { params }: { params: Promise<{ kind: string; slug: string }> }) {
  const { kind, slug } = await params;
  const a = (ARTICLE_KINDS as readonly string[]).includes(kind) ? getArticle(kind as ArticleKind, slug) : null;
  if (!a) return new Response('Not found', { status: 404 });
  const [bold, semi] = await Promise.all([
    readFile(path.join(fontDir, 'PlusJakartaSans_800ExtraBold.ttf')),
    readFile(path.join(fontDir, 'PlusJakartaSans_600SemiBold.ttf')),
  ]);
  const title = a.title.length > 96 ? `${a.title.slice(0, 94).trimEnd()}…` : a.title;
  const pastel = a.industry === 'all' ? '#E9DDF8' : INDUSTRIES[a.industry].pastel;
  const label = `${kind === 'blog' ? 'Blog' : 'Guide'} · ${a.readingTime} min read`;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', background: pastel, padding: 36, fontFamily: 'Jakarta' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#FFFFFF', borderRadius: 40, padding: '56px 64px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
              <svg width="56" height="56" viewBox="0 0 40 40">
                <rect width="40" height="40" rx="12" fill="#141414" />
                <path d="M11 11v18M29 11v18M11 20h18" stroke="#FFFFFF" strokeWidth="3.4" strokeLinecap="round" fill="none" />
                <circle cx="20" cy="20" r="4.2" fill="#D6F26B" />
              </svg>
              <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.04em', color: '#141414' }}>BranchHarbor</div>
            </div>
            <div style={{ fontSize: 24, fontWeight: 600, color: '#141414', border: '2px solid #E2E1DC', borderRadius: 999, padding: '8px 22px' }}>{label}</div>
          </div>
          <div style={{ fontSize: title.length > 60 ? 58 : 70, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.045em', color: '#141414', maxWidth: 1040 }}>{title}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 24, fontWeight: 600, color: '#6B6B66' }}>{`branchharbor.com/${kind}`}</div>
            <div style={{ width: 56, height: 56, borderRadius: 999, background: '#D6F26B' }} />
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Jakarta', data: bold, weight: 800, style: 'normal' },
        { name: 'Jakarta', data: semi, weight: 600, style: 'normal' },
      ],
      headers: { 'Cache-Control': 'public, max-age=86400, immutable' },
    },
  );
}
