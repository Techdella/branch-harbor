/**
 * Supplier and approved-vendor network (Operations → Suppliers `operations.suppliers`, Finance → Supplier rebates
 * `finance.supplier_rebates`).
 *
 * - HQ (suppliers publish, organisation-wide) keeps approved suppliers per country / region with contacts, contract
 *   terms, required certifications and a catalogue (SKU, pack, price per currency, MOQ, lead time).
 * - A location (suppliers edit there) orders from the catalogue in its own currency. Orders above the HQ threshold for
 *   that currency wait for approval (suppliers publish at the location); the others go straight to the supplier.
 * - Sending emails the supplier a magic link (no login) to view the order, download it as PDF / CSV and confirm it.
 * - The location receives deliveries (partial deliveries and discrepancies). Good packs restock the commerce variant or
 *   the foods ingredient a catalogue item is linked to.
 * - Rebates accrue from received goods per programme and period; claims carry a statement per location, and the
 *   fund share is booked into the marketing fund ledger when the rebate is received.
 * - Off-contract purchases are logged by locations and flagged for HQ. Scorecards come from orders and receipts.
 *
 * Every list is filtered to the locations where the viewer holds the module; a record outside it is 404.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import {
  applyReceipt, computeRebate, daysUntil, fundShareOf, moqViolations, poNeedsApproval, poTotal, rebatePeriodOf, supplierCovers, supplierScorecard,
  type AccessAction, type PoCreate, type PoLine, type ReceiveInput, type RebatePeriod,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  complianceDocuments, foodIngredientMovements, foodIngredients, foodIngredientStock, locations, marketingFundEntries, organizations, supplyCatalogueItems, supplyOffContract,
  supplyPurchaseOrders, supplyReceipts, supplyRebateClaims, supplyRebateProgrammes, supplySettings, supplySupplierCertifications, supplySuppliers, users, variants,
  type InventoryApplied, type PoEvent,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, forbidden, notFound, validationError } from '../lib/errors.ts';
import { renderPdf, type PdfLine, type PdfText } from '../lib/pdf.ts';
import type { EmailAttachment } from '../integrations/mailer.ts';
import { addDays, localDateParts } from '../lib/tz.ts';
import { audit } from './audit.ts';
import { capabilityLocations, hasCapability, requireMember } from './authz.ts';
import { applyMovement, nextNumber } from './commerce-stock.ts';
import { major, toCsv } from './finance/exports.ts';
import { notify } from './notifications.ts';
import { signedFileUrl } from './ops-files.ts';
import { usersWithCapability } from './audits.ts';

export const MODULE = 'operations.suppliers';
export const REBATES = 'finance.supplier_rebates';
export type Supplier = typeof supplySuppliers.$inferSelect;
export type CatalogueItem = typeof supplyCatalogueItems.$inferSelect;
export type PurchaseOrder = typeof supplyPurchaseOrders.$inferSelect;
export type RebateProgramme = typeof supplyRebateProgrammes.$inferSelect;
export type RebateClaim = typeof supplyRebateClaims.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const event = (e: string, by?: string | null, note?: string | null): PoEvent => ({ at: new Date().toISOString(), event: e, by: by ?? null, note: note ?? null });

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

const orgTarget = (organizationId: string) => ({ organizationId, kind: 'organization' as const, id: organizationId });
const locTarget = (organizationId: string, locationId: string) => ({ organizationId, kind: 'location' as const, id: locationId });

export const canOrg = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction) => hasCapability(req, db, MODULE, action, orgTarget(organizationId));
export const canAt = (req: FastifyRequest, db: Exec, organizationId: string, locationId: string, action: AccessAction) => hasCapability(req, db, MODULE, action, locTarget(organizationId, locationId));
export const canRebates = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction) => hasCapability(req, db, REBATES, action, orgTarget(organizationId));
export const supplyLocations = (req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction = 'view') => capabilityLocations(req, db, organizationId, MODULE, action);
export const inScope = (allowed: 'all' | Set<string>, id: string) => allowed === 'all' || allowed.has(id);

export async function requireHq(req: FastifyRequest, db: Exec, organizationId: string, message = 'Only HQ can manage suppliers') {
  if (!(await canOrg(req, db, organizationId, 'publish'))) throw forbidden(message);
}
export async function requireAt(req: FastifyRequest, db: Exec, organizationId: string, locationId: string, action: AccessAction, message?: string) {
  if (!(await canAt(req, db, organizationId, locationId, action))) throw forbidden(message ?? `You don't have ${action} access to suppliers at this location`);
}
export async function requireRebates(req: FastifyRequest, db: Exec, organizationId: string, action: AccessAction) {
  await requireMember(req, db, organizationId);
  if (!(await canRebates(req, db, organizationId, action))) throw forbidden(action === 'view' ? 'Supplier rebates are HQ only' : `Supplier rebates (${action}) needed`);
}

export async function locationRow(db: Exec, organizationId: string, locationId: string) {
  const [l] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!l) throw notFound('Location');
  return l;
}

const localToday = (tz: string | null | undefined, now = new Date()) => localDateParts(now, tz ?? 'UTC').date;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export async function settingsFor(db: Exec, organizationId: string) {
  const [r] = await db.select().from(supplySettings).where(eq(supplySettings.organizationId, organizationId));
  return { approvalThresholds: r?.approvalThresholds ?? {} };
}

/* ------------------------------------------------------------------ */
/* Suppliers                                                           */
/* ------------------------------------------------------------------ */

export async function loadSupplier(db: Exec, organizationId: string, id: string) {
  const [s] = await db.select().from(supplySuppliers).where(and(eq(supplySuppliers.id, id), eq(supplySuppliers.organizationId, organizationId)));
  if (!s) throw notFound('Supplier');
  return s;
}

type CertRow = typeof supplySupplierCertifications.$inferSelect;
/** Certification state: valid, expiring (30 days), expired or missing (no document or file on record). */
export function certState(c: { fileId: string | null; complianceDocumentId: string | null; expiresOn: string | null; docExpiresOn?: string | null; docStatus?: string | null }, today: string) {
  const exp = c.docExpiresOn ?? c.expiresOn;
  if (!c.fileId && !c.complianceDocumentId) return { state: 'missing' as const, expiresOn: exp, daysLeft: null };
  if (c.complianceDocumentId && c.docStatus && c.docStatus !== 'approved') return { state: 'pending' as const, expiresOn: exp, daysLeft: exp ? daysUntil(exp, today) : null };
  if (!exp) return { state: 'valid' as const, expiresOn: null, daysLeft: null };
  const d = daysUntil(exp, today);
  return { state: d < 0 ? ('expired' as const) : d <= 30 ? ('expiring' as const) : ('valid' as const), expiresOn: exp, daysLeft: d };
}

export async function certificationsFor(s: Services, organizationId: string, supplierIds: string[], today: string) {
  if (!supplierIds.length) return new Map<string, ReturnType<typeof serializeCert>[]>();
  const rows = await s.db.select({ c: supplySupplierCertifications, docExpiresOn: complianceDocuments.expiresOn, docStatus: complianceDocuments.status, docTitle: complianceDocuments.title })
    .from(supplySupplierCertifications).leftJoin(complianceDocuments, eq(complianceDocuments.id, supplySupplierCertifications.complianceDocumentId))
    .where(and(eq(supplySupplierCertifications.organizationId, organizationId), inArray(supplySupplierCertifications.supplierId, supplierIds))).orderBy(asc(supplySupplierCertifications.name));
  const out = new Map<string, ReturnType<typeof serializeCert>[]>();
  for (const r of rows) {
    const list = out.get(r.c.supplierId) ?? [];
    list.push(serializeCert(s, r.c, today, r));
    out.set(r.c.supplierId, list);
  }
  return out;
}

export function serializeCert(s: Services, c: CertRow, today: string, doc: { docExpiresOn?: string | null; docStatus?: string | null; docTitle?: string | null } = {}) {
  const st = certState({ ...c, docExpiresOn: doc.docExpiresOn ?? null, docStatus: doc.docStatus ?? null }, today);
  return {
    id: c.id, name: c.name, required: c.required, issuer: c.issuer, reference: c.reference, expiresOn: st.expiresOn, daysLeft: st.daysLeft, state: st.state,
    complianceDocument: c.complianceDocumentId ? { id: c.complianceDocumentId, title: doc.docTitle ?? null, status: doc.docStatus ?? null } : null,
    file: c.fileId ? { id: c.fileId, url: signedFileUrl(s, c.fileId) } : null,
  };
}

export function serializeSupplier(x: Supplier, extra: { certifications?: unknown[]; itemCount?: number; scorecard?: unknown; regionNames?: Map<string, string>; full?: boolean } = {}) {
  return {
    id: x.id, name: x.name, code: x.code, status: x.status, countries: x.countries, regionIds: x.regionIds, regions: x.regionIds.map((id) => ({ id, name: extra.regionNames?.get(id) ?? null })),
    contacts: x.contacts, orderEmail: x.orderEmail, orderFormat: x.orderFormat, currency: x.currency, contract: x.contract, notes: x.notes,
    certifications: extra.certifications ?? [], itemCount: extra.itemCount ?? 0, scorecard: extra.scorecard ?? null, updatedAt: x.updatedAt.toISOString(),
  };
}

export function serializeItem(i: CatalogueItem, currency?: string | null) {
  return {
    id: i.id, supplierId: i.supplierId, sku: i.sku, name: i.name, category: i.category, packLabel: i.packLabel, unitsPerPack: i.unitsPerPack, prices: i.prices, moq: i.moq,
    leadTimeDays: i.leadTimeDays, active: i.active, variantId: i.variantId, ingredientId: i.ingredientId, stockLink: i.variantId ? 'variant' : i.ingredientId ? 'ingredient' : null,
    ...(currency !== undefined ? { price: currency && i.prices[currency] !== undefined ? { amountMinor: i.prices[currency]!, currency } : null } : {}),
  };
}

/** Checks a catalogue item's stock link belongs to the organisation (a commerce variant or a foods ingredient). */
export async function checkStockLink(db: Exec, organizationId: string, b: { variantId: string | null; ingredientId: string | null }) {
  if (b.variantId) {
    const [v] = await db.select({ id: variants.id }).from(variants).where(and(eq(variants.id, b.variantId), eq(variants.organizationId, organizationId)));
    if (!v) throw validationError('Unknown product variant', { variantId: 'Not in this business' });
  }
  if (b.ingredientId) {
    const [g] = await db.select({ id: foodIngredients.id }).from(foodIngredients).where(and(eq(foodIngredients.id, b.ingredientId), eq(foodIngredients.organizationId, organizationId)));
    if (!g) throw validationError('Unknown ingredient', { ingredientId: 'Not in this business' });
  }
}

/* ------------------------------------------------------------------ */
/* Scorecards                                                          */
/* ------------------------------------------------------------------ */

/** Scorecards per supplier from the orders (and receipts) at the locations in scope. */
export async function scorecards(db: Exec, organizationId: string, allowed: 'all' | Set<string>, supplierIds?: string[]) {
  const conds = [eq(supplyPurchaseOrders.organizationId, organizationId), inArray(supplyPurchaseOrders.status, ['sent', 'confirmed', 'partially_received', 'received', 'cancelled'])];
  if (supplierIds?.length) conds.push(inArray(supplyPurchaseOrders.supplierId, supplierIds));
  const pos = (await db.select().from(supplyPurchaseOrders).where(and(...conds))).filter((p) => inScope(allowed, p.locationId) && p.sentAt);
  const receipts = pos.length ? await db.select({ po: supplyReceipts.purchaseOrderId, issues: supplyReceipts.issues }).from(supplyReceipts).where(inArray(supplyReceipts.purchaseOrderId, pos.map((p) => p.id))) : [];
  const issuesByPo = new Map<string, number>();
  for (const r of receipts) issuesByPo.set(r.po, (issuesByPo.get(r.po) ?? 0) + r.issues);
  const bySupplier = new Map<string, PurchaseOrder[]>();
  for (const p of pos) bySupplier.set(p.supplierId, [...(bySupplier.get(p.supplierId) ?? []), p]);
  const out = new Map<string, ReturnType<typeof supplierScorecard>>();
  for (const [id, list] of bySupplier) {
    out.set(id, supplierScorecard({
      orders: list.map((p) => ({
        status: p.status, expectedOn: p.expectedDeliveryDate, firstDeliveryOn: p.firstDeliveryOn, closed: p.status === 'received',
        orderedPacks: p.lines.reduce((a, l) => a + l.quantity, 0), receivedPacks: p.lines.reduce((a, l) => a + l.received, 0),
      })),
      issues: list.reduce((a, p) => a + (issuesByPo.get(p.id) ?? 0), 0),
    }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Purchase orders                                                     */
/* ------------------------------------------------------------------ */

export async function loadPo(req: FastifyRequest, db: Exec, organizationId: string, id: string) {
  await requireMember(req, db, organizationId);
  const [p] = await db.select().from(supplyPurchaseOrders).where(and(eq(supplyPurchaseOrders.id, id), eq(supplyPurchaseOrders.organizationId, organizationId)));
  if (!p || !(await canAt(req, db, organizationId, p.locationId, 'view'))) throw notFound('Purchase order');
  return p;
}

/** Creates a draft order in the location's currency from the supplier's catalogue (MOQ checked). */
export async function createPo(db: Exec, organizationId: string, input: PoCreate, by: string) {
  const loc = await locationRow(db, organizationId, input.locationId);
  const sup = await loadSupplier(db, organizationId, input.supplierId);
  if (sup.status !== 'active') throw conflict('supplier_not_active', `${sup.name} is ${sup.status}`);
  if (!supplierCovers(sup, loc)) throw conflict('supplier_not_approved_here', `${sup.name} is not approved for ${loc.name}`);
  const ids = [...new Set(input.lines.map((l) => l.itemId))];
  if (ids.length !== input.lines.length) throw validationError('Each item can appear once', { lines: 'Duplicate item' });
  const items = await db.select().from(supplyCatalogueItems).where(and(inArray(supplyCatalogueItems.id, ids), eq(supplyCatalogueItems.supplierId, sup.id), eq(supplyCatalogueItems.organizationId, organizationId)));
  const byId = new Map(items.map((i) => [i.id, i]));
  const bad = ids.filter((id) => !byId.get(id)?.active);
  if (bad.length) throw validationError('An item is not in this supplier’s active catalogue', { lines: bad.join(', ') });
  const currency = loc.currency;
  const unpriced = items.filter((i) => i.prices[currency] === undefined);
  if (unpriced.length) throw validationError(`No ${currency} price for ${unpriced.map((i) => i.sku).join(', ')}`, { lines: 'Not sold in this currency' });
  const moq = moqViolations(input.lines, byId);
  if (moq.length) throw new AppError(400, 'validation_failed', 'Below the minimum order quantity', Object.fromEntries(moq.map((id) => [`lines.${id}`, `Minimum ${byId.get(id)!.moq}`])));
  const lines: PoLine[] = input.lines.map((l) => {
    const i = byId.get(l.itemId)!;
    const unit = i.prices[currency]!;
    return { itemId: i.id, sku: i.sku, name: i.name, packLabel: i.packLabel, unitsPerPack: i.unitsPerPack, quantity: l.quantity, confirmedQuantity: null, received: 0, damaged: 0, unitPriceMinor: unit, totalMinor: unit * l.quantity, variantId: i.variantId, ingredientId: i.ingredientId };
  });
  return db.transaction(async (tx) => {
    const number = `SPO-${await nextNumber(tx, organizationId, 'supply_po', 1000)}`;
    const [po] = await tx.insert(supplyPurchaseOrders).values({
      organizationId, locationId: loc.id, supplierId: sup.id, number, status: 'draft', currency, lines, totalMinor: poTotal(lines), requestedDeliveryDate: input.requestedDeliveryDate,
      notes: input.notes, createdBy: by, history: [event('created', by)],
    }).returning();
    await audit(tx, { organizationId, actorUserId: by, action: 'supply_po.created', scopeKind: 'location', scopeId: loc.id, targetType: 'supply_purchase_order', targetId: po!.id, metadata: { number, totalMinor: po!.totalMinor, currency } });
    return po!;
  });
}

const email = (s: Services, to: string, subject: string, text: string, tag: string, attachments?: EmailAttachment[]) => s.jobs.enqueue('email.send', { to, subject, text, tag, ...(attachments?.length ? { attachments } : {}) });

/** Submits a draft: above the threshold it waits for HQ approval, otherwise it is sent to the supplier. */
export async function submitPo(s: Services, po: PurchaseOrder, by: string) {
  if (po.status !== 'draft' && po.status !== 'rejected') throw conflict('invalid_transition', `This order is ${po.status}`);
  const { approvalThresholds } = await settingsFor(s.db, po.organizationId);
  const needs = poNeedsApproval(po.totalMinor, po.currency, approvalThresholds);
  if (needs) {
    const [u] = await s.db.update(supplyPurchaseOrders).set({
      status: 'pending_approval', approval: { required: true, thresholdMinor: approvalThresholds[po.currency] ?? null, decision: null }, history: [...po.history, event('submitted_for_approval', by)], updatedAt: new Date(),
    }).where(and(eq(supplyPurchaseOrders.id, po.id), eq(supplyPurchaseOrders.status, po.status))).returning();
    if (!u) throw conflict('invalid_transition', 'This order changed. Reload and try again.');
    const approvers = (await usersWithCapability(s.db, po.organizationId, po.locationId, MODULE, 'publish')).filter((id) => id !== by);
    const [loc] = await s.db.select({ name: locations.name }).from(locations).where(eq(locations.id, po.locationId));
    const title = `Purchase order ${po.number} needs approval`;
    const body = `${loc?.name ?? ''}: ${major(po.totalMinor, po.currency)} ${po.currency}`;
    if (approvers.length) {
      await notify(s, { userIds: approvers, organizationId: po.organizationId, category: 'approval_request', title, body, data: { kind: 'supply_po', purchaseOrderId: po.id, link: `/suppliers/orders/${po.id}` } }).catch(() => {});
      const emails = await s.db.select({ email: users.email }).from(users).where(inArray(users.id, approvers));
      for (const e of emails) await email(s, e.email, title, `${body}\nReview it: ${s.cfg.APP_URL}/suppliers/orders/${po.id}`, 'supply_po_approval');
    }
    return { purchaseOrder: u, approvalRequired: true, confirmUrl: null as string | null };
  }
  const [u] = await s.db.update(supplyPurchaseOrders).set({ status: 'approved', approval: { required: false, thresholdMinor: approvalThresholds[po.currency] ?? null }, history: [...po.history, event('submitted', by)], updatedAt: new Date() })
    .where(and(eq(supplyPurchaseOrders.id, po.id), eq(supplyPurchaseOrders.status, po.status))).returning();
  if (!u) throw conflict('invalid_transition', 'This order changed. Reload and try again.');
  const sent = await sendPo(s, u, by);
  return { purchaseOrder: sent.purchaseOrder, approvalRequired: false, confirmUrl: sent.confirmUrl };
}

export async function decidePo(s: Services, po: PurchaseOrder, decision: 'approve' | 'reject', by: string, note: string | null) {
  if (po.status !== 'pending_approval') throw conflict('invalid_transition', 'Only an order waiting for approval can be decided');
  if (po.createdBy === by) throw forbidden('You cannot approve your own order');
  const approval = { ...po.approval, decision: decision === 'approve' ? ('approved' as const) : ('rejected' as const), decidedBy: by, decidedAt: new Date().toISOString(), note };
  const [u] = await s.db.update(supplyPurchaseOrders).set({ status: decision === 'approve' ? 'approved' : 'rejected', approval, history: [...po.history, event(decision === 'approve' ? 'approved' : 'rejected', by, note)], updatedAt: new Date() })
    .where(and(eq(supplyPurchaseOrders.id, po.id), eq(supplyPurchaseOrders.status, 'pending_approval'))).returning();
  if (!u) throw conflict('invalid_transition', 'This order changed. Reload and try again.');
  await audit(s.db, { organizationId: po.organizationId, actorUserId: by, action: decision === 'approve' ? 'supply_po.approved' : 'supply_po.rejected', scopeKind: 'location', scopeId: po.locationId, targetType: 'supply_purchase_order', targetId: po.id, metadata: { note } });
  if (po.createdBy) {
    const [c] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, po.createdBy));
    if (c) await email(s, c.email, `Purchase order ${po.number} ${decision === 'approve' ? 'approved' : 'rejected'}`, `${note ? `${note}\n` : ''}${s.cfg.APP_URL}/suppliers/orders/${po.id}`, 'supply_po_decided');
  }
  if (decision === 'approve') return sendPo(s, u!, by);
  return { purchaseOrder: u!, confirmUrl: null as string | null };
}

export const supplierPageUrl = (s: Services, token: string) => `${s.cfg.APP_URL.replace(/\/$/, '')}/supplier/${encodeURIComponent(token)}`;
export const supplierFileUrl = (s: Services, token: string, ext: 'pdf' | 'csv') => `${(s.cfg.PUBLIC_API_URL ?? '').replace(/\/$/, '')}/v1/public/supply/po/${encodeURIComponent(token)}/order.${ext}`;

/** Emails the order to the supplier with a magic link (view, PDF / CSV, confirm). Re-sending issues a new link. */
export async function sendPo(s: Services, po: PurchaseOrder, by: string | null) {
  if (!['approved', 'sent', 'confirmed'].includes(po.status)) throw conflict('invalid_transition', `This order is ${po.status}`);
  const sup = await loadSupplier(s.db, po.organizationId, po.supplierId);
  const to = sup.orderEmail ?? sup.contacts.find((c) => c.primary && c.email)?.email ?? sup.contacts.find((c) => c.email)?.email ?? null;
  const token = randomToken(24);
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, po.locationId));
  const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, po.organizationId));
  const today = localToday(loc?.timeZone);
  // Without a requested date, the slowest item's lead time sets the expected delivery.
  const leads = await s.db.select({ d: supplyCatalogueItems.leadTimeDays }).from(supplyCatalogueItems).where(inArray(supplyCatalogueItems.id, po.lines.map((l) => l.itemId)));
  const lead = Math.max(0, ...leads.map((r) => r.d));
  const expected = po.expectedDeliveryDate ?? po.requestedDeliveryDate ?? addDays(today, lead);
  const status = po.status === 'approved' ? 'sent' : po.status;
  const [u] = await s.db.update(supplyPurchaseOrders).set({
    status, confirmTokenHash: sha256(token), confirmTokenExpiresAt: new Date(Date.now() + 90 * 86_400_000), sentAt: new Date(), sentTo: to, expectedDeliveryDate: expected,
    history: [...po.history, event(po.status === 'approved' ? 'sent' : 'resent', by, to)], updatedAt: new Date(),
  }).where(eq(supplyPurchaseOrders.id, po.id)).returning();
  const url = supplierPageUrl(s, token);
  if (to) {
    const files = sup.orderFormat === 'both' ? `PDF: ${supplierFileUrl(s, token, 'pdf')}\nCSV: ${supplierFileUrl(s, token, 'csv')}` : `${sup.orderFormat.toUpperCase()}: ${supplierFileUrl(s, token, sup.orderFormat as 'pdf' | 'csv')}`;
    const lines = po.lines.map((l) => `- ${l.quantity} × ${l.sku} ${l.name}${l.packLabel ? ` (${l.packLabel})` : ''}`).join('\n');
    const deliverTo = [loc?.address?.line1, loc?.address?.city, loc?.address?.postalCode, loc?.address?.country].filter(Boolean).join(', ');
    // The order itself goes with the email: the PDF to read and the CSV to import (the links stay for later).
    const sent = { ...po, expectedDeliveryDate: expected };
    const attachments: EmailAttachment[] = [
      { filename: `${po.number}.pdf`, contentType: 'application/pdf', contentBase64: poPdf(sent, { orgName: org?.name ?? '', supplierName: sup.name, locationName: loc?.name ?? '', address: deliverTo }).toString('base64') },
      { filename: `${po.number}.csv`, contentType: 'text/csv', contentBase64: Buffer.from(poCsv(sent), 'utf8').toString('base64') },
    ];
    await email(s, to, `Purchase order ${po.number} from ${org?.name ?? ''} – ${loc?.name ?? ''}`,
      `Hello ${sup.name},\n\nPlease supply the following for ${loc?.name ?? ''} by ${expected}:\n${lines}\n\nTotal: ${major(po.totalMinor, po.currency)} ${po.currency}\n\nThe order is attached as PDF and CSV.\nView and confirm the order (no login needed): ${url}\n${files}\n\nDeliver to: ${deliverTo}`,
      'supply_po_sent', attachments);
  }
  await audit(s.db, { organizationId: po.organizationId, actorUserId: by, action: 'supply_po.sent', scopeKind: 'location', scopeId: po.locationId, targetType: 'supply_purchase_order', targetId: po.id, metadata: { to } });
  return { purchaseOrder: u!, confirmUrl: url };
}

/** Finds an order from a supplier's magic link (expired or unknown → 404). */
export async function poByToken(db: Exec, token: string) {
  const [p] = await db.select().from(supplyPurchaseOrders).where(eq(supplyPurchaseOrders.confirmTokenHash, sha256(token)));
  if (!p || !p.confirmTokenExpiresAt || p.confirmTokenExpiresAt < new Date() || p.status === 'cancelled') throw notFound('Purchase order');
  return p;
}

export async function publicPoView(s: Services, po: PurchaseOrder) {
  const [loc] = await s.db.select().from(locations).where(eq(locations.id, po.locationId));
  const [org] = await s.db.select({ name: organizations.name, defaultLocale: organizations.defaultLocale }).from(organizations).where(eq(organizations.id, po.organizationId));
  const [sup] = await s.db.select({ name: supplySuppliers.name, orderFormat: supplySuppliers.orderFormat }).from(supplySuppliers).where(eq(supplySuppliers.id, po.supplierId));
  if (!po.supplierViewedAt) await s.db.update(supplyPurchaseOrders).set({ supplierViewedAt: new Date() }).where(eq(supplyPurchaseOrders.id, po.id));
  return {
    number: po.number, status: po.status, currency: po.currency, totalMinor: po.totalMinor, requestedDeliveryDate: po.requestedDeliveryDate, expectedDeliveryDate: po.expectedDeliveryDate, notes: po.notes,
    organization: org?.name ?? '', supplier: sup?.name ?? '', orderFormat: sup?.orderFormat ?? 'pdf', locale: loc?.locale ?? org?.defaultLocale ?? 'en',
    deliverTo: { name: loc?.name ?? '', address: loc?.address ?? null, phone: loc?.phone ?? null },
    lines: po.lines.map((l) => ({ itemId: l.itemId, sku: l.sku, name: l.name, packLabel: l.packLabel, quantity: l.quantity, confirmedQuantity: l.confirmedQuantity, unitPriceMinor: l.unitPriceMinor, totalMinor: l.totalMinor })),
    confirmedAt: iso(po.confirmedAt), supplierReference: po.supplierReference, supplierNote: po.supplierNote, canConfirm: po.status === 'sent' || po.status === 'confirmed',
  };
}

export async function confirmPoBySupplier(s: Services, po: PurchaseOrder, input: { expectedDeliveryDate: string; reference?: string; note?: string; lines?: Array<{ itemId: string; confirmedQuantity: number }> }) {
  if (po.status !== 'sent' && po.status !== 'confirmed') throw conflict('invalid_transition', po.status === 'partially_received' || po.status === 'received' ? 'This order has already been delivered' : `This order is ${po.status}`);
  const conf = new Map((input.lines ?? []).map((l) => [l.itemId, l.confirmedQuantity]));
  const unknown = [...conf.keys()].filter((id) => !po.lines.some((l) => l.itemId === id));
  if (unknown.length) throw validationError('Unknown line', { lines: unknown.join(', ') });
  const lines = po.lines.map((l) => ({ ...l, confirmedQuantity: conf.has(l.itemId) ? conf.get(l.itemId)! : l.quantity }));
  const short = lines.filter((l) => (l.confirmedQuantity ?? l.quantity) < l.quantity);
  const [u] = await s.db.update(supplyPurchaseOrders).set({
    status: 'confirmed', lines, confirmedAt: new Date(), expectedDeliveryDate: input.expectedDeliveryDate, supplierReference: input.reference || null, supplierNote: input.note || null,
    history: [...po.history, event('confirmed_by_supplier', null, short.length ? `${short.length} line(s) confirmed short` : null)], updatedAt: new Date(),
  }).where(and(eq(supplyPurchaseOrders.id, po.id), inArray(supplyPurchaseOrders.status, ['sent', 'confirmed']))).returning();
  if (!u) throw conflict('invalid_transition', 'This order changed. Reload and try again.');
  await audit(s.db, { organizationId: po.organizationId, actorUserId: null, action: 'supply_po.confirmed', scopeKind: 'location', scopeId: po.locationId, targetType: 'supply_purchase_order', targetId: po.id, metadata: { expectedDeliveryDate: input.expectedDeliveryDate, shortLines: short.length } });
  if (po.createdBy) {
    const [c] = await s.db.select({ email: users.email }).from(users).where(eq(users.id, po.createdBy));
    if (c) await email(s, c.email, `${po.number} confirmed by the supplier for ${input.expectedDeliveryDate}`, `${short.length ? `${short.length} line(s) were confirmed short.\n` : ''}${input.note ?? ''}\n${s.cfg.APP_URL}/suppliers/orders/${po.id}`, 'supply_po_confirmed');
  }
  return u;
}

/**
 * Records a delivery: good packs count toward the order and restock the linked commerce variant or foods ingredient
 * (packs × units per pack); damaged packs and shortfalls are recorded as issues for the supplier scorecard.
 */
export async function receivePo(s: Services, poId: string, input: ReceiveInput, by: string) {
  return s.db.transaction(async (tx) => {
    const [po] = await tx.select().from(supplyPurchaseOrders).where(eq(supplyPurchaseOrders.id, poId)).for('update');
    if (!po) throw notFound('Purchase order');
    if (!['sent', 'confirmed', 'partially_received'].includes(po.status)) throw conflict('invalid_transition', po.status === 'received' ? 'This order is already fully received' : `Send the order before receiving (it is ${po.status})`);
    const unknown = input.lines.filter((l) => !po.lines.some((x) => x.itemId === l.itemId));
    if (unknown.length) throw validationError('A line is not on this order', { lines: unknown.map((l) => l.itemId).join(', ') });
    if (!input.lines.some((l) => l.received > 0 || (l.damaged ?? 0) > 0) && !input.closeShort) throw validationError('Receive at least one pack', { lines: 'Nothing received' });
    const [loc] = await tx.select({ timeZone: locations.timeZone }).from(locations).where(eq(locations.id, po.locationId));
    const today = localToday(loc?.timeZone);
    const r = applyReceipt(po.lines, input);
    const applied: InventoryApplied[] = [];
    for (const line of r.results) {
      const l = po.lines.find((x) => x.itemId === line.itemId)!;
      const units = line.received * l.unitsPerPack;
      if (!units) continue;
      if (l.variantId) {
        const [v] = await tx.select({ id: variants.id }).from(variants).where(and(eq(variants.id, l.variantId), eq(variants.organizationId, po.organizationId)));
        if (v) {
          await applyMovement(tx, { organizationId: po.organizationId, locationId: po.locationId, variantId: l.variantId, quantity: units, reason: 'received', reference: po.number, note: `Received against ${po.number}`, createdBy: by });
          applied.push({ itemId: l.itemId, kind: 'variant', targetId: l.variantId, units });
        }
      } else if (l.ingredientId) {
        const [g] = await tx.select({ id: foodIngredients.id }).from(foodIngredients).where(and(eq(foodIngredients.id, l.ingredientId), eq(foodIngredients.organizationId, po.organizationId)));
        if (g) {
          await tx.insert(foodIngredientStock).values({ organizationId: po.organizationId, locationId: po.locationId, ingredientId: l.ingredientId }).onConflictDoNothing();
          const [st] = await tx.select().from(foodIngredientStock).where(and(eq(foodIngredientStock.locationId, po.locationId), eq(foodIngredientStock.ingredientId, l.ingredientId))).for('update');
          const after = st!.onHand + units;
          await tx.update(foodIngredientStock).set({ onHand: after, updatedAt: new Date() }).where(eq(foodIngredientStock.id, st!.id));
          await tx.insert(foodIngredientMovements).values({ organizationId: po.organizationId, locationId: po.locationId, ingredientId: l.ingredientId, delta: units, reason: 'receive', balanceAfter: after, note: `Received against ${po.number}`, createdBy: by });
          applied.push({ itemId: l.itemId, kind: 'ingredient', targetId: l.ingredientId, units });
        }
      }
    }
    const status = r.complete || input.closeShort ? 'received' : 'partially_received';
    const [receipt] = await tx.insert(supplyReceipts).values({ organizationId: po.organizationId, purchaseOrderId: po.id, locationId: po.locationId, receivedOn: today, lines: r.results, issues: r.issues, note: input.note, inventory: applied, receivedBy: by }).returning();
    const [u] = await tx.update(supplyPurchaseOrders).set({
      lines: r.lines, status, firstDeliveryOn: po.firstDeliveryOn ?? today, receivedAt: status === 'received' ? new Date() : po.receivedAt, closedShort: !!input.closeShort && !r.complete,
      history: [...po.history, event(status === 'received' ? (r.complete ? 'received' : 'closed_short') : 'partially_received', by, r.issues ? `${r.issues} issue(s)` : null)], updatedAt: new Date(),
    }).where(eq(supplyPurchaseOrders.id, po.id)).returning();
    await audit(tx, { organizationId: po.organizationId, actorUserId: by, action: 'supply_po.received', scopeKind: 'location', scopeId: po.locationId, targetType: 'supply_purchase_order', targetId: po.id, metadata: { goodPacks: r.goodPacks, issues: r.issues, status, inventory: applied.length } });
    return { purchaseOrder: u!, receipt: receipt!, inventory: applied };
  });
}

export async function cancelPo(db: Exec, po: PurchaseOrder, by: string, reason: string | null) {
  if (!['draft', 'pending_approval', 'approved', 'rejected', 'sent', 'confirmed'].includes(po.status)) throw conflict('invalid_transition', `A ${po.status.replace('_', ' ')} order can't be cancelled`);
  const [u] = await db.update(supplyPurchaseOrders).set({ status: 'cancelled', confirmTokenHash: null, history: [...po.history, event('cancelled', by, reason)], updatedAt: new Date() }).where(eq(supplyPurchaseOrders.id, po.id)).returning();
  await audit(db, { organizationId: po.organizationId, actorUserId: by, action: 'supply_po.cancelled', scopeKind: 'location', scopeId: po.locationId, targetType: 'supply_purchase_order', targetId: po.id, metadata: { reason } });
  return u!;
}

export function serializePo(p: PurchaseOrder, extra: { locationName?: string | null; supplierName?: string | null; names?: Map<string, string>; receipts?: Array<typeof supplyReceipts.$inferSelect>; can?: Record<string, boolean>; today?: string } = {}) {
  const ordered = p.lines.reduce((a, l) => a + l.quantity, 0);
  const received = p.lines.reduce((a, l) => a + l.received, 0);
  return {
    id: p.id, number: p.number, status: p.status, locationId: p.locationId, locationName: extra.locationName ?? null, supplierId: p.supplierId, supplierName: extra.supplierName ?? null,
    currency: p.currency, totalMinor: p.totalMinor, lines: p.lines, requestedDeliveryDate: p.requestedDeliveryDate, expectedDeliveryDate: p.expectedDeliveryDate, notes: p.notes,
    approval: p.approval, sentAt: iso(p.sentAt), sentTo: p.sentTo, supplierViewedAt: iso(p.supplierViewedAt), confirmedAt: iso(p.confirmedAt), supplierNote: p.supplierNote, supplierReference: p.supplierReference,
    firstDeliveryOn: p.firstDeliveryOn, receivedAt: iso(p.receivedAt), closedShort: p.closedShort, packs: { ordered, received, damaged: p.lines.reduce((a, l) => a + l.damaged, 0) },
    late: !!extra.today && !!p.expectedDeliveryDate && ['sent', 'confirmed', 'partially_received'].includes(p.status) && p.expectedDeliveryDate < extra.today,
    createdBy: p.createdBy ? { id: p.createdBy, name: extra.names?.get(p.createdBy) ?? null } : null, createdAt: p.createdAt.toISOString(),
    history: p.history.map((h) => ({ ...h, byName: h.by ? extra.names?.get(h.by) ?? null : null })),
    receipts: (extra.receipts ?? []).map((r) => ({ id: r.id, receivedOn: r.receivedOn, lines: r.lines, issues: r.issues, note: r.note, inventory: r.inventory, receivedBy: r.receivedBy ? { id: r.receivedBy, name: extra.names?.get(r.receivedBy) ?? null } : null })),
    ...(extra.can ? { can: extra.can } : {}),
  };
}

/** The order as a PDF for the supplier. */
export function poPdf(p: PurchaseOrder, ctx: { orgName: string; supplierName: string; locationName: string; address: string }): Buffer {
  const m = (v: number) => `${major(v, p.currency)} ${p.currency}`;
  const t: PdfText[] = [];
  const lines: PdfLine[] = [];
  let y = 790;
  t.push({ x: 50, y, text: ctx.orgName, size: 16, bold: true });
  t.push({ x: 545, y, text: 'PURCHASE ORDER', size: 14, bold: true, align: 'right' });
  y -= 20;
  for (const [k, v] of [['Number', p.number], ['Supplier', ctx.supplierName], ['Deliver to', ctx.locationName], ['Address', ctx.address], ['Delivery by', p.expectedDeliveryDate ?? p.requestedDeliveryDate ?? '—'], ['Currency', p.currency]] as const) {
    t.push({ x: 50, y, text: k, size: 9, bold: true });
    t.push({ x: 150, y, text: v, size: 9 });
    y -= 13;
  }
  y -= 14;
  const head = (x: number, text: string, align: 'left' | 'right' = 'left') => t.push({ x, y, text, size: 9, bold: true, align });
  head(50, 'SKU'); head(140, 'Item'); head(390, 'Qty', 'right'); head(470, 'Unit', 'right'); head(545, 'Total', 'right');
  y -= 6;
  lines.push({ x1: 50, y1: y, x2: 545, y2: y });
  y -= 14;
  for (const l of p.lines) {
    t.push({ x: 50, y, text: l.sku.slice(0, 16), size: 9 });
    t.push({ x: 140, y, text: `${l.name}${l.packLabel ? ` (${l.packLabel})` : ''}`.slice(0, 48), size: 9 });
    t.push({ x: 390, y, text: String(l.quantity), size: 9, align: 'right' });
    t.push({ x: 470, y, text: major(l.unitPriceMinor, p.currency), size: 9, align: 'right' });
    t.push({ x: 545, y, text: major(l.totalMinor, p.currency), size: 9, align: 'right' });
    y -= 14;
    if (y < 80) break;
  }
  lines.push({ x1: 330, y1: y + 6, x2: 545, y2: y + 6 });
  y -= 8;
  t.push({ x: 330, y, text: 'Total', size: 10, bold: true });
  t.push({ x: 545, y, text: m(p.totalMinor), size: 10, bold: true, align: 'right' });
  if (p.notes) { y -= 26; t.push({ x: 50, y, text: `Notes: ${p.notes}`.slice(0, 110), size: 9 }); }
  return renderPdf([{ texts: t, lines }], { title: `Purchase order ${p.number}` });
}

export function poCsv(p: PurchaseOrder) {
  return toCsv(['po_number', 'sku', 'item', 'pack', 'quantity', 'unit_price', 'line_total', 'currency', 'delivery_by'],
    p.lines.map((l) => [p.number, l.sku, l.name, l.packLabel, l.quantity, major(l.unitPriceMinor, p.currency), major(l.totalMinor, p.currency), p.currency, p.expectedDeliveryDate ?? p.requestedDeliveryDate ?? '']));
}

/* ------------------------------------------------------------------ */
/* Rebates                                                             */
/* ------------------------------------------------------------------ */

export async function loadProgramme(db: Exec, organizationId: string, id: string) {
  const [p] = await db.select().from(supplyRebateProgrammes).where(and(eq(supplyRebateProgrammes.id, id), eq(supplyRebateProgrammes.organizationId, organizationId)));
  if (!p) throw notFound('Rebate programme');
  return p;
}

/**
 * Volume for a programme in a period: goods received (receipt date in the period) from the programme's supplier, in
 * its currency, for the covered items. Spend is good packs × the order's unit price.
 */
export async function rebateVolume(db: Exec, p: RebateProgramme, start: string, end: string) {
  const from = start < p.startsOn ? p.startsOn : start;
  const to = p.endsOn && p.endsOn < end ? p.endsOn : end;
  const rows = from > to ? [] : await db.select({ r: supplyReceipts, po: supplyPurchaseOrders, loc: locations.name }).from(supplyReceipts)
    .innerJoin(supplyPurchaseOrders, eq(supplyPurchaseOrders.id, supplyReceipts.purchaseOrderId)).innerJoin(locations, eq(locations.id, supplyReceipts.locationId))
    .where(and(eq(supplyReceipts.organizationId, p.organizationId), eq(supplyPurchaseOrders.supplierId, p.supplierId), eq(supplyPurchaseOrders.currency, p.currency), gte(supplyReceipts.receivedOn, from), lte(supplyReceipts.receivedOn, to)));
  const covered = (itemId: string) => !p.itemIds.length || p.itemIds.includes(itemId);
  const byLoc = new Map<string, { locationId: string; name: string; spendMinor: number; units: number; orders: Set<string> }>();
  let spendMinor = 0;
  let units = 0;
  for (const { r, po, loc } of rows) {
    for (const l of r.lines) {
      if (!covered(l.itemId) || !l.received) continue;
      const pl = po.lines.find((x) => x.itemId === l.itemId);
      if (!pl) continue;
      const amt = l.received * pl.unitPriceMinor;
      spendMinor += amt;
      units += l.received;
      const e = byLoc.get(r.locationId) ?? { locationId: r.locationId, name: loc, spendMinor: 0, units: 0, orders: new Set<string>() };
      e.spendMinor += amt;
      e.units += l.received;
      e.orders.add(po.id);
      byLoc.set(r.locationId, e);
    }
  }
  return { spendMinor, units, locations: [...byLoc.values()].map((e) => ({ locationId: e.locationId, name: e.name, spendMinor: e.spendMinor, units: e.units, orders: e.orders.size })).sort((a, b) => b.spendMinor - a.spendMinor) };
}

export async function programmeSummary(db: Exec, p: RebateProgramme, today: string) {
  const period = rebatePeriodOf(p.period as RebatePeriod, today);
  const vol = await rebateVolume(db, p, period.start, period.end);
  const accrual = computeRebate({ basis: p.basis as 'percent' | 'per_unit', measure: p.measure as 'spend' | 'units', tiers: p.tiers }, vol);
  const claims = await db.select().from(supplyRebateClaims).where(eq(supplyRebateClaims.programmeId, p.id)).orderBy(desc(supplyRebateClaims.periodStart));
  // The previous period, ready to claim when it has ended and has no claim yet.
  const prev = rebatePeriodOf(p.period as RebatePeriod, addDays(period.start, -1));
  const prevClaimed = claims.some((c) => c.periodStart === prev.start && c.status !== 'void');
  const prevVol = prevClaimed || prev.end < p.startsOn ? null : await rebateVolume(db, p, prev.start, prev.end);
  const prevAccrual = prevVol ? computeRebate({ basis: p.basis as 'percent' | 'per_unit', measure: p.measure as 'spend' | 'units', tiers: p.tiers }, prevVol) : null;
  return {
    current: { ...period, spendMinor: vol.spendMinor, units: vol.units, ...accrual, fundShareMinor: fundShareOf(accrual.accruedMinor, p.fundSharePct), locations: vol.locations },
    claimable: prevAccrual && prevAccrual.accruedMinor > 0 ? { ...prev, spendMinor: prevVol!.spendMinor, units: prevVol!.units, accruedMinor: prevAccrual.accruedMinor, tierIndex: prevAccrual.tierIndex } : null,
    claims: claims.map(serializeClaim),
  };
}

export function serializeProgramme(p: RebateProgramme, supplierName?: string | null) {
  return {
    id: p.id, supplierId: p.supplierId, supplierName: supplierName ?? null, name: p.name, basis: p.basis, measure: p.measure, currency: p.currency, tiers: p.tiers, period: p.period, startsOn: p.startsOn,
    endsOn: p.endsOn, itemIds: p.itemIds, fundSharePct: p.fundSharePct, active: p.active,
  };
}

export function serializeClaim(c: RebateClaim) {
  return {
    id: c.id, programmeId: c.programmeId, supplierId: c.supplierId, number: c.number, periodStart: c.periodStart, periodEnd: c.periodEnd, periodLabel: c.periodLabel, currency: c.currency,
    spendMinor: c.spendMinor, units: c.units, tierIndex: c.tierIndex, rate: c.rate, amountMinor: c.amountMinor, lines: c.lines, status: c.status, submittedAt: iso(c.submittedAt), receivedAt: iso(c.receivedAt),
    receivedMinor: c.receivedMinor, fundShareMinor: c.fundShareMinor, fundEntryId: c.fundEntryId, note: c.note, createdAt: c.createdAt.toISOString(),
  };
}

/** Raises a claim for an ended period, with a statement line per location (its share of the rebate by volume). */
export async function createClaim(db: Exec, p: RebateProgramme, periodStart: string, today: string, by: string) {
  const period = rebatePeriodOf(p.period as RebatePeriod, periodStart);
  if (period.end >= today) throw conflict('period_open', `The ${period.label} period has not ended yet`);
  const vol = await rebateVolume(db, p, period.start, period.end);
  const r = computeRebate({ basis: p.basis as 'percent' | 'per_unit', measure: p.measure as 'spend' | 'units', tiers: p.tiers }, vol);
  if (r.accruedMinor <= 0) throw conflict('nothing_to_claim', 'No rebate was earned in this period');
  const basisOf = (l: { spendMinor: number; units: number }) => (p.measure === 'units' ? l.units : l.spendMinor);
  const total = vol.locations.reduce((a, l) => a + basisOf(l), 0) || 1;
  let allocated = 0;
  const lines = vol.locations.map((l, i) => {
    const share = i === vol.locations.length - 1 ? r.accruedMinor - allocated : Math.floor((r.accruedMinor * basisOf(l)) / total);
    allocated += share;
    return { ...l, shareMinor: share };
  });
  return db.transaction(async (tx) => {
    const [dup] = await tx.select({ id: supplyRebateClaims.id }).from(supplyRebateClaims).where(and(eq(supplyRebateClaims.programmeId, p.id), eq(supplyRebateClaims.periodStart, period.start), sql`${supplyRebateClaims.status} <> 'void'`));
    if (dup) throw conflict('claim_exists', `A claim for ${period.label} already exists`);
    const number = `RBT-${await nextNumber(tx, p.organizationId, 'supply_rebate_claim', 100)}`;
    const [c] = await tx.insert(supplyRebateClaims).values({
      organizationId: p.organizationId, programmeId: p.id, supplierId: p.supplierId, number, periodStart: period.start, periodEnd: period.end, periodLabel: period.label, currency: p.currency,
      spendMinor: vol.spendMinor, units: vol.units, tierIndex: r.tierIndex, rate: r.rate, amountMinor: r.accruedMinor, lines, createdBy: by,
    }).returning();
    await audit(tx, { organizationId: p.organizationId, actorUserId: by, action: 'supply_rebate.claimed', targetType: 'supply_rebate_claim', targetId: c!.id, metadata: { number, amountMinor: r.accruedMinor, currency: p.currency, period: period.label } });
    return c!;
  });
}

/** Records the rebate as received; the programme's fund share is booked into the marketing fund ledger once. */
export async function receiveClaim(db: Exec, c: RebateClaim, p: RebateProgramme, amountMinor: number, receivedOn: string, by: string) {
  if (c.status !== 'submitted' && c.status !== 'draft') throw conflict('invalid_transition', `This claim is ${c.status}`);
  const [sup] = await db.select({ name: supplySuppliers.name }).from(supplySuppliers).where(eq(supplySuppliers.id, c.supplierId));
  return db.transaction(async (tx) => {
    const share = fundShareOf(amountMinor, p.fundSharePct);
    let fundEntryId: string | null = null;
    if (share > 0) {
      const [e] = await tx.insert(marketingFundEntries).values({
        organizationId: c.organizationId, kind: 'adjustment', currency: c.currency, amountMinor: share, occurredOn: receivedOn,
        description: `Supplier rebate share (${p.fundSharePct}%): ${sup?.name ?? ''} ${c.periodLabel}, claim ${c.number}`, vendor: sup?.name ?? null, createdBy: by,
      }).returning();
      fundEntryId = e!.id;
    }
    const [u] = await tx.update(supplyRebateClaims).set({ status: 'received', receivedAt: new Date(), receivedMinor: amountMinor, fundShareMinor: share, fundEntryId, updatedAt: new Date() })
      .where(and(eq(supplyRebateClaims.id, c.id), inArray(supplyRebateClaims.status, ['draft', 'submitted']))).returning();
    if (!u) throw conflict('invalid_transition', 'This claim changed. Reload and try again.');
    await audit(tx, { organizationId: c.organizationId, actorUserId: by, action: 'supply_rebate.received', targetType: 'supply_rebate_claim', targetId: c.id, metadata: { amountMinor, fundShareMinor: share } });
    return u;
  });
}

export function claimStatementCsv(c: RebateClaim, supplierName: string) {
  return toCsv(['claim', 'supplier', 'period', 'location', 'orders', 'packs', 'spend', 'rebate_share', 'currency'],
    [...c.lines.map((l) => [c.number, supplierName, c.periodLabel, l.name, l.orders, l.units, major(l.spendMinor, c.currency), major(l.shareMinor, c.currency), c.currency]),
      [c.number, supplierName, c.periodLabel, 'TOTAL', c.lines.reduce((a, l) => a + l.orders, 0), c.units, major(c.spendMinor, c.currency), major(c.amountMinor, c.currency), c.currency]]);
}

export function claimStatementPdf(c: RebateClaim, ctx: { orgName: string; supplierName: string; programmeName: string; basis: string }): Buffer {
  const t: PdfText[] = [];
  const lines: PdfLine[] = [];
  let y = 790;
  t.push({ x: 50, y, text: ctx.orgName, size: 16, bold: true });
  t.push({ x: 545, y, text: 'REBATE CLAIM', size: 14, bold: true, align: 'right' });
  y -= 20;
  const rate = ctx.basis === 'percent' ? `${(c.rate / 100).toFixed(2)}% of spend` : `${major(c.rate, c.currency)} ${c.currency} per pack`;
  for (const [k, v] of [['Claim', c.number], ['Supplier', ctx.supplierName], ['Programme', ctx.programmeName], ['Period', `${c.periodLabel} (${c.periodStart} to ${c.periodEnd})`], ['Rate', `Tier ${c.tierIndex + 1}: ${rate}`]] as const) {
    t.push({ x: 50, y, text: k, size: 9, bold: true });
    t.push({ x: 150, y, text: v, size: 9 });
    y -= 13;
  }
  y -= 14;
  const head = (x: number, text: string, align: 'left' | 'right' = 'left') => t.push({ x, y, text, size: 9, bold: true, align });
  head(50, 'Location'); head(330, 'Packs', 'right'); head(440, 'Spend', 'right'); head(545, 'Rebate', 'right');
  y -= 6;
  lines.push({ x1: 50, y1: y, x2: 545, y2: y });
  y -= 14;
  for (const l of c.lines) {
    t.push({ x: 50, y, text: l.name.slice(0, 40), size: 9 });
    t.push({ x: 330, y, text: String(l.units), size: 9, align: 'right' });
    t.push({ x: 440, y, text: major(l.spendMinor, c.currency), size: 9, align: 'right' });
    t.push({ x: 545, y, text: major(l.shareMinor, c.currency), size: 9, align: 'right' });
    y -= 14;
    if (y < 80) break;
  }
  lines.push({ x1: 300, y1: y + 6, x2: 545, y2: y + 6 });
  y -= 8;
  t.push({ x: 300, y, text: `Total due (${c.currency})`, size: 10, bold: true });
  t.push({ x: 545, y, text: major(c.amountMinor, c.currency), size: 10, bold: true, align: 'right' });
  return renderPdf([{ texts: t, lines }], { title: `Rebate claim ${c.number}` });
}

/* ------------------------------------------------------------------ */
/* Off-contract spend                                                  */
/* ------------------------------------------------------------------ */

export function serializeOffContract(s: Services, x: typeof supplyOffContract.$inferSelect, extra: { locationName?: string | null; names?: Map<string, string>; suggested?: string | null } = {}) {
  return {
    id: x.id, locationId: x.locationId, locationName: extra.locationName ?? null, vendorName: x.vendorName, description: x.description, category: x.category, amountMinor: x.amountMinor, currency: x.currency,
    purchasedOn: x.purchasedOn, reason: x.reason, note: x.note, receipt: x.receiptFileId ? { id: x.receiptFileId, url: signedFileUrl(s, x.receiptFileId) } : null, status: x.status, reviewNote: x.reviewNote,
    reviewedBy: x.reviewedBy ? { id: x.reviewedBy, name: extra.names?.get(x.reviewedBy) ?? null } : null, reviewedAt: iso(x.reviewedAt),
    suggestedSupplier: x.suggestedSupplierId ? { id: x.suggestedSupplierId, name: extra.suggested ?? null } : null,
    createdBy: x.createdBy ? { id: x.createdBy, name: extra.names?.get(x.createdBy) ?? null } : null, createdAt: x.createdAt.toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

/** HQ / location overview: orders waiting, deliveries due, issues, off-contract spend and spend per supplier (per currency). */
export async function supplyOverview(db: Exec, organizationId: string, allowed: 'all' | Set<string>, today: string) {
  const since = addDays(today, -90);
  const pos = (await db.select({ p: supplyPurchaseOrders, sup: supplySuppliers.name, loc: locations.name }).from(supplyPurchaseOrders)
    .innerJoin(supplySuppliers, eq(supplySuppliers.id, supplyPurchaseOrders.supplierId)).innerJoin(locations, eq(locations.id, supplyPurchaseOrders.locationId))
    .where(and(eq(supplyPurchaseOrders.organizationId, organizationId), sql`${supplyPurchaseOrders.createdAt} >= ${`${since}T00:00:00Z`}`))).filter((r) => inScope(allowed, r.p.locationId));
  const open = pos.filter((r) => ['sent', 'confirmed', 'partially_received'].includes(r.p.status));
  const off = (await db.select().from(supplyOffContract).where(and(eq(supplyOffContract.organizationId, organizationId), gte(supplyOffContract.purchasedOn, since)))).filter((x) => inScope(allowed, x.locationId));
  const spend = new Map<string, { supplierId: string; supplier: string; currency: string; amountMinor: number; orders: number }>();
  for (const r of pos) {
    if (['draft', 'pending_approval', 'rejected', 'cancelled'].includes(r.p.status)) continue;
    const k = `${r.p.supplierId}:${r.p.currency}`;
    const e = spend.get(k) ?? { supplierId: r.p.supplierId, supplier: r.sup, currency: r.p.currency, amountMinor: 0, orders: 0 };
    e.amountMinor += r.p.totalMinor;
    e.orders += 1;
    spend.set(k, e);
  }
  const offByCur = new Map<string, number>();
  for (const x of off) offByCur.set(x.currency, (offByCur.get(x.currency) ?? 0) + x.amountMinor);
  const onByCur = new Map<string, number>();
  for (const e of spend.values()) onByCur.set(e.currency, (onByCur.get(e.currency) ?? 0) + e.amountMinor);
  return {
    today,
    totals: {
      pendingApproval: pos.filter((r) => r.p.status === 'pending_approval').length, open: open.length, late: open.filter((r) => r.p.expectedDeliveryDate && r.p.expectedDeliveryDate < today).length,
      dueThisWeek: open.filter((r) => r.p.expectedDeliveryDate && r.p.expectedDeliveryDate >= today && r.p.expectedDeliveryDate <= addDays(today, 7)).length, offContractFlagged: off.filter((x) => x.status === 'flagged').length,
    },
    spendBySupplier: [...spend.values()].sort((a, b) => a.currency.localeCompare(b.currency) || b.amountMinor - a.amountMinor),
    /** On-contract vs off-contract spend per currency over 90 days (never combined across currencies). */
    compliance: [...new Set([...onByCur.keys(), ...offByCur.keys()])].sort().map((c) => {
      const on = onByCur.get(c) ?? 0;
      const offc = offByCur.get(c) ?? 0;
      return { currency: c, onContractMinor: on, offContractMinor: offc, onContractPct: on + offc ? Math.round((on / (on + offc)) * 1000) / 10 : null };
    }),
    deliveries: open.filter((r) => r.p.expectedDeliveryDate).sort((a, b) => a.p.expectedDeliveryDate!.localeCompare(b.p.expectedDeliveryDate!)).slice(0, 15)
      .map((r) => ({ id: r.p.id, number: r.p.number, status: r.p.status, supplierName: r.sup, locationName: r.loc, expectedDeliveryDate: r.p.expectedDeliveryDate, late: r.p.expectedDeliveryDate! < today })),
  };
}
