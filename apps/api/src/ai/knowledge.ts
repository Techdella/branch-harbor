import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AiCitation } from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  aiKnowledgeChunks, aiKnowledgeSources, assetBlobs, brandAssets, courseLessons, courseModules, courses, libraryFolders, libraryResources, ticketMessages, tickets,
  type Audience,
} from '../db/schema/index.ts';
import { audienceIncludes, buildViewer, orgLocations } from '../services/network-access.ts';
import type { AssistantContext } from './context.ts';
import { chunkText, extractText } from './extract.ts';

/**
 * Knowledge base (RAG): the operations manual and library documents, training courses, help-desk answers, brand
 * guidelines and uploads, chunked and indexed with Postgres full-text search ('simple' configuration, so every
 * language works) plus trigram word similarity. Optional embeddings (Voyage AI) when VOYAGE_API_KEY is set AND the
 * `vector` extension exists (Neon has pgvector; the local dev database usually does not).
 *
 * Scope: every source keeps the audiences of where it came from (library folders and files, courses), the module
 * whose view access is needed, and an HQ-only flag. Search filters by the person's own access, so franchisees only
 * find what is shared with them.
 */

export interface SourceInput {
  sourceType: 'library' | 'course' | 'helpdesk' | 'brand' | 'upload';
  sourceRef: string;
  title: string;
  url: string | null;
  audiences: Audience[];
  module: string;
  hqOnly?: boolean;
  text: string;
  fileName?: string | null;
  mimeType?: string | null;
  createdBy?: string | null;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Creates or refreshes one source (chunks are rebuilt only when the text changed). */
export async function indexSource(s: Services, orgId: string, src: SourceInput): Promise<{ id: string; chunks: number; changed: boolean }> {
  const text = src.text.replace(/\u0000/g, '').trim();
  const contentHash = hash(`${src.title}\n${text}`);
  const [existing] = await s.db.select().from(aiKnowledgeSources).where(and(eq(aiKnowledgeSources.organizationId, orgId), eq(aiKnowledgeSources.sourceType, src.sourceType), eq(aiKnowledgeSources.sourceRef, src.sourceRef)));
  const meta = { title: src.title.slice(0, 300), url: src.url, audiences: src.audiences, module: src.module, hqOnly: !!src.hqOnly, fileName: src.fileName ?? null, mimeType: src.mimeType ?? null, updatedAt: new Date() };
  if (existing && existing.contentHash === contentHash) {
    await s.db.update(aiKnowledgeSources).set(meta).where(eq(aiKnowledgeSources.id, existing.id));
    return { id: existing.id, chunks: existing.chunkCount, changed: false };
  }
  const chunks = text ? chunkText(text) : [];
  const id = await s.db.transaction(async (tx) => {
    const [row] = existing
      ? await tx.update(aiKnowledgeSources).set({ ...meta, contentHash, chunkCount: chunks.length, status: text ? 'ready' : 'failed', error: text ? null : 'No text could be read from this file' }).where(eq(aiKnowledgeSources.id, existing.id)).returning()
      : await tx.insert(aiKnowledgeSources).values({ organizationId: orgId, sourceType: src.sourceType, sourceRef: src.sourceRef, ...meta, contentHash, chunkCount: chunks.length, status: text ? 'ready' : 'failed', error: text ? null : 'No text could be read from this file', createdBy: src.createdBy ?? null }).returning();
    await tx.delete(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.sourceId, row!.id));
    for (let i = 0; i < chunks.length; i += 200) {
      await tx.insert(aiKnowledgeChunks).values(chunks.slice(i, i + 200).map((c, j) => ({ organizationId: orgId, sourceId: row!.id, position: i + j, heading: c.heading?.slice(0, 200) ?? null, content: c.content })));
    }
    return row!.id;
  });
  await embedSource(s, id).catch((err) => s.log.warn({ err }, '[ai] embeddings skipped'));
  return { id, chunks: chunks.length, changed: true };
}

/** Upload (PDF, DOCX, Markdown, text) → knowledge source. */
export async function indexUpload(s: Services, orgId: string, input: { fileName: string; mimeType: string; data: Buffer; title?: string; audiences?: Audience[]; hqOnly?: boolean; userId: string }) {
  const { text } = extractText(input.data, input.mimeType, input.fileName);
  return indexSource(s, orgId, {
    sourceType: 'upload', sourceRef: randomUUID(), title: input.title?.trim() || input.fileName, url: null, audiences: input.audiences ?? [], module: 'ai.assistant',
    hqOnly: input.hqOnly, text, fileName: input.fileName, mimeType: input.mimeType, createdBy: input.userId,
  });
}

/** Pulls the organisation's library, courses, help-desk answers and brand guidelines into the index. */
export async function syncOrgKnowledge(s: Services, orgId: string) {
  const seen = new Set<string>();
  const key = (t: string, r: string) => `${t}:${r}`;
  // Library (manuals, SOPs, playbooks, knowledge-base articles): the folder chain's audiences plus the file's own.
  const folders = await s.db.select().from(libraryFolders).where(eq(libraryFolders.organizationId, orgId));
  const fById = new Map(folders.map((f) => [f.id, f]));
  const chain = (id: string | null): Audience[] => {
    const out: Audience[] = [];
    for (let f = id ? fById.get(id) : undefined, d = 0; f && d < 10; f = f.parentId ? fById.get(f.parentId) : undefined, d++) out.push(f.audience);
    return out;
  };
  const res = await s.db.select().from(libraryResources).where(and(eq(libraryResources.organizationId, orgId), isNull(libraryResources.archivedAt)));
  for (const r of res) {
    const text = [r.summary, r.body].filter(Boolean).join('\n\n');
    if (!text.trim()) continue;
    seen.add(key('library', r.id));
    await indexSource(s, orgId, { sourceType: 'library', sourceRef: r.id, title: r.title, url: `/community?resource=${r.id}`, audiences: [...chain(r.folderId), r.audience], module: 'community.library', text });
  }
  // Training courses (internal and public): lesson text, quizzes excluded.
  const cs = await s.db.select().from(courses).where(and(eq(courses.organizationId, orgId), inArray(courses.status, ['published', 'pending_approval'])));
  for (const c of cs) {
    const mods = await s.db.select().from(courseModules).where(eq(courseModules.courseId, c.id)).orderBy(asc(courseModules.position));
    const lessons = await s.db.select().from(courseLessons).where(eq(courseLessons.courseId, c.id)).orderBy(asc(courseLessons.position));
    const text = [c.summary, c.description, ...mods.flatMap((m) => [`# ${m.title}`, ...lessons.filter((l) => l.moduleId === m.id && l.body).map((l) => `## ${l.title}\n\n${l.body}`)])].filter(Boolean).join('\n\n');
    if (!text.trim()) continue;
    seen.add(key('course', c.id));
    await indexSource(s, orgId, { sourceType: 'course', sourceRef: c.id, title: c.title, url: `/training?course=${c.id}`, audiences: [], module: 'training.academy', text });
  }
  // Help-desk answers: agents' public replies on resolved tickets (for HQ agents answering similar questions).
  const solved = await s.db.select().from(tickets).where(and(eq(tickets.organizationId, orgId), inArray(tickets.status, ['resolved', 'closed']))).limit(500);
  for (const t of solved) {
    const msgs = await s.db.select().from(ticketMessages).where(and(eq(ticketMessages.ticketId, t.id), eq(ticketMessages.internal, false))).orderBy(asc(ticketMessages.createdAt));
    const answers = msgs.filter((m) => m.authorId && m.authorId !== t.requesterId).map((m) => m.body);
    if (!answers.length) continue;
    seen.add(key('helpdesk', t.id));
    await indexSource(s, orgId, { sourceType: 'helpdesk', sourceRef: t.id, title: `Answered: ${t.subject}`, url: `/help?ticket=${t.id}`, audiences: [], module: 'community.help_desk', hqOnly: true, text: `Question: ${t.subject}\n\n${answers.join('\n\n')}` });
  }
  // Brand guidelines: HQ brand assets that are text or PDF files named as guidelines.
  const assets = await s.db.select().from(brandAssets).where(and(eq(brandAssets.organizationId, orgId), isNull(brandAssets.locationId), isNull(brandAssets.archivedAt), or(sql`${brandAssets.name} ilike '%guideline%'`, sql`${brandAssets.folder} ilike '%guideline%'`, sql`${brandAssets.name} ilike '%brand book%'`)));
  for (const a of assets) {
    if (!/pdf|text|markdown|wordprocessingml/.test(a.mime)) continue;
    const data = a.storage === 'db' ? (await s.db.select().from(assetBlobs).where(eq(assetBlobs.assetId, a.id)))[0]?.data : await s.assets.get(a.storageKey).catch(() => null);
    if (!data) continue;
    seen.add(key('brand', a.id));
    await indexSource(s, orgId, { sourceType: 'brand', sourceRef: a.id, title: a.name, url: '/marketing/assets', audiences: [], module: 'marketing.brand_assets', text: extractText(Buffer.from(data as Buffer), a.mime, a.name).text });
  }
  // Remove sources whose origin disappeared (uploads are kept).
  const existing = await s.db.select({ id: aiKnowledgeSources.id, t: aiKnowledgeSources.sourceType, r: aiKnowledgeSources.sourceRef }).from(aiKnowledgeSources).where(eq(aiKnowledgeSources.organizationId, orgId));
  const stale = existing.filter((x) => x.t !== 'upload' && !seen.has(key(x.t, x.r ?? '')));
  if (stale.length) await s.db.delete(aiKnowledgeSources).where(inArray(aiKnowledgeSources.id, stale.map((x) => x.id)));
  return { sources: seen.size, removed: stale.length };
}

/* ------------------------------ Search ------------------------------ */

const indexed = new Set<string>();
/** First search in an organisation (per process) without any source: index it now instead of waiting for the job. */
export async function ensureIndexed(s: Services, orgId: string) {
  if (indexed.has(orgId)) return;
  indexed.add(orgId);
  const [any] = await s.db.select({ id: aiKnowledgeSources.id }).from(aiKnowledgeSources).where(eq(aiKnowledgeSources.organizationId, orgId)).limit(1);
  if (!any) await syncOrgKnowledge(s, orgId).catch((err) => s.log.warn({ err }, '[ai] knowledge sync failed'));
}

export interface KnowledgeHit { chunkId: string; sourceId: string; title: string; url: string | null; sourceType: string; heading: string | null; content: string; score: number }

async function canSeeSource(db: Exec, ctx: AssistantContext): Promise<(src: typeof aiKnowledgeSources.$inferSelect) => boolean> {
  const viewer = buildViewer(ctx.user.id, ctx.orgId, ctx.assignments, await orgLocations(db, ctx.orgId));
  return (src) => (!src.hqOnly || ctx.hq) && ctx.can(src.module, src.module === 'community.help_desk' ? 'edit' : 'view') && (src.audiences ?? []).every((a) => audienceIncludes(a, viewer, { hqSeesAll: true }));
}

/** Full-text + trigram search, filtered to what the person may see. */
export async function searchKnowledge(s: Services, ctx: AssistantContext, query: string, limit = 6): Promise<KnowledgeHit[]> {
  const q = query.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!q) return [];
  const words = q.split(' ').filter((w) => w.length > 2).slice(0, 12);
  const orQuery = words.length ? words.join(' or ') : q;
  const rows = (await s.db.execute(sql`
    select c.id as chunk_id, c.source_id, c.heading, c.content,
      (ts_rank_cd(c.tsv, websearch_to_tsquery('simple', ${orQuery})) * 2 + word_similarity(${q}, c.content)) as score
    from ai_knowledge_chunks c
    join ai_knowledge_sources src on src.id = c.source_id
    where c.organization_id = ${ctx.orgId} and src.status = 'ready'
      and (c.tsv @@ websearch_to_tsquery('simple', ${orQuery}) or ${q} <% c.content)
    order by score desc
    limit 60`)) as unknown as Array<{ chunk_id: string; source_id: string; heading: string | null; content: string; score: number }>;
  if (!rows.length) return [];
  const sources = await s.db.select().from(aiKnowledgeSources).where(and(eq(aiKnowledgeSources.organizationId, ctx.orgId), inArray(aiKnowledgeSources.id, [...new Set(rows.map((r) => r.source_id))])));
  const byId = new Map(sources.map((x) => [x.id, x]));
  const visible = await canSeeSource(s.db, ctx);
  const hits: KnowledgeHit[] = [];
  const perSource = new Map<string, number>();
  for (const r of rows) {
    const src = byId.get(r.source_id);
    if (!src || !visible(src)) continue;
    const n = perSource.get(src.id) ?? 0;
    if (n >= 2) continue;
    perSource.set(src.id, n + 1);
    hits.push({ chunkId: r.chunk_id, sourceId: src.id, title: src.title, url: src.url, sourceType: src.sourceType, heading: r.heading, content: r.content, score: Number(r.score) });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function citationsFrom(hits: KnowledgeHit[]): AiCitation[] {
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(h.sourceId) && seen.add(h.sourceId)).map((h) => ({ id: h.sourceId, title: h.title, url: h.url, sourceType: h.sourceType, snippet: h.content.slice(0, 220) }));
}

/* ------------------------------ Embeddings (optional) ------------------------------ */

let vectorReady: Promise<boolean> | null = null;

/** True when VOYAGE_API_KEY is set and the `vector` extension can be used; creates the side table once. */
export function embeddingsAvailable(s: Services): Promise<boolean> {
  if (!s.cfg.VOYAGE_API_KEY) return Promise.resolve(false);
  vectorReady ??= (async () => {
    try {
      const ext = (await s.db.execute(sql`select 1 from pg_available_extensions where name = 'vector'`)) as unknown as unknown[];
      if (!ext.length) return false;
      await s.db.execute(sql`create extension if not exists vector`);
      await s.db.execute(sql`create table if not exists ai_knowledge_embeddings (chunk_id uuid primary key references ai_knowledge_chunks(id) on delete cascade, organization_id uuid not null, embedding vector(1024) not null)`);
      return true;
    } catch (err) {
      s.log.warn({ err }, '[ai] pgvector unavailable; using full-text search only');
      return false;
    }
  })();
  return vectorReady;
}

async function voyage(s: Services, input: string[], inputType: 'document' | 'query'): Promise<number[][]> {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.cfg.VOYAGE_API_KEY}` },
    body: JSON.stringify({ input, model: s.cfg.VOYAGE_MODEL, input_type: inputType, output_dimension: 1024 }),
  });
  if (!res.ok) throw new Error(`Voyage embeddings failed (${res.status})`);
  const j = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return j.data.map((d) => d.embedding);
}

async function embedSource(s: Services, sourceId: string) {
  if (!(await embeddingsAvailable(s))) return;
  const chunks = await s.db.select({ id: aiKnowledgeChunks.id, org: aiKnowledgeChunks.organizationId, content: aiKnowledgeChunks.content, heading: aiKnowledgeChunks.heading }).from(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.sourceId, sourceId));
  for (let i = 0; i < chunks.length; i += 64) {
    const batch = chunks.slice(i, i + 64);
    const vecs = await voyage(s, batch.map((c) => `${c.heading ?? ''}\n${c.content}`), 'document');
    for (const [j, c] of batch.entries()) {
      await s.db.execute(sql`insert into ai_knowledge_embeddings (chunk_id, organization_id, embedding) values (${c.id}, ${c.org}, ${`[${vecs[j]!.join(',')}]`}::vector) on conflict (chunk_id) do update set embedding = excluded.embedding`);
    }
  }
}

/** Semantic neighbours (when embeddings are available) merged into the keyword hits. */
export async function semanticSearch(s: Services, ctx: AssistantContext, query: string, limit = 6): Promise<KnowledgeHit[]> {
  await ensureIndexed(s, ctx.orgId);
  const keyword = await searchKnowledge(s, ctx, query, limit);
  if (!(await embeddingsAvailable(s))) return keyword;
  try {
    const [v] = await voyage(s, [query], 'query');
    const rows = (await s.db.execute(sql`select e.chunk_id from ai_knowledge_embeddings e where e.organization_id = ${ctx.orgId} order by e.embedding <=> ${`[${v!.join(',')}]`}::vector limit 20`)) as unknown as Array<{ chunk_id: string }>;
    if (!rows.length) return keyword;
    const chunks = await s.db.select().from(aiKnowledgeChunks).where(inArray(aiKnowledgeChunks.id, rows.map((r) => r.chunk_id)));
    const sources = await s.db.select().from(aiKnowledgeSources).where(inArray(aiKnowledgeSources.id, [...new Set(chunks.map((c) => c.sourceId))]));
    const visible = await canSeeSource(s.db, ctx);
    const extra = chunks.map((c) => ({ c, src: sources.find((x) => x.id === c.sourceId)! })).filter((x) => x.src && visible(x.src) && !keyword.some((k) => k.chunkId === x.c.id))
      .map((x) => ({ chunkId: x.c.id, sourceId: x.src.id, title: x.src.title, url: x.src.url, sourceType: x.src.sourceType, heading: x.c.heading, content: x.c.content, score: 0.5 }));
    return [...keyword, ...extra].slice(0, limit);
  } catch (err) {
    s.log.warn({ err }, '[ai] semantic search failed; keyword results only');
    return keyword;
  }
}
