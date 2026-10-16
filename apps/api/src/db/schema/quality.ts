import { boolean, customType, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AuditAnswers, AuditSection } from '@bh/shared';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations, ownerGroups } from './core.ts';

/**
 * Field audits (Operations → Audits), compliance documents (Legal & compliance) and the private files they hold
 * (audit photos, corrective-action evidence, certificates). The league table has no tables: it reads payments,
 * activity, audits and invoices.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Private uploads (never public URLs): stored through the asset storage service (S3 / R2 when configured, otherwise
 * in `data`). Served only through authenticated, short-lived signed links checked against the record they belong to.
 */
export const opsFiles = pgTable('ops_files', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'cascade' }),
  /** audit_photo | corrective_evidence | compliance_document */
  purpose: text('purpose').notNull(),
  name: text('name').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  /** s3 | db */
  storage: text('storage').notNull(),
  storageKey: text('storage_key').notNull(),
  data: bytea('data'),
  uploadedBy: uuid('uploaded_by'),
  createdAt: createdAt(),
}, (t) => [index('ops_files_org_idx').on(t.organizationId, t.purpose)]);

/** Checklist templates (HQ). Editing bumps the version; scheduled audits keep the checklist they were created with. */
export const auditTemplates = pgTable('audit_templates', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  starterKey: text('starter_key'),
  sections: jsonb('sections').$type<AuditSection[]>().notNull(),
  passThreshold: integer('pass_threshold').notNull().default(80),
  reauditDays: integer('reaudit_days').notNull().default(30),
  correctiveDays: integer('corrective_days').notNull().default(14),
  /** active | archived */
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('audit_templates_org_idx').on(t.organizationId, t.status)]);

export interface AuditChecklist { name: string; sections: AuditSection[]; passThreshold: number; reauditDays: number; correctiveDays: number; version: number }

/** One audit of one location against a checklist snapshot. */
export const audits = pgTable('audits', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  templateId: uuid('template_id').references(() => auditTemplates.id, { onDelete: 'set null' }),
  checklist: jsonb('checklist').$type<AuditChecklist>().notNull(),
  /** routine | pre_opening | reaudit */
  purpose: text('purpose').notNull().default('routine'),
  /** scheduled | in_progress | completed | cancelled */
  status: text('status').notNull().default('scheduled'),
  dueDate: date('due_date').notNull(),
  auditorUserId: uuid('auditor_user_id'),
  scheduledBy: uuid('scheduled_by'),
  /** The failed audit this one re-checks. */
  parentAuditId: uuid('parent_audit_id'),
  /** Pre-opening audits: the onboarding project whose go-live needs it to pass. */
  projectId: uuid('project_id'),
  answers: jsonb('answers').$type<AuditAnswers>().notNull().default({}),
  /** Autosave revision: each save must send the revision it started from (offline edits merge per question). */
  revision: integer('revision').notNull().default(0),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  /** Score in tenths of a percent (884 = 88.4 %). */
  scoreTenths: integer('score_tenths'),
  passed: boolean('passed'),
  criticalFailed: boolean('critical_failed'),
  summary: text('summary'),
  reauditDueDate: date('reaudit_due_date'),
  remindedAt: ts('reminded_at'),
  cancelReason: text('cancel_reason'),
  /** Created by a recurring schedule (`audit_schedules`): one audit per schedule, location and due date. */
  scheduleId: uuid('schedule_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('audits_schedule_due_uq').on(t.scheduleId, t.locationId, t.dueDate),
  index('audits_org_loc_idx').on(t.organizationId, t.locationId, t.status),
  index('audits_org_auditor_idx').on(t.organizationId, t.auditorUserId),
  index('audits_project_idx').on(t.projectId),
]);

/** A corrective action raised by a failed item: the location fixes it with evidence, the auditor verifies it. */
export const auditActions = pgTable('audit_actions', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  auditId: uuid('audit_id').notNull().references(() => audits.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  questionId: text('question_id').notNull(),
  sectionTitle: text('section_title').notNull(),
  title: text('title').notNull(),
  /** no | low_score | out_of_range | photo_missing */
  reason: text('reason').notNull(),
  critical: boolean('critical').notNull().default(false),
  auditorNote: text('auditor_note'),
  dueDate: date('due_date').notNull(),
  /** open | submitted | verified */
  status: text('status').notNull().default('open'),
  responseNote: text('response_note'),
  evidenceFileIds: jsonb('evidence_file_ids').$type<string[]>().notNull().default([]),
  submittedBy: uuid('submitted_by'),
  submittedAt: ts('submitted_at'),
  verifiedBy: uuid('verified_by'),
  verifiedAt: ts('verified_at'),
  reviewNote: text('review_note'),
  reopenedCount: integer('reopened_count').notNull().default(0),
  remindedAt: ts('reminded_at'),
  /** Retraining loop: the academy course this failed item recommends, and the assignment made for the location. */
  trainingCourseId: uuid('training_course_id'),
  trainingAssignmentId: uuid('training_assignment_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('audit_actions_audit_question_uq').on(t.auditId, t.questionId),
  index('audit_actions_org_status_idx').on(t.organizationId, t.status, t.dueDate),
]);

/** What HQ requires each location (or owner group) to hold, e.g. "General liability ≥ 2,000,000 USD". */
export const complianceRequirements = pgTable('compliance_requirements', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** insurance | licence | permit | health_certificate | franchisee_document */
  category: text('category').notNull(),
  description: text('description').notNull().default(''),
  coverageType: text('coverage_type'),
  minAmountMinor: minor('min_amount_minor'),
  currency: currencyCol('currency'),
  /** location | owner_group */
  appliesTo: text('applies_to').notNull().default('location'),
  /** Country (`CA`) or country-region (`CA-ON`) codes; empty = every location. */
  jurisdictions: jsonb('jurisdictions').$type<string[]>().notNull().default([]),
  requiresExpiry: boolean('requires_expiry').notNull().default(true),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('compliance_requirements_org_idx').on(t.organizationId, t.active)]);

/** An uploaded certificate, licence or permit for a location or an owner group. */
export const complianceDocuments = pgTable('compliance_documents', {
  id: pk(),
  organizationId: orgId().references(() => organizations.id, { onDelete: 'cascade' }),
  requirementId: uuid('requirement_id').references(() => complianceRequirements.id, { onDelete: 'set null' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  ownerGroupId: uuid('owner_group_id').references(() => ownerGroups.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  title: text('title').notNull(),
  /** Insurer or issuing authority. */
  issuer: text('issuer'),
  /** Policy, licence or permit number. */
  reference: text('reference'),
  coverageType: text('coverage_type'),
  coverageAmountMinor: minor('coverage_amount_minor'),
  currency: currencyCol('currency'),
  issuedOn: date('issued_on'),
  expiresOn: date('expires_on'),
  fileId: uuid('file_id').references(() => opsFiles.id, { onDelete: 'set null' }),
  /** pending | approved | rejected */
  status: text('status').notNull().default('pending'),
  reviewNote: text('review_note'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  uploadedBy: uuid('uploaded_by'),
  /** Reminder steps already sent (days before expiry: 60, 30, 7, 0). */
  remindersSent: jsonb('reminders_sent').$type<number[]>().notNull().default([]),
  escalatedAt: ts('escalated_at'),
  /** Replaced by a newer approved document for the same requirement. */
  supersededAt: ts('superseded_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  index('compliance_documents_org_idx').on(t.organizationId, t.status),
  index('compliance_documents_loc_idx').on(t.locationId),
  index('compliance_documents_group_idx').on(t.ownerGroupId),
  index('compliance_documents_expiry_idx').on(t.organizationId, t.expiresOn),
]);
