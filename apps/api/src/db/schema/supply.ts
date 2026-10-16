import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AuditAnswers, PoLine, RebateTier, ScheduleTarget, SupplierContact, SupplierContract } from '@bh/shared';
import { createdAt, currencyCol, minor, orgId, pk, ts, updatedAt } from './_shared.ts';
import { locations, organizations } from './core.ts';
import { auditTemplates, complianceDocuments, opsFiles, type AuditChecklist } from './quality.ts';

/**
 * Supplier and approved-vendor network (Operations → Suppliers, Finance → Supplier rebates) and audits phase 2
 * (recurring audit schedules, self-checks). Money is integer minor units with its currency; purchase order quantities
 * are packs.
 */
const org = () => orgId().references(() => organizations.id, { onDelete: 'cascade' });
const loc = () => uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' });

/** Organisation-wide supply settings: the HQ approval threshold per currency. */
export const supplySettings = pgTable('supply_settings', {
  organizationId: uuid('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
  approvalThresholds: jsonb('approval_thresholds').$type<Record<string, number>>().notNull().default({}),
  updatedBy: uuid('updated_by'),
  updatedAt: updatedAt(),
});

/** An approved supplier (HQ), with where it is approved, contacts and contract terms. */
export const supplySuppliers = pgTable('supply_suppliers', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  code: text('code').notNull().default(''),
  /** active | suspended | archived */
  status: text('status').notNull().default('active'),
  countries: jsonb('countries').$type<string[]>().notNull().default([]),
  regionIds: jsonb('region_ids').$type<string[]>().notNull().default([]),
  contacts: jsonb('contacts').$type<SupplierContact[]>().notNull().default([]),
  orderEmail: text('order_email'),
  /** pdf | csv | both */
  orderFormat: text('order_format').notNull().default('pdf'),
  currency: currencyCol().notNull(),
  contract: jsonb('contract').$type<SupplierContract | null>(),
  notes: text('notes').notNull().default(''),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('supply_suppliers_org_idx').on(t.organizationId, t.status)]);

/** A certification HQ requires from a supplier (food safety, organic …), linked to a compliance document or a file. */
export const supplySupplierCertifications = pgTable('supply_supplier_certifications', {
  id: pk(),
  organizationId: org(),
  supplierId: uuid('supplier_id').notNull().references(() => supplySuppliers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  required: boolean('required').notNull().default(true),
  complianceDocumentId: uuid('compliance_document_id').references(() => complianceDocuments.id, { onDelete: 'set null' }),
  fileId: uuid('file_id').references(() => opsFiles.id, { onDelete: 'set null' }),
  issuer: text('issuer'),
  reference: text('reference'),
  expiresOn: date('expires_on'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('supply_supplier_certs_supplier_idx').on(t.supplierId)]);

/** A catalogue item: SKU, pack, price per currency, MOQ and lead time, optionally linked to stock it replenishes. */
export const supplyCatalogueItems = pgTable('supply_catalogue_items', {
  id: pk(),
  organizationId: org(),
  supplierId: uuid('supplier_id').notNull().references(() => supplySuppliers.id, { onDelete: 'cascade' }),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  category: text('category').notNull().default(''),
  packLabel: text('pack_label').notNull().default(''),
  unitsPerPack: integer('units_per_pack').notNull().default(1),
  prices: jsonb('prices').$type<Record<string, number>>().notNull(),
  moq: integer('moq').notNull().default(1),
  leadTimeDays: integer('lead_time_days').notNull().default(2),
  active: boolean('active').notNull().default(true),
  /** Commerce product variant / foods ingredient that receiving restocks. */
  variantId: uuid('variant_id'),
  ingredientId: uuid('ingredient_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('supply_catalogue_sku_uq').on(t.supplierId, t.sku),
  index('supply_catalogue_org_idx').on(t.organizationId, t.active),
]);

export interface PoApproval { required: boolean; thresholdMinor: number | null; decidedBy?: string | null; decidedAt?: string | null; decision?: 'approved' | 'rejected' | null; note?: string | null }
export interface PoEvent { at: string; event: string; by?: string | null; note?: string | null }

/** A purchase order from a location to an approved supplier. */
export const supplyPurchaseOrders = pgTable('supply_purchase_orders', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  supplierId: uuid('supplier_id').notNull().references(() => supplySuppliers.id, { onDelete: 'restrict' }),
  number: text('number').notNull(),
  /** draft | pending_approval | approved | rejected | sent | confirmed | partially_received | received | cancelled */
  status: text('status').notNull().default('draft'),
  currency: currencyCol().notNull(),
  lines: jsonb('lines').$type<PoLine[]>().notNull(),
  totalMinor: minor('total_minor').notNull(),
  requestedDeliveryDate: date('requested_delivery_date'),
  /** The date the supplier confirmed (or the lead time implied when sent). Drives on-time delivery. */
  expectedDeliveryDate: date('expected_delivery_date'),
  notes: text('notes').notNull().default(''),
  approval: jsonb('approval').$type<PoApproval>().notNull().default({ required: false, thresholdMinor: null }),
  /** Magic link for the supplier (hash only; the token is in the email). */
  confirmTokenHash: text('confirm_token_hash'),
  confirmTokenExpiresAt: ts('confirm_token_expires_at'),
  sentAt: ts('sent_at'),
  sentTo: text('sent_to'),
  supplierViewedAt: ts('supplier_viewed_at'),
  confirmedAt: ts('confirmed_at'),
  supplierNote: text('supplier_note'),
  supplierReference: text('supplier_reference'),
  firstDeliveryOn: date('first_delivery_on'),
  receivedAt: ts('received_at'),
  closedShort: boolean('closed_short').notNull().default(false),
  history: jsonb('history').$type<PoEvent[]>().notNull().default([]),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('supply_po_number_uq').on(t.organizationId, t.number),
  uniqueIndex('supply_po_token_uq').on(t.confirmTokenHash),
  index('supply_po_org_status_idx').on(t.organizationId, t.status),
  index('supply_po_loc_idx').on(t.locationId),
  index('supply_po_supplier_idx').on(t.supplierId, t.createdAt),
]);

export interface ReceiptLine { itemId: string; received: number; damaged: number; outstandingBefore: number; outstandingAfter: number; issue: string | null; note: string }
export interface InventoryApplied { itemId: string; kind: 'variant' | 'ingredient'; targetId: string; units: number }

/** One delivery received against a purchase order (partial deliveries make several). */
export const supplyReceipts = pgTable('supply_receipts', {
  id: pk(),
  organizationId: org(),
  purchaseOrderId: uuid('purchase_order_id').notNull().references(() => supplyPurchaseOrders.id, { onDelete: 'cascade' }),
  locationId: loc(),
  receivedOn: date('received_on').notNull(),
  lines: jsonb('lines').$type<ReceiptLine[]>().notNull(),
  issues: integer('issues').notNull().default(0),
  note: text('note').notNull().default(''),
  inventory: jsonb('inventory').$type<InventoryApplied[]>().notNull().default([]),
  receivedBy: uuid('received_by'),
  createdAt: createdAt(),
}, (t) => [index('supply_receipts_po_idx').on(t.purchaseOrderId)]);

/** A rebate programme negotiated by HQ with a supplier. */
export const supplyRebateProgrammes = pgTable('supply_rebate_programmes', {
  id: pk(),
  organizationId: org(),
  supplierId: uuid('supplier_id').notNull().references(() => supplySuppliers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** percent | per_unit */
  basis: text('basis').notNull(),
  /** spend | units */
  measure: text('measure').notNull().default('spend'),
  currency: currencyCol().notNull(),
  tiers: jsonb('tiers').$type<RebateTier[]>().notNull(),
  /** month | quarter | year */
  period: text('period').notNull().default('quarter'),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on'),
  itemIds: jsonb('item_ids').$type<string[]>().notNull().default([]),
  fundSharePct: integer('fund_share_pct').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('supply_rebate_programmes_org_idx').on(t.organizationId, t.active)]);

export interface ClaimLocationLine { locationId: string; name: string; spendMinor: number; units: number; orders: number; shareMinor: number }

/** A rebate claim for one programme and period, with its statement lines per location. */
export const supplyRebateClaims = pgTable('supply_rebate_claims', {
  id: pk(),
  organizationId: org(),
  programmeId: uuid('programme_id').notNull().references(() => supplyRebateProgrammes.id, { onDelete: 'cascade' }),
  supplierId: uuid('supplier_id').notNull().references(() => supplySuppliers.id, { onDelete: 'cascade' }),
  number: text('number').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  periodLabel: text('period_label').notNull(),
  currency: currencyCol().notNull(),
  spendMinor: minor('spend_minor').notNull(),
  units: integer('units').notNull(),
  tierIndex: integer('tier_index').notNull(),
  rate: integer('rate').notNull(),
  amountMinor: minor('amount_minor').notNull(),
  lines: jsonb('lines').$type<ClaimLocationLine[]>().notNull().default([]),
  /** draft | submitted | received | void */
  status: text('status').notNull().default('draft'),
  submittedAt: ts('submitted_at'),
  receivedAt: ts('received_at'),
  receivedMinor: minor('received_minor'),
  fundShareMinor: minor('fund_share_minor'),
  /** The marketing fund ledger entry booked for the fund share. */
  fundEntryId: uuid('fund_entry_id'),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('supply_rebate_claims_number_uq').on(t.organizationId, t.number),
  uniqueIndex('supply_rebate_claims_period_uq').on(t.programmeId, t.periodStart).where(sql`${t.status} <> 'void'`),
]);

/** A purchase outside the approved catalogue, logged by a location and flagged for HQ. */
export const supplyOffContract = pgTable('supply_off_contract', {
  id: pk(),
  organizationId: org(),
  locationId: loc(),
  vendorName: text('vendor_name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull().default(''),
  amountMinor: minor('amount_minor').notNull(),
  currency: currencyCol().notNull(),
  purchasedOn: date('purchased_on').notNull(),
  /** urgent | out_of_stock | price | not_in_catalogue | other */
  reason: text('reason').notNull(),
  note: text('note').notNull().default(''),
  receiptFileId: uuid('receipt_file_id').references(() => opsFiles.id, { onDelete: 'set null' }),
  /** flagged | accepted | action_required */
  status: text('status').notNull().default('flagged'),
  reviewNote: text('review_note'),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: ts('reviewed_at'),
  /** An approved supplier HQ points the location to instead. */
  suggestedSupplierId: uuid('suggested_supplier_id').references(() => supplySuppliers.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('supply_off_contract_org_idx').on(t.organizationId, t.status, t.purchasedOn)]);

/* ------------------------------------------------------------------ */
/* Audits phase 2                                                      */
/* ------------------------------------------------------------------ */

/** A recurring HQ audit (e.g. a monthly brand visit at every location), created ahead of its due date by a job. */
export const auditSchedules = pgTable('audit_schedules', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  templateId: uuid('template_id').notNull().references(() => auditTemplates.id, { onDelete: 'cascade' }),
  target: jsonb('target').$type<ScheduleTarget>().notNull(),
  /** weekly | monthly | quarterly */
  frequency: text('frequency').notNull(),
  interval: integer('interval').notNull().default(1),
  anchorDate: date('anchor_date').notNull(),
  leadDays: integer('lead_days').notNull().default(14),
  /** field_consultant | user */
  auditorRule: text('auditor_rule').notNull().default('field_consultant'),
  auditorUserId: uuid('auditor_user_id'),
  active: boolean('active').notNull().default(true),
  lastRunAt: ts('last_run_at'),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('audit_schedules_org_idx').on(t.organizationId, t.active)]);

/** A checklist a location runs itself on a schedule (opening, closing, temperature log). */
export const selfCheckSchedules = pgTable('self_check_schedules', {
  id: pk(),
  organizationId: org(),
  name: text('name').notNull(),
  templateId: uuid('template_id').notNull().references(() => auditTemplates.id, { onDelete: 'cascade' }),
  /** opening | closing | food_safety | cleaning | other */
  kind: text('kind').notNull().default('other'),
  target: jsonb('target').$type<ScheduleTarget>().notNull(),
  weekdays: jsonb('weekdays').$type<number[]>().notNull(),
  dueTime: text('due_time').notNull().default('10:00'),
  remindMinutesBefore: integer('remind_minutes_before').notNull().default(30),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index('self_check_schedules_org_idx').on(t.organizationId, t.active)]);

/** One day's run of a self-check at a location. */
export const selfCheckRuns = pgTable('self_check_runs', {
  id: pk(),
  organizationId: org(),
  scheduleId: uuid('schedule_id').notNull().references(() => selfCheckSchedules.id, { onDelete: 'cascade' }),
  locationId: loc(),
  /** Local date at the location. */
  date: date('date').notNull(),
  dueAt: ts('due_at').notNull(),
  checklist: jsonb('checklist').$type<AuditChecklist>().notNull(),
  /** due | in_progress | completed | missed */
  status: text('status').notNull().default('due'),
  answers: jsonb('answers').$type<AuditAnswers>().notNull().default({}),
  scoreTenths: integer('score_tenths'),
  passed: boolean('passed'),
  criticalFailed: boolean('critical_failed'),
  failedItems: jsonb('failed_items').$type<Array<{ questionId: string; text: string; reason: string | null; critical: boolean }>>().notNull().default([]),
  note: text('note'),
  completedBy: uuid('completed_by'),
  completedAt: ts('completed_at'),
  remindedAt: ts('reminded_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('self_check_runs_uq').on(t.scheduleId, t.locationId, t.date),
  index('self_check_runs_loc_idx').on(t.organizationId, t.locationId, t.date),
]);
