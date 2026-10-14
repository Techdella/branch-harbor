import { bigint, char, timestamp, uuid } from 'drizzle-orm/pg-core';

/** All timestamps are timestamptz and stored in UTC. */
export const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
export const createdAt = () => ts('created_at').notNull().defaultNow();
export const updatedAt = () => ts('updated_at').notNull().defaultNow();
export const pk = () => uuid('id').primaryKey().defaultRandom();
export const orgId = () => uuid('organization_id').notNull();
/** Money: integer minor units. bigint in Postgres, number in JS (safe below 2^53). */
export const minor = (name: string) => bigint(name, { mode: 'number' });
export const currencyCol = (name = 'currency') => char(name, { length: 3 });
