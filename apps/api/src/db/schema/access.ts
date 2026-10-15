import { sql } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, orgId, pk, updatedAt } from './_shared.ts';
import { organizations, roleAssignments, users } from './core.ts';

/**
 * Access model (packages/shared/src/access.ts). System roles are role templates defined in code; organisations add
 * their own custom roles (a named capability set). A role assignment points at either a system role (`role`) or a
 * custom role (`role = 'custom'` + `custom_role_id`), and can carry per-person overrides.
 */
export const customRoles = pgTable('custom_roles', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  /** The system template it started from (informational). */
  baseRole: text('base_role'),
  /** Landing workspace for people with this role (optional). */
  primaryWorkspace: text('primary_workspace'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('custom_roles_org_name_uq').on(t.organizationId, sql`lower(${t.name})`)]);

/** One row per capability (`<module>:<action>`) a custom role grants. */
export const roleCapabilities = pgTable('role_capabilities', {
  roleId: uuid('role_id').notNull().references(() => customRoles.id, { onDelete: 'cascade' }),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  capability: text('capability').notNull(),
}, (t) => [primaryKey({ columns: [t.roleId, t.capability] })]);

/** Per-person overrides on one role assignment: extra capabilities (`grant`) or removed ones (`revoke`). */
export const memberAccessOverrides = pgTable('member_access_overrides', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  assignmentId: uuid('assignment_id').notNull().references(() => roleAssignments.id, { onDelete: 'cascade' }),
  capability: text('capability').notNull(),
  effect: text('effect').notNull(), // grant | revoke
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('member_access_overrides_uq').on(t.assignmentId, t.capability),
  index('member_access_overrides_org_idx').on(t.organizationId),
]);

/** A person in one business: a free-text job title (separate from their roles) and sensitive classes denied to them. */
export const memberProfiles = pgTable('member_profiles', {
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  jobTitle: text('job_title'),
  /** Sensitive data classes (finance | legal | personal_data) removed from every role the person holds. */
  deniedClasses: text('denied_classes').array().notNull().default(sql`'{}'::text[]`),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.userId] })]);

/** The business's own display name for a system role (any template can be renamed). */
export const roleLabels = pgTable('role_labels', {
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  name: text('name').notNull(),
  updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.organizationId, t.role] })]);
