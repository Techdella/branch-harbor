import { index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, users } from './core.ts';

/**
 * Expo push tokens, one row per device token. A token belongs to the user who registered it last
 * (devices change hands); sign-out removes it. Sending is not implemented yet — this is the registry.
 */
export const pushTokens = pgTable('push_tokens', {
  id: pk(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  platform: text('platform').notNull(), // ios | android | web
  deviceId: text('device_id'),
  appVersion: text('app_version'),
  locale: text('locale'),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('push_tokens_token_uq').on(t.token), index('push_tokens_user_idx').on(t.userId)]);

/**
 * Customer ↔ location conversation. One thread per (location, customer user). `direction` is from the
 * business's point of view: inbound = written by the customer, outbound = written by staff.
 */
export const customerMessages = pgTable('customer_messages', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  /** The signed-in customer the thread belongs to. */
  customerUserId: uuid('customer_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id'),
  direction: text('direction').notNull(), // inbound | outbound
  authorUserId: uuid('author_user_id'),
  body: text('body').notNull(),
  readAt: ts('read_at'),
  createdAt: createdAt(),
}, (t) => [index('customer_messages_thread_idx').on(t.locationId, t.customerUserId, t.createdAt)]);
