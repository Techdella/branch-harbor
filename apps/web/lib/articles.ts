import fs from 'node:fs';
import path from 'node:path';
import { cache } from 'react';
import { IMG } from '@/content/images';
import { INDUSTRY_KEYS, type IndustryKey } from '@/content/industries';

/**
 * Blog posts and guides: Markdown files with frontmatter in content/blog and content/guides.
 *
 * Frontmatter (all required unless marked optional):
 *   title, description, date (YYYY-MM-DD), updated (optional), author, tags ([a, b] from ARTICLE_TAGS),
 *   industry (an industry key or "all"), hero (an IMG key or https URL), heroAlt, readingTime (minutes, optional —
 *   computed from the word count when omitted).
 * Body: Markdown subset rendered by components/articles/Markdown.tsx — ## / ### headings (feed the table of
 * contents), paragraphs, - and 1. lists, > quotes (a quote starting "**Note**" renders as a callout), pipe tables,
 * **bold**, *italic*, `code` and [links](/path or https://…).
 *
 * Articles are written in English. Other locales show the English article with a note (lang="en").
 */
export const ARTICLE_KINDS = ['blog', 'guides'] as const;
export type ArticleKind = (typeof ARTICLE_KINDS)[number];

export const ARTICLE_TAGS = [
  'marketing', 'franchising', 'websites', 'brand', 'finance', 'international', 'operations', 'legal', 'bookings', 'distribution', 'launch',
  'localSeo', 'kitchen', 'registration', 'pricing', 'leads',
] as const;
export type ArticleTag = (typeof ARTICLE_TAGS)[number];

export interface ArticleMeta {
  kind: ArticleKind;
  slug: string;
  title: string;
  description: string;
  date: string;
  updated: string | null;
  author: string;
  tags: ArticleTag[];
  industry: IndustryKey | 'all';
  hero: string;
  heroAlt: string;
  readingTime: number;
}

export interface Article extends ArticleMeta {
  body: string;
  headings: { id: string; text: string; level: 2 | 3 }[];
}

const DIR = path.join(process.cwd(), 'content');

function parseFrontmatter(src: string, file: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const data: Record<string, string | string[]> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`${file}: bad frontmatter line "${line}"`);
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    value = value.replace(/^["'](.*)["']$/, '$1');
    data[key] = value;
  }
  return { data, body: m[2]! };
}

/** Heading text → anchor id ("Launch week: day one" → "launch-week-day-one"). */
export function headingId(text: string): string {
  return stripInline(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Removes inline Markdown markers (for ids, plain-text excerpts and word counts). */
export function stripInline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

const str = (v: string | string[] | undefined, key: string, file: string): string => {
  if (typeof v !== 'string' || !v) throw new Error(`${file}: frontmatter "${key}" is required`);
  return v;
};

function load(kind: ArticleKind, file: string): Article {
  const full = path.join(DIR, kind, file);
  const { data, body } = parseFrontmatter(fs.readFileSync(full, 'utf8'), `${kind}/${file}`);
  const where = `${kind}/${file}`;
  const date = str(data.date, 'date', where);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${where}: date must be YYYY-MM-DD`);
  const tags = (Array.isArray(data.tags) ? data.tags : []) as ArticleTag[];
  for (const t of tags) if (!(ARTICLE_TAGS as readonly string[]).includes(t)) throw new Error(`${where}: unknown tag "${t}"`);
  const industry = str(data.industry, 'industry', where);
  if (industry !== 'all' && !(INDUSTRY_KEYS as readonly string[]).includes(industry)) throw new Error(`${where}: unknown industry "${industry}"`);
  const heroKey = str(data.hero, 'hero', where);
  const hero = heroKey.startsWith('https://') ? heroKey : (IMG as Record<string, string>)[heroKey];
  if (!hero) throw new Error(`${where}: unknown hero image "${heroKey}"`);
  const words = stripInline(body).split(/\s+/).filter(Boolean).length;
  const headings = [...body.matchAll(/^(#{2,3})\s+(.+)$/gm)].map((h) => ({ level: h[1]!.length as 2 | 3, text: stripInline(h[2]!.trim()), id: headingId(h[2]!.trim()) }));
  return {
    kind,
    slug: file.replace(/\.md$/, ''),
    title: str(data.title, 'title', where),
    description: str(data.description, 'description', where),
    date,
    updated: typeof data.updated === 'string' && data.updated ? data.updated : null,
    author: str(data.author, 'author', where),
    tags,
    industry: industry as IndustryKey | 'all',
    hero,
    heroAlt: typeof data.heroAlt === 'string' ? data.heroAlt : '',
    readingTime: Number(data.readingTime) > 0 ? Number(data.readingTime) : Math.max(1, Math.round(words / 220)),
    body,
    headings,
  };
}

/** Every article of a kind, newest first. */
export const getArticles = cache((kind: ArticleKind): Article[] => {
  const dir = path.join(DIR, kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => load(kind, f))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
});

export function getArticle(kind: ArticleKind, slug: string): Article | null {
  return getArticles(kind).find((a) => a.slug === slug) ?? null;
}

export function toMeta(a: Article): ArticleMeta {
  const { body: _body, headings: _headings, ...meta } = a;
  return meta;
}

/** Related reading across blog and guides: shared industry and tags score highest; ties go to the newest. */
export function relatedArticles(a: Article, limit = 3): ArticleMeta[] {
  const all = [...getArticles('blog'), ...getArticles('guides')].filter((x) => !(x.kind === a.kind && x.slug === a.slug));
  const score = (x: Article) =>
    x.tags.filter((t) => a.tags.includes(t)).length * 2 + (x.industry === a.industry && a.industry !== 'all' ? 3 : 0) + (x.industry === 'all' || a.industry === 'all' ? 0.5 : 0);
  return all
    .map((x) => ({ x, s: score(x) }))
    .sort((p, q) => q.s - p.s || q.x.date.localeCompare(p.x.date))
    .slice(0, limit)
    .map(({ x }) => toMeta(x));
}

export function articlePath(kind: ArticleKind, slug?: string): string {
  return slug ? `/${kind}/${slug}` : `/${kind}`;
}
