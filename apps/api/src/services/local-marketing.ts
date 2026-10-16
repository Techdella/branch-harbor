/** Organisation settings for local marketing (listing field policy, review SLA, co-op checklist, call recording). */
import { eq } from 'drizzle-orm';
import { localMarketingSettingsSchema, type LocalMarketingSettings } from '@bh/shared';
import type { Exec } from '../db/client.ts';
import { localMarketingSettings } from '../db/schema/index.ts';

export async function getLocalMarketingSettings(db: Exec, orgId: string): Promise<LocalMarketingSettings> {
  const [row] = await db.select().from(localMarketingSettings).where(eq(localMarketingSettings.organizationId, orgId));
  const parsed = localMarketingSettingsSchema.safeParse(row?.settings ?? {});
  return parsed.success ? parsed.data : localMarketingSettingsSchema.parse({});
}

/** Saves a partial change (top-level keys replace; the result is validated before it is stored). */
export async function saveLocalMarketingSettings(db: Exec, orgId: string, patch: Record<string, unknown>, userId: string): Promise<LocalMarketingSettings> {
  const [row] = await db.select().from(localMarketingSettings).where(eq(localMarketingSettings.organizationId, orgId));
  const next = { ...(row?.settings ?? {}), ...patch };
  const parsed = localMarketingSettingsSchema.parse(next);
  await db.insert(localMarketingSettings).values({ organizationId: orgId, settings: next, updatedBy: userId })
    .onConflictDoUpdate({ target: localMarketingSettings.organizationId, set: { settings: next, updatedBy: userId, updatedAt: new Date() } });
  return parsed;
}
