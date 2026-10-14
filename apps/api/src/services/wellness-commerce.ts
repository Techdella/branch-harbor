/**
 * Wellness packages (N sessions, expiry, sharing), gift vouchers (code, balance in one currency, expiry), and the
 * money side of cancellations/no-shows (policy fees settled from the deposit and voucher value; refunds of the rest).
 */
import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { Services } from '../context.ts';
import type { Exec, Tx } from '../db/client.ts';
import {
  appointments, locations, wellnessAppointmentCharges, wellnessClientPackages, wellnessGiftVouchers, wellnessPackagePlans, wellnessPackageRedemptions,
  wellnessVoucherTransactions, type paymentReferences,
} from '../db/schema/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, conflict, notFound, validationError } from '../lib/errors.ts';
import { isUniqueViolation } from '../lib/pg.ts';
import { audit } from './audit.ts';
import { refundPayment, reverseTargetPayment } from './payments.ts';
import { computeCancellation, depositPaid, groupMembers, type AppointmentRow, type CancelMode } from './wellness.ts';
import { services as servicesTable } from '../db/schema/index.ts';

type Voucher = typeof wellnessGiftVouchers.$inferSelect;
type ClientPackage = typeof wellnessClientPackages.$inferSelect;
type Plan = typeof wellnessPackagePlans.$inferSelect;
const DAY = 86400_000;

// ───────────────────────── Gift vouchers ─────────────────────────

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function voucherCode(): string {
  const b = randomBytes(8);
  const chars = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `GV-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}
export const normaliseCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');

export interface IssueVoucherInput {
  organizationId: string;
  locationId: string | null;
  amountMinor: number;
  currency: string;
  validityDays?: number;
  purchaserCustomerId?: string | null;
  recipientName?: string | null;
  recipientEmail?: string | null;
  message?: string | null;
  status: 'active' | 'pending_payment';
  createdBy?: string | null;
  code?: string;
}

export async function issueVoucher(db: Exec, input: IssueVoucherInput) {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw validationError('Voucher value must be a positive amount', { amountMinor: 'Must be > 0' });
  const manageToken = randomToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [v] = await db.insert(wellnessGiftVouchers).values({
        organizationId: input.organizationId, code: input.code ?? voucherCode(), locationId: input.locationId, initialMinor: input.amountMinor, balanceMinor: input.amountMinor,
        currency: input.currency, expiresAt: new Date(Date.now() + (input.validityDays ?? 365) * DAY), status: input.status, purchaserCustomerId: input.purchaserCustomerId ?? null,
        recipientName: input.recipientName ?? null, recipientEmail: input.recipientEmail ?? null, message: input.message ?? null, createdBy: input.createdBy ?? null, manageTokenHash: sha256(manageToken),
      }).returning();
      if (input.status === 'active') await db.insert(wellnessVoucherTransactions).values({ organizationId: input.organizationId, voucherId: v!.id, kind: 'issue', amountMinor: input.amountMinor, balanceAfterMinor: input.amountMinor, actorUserId: input.createdBy ?? null });
      return { voucher: v!, manageToken };
    } catch (err) {
      if (isUniqueViolation(err) && !input.code) continue;
      throw err;
    }
  }
  throw new AppError(500, 'voucher_code_failed', 'Could not generate a unique voucher code');
}

export async function activateVoucher(tx: Exec, voucherId: string, paymentId?: string | null) {
  const [v] = await tx.select().from(wellnessGiftVouchers).where(eq(wellnessGiftVouchers.id, voucherId)).for('update');
  if (!v) return { fulfilled: false, note: 'Voucher record missing' };
  if (v.status === 'active') return { fulfilled: true, note: 'Voucher already active' };
  if (v.status !== 'pending_payment') return { fulfilled: false, note: `Voucher is ${v.status}` };
  await tx.update(wellnessGiftVouchers).set({ status: 'active', paymentId: paymentId ?? v.paymentId, updatedAt: new Date() }).where(eq(wellnessGiftVouchers.id, v.id));
  await tx.insert(wellnessVoucherTransactions).values({ organizationId: v.organizationId, voucherId: v.id, kind: 'issue', amountMinor: v.initialMinor, balanceAfterMinor: v.balanceMinor });
  return { fulfilled: true, note: 'Voucher issued' };
}

export function serializeVoucher(v: Voucher, opts: { showCode?: boolean } = {}) {
  return {
    id: v.id, code: opts.showCode === false ? `${v.code.slice(0, 3)}••••-${v.code.slice(-4)}` : v.code, locationId: v.locationId,
    initial: { amount: v.initialMinor, currency: v.currency }, balance: { amount: v.balanceMinor, currency: v.currency },
    expiresAt: v.expiresAt.toISOString(), status: effectiveVoucherStatus(v), recipientName: v.recipientName, recipientEmail: v.recipientEmail, message: v.message,
    purchaserCustomerId: v.purchaserCustomerId, paymentId: v.paymentId, createdAt: v.createdAt.toISOString(),
  };
}

export const effectiveVoucherStatus = (v: Voucher, now = new Date()) => (v.status === 'active' && v.expiresAt <= now ? 'expired' : v.status);

/**
 * Apply a voucher to an appointment (or couples group). The voucher must be active, unexpired and in the
 * appointment currency; the balance never goes negative (row lock + CHECK constraint).
 */
export async function redeemVoucher(tx: Tx, input: { organizationId: string; code: string; members: AppointmentRow[]; actorUserId?: string | null }) {
  const code = normaliseCode(input.code);
  const [v] = await tx.select().from(wellnessGiftVouchers).where(and(eq(wellnessGiftVouchers.organizationId, input.organizationId), eq(wellnessGiftVouchers.code, code))).for('update');
  if (!v) throw conflict('voucher_not_found', 'That voucher code was not recognised');
  const status = effectiveVoucherStatus(v);
  if (status === 'expired') throw conflict('voucher_expired', `This voucher expired on ${v.expiresAt.toISOString().slice(0, 10)}`);
  if (status !== 'active') throw conflict('voucher_not_active', `This voucher is ${status.replace('_', ' ')}`);
  const currency = input.members[0]!.currency;
  if (v.currency !== currency) throw conflict('voucher_currency_mismatch', `This voucher is in ${v.currency} and can only be used for bookings in ${v.currency} (this booking is in ${currency})`, { voucherCurrency: v.currency, bookingCurrency: currency });
  let balance = v.balanceMinor;
  let applied = 0;
  for (const m of input.members) {
    const due = m.priceMinor - m.voucherAppliedMinor;
    const amt = Math.min(balance, Math.max(0, due));
    if (amt <= 0) continue;
    balance -= amt;
    applied += amt;
    await tx.update(appointments).set({ voucherAppliedMinor: m.voucherAppliedMinor + amt, depositMinor: Math.max(0, Math.min(m.depositMinor, m.priceMinor - m.voucherAppliedMinor - amt)), updatedAt: new Date() }).where(eq(appointments.id, m.id));
    await tx.insert(wellnessVoucherTransactions).values({ organizationId: v.organizationId, voucherId: v.id, kind: 'redeem', amountMinor: -amt, balanceAfterMinor: balance, appointmentId: m.id, actorUserId: input.actorUserId ?? null });
  }
  if (applied === 0) throw conflict('voucher_nothing_to_apply', v.balanceMinor === 0 ? 'This voucher has no balance left' : 'Nothing left to pay on this booking');
  await tx.update(wellnessGiftVouchers).set({ balanceMinor: balance, status: balance === 0 ? 'redeemed' : 'active', updatedAt: new Date() }).where(eq(wellnessGiftVouchers.id, v.id));
  return { voucherId: v.id, applied: { amount: applied, currency }, balance: { amount: balance, currency } };
}

/** Credit voucher value back for an appointment (cancellation within policy). */
export async function returnVoucherValue(tx: Tx, appointmentIds: string[], amount: number, actorUserId: string | null) {
  if (amount <= 0 || !appointmentIds.length) return 0;
  const txs = await tx.select().from(wellnessVoucherTransactions).where(and(inArray(wellnessVoucherTransactions.appointmentId, appointmentIds), eq(wellnessVoucherTransactions.kind, 'redeem'))).orderBy(asc(wellnessVoucherTransactions.createdAt));
  let left = amount;
  for (const t of txs) {
    if (left <= 0) break;
    const back = Math.min(left, -t.amountMinor);
    const [v] = await tx.select().from(wellnessGiftVouchers).where(eq(wellnessGiftVouchers.id, t.voucherId)).for('update');
    if (!v) continue;
    const balance = Math.min(v.initialMinor, v.balanceMinor + back);
    await tx.update(wellnessGiftVouchers).set({ balanceMinor: balance, status: v.status === 'redeemed' ? 'active' : v.status, updatedAt: new Date() }).where(eq(wellnessGiftVouchers.id, v.id));
    await tx.insert(wellnessVoucherTransactions).values({ organizationId: v.organizationId, voucherId: v.id, kind: 'reversal', amountMinor: back, balanceAfterMinor: balance, appointmentId: t.appointmentId, actorUserId });
    left -= back;
  }
  return amount - left;
}

// ───────────────────────── Packages ─────────────────────────

export function serializePlan(p: Plan) {
  return {
    id: p.id, locationId: p.locationId, name: p.name, description: p.description, serviceId: p.serviceId, variantId: p.variantId, sessions: p.sessions,
    price: { amount: p.priceMinor, currency: p.currency }, perSession: { amount: Math.round(p.priceMinor / p.sessions), currency: p.currency },
    validityDays: p.validityDays, sharing: p.sharing, maxSharedWith: p.maxSharedWith, onlinePurchasable: p.onlinePurchasable, active: p.active,
  };
}

export const effectivePackageStatus = (cp: ClientPackage, now = new Date()) => (cp.status === 'active' && cp.expiresAt && cp.expiresAt <= now ? 'expired' : cp.status);

export function serializeClientPackage(cp: ClientPackage, plan?: Plan | null) {
  return {
    id: cp.id, planId: cp.planId, name: plan?.name ?? null, serviceId: plan?.serviceId ?? null, variantId: plan?.variantId ?? null, customerId: cp.customerId, locationId: cp.locationId,
    sessionsTotal: cp.sessionsTotal, sessionsUsed: cp.sessionsUsed, sessionsRemaining: cp.sessionsTotal - cp.sessionsUsed,
    price: { amount: cp.priceMinor, currency: cp.currency }, purchasedAt: cp.purchasedAt?.toISOString() ?? null, expiresAt: cp.expiresAt?.toISOString() ?? null,
    status: effectivePackageStatus(cp), sharing: plan?.sharing ?? 'personal', sharedWithCustomerIds: cp.sharedWithCustomerIds, paidVia: cp.paidVia, paymentId: cp.paymentId,
  };
}

export async function loadPlanFor(db: Exec, organizationId: string, planId: string, locationId: string) {
  const [plan] = await db.select().from(wellnessPackagePlans).where(and(eq(wellnessPackagePlans.id, planId), eq(wellnessPackagePlans.organizationId, organizationId)));
  if (!plan || !plan.active) throw notFound('Package');
  const [loc] = await db.select().from(locations).where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)));
  if (!loc) throw notFound('Location');
  if ((plan.locationId && plan.locationId !== loc.id) || plan.currency !== loc.currency) throw conflict('not_offered_here', 'This package is not sold at this location');
  return { plan, loc };
}

export async function createClientPackage(db: Exec, input: { organizationId: string; locationId: string; plan: Plan; customerId: string; paidVia: 'in_person' | 'online'; status: 'active' | 'pending_payment' }) {
  const now = new Date();
  const manageToken = randomToken();
  const [cp] = await db.insert(wellnessClientPackages).values({
    organizationId: input.organizationId, locationId: input.locationId, planId: input.plan.id, customerId: input.customerId, sessionsTotal: input.plan.sessions,
    priceMinor: input.plan.priceMinor, currency: input.plan.currency, status: input.status, paidVia: input.paidVia, manageTokenHash: sha256(manageToken),
    purchasedAt: input.status === 'active' ? now : null, expiresAt: input.status === 'active' ? new Date(now.getTime() + input.plan.validityDays * DAY) : null,
  }).returning();
  return { clientPackage: cp!, manageToken };
}

export async function activatePackage(tx: Exec, id: string, paymentId?: string | null) {
  const [cp] = await tx.select().from(wellnessClientPackages).where(eq(wellnessClientPackages.id, id)).for('update');
  if (!cp) return { fulfilled: false, note: 'Package record missing' };
  if (cp.status === 'active') return { fulfilled: true, note: 'Package already active' };
  if (cp.status !== 'pending_payment') return { fulfilled: false, note: `Package is ${cp.status}` };
  const [plan] = await tx.select().from(wellnessPackagePlans).where(eq(wellnessPackagePlans.id, cp.planId));
  const now = new Date();
  await tx.update(wellnessClientPackages).set({ status: 'active', purchasedAt: now, expiresAt: new Date(now.getTime() + (plan?.validityDays ?? 365) * DAY), paymentId: paymentId ?? cp.paymentId, updatedAt: now }).where(eq(wellnessClientPackages.id, cp.id));
  return { fulfilled: true, note: 'Package active' };
}

/**
 * Redeem one session per guest from a package. Checks: active and not expired (also at the appointment time),
 * belongs to or is shared with the customer, matches the service (and variant), enough sessions left.
 */
export async function redeemPackage(tx: Tx, input: { organizationId: string; clientPackageId: string; members: AppointmentRow[]; customerId: string }) {
  const [cp] = await tx.select().from(wellnessClientPackages).where(and(eq(wellnessClientPackages.id, input.clientPackageId), eq(wellnessClientPackages.organizationId, input.organizationId))).for('update');
  if (!cp) throw conflict('package_not_found', 'Package not found');
  const now = new Date();
  if (cp.status === 'active' && cp.expiresAt && cp.expiresAt <= now) {
    await tx.update(wellnessClientPackages).set({ status: 'expired', updatedAt: now }).where(eq(wellnessClientPackages.id, cp.id));
    throw conflict('package_expired', 'This package has expired');
  }
  if (cp.status !== 'active') throw conflict(cp.status === 'exhausted' ? 'package_exhausted' : 'package_not_active', cp.status === 'exhausted' ? 'No sessions left in this package' : `This package is ${cp.status.replace('_', ' ')}`);
  const first = input.members[0]!;
  if (cp.expiresAt && first.startsAt >= cp.expiresAt) throw conflict('package_expires_before_appointment', `This package expires on ${cp.expiresAt.toISOString().slice(0, 10)}, before the appointment`);
  if (cp.customerId !== input.customerId && !cp.sharedWithCustomerIds.includes(input.customerId)) throw conflict('package_not_shared', 'This package belongs to another client and is not shared with this client');
  const [plan] = await tx.select().from(wellnessPackagePlans).where(eq(wellnessPackagePlans.id, cp.planId));
  if (!plan || plan.serviceId !== first.serviceId || (plan.variantId && plan.variantId !== first.variantId)) throw conflict('package_service_mismatch', 'This package does not cover this service option');
  const n = input.members.length;
  if (cp.sessionsTotal - cp.sessionsUsed < n) throw conflict('package_exhausted', 'Not enough sessions left in this package');
  const used = cp.sessionsUsed + n;
  await tx.update(wellnessClientPackages).set({ sessionsUsed: used, status: used >= cp.sessionsTotal ? 'exhausted' : 'active', updatedAt: now }).where(eq(wellnessClientPackages.id, cp.id));
  for (const m of input.members) {
    await tx.insert(wellnessPackageRedemptions).values({ organizationId: cp.organizationId, clientPackageId: cp.id, appointmentId: m.id, customerId: m.customerId });
    await tx.update(appointments).set({ clientPackageId: cp.id, depositMinor: 0, updatedAt: now }).where(eq(appointments.id, m.id));
  }
  return { clientPackageId: cp.id, sessionsRemaining: cp.sessionsTotal - used };
}

export async function reversePackageRedemptions(tx: Tx, appointmentIds: string[], reason: string) {
  if (!appointmentIds.length) return 0;
  const rows = await tx.select().from(wellnessPackageRedemptions).where(and(inArray(wellnessPackageRedemptions.appointmentId, appointmentIds), isNull(wellnessPackageRedemptions.reversedAt)));
  for (const r of rows) {
    await tx.update(wellnessPackageRedemptions).set({ reversedAt: new Date(), reversalReason: reason }).where(eq(wellnessPackageRedemptions.id, r.id));
    const [cp] = await tx.select().from(wellnessClientPackages).where(eq(wellnessClientPackages.id, r.clientPackageId)).for('update');
    if (!cp) continue;
    await tx.update(wellnessClientPackages).set({ sessionsUsed: Math.max(0, cp.sessionsUsed - 1), status: cp.status === 'exhausted' ? 'active' : cp.status, updatedAt: new Date() }).where(eq(wellnessClientPackages.id, cp.id));
  }
  return rows.length;
}

/** Mark packages and vouchers past their expiry. Expired value stops counting as liability. */
export async function expireStale(db: Exec, now = new Date()) {
  const p = await db.update(wellnessClientPackages).set({ status: 'expired', updatedAt: now }).where(and(eq(wellnessClientPackages.status, 'active'), lte(wellnessClientPackages.expiresAt, now))).returning({ id: wellnessClientPackages.id });
  const v = await db.update(wellnessGiftVouchers).set({ status: 'expired', updatedAt: now }).where(and(eq(wellnessGiftVouchers.status, 'active'), lte(wellnessGiftVouchers.expiresAt, now))).returning({ id: wellnessGiftVouchers.id, org: wellnessGiftVouchers.organizationId, bal: wellnessGiftVouchers.balanceMinor });
  for (const x of v) await db.insert(wellnessVoucherTransactions).values({ organizationId: x.org, voucherId: x.id, kind: 'expire', amountMinor: 0, balanceAfterMinor: x.bal, note: 'Expired with remaining balance' });
  return { packages: p.length, vouchers: v.length };
}

/** Called by the payments webhook processor for package and voucher purchases. */
export async function fulfilWellnessPurchase(tx: Tx, p: typeof paymentReferences.$inferSelect) {
  if (p.targetType === 'wellness_package') return activatePackage(tx, p.targetId!, p.id);
  if (p.targetType === 'wellness_voucher') return activateVoucher(tx, p.targetId!, p.id);
  return { fulfilled: false, note: `Unknown target ${p.targetType}` };
}

// ───────────────────────── Cancellation / no-show ─────────────────────────

export interface CancelOptions { organizationId?: string; mode: CancelMode; waiveFee?: boolean; reason?: string | null; actorUserId: string | null }

/**
 * Cancel (or mark no-show) an appointment and its couples group under the service policy: package session returned or
 * forfeited, voucher value returned or retained, fee settled from the deposit first; the rest of the deposit refunded.
 */
export async function applyCancellation(s: Services, appointmentId: string, opts: CancelOptions) {
  const done = await s.db.transaction(async (tx) => {
    const [a] = await tx.select().from(appointments).where(eq(appointments.id, appointmentId)).for('update');
    if (!a || (opts.organizationId && a.organizationId !== opts.organizationId)) throw notFound('Appointment');
    if (a.status !== 'confirmed') throw conflict('appointment_not_active', `Appointment is ${a.status}`);
    if (opts.mode === 'no_show' && a.startsAt > new Date()) throw conflict('not_started', 'A no-show can only be recorded after the start time');
    const members = await groupMembers(tx, a);
    const [svc] = await tx.select().from(servicesTable).where(eq(servicesTable.id, a.serviceId));
    const paymentId = members.find((m) => m.paymentId)?.paymentId ?? null;
    const dep = await depositPaid(tx, paymentId);
    const preview = computeCancellation({ members, svc: svc!, depositPaidMinor: dep.paid, paymentState: dep.state, now: new Date(), mode: opts.mode, waiveFee: opts.waiveFee });
    const ids = members.map((m) => m.id);
    const now = new Date();
    await tx.update(appointments).set({ status: opts.mode === 'no_show' ? 'no_show' : 'cancelled', cancelledAt: now, cancellationKind: preview.window, updatedAt: now }).where(inArray(appointments.id, ids));
    if (preview.packageSession === 'returned') await reversePackageRedemptions(tx, ids, `cancelled (${preview.window})`);
    if (preview.voucher.returned > 0) await returnVoucherValue(tx, ids, preview.voucher.returned, opts.actorUserId);
    if (preview.window === 'late' || preview.window === 'no_show') {
      const feeBase = Math.round((preview.price.amount * (preview.window === 'no_show' ? preview.policy.noShowFeePercent : preview.policy.lateCancelFeePercent)) / 100);
      if (feeBase > 0 && preview.packageSession !== 'forfeited') {
        await tx.insert(wellnessAppointmentCharges).values({
          organizationId: a.organizationId, locationId: a.locationId, appointmentId: a.id, kind: preview.window === 'no_show' ? 'no_show' : 'late_cancel',
          feeMinor: opts.waiveFee ? feeBase : preview.fee.amount, currency: a.currency, retainedFromDepositMinor: preview.deposit.retained, retainedFromVoucherMinor: preview.voucher.retained,
          outstandingMinor: preview.outstanding.amount, status: opts.waiveFee ? 'waived' : preview.outstanding.amount > 0 ? 'outstanding' : 'settled', createdBy: opts.actorUserId,
        }).onConflictDoNothing();
      }
    }
    await audit(tx, { organizationId: a.organizationId, actorUserId: opts.actorUserId, actorType: opts.actorUserId ? 'user' : 'system', action: opts.mode === 'no_show' ? 'appointment.no_show' : 'appointment.cancelled', scopeKind: 'location', scopeId: a.locationId, targetType: 'appointment', targetId: a.id, metadata: { window: preview.window, fee: preview.fee, refund: preview.deposit.refund, reason: opts.reason ?? null, group: ids.length > 1 } });
    return { a, members, preview, payment: dep.payment };
  });

  let payment: { action: string; refundState?: string; amount?: number } = { action: 'none' };
  const p = done.payment;
  if (p && p.state === 'succeeded' && done.preview.deposit.refund > 0) {
    try {
      const r = await refundPayment(s, p.id, done.preview.deposit.refund, { actorUserId: opts.actorUserId, reason: `Appointment ${done.preview.window === 'business' ? 'cancelled by the business' : 'cancelled'} — refund per policy` });
      payment = { action: 'refunded', refundState: r.refund.state, amount: done.preview.deposit.refund };
      await s.db.update(wellnessAppointmentCharges).set({ refundedMinor: done.preview.deposit.refund }).where(eq(wellnessAppointmentCharges.appointmentId, done.a.id));
    } catch (err) {
      s.log.error({ err, appointmentId }, 'policy refund failed');
      payment = { action: 'refund_failed' };
    }
  } else if (p && ['created', 'requires_action', 'processing'].includes(p.state)) {
    payment = await reverseTargetPayment(s, p.id, opts.actorUserId, 'Appointment cancelled before payment completed');
  } else if (p && p.state === 'succeeded' && done.preview.deposit.retained > 0) {
    payment = { action: 'retained', amount: done.preview.deposit.retained };
  }
  return { appointment: { ...done.a, status: opts.mode === 'no_show' ? 'no_show' : 'cancelled' }, members: done.members.map((m) => m.id), preview: done.preview, payment };
}

/** Sum of value still owed to clients: unused package sessions and voucher balances, per currency. */
export async function liabilities(db: Exec, organizationId: string, locationIds: string[] | null, now = new Date()) {
  const pk = await db.select().from(wellnessClientPackages).where(and(eq(wellnessClientPackages.organizationId, organizationId), eq(wellnessClientPackages.status, 'active')));
  const vs = await db.select().from(wellnessGiftVouchers).where(and(eq(wellnessGiftVouchers.organizationId, organizationId), eq(wellnessGiftVouchers.status, 'active')));
  const inScope = (l: string | null) => !locationIds || (!!l && locationIds.includes(l));
  const pkg = new Map<string, { currency: string; packages: number; sessionsRemaining: number; valueMinor: number }>();
  for (const cp of pk) {
    if (!inScope(cp.locationId) || (cp.expiresAt && cp.expiresAt <= now)) continue;
    const r = pkg.get(cp.currency) ?? { currency: cp.currency, packages: 0, sessionsRemaining: 0, valueMinor: 0 };
    const remaining = cp.sessionsTotal - cp.sessionsUsed;
    r.packages += 1;
    r.sessionsRemaining += remaining;
    r.valueMinor += Math.round((cp.priceMinor * remaining) / cp.sessionsTotal);
    pkg.set(cp.currency, r);
  }
  const vou = new Map<string, { currency: string; vouchers: number; balanceMinor: number }>();
  for (const v of vs) {
    if (!inScope(v.locationId) || v.expiresAt <= now) continue;
    const r = vou.get(v.currency) ?? { currency: v.currency, vouchers: 0, balanceMinor: 0 };
    r.vouchers += 1;
    r.balanceMinor += v.balanceMinor;
    vou.set(v.currency, r);
  }
  return { packages: [...pkg.values()], vouchers: [...vou.values()], definition: 'Unused, unexpired package sessions valued at the price paid per session, and unexpired voucher balances. Per currency; never combined.' };
}

