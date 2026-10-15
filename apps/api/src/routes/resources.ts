import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod';
import { libraryFolders, libraryResources, libraryVersions, type Audience } from '../db/schema/index.ts';
import { notFound, validationError } from '../lib/errors.ts';
import { authenticate } from '../plugins/auth.ts';
import { actor, audit } from '../services/audit.ts';
import { audienceSummary } from '../services/community.ts';
import { audienceIncludes, requireNetworkPerm, userNames, validateAudience, viewerFor, type Viewer } from '../services/network-access.ts';
import { idParams, orgParams, secured } from './_common.ts';
import { audienceSchema, httpUrl } from './network-common.ts';

const tags = ['community'];
export const RESOURCE_KINDS = ['document', 'playbook', 'sop', 'kb_article', 'link', 'video'] as const;

/**
 * Resource library (documents, playbooks, SOPs) and help desk knowledge base articles, in one searchable store with
 * folders, versions and audience permissions. A resource is visible when both its folder and itself include you.
 */
export const resourceRoutes: FastifyPluginAsyncZod = async (_app) => {
  const app = _app.withTypeProvider<ZodTypeProvider>();
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  const base = '/orgs/:orgId/resources';

  const viewer = async (req: Parameters<typeof viewerFor>[0], orgId: string) => {
    const v = await viewerFor(req, s.db, orgId);
    if (!v.perms.has('community.read') && !v.perms.has('helpdesk.raise')) requireNetworkPerm(v, 'community.read');
    return v;
  };
  const sees = (a: Audience, v: Viewer) => audienceIncludes(a, v, { hqSeesAll: true });
  const manager = (v: Viewer) => v.orgPerms.has('community.manage') || v.orgPerms.has('helpdesk.agent');

  async function visibleFolders(v: Viewer) {
    const rows = await s.db.select().from(libraryFolders).where(eq(libraryFolders.organizationId, v.organizationId)).orderBy(asc(libraryFolders.position), asc(libraryFolders.name));
    const byId = new Map(rows.map((f) => [f.id, f]));
    // A folder inside a hidden folder is hidden too.
    const ok = (id: string | null, depth = 0): boolean => {
      if (!id) return true;
      const f = byId.get(id);
      return !!f && depth < 10 && sees(f.audience, v) && ok(f.parentId, depth + 1);
    };
    return rows.filter((f) => ok(f.id));
  }

  app.get(`${base}/folders`, { schema: { tags, security: secured, params: orgParams } }, async (req) => {
    const v = await viewer(req, req.params.orgId);
    const folders = await visibleFolders(v);
    const counts = await s.db.select({ folderId: libraryResources.folderId, n: sql<number>`count(*)::int` }).from(libraryResources).where(and(eq(libraryResources.organizationId, v.organizationId), isNull(libraryResources.archivedAt))).groupBy(libraryResources.folderId);
    const cm = new Map(counts.map((c) => [c.folderId, c.n]));
    return { items: folders.map((f) => ({ id: f.id, parentId: f.parentId, name: f.name, audience: audienceSummary(f.audience), count: cm.get(f.id) ?? 0 })), canManage: manager(v) };
  });

  app.post(`${base}/folders`, { schema: { tags, security: secured, params: orgParams, body: z.object({ name: z.string().trim().min(1).max(120), parentId: z.uuid().nullable().optional(), audience: audienceSchema.default({}), position: z.number().int().min(0).max(1000).default(0) }) } }, async (req, reply) => {
    const v = await viewer(req, req.params.orgId);
    requireNetworkPerm(v, 'community.manage', { orgWide: true });
    if (req.body.parentId) {
      const [p] = await s.db.select().from(libraryFolders).where(and(eq(libraryFolders.id, req.body.parentId), eq(libraryFolders.organizationId, v.organizationId)));
      if (!p) throw validationError('Unknown parent folder', { parentId: 'Unknown folder' });
    }
    const audience = await validateAudience(s.db, v.organizationId, req.body.audience);
    const [f] = await s.db.insert(libraryFolders).values({ organizationId: v.organizationId, name: req.body.name, parentId: req.body.parentId ?? null, audience, position: req.body.position }).returning();
    reply.code(201);
    return { id: f!.id, name: f!.name, parentId: f!.parentId, audience: audienceSummary(f!.audience) };
  });

  const resourceBody = z.object({
    title: z.string().trim().min(1).max(200), kind: z.enum(RESOURCE_KINDS).default('document'), folderId: z.uuid().nullable().optional(), summary: z.string().max(1000).nullable().optional(),
    body: z.string().max(100_000).nullable().optional(), url: httpUrl.nullable().optional(), fileName: z.string().max(200).nullable().optional(), tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    audience: audienceSchema.default({}), helpCategory: z.string().max(80).nullable().optional(), note: z.string().max(300).optional(),
  });

  const serialize = (r: typeof libraryResources.$inferSelect, names: Map<string, string>, full = false) => ({
    id: r.id, title: r.title, kind: r.kind, folderId: r.folderId, summary: r.summary, url: r.url, fileName: r.fileName, tags: r.tags, audience: audienceSummary(r.audience), helpCategory: r.helpCategory,
    version: r.currentVersion, updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy ? names.get(r.updatedBy) ?? null : null, archived: !!r.archivedAt, ...(full ? { body: r.body } : {}),
  });

  app.get(`${base}`, {
    schema: { tags, security: secured, params: orgParams, querystring: z.object({ folderId: z.uuid().optional(), kind: z.enum(RESOURCE_KINDS).optional(), q: z.string().trim().max(120).optional(), helpOnly: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(200).default(100) }), summary: 'Browse or search the library (also the help desk knowledge base)' },
  }, async (req) => {
    const v = await viewer(req, req.params.orgId);
    const folders = await visibleFolders(v);
    const okFolder = new Set(folders.map((f) => f.id));
    const q = req.query.q;
    const tsv = sql`to_tsvector('simple', coalesce(${libraryResources.title},'') || ' ' || coalesce(${libraryResources.summary},'') || ' ' || coalesce(${libraryResources.body},'') || ' ' || array_to_string(${libraryResources.tags}, ' '))`;
    const rank = q ? sql<number>`ts_rank(${tsv}, websearch_to_tsquery('simple', ${q}))` : sql<number>`0`;
    const rows = await s.db.select({ r: libraryResources }).from(libraryResources).where(and(
      eq(libraryResources.organizationId, v.organizationId), isNull(libraryResources.archivedAt),
      ...(req.query.folderId ? [eq(libraryResources.folderId, req.query.folderId)] : []),
      ...(req.query.kind ? [eq(libraryResources.kind, req.query.kind)] : []),
      ...(req.query.helpOnly ? [eq(libraryResources.kind, 'kb_article')] : []),
      ...(q ? [sql`(${tsv} @@ websearch_to_tsquery('simple', ${q}) or ${libraryResources.title} ilike ${`%${q}%`} or ${libraryResources.summary} ilike ${`%${q}%`})`] : []),
    )).orderBy(...(q ? [desc(rank)] : []), desc(libraryResources.updatedAt)).limit(req.query.limit);
    const list = rows.map((x) => x.r).filter((r) => (!r.folderId || okFolder.has(r.folderId)) && sees(r.audience, v));
    const names = await userNames(s.db, list.map((r) => r.updatedBy));
    return { items: list.map((r) => serialize(r, names)), canManage: manager(v) };
  });

  async function load(v: Viewer, id: string) {
    const [r] = await s.db.select().from(libraryResources).where(and(eq(libraryResources.id, id), eq(libraryResources.organizationId, v.organizationId)));
    if (!r || (r.archivedAt && !manager(v))) throw notFound('Resource');
    if (r.folderId && !(await visibleFolders(v)).some((f) => f.id === r.folderId)) throw notFound('Resource');
    if (!sees(r.audience, v)) throw notFound('Resource');
    return r;
  }

  app.get(`${base}/:id`, { schema: { tags, security: secured, params: idParams } }, async (req) => {
    const v = await viewer(req, req.params.orgId);
    const r = await load(v, req.params.id);
    const versions = await s.db.select().from(libraryVersions).where(eq(libraryVersions.resourceId, r.id)).orderBy(desc(libraryVersions.version));
    const names = await userNames(s.db, [r.updatedBy, ...versions.map((x) => x.createdBy)]);
    return { ...serialize(r, names, true), versions: versions.map((x) => ({ version: x.version, title: x.title, url: x.url, fileName: x.fileName, note: x.note, by: x.createdBy ? names.get(x.createdBy) ?? null : null, at: x.createdAt.toISOString() })), canManage: manager(v) };
  });

  app.post(`${base}`, { schema: { tags, security: secured, params: orgParams, body: resourceBody } }, async (req, reply) => {
    const v = await viewer(req, req.params.orgId);
    if (!manager(v)) requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const b = req.body;
    if (!b.body && !b.url) throw validationError('Add text or a link to the file', { url: 'Required when there is no text' });
    if (b.folderId) {
      const [f] = await s.db.select().from(libraryFolders).where(and(eq(libraryFolders.id, b.folderId), eq(libraryFolders.organizationId, v.organizationId)));
      if (!f) throw validationError('Unknown folder', { folderId: 'Unknown folder' });
    }
    const audience = await validateAudience(s.db, v.organizationId, b.audience);
    const r = await s.db.transaction(async (tx) => {
      const [row] = await tx.insert(libraryResources).values({ organizationId: v.organizationId, title: b.title, kind: b.kind, folderId: b.folderId ?? null, summary: b.summary ?? null, body: b.body ?? null, url: b.url ?? null, fileName: b.fileName ?? null, tags: b.tags, audience, helpCategory: b.helpCategory ?? null, createdBy: v.userId, updatedBy: v.userId }).returning();
      await tx.insert(libraryVersions).values({ organizationId: v.organizationId, resourceId: row!.id, version: 1, title: b.title, body: b.body ?? null, url: b.url ?? null, fileName: b.fileName ?? null, note: b.note ?? null, createdBy: v.userId });
      await audit(tx, { organizationId: v.organizationId, ...actor(req), action: 'resource.created', targetType: 'resource', targetId: row!.id, metadata: { kind: b.kind } });
      return row!;
    });
    reply.code(201);
    return serialize(r, new Map(), true);
  });

  app.patch(`${base}/:id`, { schema: { tags, security: secured, params: idParams, body: resourceBody.partial().extend({ archived: z.boolean().optional() }), summary: 'Edit; changing the title, text or file creates a new version' } }, async (req) => {
    const v = await viewer(req, req.params.orgId);
    if (!manager(v)) requireNetworkPerm(v, 'community.manage', { orgWide: true });
    const r = await load(v, req.params.id);
    const { archived, note, audience, tags: tagList, ...b } = req.body;
    const clean = audience ? await validateAudience(s.db, v.organizationId, audience) : undefined;
    const contentChanged = (b.title !== undefined && b.title !== r.title) || (b.body !== undefined && b.body !== r.body) || (b.url !== undefined && b.url !== r.url) || (b.fileName !== undefined && b.fileName !== r.fileName);
    const u = await s.db.transaction(async (tx) => {
      const version = contentChanged ? r.currentVersion + 1 : r.currentVersion;
      const [row] = await tx.update(libraryResources).set({ ...b, ...(tagList ? { tags: tagList } : {}), ...(clean ? { audience: clean } : {}), ...(archived !== undefined ? { archivedAt: archived ? new Date() : null } : {}), currentVersion: version, updatedBy: v.userId, updatedAt: new Date() }).where(eq(libraryResources.id, r.id)).returning();
      if (contentChanged) await tx.insert(libraryVersions).values({ organizationId: v.organizationId, resourceId: r.id, version, title: row!.title, body: row!.body, url: row!.url, fileName: row!.fileName, note: note ?? null, createdBy: v.userId });
      await audit(tx, { organizationId: v.organizationId, ...actor(req), action: 'resource.updated', targetType: 'resource', targetId: r.id, metadata: { version, archived } });
      return row!;
    });
    return serialize(u, new Map(), true);
  });
};
