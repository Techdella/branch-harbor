import { getArticles } from '@/lib/articles';
import { SITE_URL, localizedPath } from '@/lib/seo';

/** RSS 2.0 feed of the blog (English), prerendered at build time. Linked from /blog and article <head>s. */
export const dynamic = 'force-static';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function GET() {
  const posts = getArticles('blog');
  const items = posts
    .map((a) => {
      const url = SITE_URL + localizedPath('en', `/blog/${a.slug}`);
      return [
        '    <item>',
        `      <title>${esc(a.title)}</title>`,
        `      <link>${esc(url)}</link>`,
        `      <guid isPermaLink="true">${esc(url)}</guid>`,
        `      <description>${esc(a.description)}</description>`,
        `      <pubDate>${new Date(`${a.date}T09:00:00Z`).toUTCString()}</pubDate>`,
        `      <dc:creator>${esc(a.author)}</dc:creator>`,
        ...a.tags.map((t) => `      <category>${esc(t)}</category>`),
        '    </item>',
      ].join('\n');
    })
    .join('\n');
  const latest = posts[0] ? new Date(`${posts[0].date}T09:00:00Z`).toUTCString() : new Date().toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>BranchHarbor blog</title>
    <link>${esc(SITE_URL + localizedPath('en', '/blog'))}</link>
    <atom:link href="${esc(`${SITE_URL}/blog/rss.xml`)}" rel="self" type="application/rss+xml" />
    <description>Ideas for running franchises and multi-location businesses across countries.</description>
    <language>en</language>
    <lastBuildDate>${latest}</lastBuildDate>
${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
