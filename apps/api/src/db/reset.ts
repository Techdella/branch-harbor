import { createDb } from './client.ts';
import { config } from '../config.ts';
import { runMigrations } from './migrate.ts';

/** Development helper: drops and recreates the public schema, then migrates. Refuses in production. */
const cfg = config();
if (cfg.NODE_ENV === 'production') throw new Error('Refusing to reset a production database');
const h = createDb(cfg.DATABASE_URL, { max: 1 });
await h.sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;');
await h.close();
await runMigrations(cfg.DATABASE_URL);
console.log('Database reset and migrated.');
