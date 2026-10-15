/**
 * Import wizard (Settings → Import, module `settings.import`).
 *
 * Upload (CSV or XLSX) → column mapping (auto-detected, migration templates for Mindbody, Glofox, Square, Shopify,
 * Fresha and Vagaro exports) → validation preview with row errors → dry run or run as a background job with progress →
 * undo within 24 hours (created records removed, updated records restored, invitations revoked).
 *
 * Rules: nothing is merged silently (customers match on email and only fill or replace the mapped fields, with the
 * previous values kept for the undo); consent is only recorded from an explicit consent column (an empty or
 * unrecognised value records nothing); rows the person may not write (outside their scope) are row errors.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  IMPORTABLE_ROLES, IMPORT_FIELDS, IMPORT_MAX_ROWS, IMPORT_UNDO_HOURS, autoDetectMapping, decimalToMinor, detectTemplate, importEntitiesFor, isValidTimeZone, migrationTemplate, normalizeHeader,
  parseBooleanish, parseDateish, suggestRole, SUPPORTED_CURRENCIES, type ImportEntity, type ImportMapping, type Role,
} from '@bh/shared';
import type { Services } from '../context.ts';
import type { Exec } from '../db/client.ts';
import {
  consentRecords, customers, hospRooms, hospRoomTypes, importBatchRecords, importBatches, invitations, leads, locations, memberships, menuItems, menus, organizations, ownerGroups, packs,
  products, realtyListings, regions, roleAssignments, users, variants,
} from '../db/schema/index.ts';
import { csvRecords } from '../lib/csv.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { conflict, notFound, validationError } from '../lib/errors.ts';
import { slugify } from '../lib/slug.ts';
import { readXlsx } from '../lib/xlsx.ts';
import { uniqueSlug } from '../routes/locations.ts';
import { audit } from './audit.ts';

export type BatchRow = typeof importBatches.$inferSelect;
type LocationRow = typeof locations.$inferSelect;
export interface RowError { row: number; field: string; code: string; message: string }
export interface Planned { row: number; action: 'create' | 'update' | 'skip'; data: Record<string, unknown>; errors: RowError[]; summary: string }
/** Who may write what (computed from the person's access when the batch is validated and again when it runs). */
export interface ImportAccess { locations: 'all' | string[]; orgWide: boolean }

const DAY = 86_400_000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Capability needed to import each entity (checked per row in the row's scope). */
export function moduleFor(entity: ImportEntity, industry: string): string {
  switch (entity) {
    case 'locations': return 'network.locations';
    case 'staff': return 'settings.team';
    case 'customers': return 'sales.customers';
    case 'leads': return 'sales.customer_pipeline';
    case 'memberships': return 'operations.memberships';
    case 'products': return industry === 'foods' ? 'operations.menu' : 'operations.catalogue';
    case 'properties': return industry === 'realty' ? 'operations.listings' : 'operations.rooms';
  }
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

export function parseUpload(filename: string, dataBase64: string): { format: 'csv' | 'xlsx'; headers: string[]; rows: string[][] } {
  const buf = Buffer.from(dataBase64, 'base64');
  if (!buf.length) throw validationError('The file is empty', { file: 'Empty file' });
  if (buf.length > MAX_UPLOAD_BYTES) throw validationError('The file is larger than 8 MB', { file: 'Too large' });
  const isZip = buf.readUInt32LE(0) === 0x04034b50;
  const format = isZip || /\.xlsx$/i.test(filename) ? 'xlsx' as const : 'csv' as const;
  let records: string[][];
  try {
    records = format === 'xlsx' ? readXlsx(buf) : csvRecords(buf.toString('utf8'));
  } catch (err) {
    throw validationError(`The file could not be read: ${(err as Error).message}`, { file: 'Unreadable file' });
  }
  const [head, ...rows] = records;
  const headers = (head ?? []).map((h) => h.trim());
  if (!headers.filter(Boolean).length) throw validationError('The first row must hold the column names', { file: 'No header row' });
  if (!rows.length) throw validationError('The file has no data rows', { file: 'No rows' });
  if (rows.length > IMPORT_MAX_ROWS) throw validationError(`At most ${IMPORT_MAX_ROWS} rows per import; split the file`, { file: `Max ${IMPORT_MAX_ROWS} rows` });
  return { format, headers, rows: rows.map((r) => headers.map((_, i) => (r[i] ?? '').trim())) };
}

export async function createBatch(s: Services, organizationId: string, input: { entity: ImportEntity; filename: string; dataBase64: string; templateKey?: string | null }, actorUserId: string) {
  const [org] = await s.db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!importEntitiesFor(org!.industry).includes(input.entity)) throw validationError(`${input.entity} cannot be imported for this industry`, { entity: 'Not available' });
  const parsed = parseUpload(input.filename, input.dataBase64);
  const template = input.templateKey ? migrationTemplate(input.templateKey) : detectTemplate(parsed.headers, input.entity);
  if (input.templateKey && (!template || template.entity !== input.entity)) throw validationError('That template is for another record type', { templateKey: 'Wrong template' });
  const { mapping } = autoDetectMapping(input.entity, parsed.headers, template);
  const [row] = await s.db.insert(importBatches).values({
    organizationId, entity: input.entity, templateKey: template?.key ?? null, filename: input.filename.slice(0, 200), format: parsed.format, headers: parsed.headers, rows: parsed.rows,
    mapping, options: { dateFormat: template?.dateFormat ?? 'ymd' }, totalRows: parsed.rows.length, createdBy: actorUserId,
  }).returning();
  await audit(s.db, { organizationId, actorUserId, action: 'import.uploaded', targetType: 'import_batch', targetId: row!.id, metadata: { entity: input.entity, rows: parsed.rows.length, template: template?.key ?? null } });
  return row!;
}

/* ------------------------------------------------------------------ */
/* Planning (validation)                                               */
/* ------------------------------------------------------------------ */

interface Ctx {
  organizationId: string;
  industry: string;
  currency: string;
  country: string;
  access: ImportAccess;
  options: Record<string, unknown>;
  locations: LocationRow[];
  byCode: Map<string, LocationRow>;
  defaultLocation: LocationRow | null;
  regions: Map<string, string>;
  groups: Map<string, string>;
  customersByEmail: Map<string, typeof customers.$inferSelect>;
  existingCodes: Set<string>;
  existingSkus: Set<string>;
  existingRefs: Set<string>;
  existingRooms: Set<string>;
  members: Set<string>;
  pendingInvites: Set<string>;
  seenKeys: Set<string>;
}

async function context(db: Exec, b: BatchRow, access: ImportAccess): Promise<Ctx> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, b.organizationId));
  const locs = (await db.select().from(locations).where(eq(locations.organizationId, b.organizationId))).filter((l) => !l.archivedAt);
  const byCode = new Map<string, LocationRow>();
  for (const l of locs) { byCode.set(l.code.toLowerCase(), l); if (!byCode.has(l.name.toLowerCase())) byCode.set(l.name.toLowerCase(), l); }
  const defaultLocation = typeof b.options.locationId === 'string' ? locs.find((l) => l.id === b.options.locationId) ?? null : null;
  const ctx: Ctx = {
    organizationId: b.organizationId, industry: org!.industry, currency: org!.defaultCurrency, country: org!.country, access, options: b.options, locations: locs, byCode, defaultLocation,
    regions: new Map((await db.select().from(regions).where(eq(regions.organizationId, b.organizationId))).map((r) => [r.name.toLowerCase(), r.id])),
    groups: new Map((await db.select().from(ownerGroups).where(eq(ownerGroups.organizationId, b.organizationId))).map((g) => [g.name.toLowerCase(), g.id])),
    customersByEmail: new Map(), existingCodes: new Set(locs.map((l) => l.code.toLowerCase())), existingSkus: new Set(), existingRefs: new Set(), existingRooms: new Set(), members: new Set(), pendingInvites: new Set(), seenKeys: new Set(),
  };
  if (b.entity === 'customers' || b.entity === 'memberships') {
    for (const c of await db.select().from(customers).where(and(eq(customers.organizationId, b.organizationId), isNull(customers.erasedAt)))) if (c.email) ctx.customersByEmail.set(c.email.toLowerCase(), c);
  }
  if (b.entity === 'products') {
    if (ctx.industry === 'commerce') for (const p of await db.select({ sku: products.sku }).from(products).where(eq(products.organizationId, b.organizationId))) ctx.existingSkus.add(p.sku.toLowerCase());
  }
  if (b.entity === 'properties') {
    if (ctx.industry === 'realty') for (const r of await db.select({ ref: realtyListings.reference }).from(realtyListings).where(eq(realtyListings.organizationId, b.organizationId))) ctx.existingRefs.add(r.ref.toLowerCase());
    else for (const r of await db.select({ loc: hospRooms.locationId, n: hospRooms.number }).from(hospRooms).where(eq(hospRooms.organizationId, b.organizationId))) ctx.existingRooms.add(`${r.loc}:${r.n.toLowerCase()}`);
  }
  if (b.entity === 'staff') {
    const m = await db.select({ email: users.email }).from(roleAssignments).innerJoin(users, eq(users.id, roleAssignments.userId)).where(eq(roleAssignments.organizationId, b.organizationId));
    for (const x of m) ctx.members.add(x.email.toLowerCase());
    for (const i of await db.select({ email: invitations.email }).from(invitations).where(and(eq(invitations.organizationId, b.organizationId), eq(invitations.status, 'pending')))) ctx.pendingInvites.add(i.email.toLowerCase());
  }
  return ctx;
}

const allowedAt = (ctx: Ctx, locationId: string | null) => (locationId ? ctx.access.locations === 'all' || ctx.access.locations.includes(locationId) : ctx.access.orgWide);

function valuesOf(b: BatchRow, mapping: ImportMapping, row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, idx] of Object.entries(mapping)) if (idx !== null && idx !== undefined) out[field] = (row[idx] ?? '').trim();
  return out;
}

function nameOf(v: Record<string, string>) {
  return (v.name || [v.first_name, v.last_name].filter(Boolean).join(' ')).trim();
}

function plan(ctx: Ctx, entity: ImportEntity, rowNo: number, v: Record<string, string>, dateFormat: 'ymd' | 'mdy' | 'dmy'): Planned {
  const errors: RowError[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ row: rowNo, field, code, message });
  const loc = () => {
    if (v.location_code) {
      const l = ctx.byCode.get(v.location_code.toLowerCase());
      if (!l) err('location_code', 'unknown_location', `No location with code or name "${v.location_code}"`);
      return l ?? null;
    }
    return ctx.defaultLocation;
  };
  const date = (field: string) => {
    if (!v[field]) return null;
    const d = parseDateish(v[field], dateFormat);
    if (!d) err(field, 'invalid_date', `"${v[field]}" is not a date`);
    return d;
  };
  const money = (field: string, currency: string, required = false) => {
    if (!v[field]) { if (required) err(field, 'required', 'Required'); return null; }
    const m = decimalToMinor(v[field]!.replace(/^[^\d-]+/, ''), currency);
    if (m === null || m < 0) err(field, 'invalid_amount', `"${v[field]}" is not an amount`);
    return m;
  };
  const int = (field: string) => {
    if (!v[field]) return null;
    const n = Number(v[field]);
    if (!Number.isInteger(n) || n < 0) err(field, 'invalid_number', `"${v[field]}" is not a whole number`);
    return Number.isInteger(n) ? n : null;
  };
  const requireField = (field: string, value: unknown) => { if (value === null || value === undefined || value === '') err(field, 'required', 'Required'); };
  const scope = (locationId: string | null) => { if (!allowedAt(ctx, locationId)) err(locationId ? 'location_code' : 'row', 'not_allowed', 'Outside your access'); };
  const dup = (key: string, field: string) => { if (ctx.seenKeys.has(key)) err(field, 'duplicate_in_file', 'Appears twice in this file'); ctx.seenKeys.add(key); };

  switch (entity) {
    case 'locations': {
      for (const fld of ['name', 'code', 'address_line1', 'city', 'country', 'time_zone', 'currency']) requireField(fld, v[fld]);
      const country = (v.country ?? '').toUpperCase();
      const currency = (v.currency ?? '').toUpperCase();
      if (country && !/^[A-Z]{2}$/.test(country)) err('country', 'invalid_country', 'Use a two-letter country code');
      if (currency && !(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) err('currency', 'invalid_currency', `Unsupported currency "${v.currency}"`);
      if (v.time_zone && !isValidTimeZone(v.time_zone)) err('time_zone', 'invalid_time_zone', `Unknown time zone "${v.time_zone}"`);
      if (v.code && ctx.existingCodes.has(v.code.toLowerCase())) err('code', 'duplicate_code', `Code "${v.code}" is already used`);
      if (v.code) dup(`code:${v.code.toLowerCase()}`, 'code');
      if (v.email && !EMAIL.test(v.email)) err('email', 'invalid_email', 'Invalid email');
      scope(null);
      return { row: rowNo, action: 'create', errors, summary: `${v.name ?? ''} (${v.code ?? ''})`, data: { ...v, country, currency } };
    }
    case 'staff': {
      const email = (v.email ?? '').toLowerCase();
      requireField('email', email);
      if (email && !EMAIL.test(email)) err('email', 'invalid_email', 'Invalid email');
      const mapped = ((ctx.options.roleMapping as Record<string, string> | undefined) ?? {})[v.role ?? ''] as Role | undefined;
      const role = mapped ?? suggestRole(v.role);
      if (!IMPORTABLE_ROLES.includes(role)) err('role', 'role_not_importable', `Role "${role}" cannot be assigned by import`);
      const l = loc();
      const needsLocation = ['location_manager', 'staff', 'marketing_contributor', 'franchise_owner', 'regional_manager'].includes(role);
      let scopeKind = 'organization';
      let scopeId: string | null = ctx.organizationId;
      if (needsLocation) {
        if (!l) err('location_code', 'location_required', 'This role needs a location');
        else if (role === 'franchise_owner') { scopeKind = 'owner_group'; scopeId = l.ownerGroupId; if (!scopeId) err('location_code', 'no_owner_group', 'The location has no owner group'); }
        else if (role === 'regional_manager') { scopeKind = 'region'; scopeId = l.regionId; if (!scopeId) err('location_code', 'no_region', 'The location has no region'); }
        else { scopeKind = 'location'; scopeId = l.id; }
      }
      scope(scopeKind === 'organization' ? null : l?.id ?? null);
      if (email) dup(`email:${email}`, 'email');
      const skip = ctx.members.has(email) || ctx.pendingInvites.has(email);
      return { row: rowNo, action: skip ? 'skip' : 'create', errors, summary: `${nameOf(v) || email} → ${role}`, data: { email, name: nameOf(v), role, sourceRole: v.role ?? '', scopeKind, scopeId, reason: skip ? 'already_member_or_invited' : null } };
    }
    case 'customers':
    case 'leads': {
      const email = (v.email ?? '').toLowerCase();
      const name = nameOf(v);
      if (!email && !v.phone) err('email', 'contact_required', 'An email or a phone number is required');
      if (email && !EMAIL.test(email)) err('email', 'invalid_email', 'Invalid email');
      if (entity === 'customers' && !name && !email) err('name', 'required', 'Required');
      const l = loc();
      scope(l?.id ?? null);
      const dob = entity === 'customers' ? date('date_of_birth') : null;
      const consentEmail = v.marketing_email !== undefined ? parseBooleanish(v.marketing_email) : null;
      const consentSms = v.marketing_sms !== undefined ? parseBooleanish(v.marketing_sms) : null;
      if (email) dup(`email:${email}`, 'email');
      if (entity === 'leads') {
        const status = (v.status ?? '').toLowerCase() || 'new';
        if (!['new', 'contacted', 'qualified', 'won', 'lost'].includes(status)) err('status', 'invalid_value', `Unknown status "${v.status}"`);
        return { row: rowNo, action: 'create', errors, summary: name || email || v.phone || '', data: { name: name || null, email: email || null, phone: v.phone || null, message: v.message || null, source: v.source || 'import', status, locationId: l?.id ?? null, marketingConsent: consentEmail === true } };
      }
      const existing = email ? ctx.customersByEmail.get(email) : undefined;
      return {
        row: rowNo, action: existing ? 'update' : 'create', errors, summary: name || email,
        data: { existingId: existing?.id ?? null, name: name || existing?.name || email, email: email || null, phone: v.phone || null, dateOfBirth: dob, notes: v.notes || null, locale: v.locale || null, locationId: l?.id ?? existing?.locationId ?? null, consentEmail, consentSms },
      };
    }
    case 'memberships': {
      const email = (v.customer_email ?? '').toLowerCase();
      requireField('customer_email', email);
      requireField('plan', v.plan);
      const cust = email ? ctx.customersByEmail.get(email) : undefined;
      if (email && !cust) err('customer_email', 'customer_not_found', 'No customer with this email: import customers first');
      const l = loc() ?? (cust?.locationId ? ctx.locations.find((x) => x.id === cust.locationId) ?? null : null);
      scope(l?.id ?? null);
      const currency = l?.currency ?? ctx.currency;
      const credits = int('credits_remaining');
      const total = int('credits_total');
      const raw = (v.kind ?? '').toLowerCase();
      const kind = raw ? (raw.includes('pack') || raw.includes('pass') || raw.includes('class') || raw.includes('credit') ? 'pack' : 'membership') : credits !== null ? 'pack' : 'membership';
      const starts = date('starts_on') ?? new Date().toISOString().slice(0, 10);
      const ends = date('ends_on');
      if (kind === 'pack' && credits === null) err('credits_remaining', 'required', 'Required for packs and passes');
      return { row: rowNo, action: 'create', errors, summary: `${email}: ${v.plan ?? ''}`, data: { customerId: cust?.id ?? null, kind, plan: v.plan, startsOn: starts, endsOn: ends, creditsRemaining: credits, creditsTotal: total ?? credits, priceMinor: money('price', currency), currency, locationId: l?.id ?? null } };
    }
    case 'products': {
      requireField('name', v.name);
      const currency = ((ctx.options.currency as string | undefined) ?? ctx.currency).toUpperCase();
      const price = money('price', currency, true);
      scope(null);
      if (ctx.industry === 'foods') {
        return { row: rowNo, action: 'create', errors, summary: v.name ?? '', data: { name: v.name, description: v.description || null, category: v.category || 'Imported', prices: price === null ? {} : { [currency]: price } } };
      }
      const sku = (v.sku || slugify(v.name ?? '').toUpperCase().slice(0, 40)).trim();
      if (sku && ctx.existingSkus.has(sku.toLowerCase())) err('sku', 'duplicate_sku', `SKU "${sku}" already exists`);
      if (sku) dup(`sku:${sku.toLowerCase()}`, 'sku');
      return { row: rowNo, action: 'create', errors, summary: `${v.name ?? ''} (${sku})`, data: { sku, name: v.name, description: v.description || null, productType: v.category || null, vendor: v.vendor || null, tags: (v.tags ?? '').split(/[,;|]/).map((t) => t.trim()).filter(Boolean), barcode: v.barcode || null, prices: price === null ? {} : { [currency]: price } } };
    }
    case 'properties': {
      requireField('reference', v.reference);
      const l = loc();
      if (!l) err('location_code', 'location_required', 'Choose the property or office (location)');
      scope(l?.id ?? null);
      if (ctx.industry === 'realty') {
        if (v.reference && ctx.existingRefs.has(v.reference.toLowerCase())) err('reference', 'duplicate_reference', `Reference "${v.reference}" already exists`);
        if (v.reference) dup(`ref:${v.reference.toLowerCase()}`, 'reference');
        requireField('address_line1', v.address_line1);
        requireField('city', v.city);
        const transaction = (v.transaction ?? 'sale').toLowerCase();
        if (!['sale', 'rent'].includes(transaction)) err('transaction', 'invalid_value', 'Use sale or rent');
        const price = money('price', l?.currency ?? ctx.currency, true);
        return { row: rowNo, action: 'create', errors, summary: `${v.reference ?? ''} ${v.name ?? ''}`.trim(), data: { reference: v.reference, title: v.name || v.reference, transaction, propertyType: (v.kind || 'house').toLowerCase(), addressLine1: v.address_line1, city: v.city, postalCode: v.postal_code || null, country: l?.country ?? ctx.country, priceMinor: price, currency: l?.currency ?? ctx.currency, bedrooms: int('capacity'), description: v.description || null, locationId: l?.id ?? null } };
      }
      if (l && v.reference && ctx.existingRooms.has(`${l.id}:${v.reference.toLowerCase()}`)) err('reference', 'duplicate_room', `Room "${v.reference}" already exists at this property`);
      if (l && v.reference) dup(`room:${l.id}:${v.reference.toLowerCase()}`, 'reference');
      return { row: rowNo, action: 'create', errors, summary: `${l?.name ?? ''} ${v.reference ?? ''}`.trim(), data: { number: v.reference, roomType: v.kind || 'Standard', floor: v.floor || null, capacity: int('capacity') ?? 2, notes: v.description || null, locationId: l?.id ?? null } };
    }
  }
}

export interface PlanResult { planned: Planned[]; errors: RowError[]; valid: number; invalid: number; creates: number; updates: number; skips: number }

export async function planBatch(db: Exec, b: BatchRow, access: ImportAccess): Promise<PlanResult> {
  const ctx = await context(db, b, access);
  const required = IMPORT_FIELDS[b.entity as ImportEntity].filter((f) => f.required).map((f) => f.key);
  const dateFormat = (b.options.dateFormat as 'ymd' | 'mdy' | 'dmy' | undefined) ?? 'ymd';
  const planned = b.rows.map((r, i) => plan(ctx, b.entity as ImportEntity, i + 2, valuesOf(b, b.mapping, r), dateFormat));
  // A required field without a mapped column is one error, not one per row.
  const unmapped = required.filter((k) => b.mapping[k] === null || b.mapping[k] === undefined);
  const errors = [...unmapped.map((k) => ({ row: 1, field: k, code: 'column_not_mapped', message: 'Map a column to this field' })), ...planned.flatMap((p) => p.errors)];
  const bad = new Set(planned.filter((p) => p.errors.length).map((p) => p.row));
  return {
    planned, errors, valid: planned.length - bad.size, invalid: bad.size,
    creates: planned.filter((p) => !p.errors.length && p.action === 'create').length, updates: planned.filter((p) => !p.errors.length && p.action === 'update').length, skips: planned.filter((p) => !p.errors.length && p.action === 'skip').length,
  };
}

/* ------------------------------------------------------------------ */
/* Applying                                                            */
/* ------------------------------------------------------------------ */

type Rec = { recordType: string; recordId: string; action: 'created' | 'updated'; previous?: Record<string, unknown> | null };

async function applyRow(s: Services, tx: Exec, b: BatchRow, ctx: { industry: string; menuId: string | null; regions: Map<string, string>; groups: Map<string, string>; invites: Array<{ email: string; token: string }> }, p: Planned): Promise<Rec[]> {
  const d = p.data as Record<string, any>;
  const org = b.organizationId;
  const out: Rec[] = [];
  switch (b.entity as ImportEntity) {
    case 'locations': {
      const parent = async (name: string | undefined, map: Map<string, string>, kind: 'region' | 'owner_group') => {
        if (!name) return null;
        const hit = map.get(name.toLowerCase());
        if (hit) return hit;
        const [row] = kind === 'region' ? await tx.insert(regions).values({ organizationId: org, name }).returning() : await tx.insert(ownerGroups).values({ organizationId: org, name }).returning();
        map.set(name.toLowerCase(), row!.id);
        out.push({ recordType: kind === 'region' ? 'regions' : 'owner_groups', recordId: row!.id, action: 'created' });
        return row!.id;
      };
      const regionId = await parent(d.region, ctx.regions, 'region');
      const ownerGroupId = await parent(d.owner_group, ctx.groups, 'owner_group');
      const [row] = await tx.insert(locations).values({
        organizationId: org, regionId, ownerGroupId, name: d.name, code: d.code, slug: await uniqueSlug(tx, org, d.name),
        address: { line1: d.address_line1, ...(d.address_line2 ? { line2: d.address_line2 } : {}), city: d.city, ...(d.state_region ? { region: d.state_region } : {}), ...(d.postal_code ? { postalCode: d.postal_code } : {}), country: d.country },
        country: d.country, timeZone: d.time_zone, currency: d.currency, phone: d.phone || null, email: d.email || null, status: 'draft',
      }).returning();
      out.push({ recordType: 'locations', recordId: row!.id, action: 'created' });
      return out;
    }
    case 'staff': {
      const token = randomToken();
      const [inv] = await tx.insert(invitations).values({ organizationId: org, email: d.email, role: d.role, scopeKind: d.scopeKind, scopeId: d.scopeId, tokenHash: sha256(token), invitedBy: b.createdBy, expiresAt: new Date(Date.now() + 14 * DAY) }).returning();
      if (b.options.sendInvites !== false) ctx.invites.push({ email: d.email, token });
      return [{ recordType: 'invitations', recordId: inv!.id, action: 'created' }];
    }
    case 'customers': {
      let id: string;
      if (d.existingId) {
        const [prev] = await tx.select().from(customers).where(eq(customers.id, d.existingId));
        const patch: Record<string, unknown> = {};
        for (const k of ['phone', 'dateOfBirth', 'notes', 'locale', 'locationId'] as const) if (d[k] !== null && d[k] !== undefined) patch[k] = d[k];
        if (d.name && d.name !== d.email) patch.name = d.name;
        await tx.update(customers).set({ ...patch, updatedAt: new Date() }).where(eq(customers.id, d.existingId));
        out.push({ recordType: 'customers', recordId: d.existingId, action: 'updated', previous: Object.fromEntries(Object.keys(patch).map((k) => [k, (prev as Record<string, unknown>)[k] ?? null])) });
        id = d.existingId;
      } else {
        const [row] = await tx.insert(customers).values({ organizationId: org, locationId: d.locationId, name: d.name, email: d.email, phone: d.phone, dateOfBirth: d.dateOfBirth, notes: d.notes, locale: d.locale }).returning();
        out.push({ recordType: 'customers', recordId: row!.id, action: 'created' });
        id = row!.id;
      }
      for (const [purpose, granted] of [['marketing_email', d.consentEmail], ['marketing_sms', d.consentSms]] as const) {
        if (granted === null || granted === undefined) continue;
        const [c] = await tx.insert(consentRecords).values({ organizationId: org, customerId: id, email: d.email, purpose, version: `import:${b.id}`, granted, source: `import:${b.templateKey ?? b.format}` }).returning();
        out.push({ recordType: 'consent_records', recordId: c!.id, action: 'created' });
      }
      return out;
    }
    case 'leads': {
      const [row] = await tx.insert(leads).values({ organizationId: org, locationId: d.locationId, source: d.source, name: d.name, email: d.email, phone: d.phone, message: d.message, status: d.status, marketingConsent: d.marketingConsent, updatedAt: new Date() }).returning();
      return [{ recordType: 'leads', recordId: row!.id, action: 'created' }];
    }
    case 'memberships': {
      const start = new Date(`${d.startsOn}T00:00:00Z`);
      const end = d.endsOn ? new Date(`${d.endsOn}T00:00:00Z`) : null;
      if (d.kind === 'pack') {
        const [row] = await tx.insert(packs).values({ organizationId: org, locationId: d.locationId, customerId: d.customerId, name: d.plan, creditsTotal: d.creditsTotal ?? d.creditsRemaining, creditsRemaining: d.creditsRemaining, expiresAt: end, priceMinor: d.priceMinor, currency: d.currency, source: 'import', status: end && end < new Date() ? 'expired' : d.creditsRemaining > 0 ? 'active' : 'exhausted' }).returning();
        return [{ recordType: 'packs', recordId: row!.id, action: 'created' }];
      }
      // Imported memberships have no saved payment method: they are not renewed automatically (recurring = false).
      const [row] = await tx.insert(memberships).values({ organizationId: org, locationId: d.locationId, customerId: d.customerId, plan: d.plan, status: end && end < new Date() ? 'cancelled' : 'active', priceMinor: d.priceMinor, currency: d.currency, startsAt: start, endsAt: end, recurring: false }).returning();
      return [{ recordType: 'memberships', recordId: row!.id, action: 'created' }];
    }
    case 'products': {
      if (ctx.industry === 'foods') {
        if (!ctx.menuId) {
          const [m] = await tx.insert(menus).values({ organizationId: org, name: `Imported ${new Date().toISOString().slice(0, 10)}`, status: 'draft', description: `Import ${b.filename}` }).returning();
          ctx.menuId = m!.id;
          out.push({ recordType: 'menus', recordId: m!.id, action: 'created' });
        }
        const [row] = await tx.insert(menuItems).values({ organizationId: org, menuId: ctx.menuId, category: d.category, name: d.name, description: d.description, prices: d.prices, sortOrder: p.row }).returning();
        out.push({ recordType: 'menu_items', recordId: row!.id, action: 'created' });
        return out;
      }
      const [prod] = await tx.insert(products).values({ organizationId: org, sku: d.sku, name: d.name, description: d.description, status: 'draft', productType: d.productType, vendor: d.vendor, tags: d.tags, updatedBy: b.createdBy }).returning();
      const [v] = await tx.insert(variants).values({ organizationId: org, productId: prod!.id, sku: d.sku, name: d.name, prices: d.prices, barcode: d.barcode }).returning();
      return [{ recordType: 'products', recordId: prod!.id, action: 'created' }, { recordType: 'variants', recordId: v!.id, action: 'created' }];
    }
    case 'properties': {
      if (ctx.industry === 'realty') {
        const [row] = await tx.insert(realtyListings).values({
          organizationId: org, locationId: d.locationId, reference: d.reference, transaction: d.transaction, propertyType: d.propertyType, status: 'draft', title: d.title, description: d.description,
          addressLine1: d.addressLine1, city: d.city, postalCode: d.postalCode, country: d.country, priceMinor: d.priceMinor, currency: d.currency, bedrooms: d.bedrooms, createdBy: b.createdBy,
        }).returning();
        return [{ recordType: 'realty_listings', recordId: row!.id, action: 'created' }];
      }
      const code = slugify(d.roomType).toUpperCase().slice(0, 20);
      let [type] = await tx.select().from(hospRoomTypes).where(and(eq(hospRoomTypes.locationId, d.locationId), sql`(lower(${hospRoomTypes.code}) = ${code.toLowerCase()} or lower(${hospRoomTypes.name}) = ${String(d.roomType).toLowerCase()})`));
      if (!type) {
        [type] = await tx.insert(hospRoomTypes).values({ organizationId: org, locationId: d.locationId, code, name: d.roomType, maxOccupancy: Math.max(1, d.capacity), baseOccupancy: Math.min(2, Math.max(1, d.capacity)) }).returning();
        out.push({ recordType: 'hosp_room_types', recordId: type!.id, action: 'created' });
      }
      const [room] = await tx.insert(hospRooms).values({ organizationId: org, locationId: d.locationId, roomTypeId: type!.id, number: d.number, floor: d.floor, notes: d.notes, sortOrder: p.row }).returning();
      out.push({ recordType: 'hosp_rooms', recordId: room!.id, action: 'created' });
      return out;
    }
  }
}

/** Background job: plans again (data may have changed since the preview), then writes valid rows in chunks with progress. */
export async function runBatch(s: Services, batchId: string) {
  const [b] = await s.db.select().from(importBatches).where(eq(importBatches.id, batchId));
  if (!b || b.status !== 'queued') return;
  await s.db.update(importBatches).set({ status: 'running', startedAt: new Date(), processedRows: 0, updatedAt: new Date() }).where(eq(importBatches.id, b.id));
  try {
    const access = (b.options.access ?? { locations: [], orgWide: false }) as ImportAccess;
    const r = await planBatch(s.db, b, access);
    const blocking = r.errors.filter((e) => e.code === 'column_not_mapped');
    if (blocking.length) throw new Error(`Map a column to: ${blocking.map((e) => e.field).join(', ')}`);
    const ok = r.planned.filter((p) => !p.errors.length);
    if (b.dryRun) {
      await s.db.update(importBatches).set({ status: 'completed', processedRows: b.totalRows, validRows: r.valid, errorRows: r.invalid, createdCount: r.creates, updatedCount: r.updates, skippedCount: r.skips + r.invalid, errors: r.errors.slice(0, 500), finishedAt: new Date(), updatedAt: new Date() }).where(eq(importBatches.id, b.id));
      return;
    }
    const ctx = {
      industry: (await s.db.select({ i: organizations.industry }).from(organizations).where(eq(organizations.id, b.organizationId)))[0]!.i,
      menuId: typeof b.options.menuId === 'string' ? b.options.menuId : null,
      regions: new Map((await s.db.select().from(regions).where(eq(regions.organizationId, b.organizationId))).map((x) => [x.name.toLowerCase(), x.id])),
      groups: new Map((await s.db.select().from(ownerGroups).where(eq(ownerGroups.organizationId, b.organizationId))).map((x) => [x.name.toLowerCase(), x.id])),
      invites: [] as Array<{ email: string; token: string }>,
    };
    let created = 0, updated = 0, processed = r.planned.length - ok.length;
    const failures: RowError[] = [];
    for (let i = 0; i < ok.length; i += 100) {
      const chunk = ok.slice(i, i + 100);
      for (const p of chunk) {
        if (p.action === 'skip') { processed++; continue; }
        try {
          // One savepoint per row: a row that fails (e.g. a race on a unique code) does not undo the others.
          const recs = await s.db.transaction(async (tx) => {
            const recs = await applyRow(s, tx, b, ctx, p);
            if (recs.length) await tx.insert(importBatchRecords).values(recs.map((x) => ({ organizationId: b.organizationId, batchId: b.id, rowNumber: p.row, recordType: x.recordType, recordId: x.recordId, action: x.action, previous: x.previous ?? null })));
            return recs;
          });
          if (p.action === 'update') updated++; else created++;
          void recs;
        } catch (err) {
          failures.push({ row: p.row, field: 'row', code: 'write_failed', message: (err as Error).message.slice(0, 300) });
        }
        processed++;
      }
      await s.db.update(importBatches).set({ processedRows: processed, createdCount: created, updatedCount: updated, updatedAt: new Date() }).where(eq(importBatches.id, b.id));
    }
    const [org] = await s.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, b.organizationId));
    for (const inv of ctx.invites) {
      await s.jobs.enqueue('email.send', {
        to: inv.email, subject: `You're invited to ${org?.name ?? 'BranchHarbor'} on BranchHarbor`,
        text: `You've been invited to join ${org?.name ?? 'your team'} on BranchHarbor.\nAccept: ${s.cfg.APP_URL}/invitations/accept?token=${encodeURIComponent(inv.token)}\nThis invitation expires in 14 days.`, tag: 'invitation',
      });
    }
    const errors = [...r.errors, ...failures];
    await s.db.update(importBatches).set({
      status: 'completed', processedRows: b.totalRows, validRows: r.valid - failures.length, errorRows: r.invalid + failures.length, createdCount: created, updatedCount: updated, skippedCount: r.skips + r.invalid + failures.length,
      errors: errors.slice(0, 500), finishedAt: new Date(), undoUntil: new Date(Date.now() + IMPORT_UNDO_HOURS * 3600_000), updatedAt: new Date(),
      options: { ...b.options, ...(ctx.menuId ? { menuId: ctx.menuId } : {}) },
    }).where(eq(importBatches.id, b.id));
    await audit(s.db, { organizationId: b.organizationId, actorUserId: b.createdBy, action: 'import.completed', targetType: 'import_batch', targetId: b.id, metadata: { entity: b.entity, created, updated, errors: errors.length } });
  } catch (err) {
    await s.db.update(importBatches).set({ status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date(), updatedAt: new Date() }).where(eq(importBatches.id, b.id));
  }
}

const TABLES: Record<string, any> = {
  locations, regions, owner_groups: ownerGroups, invitations, customers, consent_records: consentRecords, leads, packs, memberships, menus, menu_items: menuItems, products, variants,
  realty_listings: realtyListings, hosp_room_types: hospRoomTypes, hosp_rooms: hospRooms,
};

/** Undo within the window: restores updated records, removes created ones (newest first), revokes invitations. */
export async function rollbackBatch(s: Services, b: BatchRow, actorUserId: string) {
  if (b.status !== 'completed' || b.dryRun) throw conflict('import_not_undoable', 'Only a completed import (not a dry run) can be undone');
  if (!b.undoUntil || b.undoUntil < new Date()) throw conflict('undo_window_closed', `Imports can be undone for ${IMPORT_UNDO_HOURS} hours`);
  const recs = await s.db.select().from(importBatchRecords).where(eq(importBatchRecords.batchId, b.id));
  const kept: Array<{ recordType: string; recordId: string; reason: string }> = [];
  await s.db.transaction(async (tx) => {
    for (const r of [...recs].sort((a, b2) => b2.rowNumber - a.rowNumber || (b2.createdAt.getTime() - a.createdAt.getTime()))) {
      const table = TABLES[r.recordType];
      if (!table) continue;
      if (r.action === 'updated') {
        if (r.previous) await tx.update(table).set({ ...r.previous, updatedAt: new Date() }).where(eq(table.id, r.recordId));
        continue;
      }
      if (r.recordType === 'invitations') { await tx.update(invitations).set({ status: 'revoked' }).where(and(eq(invitations.id, r.recordId), eq(invitations.status, 'pending'))); continue; }
      if (r.recordType === 'locations') {
        const [l] = await tx.select({ status: locations.status }).from(locations).where(eq(locations.id, r.recordId));
        if (l && l.status !== 'draft') { kept.push({ recordType: r.recordType, recordId: r.recordId, reason: 'location_in_use' }); continue; }
      }
      if (r.recordType === 'regions' || r.recordType === 'owner_groups') {
        const col = r.recordType === 'regions' ? locations.regionId : locations.ownerGroupId;
        const used = await tx.select({ id: locations.id }).from(locations).where(eq(col, r.recordId));
        if (used.length) { kept.push({ recordType: r.recordType, recordId: r.recordId, reason: 'in_use' }); continue; }
      }
      try {
        await tx.transaction(async (sp) => { await sp.delete(table).where(eq(table.id, r.recordId)); });
      } catch {
        kept.push({ recordType: r.recordType, recordId: r.recordId, reason: 'referenced' });
      }
    }
    await tx.update(importBatches).set({ status: 'rolled_back', rolledBackAt: new Date(), rolledBackBy: actorUserId, rows: [], updatedAt: new Date() }).where(eq(importBatches.id, b.id));
  });
  await audit(s.db, { organizationId: b.organizationId, actorUserId, action: 'import.rolled_back', targetType: 'import_batch', targetId: b.id, metadata: { records: recs.length, kept: kept.length } });
  return { records: recs.length, kept };
}

export async function loadBatch(db: Exec, organizationId: string, id: string) {
  const [b] = await db.select().from(importBatches).where(and(eq(importBatches.id, id), eq(importBatches.organizationId, organizationId)));
  if (!b) throw notFound('Import');
  return b;
}

export function serializeBatch(b: BatchRow, opts: { sample?: boolean } = {}) {
  const { access: _a, ...options } = b.options as Record<string, unknown>;
  return {
    id: b.id, entity: b.entity, templateKey: b.templateKey, filename: b.filename, format: b.format, status: b.status, dryRun: b.dryRun, headers: b.headers, mapping: b.mapping, options,
    totalRows: b.totalRows, validRows: b.validRows, errorRows: b.errorRows, processedRows: b.processedRows, createdCount: b.createdCount, updatedCount: b.updatedCount, skippedCount: b.skippedCount,
    progressPct: b.totalRows ? Math.round((b.processedRows / b.totalRows) * 100) : 0, errors: b.errors.slice(0, 200), error: b.error,
    canUndo: b.status === 'completed' && !b.dryRun && !!b.undoUntil && b.undoUntil > new Date(), undoUntil: b.undoUntil?.toISOString() ?? null,
    startedAt: b.startedAt?.toISOString() ?? null, finishedAt: b.finishedAt?.toISOString() ?? null, rolledBackAt: b.rolledBackAt?.toISOString() ?? null, createdAt: b.createdAt.toISOString(),
    ...(opts.sample ? { sample: b.rows.slice(0, 5) } : {}),
  };
}

/** Purges parsed rows of finished batches after the undo window (personal data is not kept longer than needed). */
export async function purgeImportRows(db: Exec, now = new Date()) {
  const old = await db.select({ id: importBatches.id, status: importBatches.status, undoUntil: importBatches.undoUntil, createdAt: importBatches.createdAt }).from(importBatches);
  const ids = old.filter((b) => (b.undoUntil ? b.undoUntil < now : b.createdAt.getTime() < now.getTime() - 7 * DAY)).map((b) => b.id);
  if (ids.length) await db.update(importBatches).set({ rows: [] }).where(inArray(importBatches.id, ids));
  return ids.length;
}

export { normalizeHeader };
