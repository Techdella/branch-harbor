import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { createLocationSchema, currency, locale, timeZone, isValidTimeZone, locationStatuses, addressSchema, isBrandReservedPath } from '@bh/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Exec } from '../db/client.ts';
import { locations, organizations, ownerGroups, regions } from '../db/schema/index.ts';
import { parseCsv } from '../lib/csv.ts';
import { notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { authenticate } from '../plugins/auth.ts';
import { syncBillingQuietly } from '../services/billing.ts';
import { actor, audit } from '../services/audit.ts';
import { authorisedLocations, requirePerm, type ScopeTarget } from '../services/authz.ts';
import { serializeLocation } from '../services/serializers.ts';
import { brandInOrg } from '../services/brands.ts';
import { activeLocations, isIndependent, requireNetwork, upgradeRequired, upgradeToNetwork } from '../services/businessMode.ts';
import { AppError } from '../lib/errors.ts';
import { requireMember } from '../services/authz.ts';
import { idParams, orgParams, secured } from './_common.ts';

export async function uniqueSlug(db: Exec, orgId: string, name: string) {
  const base = slugify(name);
  const existing = await db.select({ slug: locations.slug }).from(locations).where(eq(locations.organizationId, orgId));
  const taken = new Set(existing.map((e) => e.slug));
  // Brand-level site paths (/{brand}/franchise, …) are never location slugs.
  if (!taken.has(base) && !isBrandReservedPath(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function assertParents(db: Exec, orgId: string, regionId?: string, ownerGroupId?: string) {
  if (regionId) {
    const [r] = await db.select({ id: regions.id }).from(regions).where(and(eq(regions.id, regionId), eq(regions.organizationId, orgId)));
    if (!r) throw validationError('Unknown region', { regionId: 'Region not found in this organisation' });
  }
  if (ownerGroupId) {
    const [g] = await db.select({ id: ownerGroups.id }).from(ownerGroups).where(and(eq(ownerGroups.id, ownerGroupId), eq(ownerGroups.organizationId, orgId)));
    if (!g) throw validationError('Unknown owner group', { ownerGroupId: 'Owner group not found in this organisation' });
  }
}

const IMPORT_COLUMNS = ['name', 'code', 'address_line1', 'address_line2', 'city', 'state_region', 'postal_code', 'country', 'time_zone', 'currency', 'locale', 'phone', 'email', 'region', 'owner_group'] as const;

export const locationRoutes: FastifyPluginAsyncZod = async (app) => {
  const s = app.ctx;
  app.addHook('preHandler', authenticate);
  // Billing follows the network: a location added, archived, paused or moved between owner groups changes the
  // subscription quantities and franchisee shares (services/billing.ts syncBillingSubscriptions).
  app.addHook('onSend', async (req, reply, payload) => {
    const orgId = (req.params as { orgId?: string } | undefined)?.orgId;
    if (orgId && req.method !== 'GET' && reply.statusCode < 300) await syncBillingQuietly(s, orgId);
    return payload;
  });

  app.get('/orgs/:orgId/locations', {
    schema: {
      tags: ['locations'], security: secured, params: orgParams,
      querystring: z.object({ status: z.enum(locationStatuses).optional(), regionId: z.uuid().optional(), ownerGroupId: z.uuid().optional(), includeArchived: z.coerce.boolean().default(false) }),
      summary: 'Locations the user is authorised to see (locations.read)',
    },
  }, async (req) => {
    const { orgId } = req.params;
    const allowed = await authorisedLocations(req, s.db, orgId, 'locations.read');
    const conds = [eq(locations.organizationId, orgId)];
    if (!req.query.includeArchived) conds.push(isNull(locations.archivedAt));
    if (req.query.status) conds.push(eq(locations.status, req.query.status));
    if (req.query.regionId) conds.push(eq(locations.regionId, req.query.regionId));
    if (req.query.ownerGroupId) conds.push(eq(locations.ownerGroupId, req.query.ownerGroupId));
    if (allowed !== 'all') {
      if (!allowed.size) return { items: [], scope: 'none' };
      conds.push(inArray(locations.id, [...allowed]));
    }
    const rows = await s.db.select().from(locations).where(and(...conds)).orderBy(locations.name);
    return { items: rows.map(serializeLocation), scope: allowed === 'all' ? 'organization' : 'assigned' };
  });

  app.get('/orgs/:orgId/locations/:id', { schema: { tags: ['locations'], security: secured, params: idParams } }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'locations.read', { organizationId: orgId, kind: 'location', id });
    const [l] = await s.db.select().from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
    if (!l) throw notFound('Location');
    return serializeLocation(l);
  });

  app.post('/orgs/:orgId/locations', {
    schema: {
      tags: ['locations'], security: secured, params: orgParams,
      body: createLocationSchema.extend({
        status: z.enum(locationStatuses).default('draft'),
        brandId: z.uuid().optional().describe('Brand the location belongs to (multi-brand HQ); default = the main brand'),
        upgradeToNetwork: z.boolean().default(false).describe('Independent businesses only: adding a second location requires upgrading to a network. Set true (owner only) to upgrade in the same step.'),
      }),
      summary: 'Add a location. Never auto-publishes or makes it visible to customers.',
      description: 'An independent business already has its one location: a second one returns 409 `upgrade_required` unless `upgradeToNetwork: true` is sent by the owner, which upgrades the organisation (audited) and then adds the location.',
    },
  }, async (req, reply) => {
    const { orgId } = req.params;
    const { upgradeToNetwork: wantsUpgrade, ...b } = req.body;
    const target: ScopeTarget = b.regionId ? { organizationId: orgId, kind: 'region', id: b.regionId } : b.brandId ? { organizationId: orgId, kind: 'brand', id: b.brandId } : { organizationId: orgId, kind: 'organization', id: orgId };
    await requirePerm(req, s.db, 'locations.write', target);
    const [orgRow] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    let upgrade = false;
    if (orgRow && isIndependent(orgRow)) {
      if (b.regionId || b.ownerGroupId) requireNetwork(orgRow, 'Regions and owner groups');
      const existing = await activeLocations(s.db, orgId);
      if (existing.length >= 1) {
        if (!wantsUpgrade) {
          throw upgradeRequired(
            `${orgRow.name} is set up as an independent business with one location. To add another location, upgrade to a network: your existing location, customers, website and history are kept. Send upgradeToNetwork: true, or call POST /v1/orgs/${orgId}/upgrade-to-network first.`,
            { currentLocationCount: existing.length },
          );
        }
        const mine = await requireMember(req, s.db, orgId);
        if (!mine.some((a) => a.role === 'org_owner' && a.scopeKind === 'organization')) throw new AppError(403, 'forbidden', 'Only the business owner can upgrade to a network');
        upgrade = true;
      }
    }
    if (!isValidTimeZone(b.timeZone)) throw validationError('Unknown timezone', { timeZone: 'Use an IANA timezone such as America/Toronto' });
    await assertParents(s.db, orgId, b.regionId, b.ownerGroupId);
    let brandId: string | null = null;
    if (b.brandId) {
      // Each location belongs to one brand; choosing one is an HQ decision (it decides who can see the location).
      await requirePerm(req, s.db, 'locations.write', { organizationId: orgId, kind: 'brand', id: b.brandId });
      const brand = await brandInOrg(s.db, orgId, b.brandId);
      if (!brand || brand.archivedAt) throw notFound('Brand');
      brandId = brand.isDefault ? null : brand.id;
    }
    const [dupe] = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), eq(locations.code, b.code)));
    if (dupe) throw validationError('Location code already in use', { code: 'Each location needs a unique internal code' });
    const [org] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    const geo = await s.geocoder.geocode(`${b.address.line1}, ${b.address.city}, ${b.address.country}`);
    const row = await s.db.transaction(async (tx) => {
      if (upgrade && orgRow) await upgradeToNetwork(tx, orgRow, { actorUserId: req.user!.id, ip: req.ip, trigger: 'add_location' }, s.cfg.SITES_BASE_URL);
      const [row] = await tx.insert(locations).values({
        organizationId: orgId, regionId: b.regionId ?? null, ownerGroupId: b.ownerGroupId ?? null, name: b.name, code: b.code,
        slug: await uniqueSlug(tx, orgId, b.name), address: b.address, country: b.address.country, timeZone: b.timeZone,
        currency: b.currency, locale: b.locale ?? org?.defaultLocale ?? 'en', phone: b.phone ?? null, email: b.email ?? null,
        templateId: b.templateId ?? null, status: b.status, geo, brandId,
      }).returning();
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'location.created', scopeKind: 'location', scopeId: row!.id, targetType: 'location', targetId: row!.id });
      return row!;
    });
    return reply.code(201).send({ ...serializeLocation(row), ...(upgrade ? { organizationUpgraded: true } : {}) });
  });

  app.patch('/orgs/:orgId/locations/:id', {
    schema: {
      tags: ['locations'], security: secured, params: idParams,
      body: z.object({
        name: z.string().min(1).optional(), address: addressSchema.optional(), timeZone: timeZone.optional(), currency: currency.optional(), locale: locale.optional(),
        phone: z.string().nullable().optional(), email: z.email().nullable().optional(), status: z.enum(locationStatuses).optional(),
        publiclyVisible: z.boolean().optional(), regionId: z.uuid().nullable().optional(), ownerGroupId: z.uuid().nullable().optional(),
        hours: z.record(z.string(), z.unknown()).optional(),
      }),
    },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'locations.write', { organizationId: orgId, kind: 'location', id });
    const b = req.body;
    if (b.timeZone && !isValidTimeZone(b.timeZone)) throw validationError('Unknown timezone', { timeZone: 'Invalid IANA timezone' });
    if (b.regionId || b.ownerGroupId) {
      const [o] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
      if (o) requireNetwork(o, 'Regions and owner groups');
    }
    if (b.regionId !== undefined || b.ownerGroupId !== undefined) {
      // Moving a location across regions/owner groups changes who can access it: HQ-level only.
      await requirePerm(req, s.db, 'locations.write', { organizationId: orgId, kind: 'organization', id: orgId });
      await assertParents(s.db, orgId, b.regionId ?? undefined, b.ownerGroupId ?? undefined);
    }
    const [before] = await s.db.select().from(locations).where(and(eq(locations.id, id), eq(locations.organizationId, orgId)));
    if (!before) throw notFound('Location');
    if (b.currency && b.currency !== before.currency) {
      // Existing prices and payments stay in their original currency; flag it rather than silently converting.
      req.log.warn({ locationId: id, from: before.currency, to: b.currency }, 'location currency changed');
    }
    const [row] = await s.db.update(locations).set({ ...b, ...(b.address ? { country: b.address.country } : {}), updatedAt: new Date() }).where(eq(locations.id, id)).returning();
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'location.updated', scopeKind: 'location', scopeId: id, targetType: 'location', targetId: id, metadata: { changes: b } });
    return serializeLocation(row!);
  });

  app.delete('/orgs/:orgId/locations/:id', {
    schema: { tags: ['locations'], security: secured, params: idParams, summary: 'Archive a location (recoverable). Hides it from customers.' },
  }, async (req) => {
    const { orgId, id } = req.params;
    await requirePerm(req, s.db, 'locations.write', { organizationId: orgId, kind: 'organization', id: orgId });
    const [row] = await s.db.update(locations).set({ archivedAt: new Date(), status: 'closed', publiclyVisible: false, updatedAt: new Date() })
      .where(and(eq(locations.id, id), eq(locations.organizationId, orgId))).returning();
    if (!row) throw notFound('Location');
    await audit(s.db, { organizationId: orgId, ...actor(req), action: 'location.archived', scopeKind: 'location', scopeId: id, targetType: 'location', targetId: id });
    return serializeLocation(row);
  });

  app.post('/orgs/:orgId/locations/import', {
    schema: {
      tags: ['locations'], security: secured, params: orgParams,
      summary: 'Import locations from CSV with row-level validation',
      description: `CSV columns: ${IMPORT_COLUMNS.join(', ')}. region/owner_group are matched by name (created if createMissingParents). By default nothing is written if any row is invalid; set createValidRows to import the valid rows anyway. dryRun validates only.`,
      body: z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(false), createValidRows: z.boolean().default(false), createMissingParents: z.boolean().default(true) }),
    },
  }, async (req) => {
    const { orgId } = req.params;
    await requirePerm(req, s.db, 'locations.write', { organizationId: orgId, kind: 'organization', id: orgId });
    const [importOrg] = await s.db.select().from(organizations).where(eq(organizations.id, orgId));
    if (importOrg) requireNetwork(importOrg, 'Importing locations');
    const { headers, rows } = parseCsv(req.body.csv);
    const missing = ['name', 'code', 'address_line1', 'city', 'country', 'time_zone', 'currency'].filter((h) => !headers.includes(h));
    if (missing.length) throw validationError('CSV is missing required columns', Object.fromEntries(missing.map((m) => [m, 'Required column'])));
    if (rows.length > 2000) throw validationError('Too many rows (max 2000 per import)');

    const existing = await s.db.select({ code: locations.code }).from(locations).where(eq(locations.organizationId, orgId));
    const codes = new Set(existing.map((e) => e.code.toLowerCase()));
    const regionRows = await s.db.select().from(regions).where(eq(regions.organizationId, orgId));
    const groupRows = await s.db.select().from(ownerGroups).where(eq(ownerGroups.organizationId, orgId));

    const errors: Array<{ row: number; field: string; message: string }> = [];
    const valid: Array<{ row: number; data: z.infer<typeof createLocationSchema>; regionName?: string; ownerGroupName?: string }> = [];
    rows.forEach((r, i) => {
      const rowNo = i + 2; // header is row 1
      const candidate = {
        name: r.name, code: r.code,
        address: { line1: r.address_line1 ?? '', line2: r.address_line2 || undefined, city: r.city ?? '', region: r.state_region || undefined, postalCode: r.postal_code || undefined, country: (r.country ?? '').toUpperCase() },
        timeZone: r.time_zone, currency: (r.currency ?? '').toUpperCase(), locale: r.locale || undefined, phone: r.phone || undefined, email: r.email || undefined,
      };
      const parsed = createLocationSchema.safeParse(candidate);
      const rowErrors: Array<{ field: string; message: string }> = [];
      if (!parsed.success) for (const iss of parsed.error.issues) rowErrors.push({ field: iss.path.join('.').replace('address.line1', 'address_line1').replace('address.city', 'city').replace('address.country', 'country').replace('timeZone', 'time_zone'), message: iss.message });
      if (r.time_zone && !isValidTimeZone(r.time_zone)) rowErrors.push({ field: 'time_zone', message: `Unknown timezone "${r.time_zone}"` });
      if (r.code && codes.has(r.code.toLowerCase())) rowErrors.push({ field: 'code', message: `Code "${r.code}" is already used` });
      if (r.region && !req.body.createMissingParents && !regionRows.some((x) => x.name.toLowerCase() === r.region!.toLowerCase())) rowErrors.push({ field: 'region', message: `Unknown region "${r.region}"` });
      if (r.owner_group && !req.body.createMissingParents && !groupRows.some((x) => x.name.toLowerCase() === r.owner_group!.toLowerCase())) rowErrors.push({ field: 'owner_group', message: `Unknown owner group "${r.owner_group}"` });
      if (rowErrors.length || !parsed.success) {
        errors.push(...rowErrors.map((e) => ({ row: rowNo, ...e })));
        return;
      }
      if (r.code) codes.add(r.code.toLowerCase()); // duplicates within the file
      valid.push({ row: rowNo, data: parsed.data, regionName: r.region || undefined, ownerGroupName: r.owner_group || undefined });
    });

    const summary = { totalRows: rows.length, validRows: valid.length, invalidRows: new Set(errors.map((e) => e.row)).size, errors };
    if (req.body.dryRun || (errors.length && !req.body.createValidRows)) {
      return { ...summary, created: [], committed: false, reason: req.body.dryRun ? 'dry_run' : 'validation_errors' };
    }

    const created = await s.db.transaction(async (tx) => {
      const out: Array<{ row: number; id: string; code: string }> = [];
      const regionByName = new Map(regionRows.map((x) => [x.name.toLowerCase(), x.id]));
      const groupByName = new Map(groupRows.map((x) => [x.name.toLowerCase(), x.id]));
      for (const v of valid) {
        let regionId: string | null = null;
        let ownerGroupId: string | null = null;
        if (v.regionName) {
          regionId = regionByName.get(v.regionName.toLowerCase()) ?? null;
          if (!regionId) {
            const [nr] = await tx.insert(regions).values({ organizationId: orgId, name: v.regionName }).returning();
            regionId = nr!.id;
            regionByName.set(v.regionName.toLowerCase(), regionId);
          }
        }
        if (v.ownerGroupName) {
          ownerGroupId = groupByName.get(v.ownerGroupName.toLowerCase()) ?? null;
          if (!ownerGroupId) {
            const [ng] = await tx.insert(ownerGroups).values({ organizationId: orgId, name: v.ownerGroupName }).returning();
            ownerGroupId = ng!.id;
            groupByName.set(v.ownerGroupName.toLowerCase(), ownerGroupId);
          }
        }
        const d = v.data;
        const [row] = await tx.insert(locations).values({
          organizationId: orgId, regionId, ownerGroupId, name: d.name, code: d.code, slug: await uniqueSlug(tx, orgId, d.name),
          address: d.address, country: d.address.country, timeZone: d.timeZone, currency: d.currency, locale: d.locale ?? 'en',
          phone: d.phone ?? null, email: d.email ?? null, status: 'draft',
        }).returning({ id: locations.id, code: locations.code });
        out.push({ row: v.row, id: row!.id, code: row!.code });
      }
      await audit(tx, { organizationId: orgId, ...actor(req), action: 'location.imported', scopeKind: 'organization', scopeId: orgId, metadata: { created: out.length, skipped: summary.invalidRows } });
      return out;
    });
    return { ...summary, created, committed: true, reason: null };
  });
};
