/**
 * Production-safe seed: creates NO businesses, customers or sample data.
 *
 * When PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD are both set, it creates (or updates) one BranchHarbor
 * platform admin — the only account that may use the audited /v1/platform endpoints (e.g. correcting an
 * organisation's industry). Safe to re-run.
 *
 *   pnpm db:seed
 *
 * Demo data for the demo site lives in seed-demo.ts (`pnpm db:seed:demo`) and must never run against production.
 */
import { sql } from 'drizzle-orm';
import { config } from '../config.ts';
import { hashPassword } from '../services/auth.ts';
import { createDb } from './client.ts';
import * as t from './schema/index.ts';

async function main() {
  const cfg = config();
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
  if (!email || !password) {
    console.log('[seed] Nothing to seed. The product starts empty: businesses are created by signing up.');
    console.log('[seed] Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD to create a platform admin. Demo data: pnpm db:seed:demo (demo site only).');
    return;
  }
  if (password.length < 12) throw new Error('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');
  const handle = createDb(cfg.DATABASE_URL, { max: 1 });
  try {
    const db = handle.db;
    const passwordHash = await hashPassword(password);
    const [existing] = await db.select().from(t.users).where(sql`lower(${t.users.email}) = ${email.toLowerCase()}`);
    const [u] = existing
      ? await db.update(t.users).set({ passwordHash, platformRole: 'admin', emailVerifiedAt: existing.emailVerifiedAt ?? new Date(), updatedAt: new Date() }).where(sql`${t.users.id} = ${existing.id}`).returning()
      : await db.insert(t.users).values({ email, name: process.env.PLATFORM_ADMIN_NAME?.trim() || 'BranchHarbor Admin', passwordHash, platformRole: 'admin', emailVerifiedAt: new Date() }).returning();
    await db.insert(t.auditEvents).values({ organizationId: null, actorUserId: null, actorType: 'system', action: existing ? 'platform.admin_updated' : 'platform.admin_created', targetType: 'user', targetId: u!.id, metadata: { email } });
    console.log(`[seed] Platform admin ${existing ? 'updated' : 'created'}: ${email}. No businesses were created.`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
