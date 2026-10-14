import { and, eq, sql } from 'drizzle-orm';
import type { Services } from '../context.ts';
import { classTypes, connections, externalMappings, locations, products, syncRuns } from '../db/schema/index.ts';
import type { ConnectorProvider } from '../integrations/connectors.ts';
import { decrypt } from '../lib/crypto.ts';

type Connection = typeof connections.$inferSelect;

export function credentialsOf(s: Services, c: Connection): Record<string, string> | null {
  if (!c.credentialsEncrypted) return null;
  try {
    return JSON.parse(decrypt(c.credentialsEncrypted, s.cfg.ENCRYPTION_KEY));
  } catch {
    return null;
  }
}

export function serializeConnection(c: Connection, extra: Record<string, unknown> = {}) {
  return {
    id: c.id, organizationId: c.organizationId, locationId: c.locationId, provider: c.provider, kind: c.kind, direction: c.direction,
    authoritative: c.authoritative, state: c.state, config: c.config, hasCredentials: !!c.credentialsEncrypted,
    lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null, lastErrorAt: c.lastErrorAt?.toISOString() ?? null, lastError: c.lastError,
    createdAt: c.createdAt.toISOString(), ...extra,
  };
}

/** Automatic matching: by exact (case-insensitive) name for locations/class types, by SKU for products. */
async function autoMatch(s: Services, orgId: string, entityType: string, data: Record<string, unknown>): Promise<string | null> {
  const name = typeof data.name === 'string' ? data.name : null;
  if (entityType === 'location' && name) {
    const [l] = await s.db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, orgId), sql`lower(${locations.name}) = ${name.toLowerCase()}`));
    return l?.id ?? null;
  }
  if (entityType === 'product' && typeof data.sku === 'string') {
    const [p] = await s.db.select({ id: products.id }).from(products).where(and(eq(products.organizationId, orgId), eq(products.sku, data.sku)));
    return p?.id ?? null;
  }
  if (entityType === 'class_type' && name) {
    const [c] = await s.db.select({ id: classTypes.id }).from(classTypes).where(and(eq(classTypes.organizationId, orgId), sql`lower(${classTypes.name}) = ${name.toLowerCase()}`));
    return c?.id ?? null;
  }
  return null;
}

/**
 * Pull records from the provider and maintain stable external mappings. Unmatched records become
 * mapping errors for a person to resolve — nothing is silently created, merged or overwritten.
 * Re-running a sync is idempotent (unique connection/entity/external id).
 */
export async function runConnectionSync(s: Services, connectionId: string, syncRunId: string) {
  const [c] = await s.db.select().from(connections).where(eq(connections.id, connectionId));
  if (!c) return;
  await s.db.update(syncRuns).set({ status: 'running', startedAt: new Date() }).where(eq(syncRuns.id, syncRunId));
  const adapter = s.connectors[c.provider as ConnectorProvider];
  try {
    const { records, cursor } = await adapter.fetch(c.config, credentialsOf(s, c), c.syncCursor ?? null);
    let failed = 0;
    for (const r of records) {
      const [existing] = await s.db.select().from(externalMappings).where(and(eq(externalMappings.connectionId, c.id), eq(externalMappings.entityType, r.entityType), eq(externalMappings.externalId, r.externalId)));
      if (existing && (existing.status === 'mapped' || existing.status === 'ignored')) {
        await s.db.update(externalMappings).set({ externalData: r.data, updatedAt: new Date() }).where(eq(externalMappings.id, existing.id));
        continue;
      }
      const internalId = await autoMatch(s, c.organizationId, r.entityType, r.data);
      if (!internalId) failed++;
      const values = {
        organizationId: c.organizationId, connectionId: c.id, entityType: r.entityType, externalId: r.externalId, internalId,
        status: internalId ? 'mapped' : 'error', error: internalId ? null : `No matching BranchHarbor ${r.entityType.replace('_', ' ')} for "${String(r.data.name ?? r.externalId)}"`,
        externalData: r.data, updatedAt: new Date(),
      };
      await s.db.insert(externalMappings).values(values).onConflictDoUpdate({ target: [externalMappings.connectionId, externalMappings.entityType, externalMappings.externalId], set: values });
    }
    const now = new Date();
    await s.db.update(syncRuns).set({ status: failed ? 'partial' : 'succeeded', recordsProcessed: records.length, recordsFailed: failed, finishedAt: now }).where(eq(syncRuns.id, syncRunId));
    await s.db.update(connections).set({ state: failed ? 'degraded' : 'connected', lastSuccessAt: now, syncCursor: cursor, lastError: failed ? `${failed} record(s) need mapping` : null, lastErrorAt: failed ? now : c.lastErrorAt, updatedAt: now }).where(eq(connections.id, c.id));
  } catch (err) {
    const msg = (err as Error).message;
    await s.db.update(syncRuns).set({ status: 'failed', error: msg, finishedAt: new Date() }).where(eq(syncRuns.id, syncRunId));
    await s.db.update(connections).set({ state: 'degraded', lastError: msg, lastErrorAt: new Date(), updatedAt: new Date() }).where(eq(connections.id, c.id));
  }
}
