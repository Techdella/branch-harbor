/**
 * Website builder data migration: converts classic template-field pages (and their published versions) into page
 * documents. Idempotent — pages that already have a document are left alone. `db:migrate` also runs it.
 *
 *   pnpm --filter @bh/api db:migrate-sites
 */
import { config } from '../config.ts';
import { createDb } from './client.ts';
import { migrateSiteDocuments } from '../services/site-builder.ts';

const handle = createDb(config().DATABASE_URL, { max: 2 });
try {
  const r = await migrateSiteDocuments(handle.db);
  console.log(`Website builder migration: ${r.migratedPages} pages, ${r.migratedVersions} published versions converted.`);
} catch (err) {
  console.error('Website builder migration failed:', err);
  process.exitCode = 1;
} finally {
  await handle.close();
}
