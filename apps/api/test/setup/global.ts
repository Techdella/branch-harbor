import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    dbUrl: string | null;
    dbUnavailableReason: string | null;
  }
}

/**
 * Creates a fresh, separate test database (never the development database) and migrates it.
 * If Postgres is unreachable, DB-backed tests are skipped with a clear message.
 */
export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL ?? 'postgres://bh:bh@localhost:5432/branchharbor_test';
  const url = new URL(base);
  const dbName = url.pathname.replace(/^\//, '') || 'branchharbor_test';
  if (!/test/.test(dbName)) throw new Error(`Refusing to use non-test database "${dbName}" for tests`);
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    await runMigrations(url.toString());
    project.provide('dbUrl', url.toString());
    project.provide('dbUnavailableReason', null);
    console.log(`[test] Using fresh test database ${dbName}`);
  } catch (err) {
    await admin.end().catch(() => {});
    const reason = `Postgres not available for integration tests (${(err as Error).message}). DB tests are SKIPPED. Start Postgres (docker compose up -d postgres) or set TEST_DATABASE_URL.`;
    console.warn(`\n[test] ${reason}\n`);
    project.provide('dbUrl', null);
    project.provide('dbUnavailableReason', reason);
  }
}
