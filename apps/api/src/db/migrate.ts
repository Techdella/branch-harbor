import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.ts';
import { config } from '../config.ts';

export const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(url: string) {
  const handle = createDb(url, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder });
    // Data migration (idempotent): classic field pages → website builder documents, so live sites keep rendering.
    const { migrateSiteDocuments } = await import('../services/site-builder.ts');
    const r = await migrateSiteDocuments(handle.db);
    if (r.migratedPages || r.migratedVersions) console.log(`Website builder: migrated ${r.migratedPages} pages and ${r.migratedVersions} published versions`);
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = config().DATABASE_URL;
  runMigrations(url)
    .then(() => {
      console.log(`Migrations applied to ${url.replace(/:[^:@/]+@/, ':****@')}`);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
