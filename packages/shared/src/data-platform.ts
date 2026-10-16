/**
 * Network data platform (docs/API_INTEGRATIONS.md "Sales connectors", "Import wizard", "Bulk location launch",
 * "Network benchmarks"): pure helpers shared by the API and the apps.
 *
 * - Sales connectors normalise POS / booking sales into one daily row per location, business date, channel and
 *   currency: gross (everything the customer paid, tax and tips included), refunds, tax, tips, discounts (information
 *   only) and net = gross − refunds − tax − tips. Amounts are integer minor units, never converted between currencies.
 * - Gross-sales sources: exactly one per location (BranchHarbor payments, one connector, or a self-reported figure with
 *   evidence). Self-reported figures are compared with connector data when both exist (variance flags).
 * - Import wizard: entity field catalogue, header auto-detection, migration templates for common vendor exports,
 *   value parsers (booleans, dates, money) and role mapping.
 * - Benchmarks: k-anonymous cohorts (k ≥ 10 organisations), deterministic Laplace noise on published percentiles and
 *   interpolated "you vs similar networks" percentiles. Money metrics are compared within one currency only.
 */
import { minorUnitExponent, type Currency } from './money.ts';
import type { Industry } from './industries.ts';
import type { Role } from './permissions.ts';

/* ------------------------------------------------------------------ */
/* Sales connectors and gross-sales sources                            */
/* ------------------------------------------------------------------ */

export const SALES_CONNECTOR_PROVIDERS = ['square', 'toast', 'mindbody', 'shopify', 'lightspeed', 'clover'] as const;
export type SalesConnectorProvider = (typeof SALES_CONNECTOR_PROVIDERS)[number];

export const SALES_CHANNELS = ['in_store', 'online', 'delivery', 'other'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const SALES_SOURCE_KINDS = ['branchharbor', 'connector', 'self_reported'] as const;
export type SalesSourceKind = (typeof SALES_SOURCE_KINDS)[number];

/** How a provider connects: OAuth authorisation by the merchant, or a partner grant the merchant enables in the vendor's own back office. */
export type ConnectFlow = 'oauth' | 'partner_grant' | 'activation_link';

export interface SalesConnectorMeta {
  provider: SalesConnectorProvider;
  name: string;
  flow: ConnectFlow;
  /** Industries the vendor is typically used in (for sorting the catalogue; any location may connect any vendor). */
  industries: readonly Industry[];
  /** Configuration a person supplies (non-secret), e.g. the Toast restaurant GUID. */
  configFields: readonly string[];
}

export const SALES_CONNECTORS: readonly SalesConnectorMeta[] = [
  { provider: 'square', name: 'Square', flow: 'oauth', industries: ['foods', 'commerce', 'wellness', 'studios'], configFields: ['externalLocationId'] },
  { provider: 'toast', name: 'Toast', flow: 'partner_grant', industries: ['foods'], configFields: ['restaurantGuid'] },
  { provider: 'mindbody', name: 'Mindbody', flow: 'activation_link', industries: ['studios', 'wellness', 'sports'], configFields: ['siteId', 'externalLocationId'] },
  { provider: 'shopify', name: 'Shopify', flow: 'oauth', industries: ['commerce', 'foods'], configFields: ['shopDomain', 'externalLocationId'] },
  { provider: 'lightspeed', name: 'Lightspeed', flow: 'oauth', industries: ['commerce', 'foods'], configFields: ['series', 'domainPrefix', 'externalLocationId'] },
  { provider: 'clover', name: 'Clover', flow: 'oauth', industries: ['foods', 'commerce', 'wellness'], configFields: ['merchantId'] },
];

export const salesConnectorMeta = (p: string) => SALES_CONNECTORS.find((c) => c.provider === p);

export interface DailySalesFigures {
  grossMinor: number;
  refundsMinor: number;
  taxMinor: number;
  tipsMinor: number;
  discountsMinor: number;
  orderCount: number;
}

/** Net sales = gross − refunds − tax − tips (the default royalty basis before HQ's own basis rules). */
export function netSales(f: Pick<DailySalesFigures, 'grossMinor' | 'refundsMinor' | 'taxMinor' | 'tipsMinor'>): number {
  return f.grossMinor - f.refundsMinor - f.taxMinor - f.tipsMinor;
}

export function addFigures(a: DailySalesFigures, b: Partial<DailySalesFigures>): DailySalesFigures {
  return {
    grossMinor: a.grossMinor + (b.grossMinor ?? 0), refundsMinor: a.refundsMinor + (b.refundsMinor ?? 0), taxMinor: a.taxMinor + (b.taxMinor ?? 0),
    tipsMinor: a.tipsMinor + (b.tipsMinor ?? 0), discountsMinor: a.discountsMinor + (b.discountsMinor ?? 0), orderCount: a.orderCount + (b.orderCount ?? 0),
  };
}
export const zeroFigures = (): DailySalesFigures => ({ grossMinor: 0, refundsMinor: 0, taxMinor: 0, tipsMinor: 0, discountsMinor: 0, orderCount: 0 });

/**
 * Decimal amount (string or number as vendors send it, e.g. "12.30") → integer minor units for the currency, without
 * binary floating-point drift. Returns null for anything that is not a plain decimal number.
 */
export function decimalToMinor(value: unknown, currency: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const s = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(6) : '') : String(value).trim().replace(/[\s,](?=\d{3}\b)/g, '');
  const m = /^(-)?(\d*)(?:\.(\d+))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const exp = minorUnitExponent(currency.toUpperCase() as Currency);
  const frac = (m[3] ?? '').padEnd(exp + 1, '0');
  const whole = Number(m[2] || '0') * 10 ** exp + Number(frac.slice(0, exp) || '0');
  const rounded = whole + (Number(frac[exp] ?? '0') >= 5 ? 1 : 0);
  return m[1] ? -rounded : rounded;
}

/** Default variance threshold for self-reported vs connector sales: 5 % (in basis points). */
export const DEFAULT_VARIANCE_THRESHOLD_BPS = 500;

/**
 * Variance of a self-reported figure against observed (connector) sales of the same location, period and currency.
 * Positive = reported more than observed. Flagged when the absolute difference exceeds the threshold.
 */
export function salesVariance(reportedMinor: number, observedMinor: number, thresholdBps = DEFAULT_VARIANCE_THRESHOLD_BPS) {
  const diffMinor = reportedMinor - observedMinor;
  if (observedMinor === 0) return { diffMinor, pct: reportedMinor === 0 ? 0 : null, flagged: reportedMinor !== 0 };
  const pct = Math.round((diffMinor / Math.abs(observedMinor)) * 1000) / 10;
  return { diffMinor, pct, flagged: Math.abs(diffMinor) * 10_000 > Math.abs(observedMinor) * thresholdBps };
}

/** Local business dates between two YYYY-MM-DD dates, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

/* ------------------------------------------------------------------ */
/* Import wizard                                                       */
/* ------------------------------------------------------------------ */

export const IMPORT_ENTITIES = ['locations', 'staff', 'customers', 'memberships', 'products', 'properties', 'leads'] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export type ImportFieldType = 'text' | 'email' | 'phone' | 'date' | 'integer' | 'money' | 'boolean' | 'enum' | 'country' | 'currency' | 'timezone' | 'list';
export interface ImportField {
  key: string;
  type: ImportFieldType;
  required?: boolean;
  /** Header names (normalised) that map to this field automatically. */
  synonyms: readonly string[];
  values?: readonly string[];
}

const f = (key: string, type: ImportFieldType, synonyms: string[], extra: Partial<ImportField> = {}): ImportField => ({ key, type, synonyms: [key, ...synonyms], ...extra });

/** Consent fields are only ever set from an explicit column: an empty or missing value records nothing. */
export const CONSENT_FIELDS = ['marketing_email', 'marketing_sms'] as const;

export const IMPORT_FIELDS: Record<ImportEntity, readonly ImportField[]> = {
  locations: [
    f('name', 'text', ['location', 'location_name', 'site_name', 'studio', 'store_name'], { required: true }),
    f('code', 'text', ['location_code', 'store_code', 'site_code', 'id', 'reference'], { required: true }),
    f('address_line1', 'text', ['address', 'address1', 'street', 'street_address'], { required: true }),
    f('address_line2', 'text', ['address2', 'suite', 'unit']),
    f('city', 'text', ['town', 'locality'], { required: true }),
    f('state_region', 'text', ['state', 'province', 'region', 'county']),
    f('postal_code', 'text', ['zip', 'zip_code', 'postcode', 'post_code']),
    f('country', 'country', ['country_code'], { required: true }),
    f('time_zone', 'timezone', ['timezone', 'tz'], { required: true }),
    f('currency', 'currency', ['currency_code'], { required: true }),
    f('phone', 'phone', ['telephone', 'phone_number']),
    f('email', 'email', ['email_address']),
    f('region', 'text', ['region_name', 'area']),
    f('owner_group', 'text', ['franchisee', 'owner', 'owner_group_name', 'franchise_company']),
  ],
  staff: [
    f('name', 'text', ['full_name', 'staff_name', 'employee', 'employee_name']),
    f('first_name', 'text', ['firstname', 'given_name']),
    f('last_name', 'text', ['lastname', 'surname', 'family_name']),
    f('email', 'email', ['email_address', 'work_email'], { required: true }),
    f('role', 'text', ['job_title', 'position', 'title', 'staff_type', 'permission_level'], { required: true }),
    f('location_code', 'text', ['location', 'home_location', 'site', 'studio', 'store']),
    f('phone', 'phone', ['mobile', 'mobile_phone', 'cell_phone']),
  ],
  customers: [
    f('name', 'text', ['full_name', 'client_name', 'customer_name', 'member_name']),
    f('first_name', 'text', ['firstname', 'given_name']),
    f('last_name', 'text', ['lastname', 'surname', 'family_name']),
    f('email', 'email', ['email_address', 'e_mail']),
    f('phone', 'phone', ['mobile', 'mobile_phone', 'cell_phone', 'mobile_number', 'phone_number', 'telephone']),
    f('date_of_birth', 'date', ['birth_date', 'birthday', 'dob']),
    f('location_code', 'text', ['home_location', 'location', 'site', 'studio', 'store']),
    f('notes', 'text', ['note', 'memo', 'comments']),
    f('locale', 'text', ['language', 'preferred_language']),
    f('marketing_email', 'boolean', ['email_opt_in', 'accepts_email_marketing', 'accepts_marketing', 'email_marketing', 'email_subscription_status', 'email_promotions', 'send_promotional_emails', 'marketing_consent']),
    f('marketing_sms', 'boolean', ['sms_opt_in', 'accepts_sms_marketing', 'sms_marketing', 'text_promotions', 'sms_promotions']),
  ],
  memberships: [
    f('customer_email', 'email', ['email', 'email_address', 'client_email', 'member_email'], { required: true }),
    f('customer_name', 'text', ['name', 'client_name', 'member_name', 'full_name']),
    f('kind', 'enum', ['type', 'product_type', 'pricing_option_type'], { values: ['membership', 'pack', 'pass'] }),
    f('plan', 'text', ['membership', 'membership_name', 'pricing_option', 'product', 'plan_name', 'contract'], { required: true }),
    f('starts_on', 'date', ['start_date', 'membership_start_date', 'activation_date', 'purchase_date']),
    f('ends_on', 'date', ['end_date', 'expiry_date', 'expiration_date', 'membership_expiry_date']),
    f('credits_remaining', 'integer', ['credits', 'remaining', 'sessions_remaining', 'classes_remaining', 'remaining_count']),
    f('credits_total', 'integer', ['count', 'sessions', 'classes', 'total_credits']),
    f('price', 'money', ['amount', 'price_paid', 'monthly_price']),
    f('location_code', 'text', ['home_location', 'location', 'site', 'studio']),
  ],
  products: [
    f('name', 'text', ['title', 'product_name', 'item_name', 'item'], { required: true }),
    f('sku', 'text', ['variant_sku', 'item_sku', 'plu', 'code', 'handle']),
    f('description', 'text', ['body', 'body_html', 'item_description']),
    f('category', 'text', ['type', 'product_type', 'menu_category', 'reporting_category', 'collection']),
    f('price', 'money', ['variant_price', 'unit_price', 'retail_price', 'item_price'], { required: true }),
    f('vendor', 'text', ['brand', 'manufacturer']),
    f('tags', 'list', ['keywords']),
    f('barcode', 'text', ['variant_barcode', 'gtin', 'upc', 'ean']),
  ],
  properties: [
    f('reference', 'text', ['code', 'room_number', 'number', 'listing_id', 'ref'], { required: true }),
    f('name', 'text', ['title', 'room_name', 'headline']),
    f('kind', 'text', ['room_type', 'type', 'property_type', 'category']),
    f('location_code', 'text', ['property', 'location', 'office', 'hotel']),
    f('floor', 'text', ['level']),
    f('capacity', 'integer', ['max_occupancy', 'occupancy', 'sleeps', 'bedrooms']),
    f('transaction', 'enum', ['listing_type', 'sale_or_rent'], { values: ['sale', 'rent'] }),
    f('price', 'money', ['asking_price', 'rent', 'list_price']),
    f('address_line1', 'text', ['address', 'street']),
    f('city', 'text', ['town']),
    f('postal_code', 'text', ['zip', 'postcode']),
    f('description', 'text', ['details', 'notes']),
  ],
  leads: [
    f('name', 'text', ['full_name', 'contact_name', 'lead_name']),
    f('first_name', 'text', ['firstname', 'given_name']),
    f('last_name', 'text', ['lastname', 'surname']),
    f('email', 'email', ['email_address']),
    f('phone', 'phone', ['mobile', 'phone_number', 'cell_phone']),
    f('message', 'text', ['enquiry', 'inquiry', 'comments', 'interest']),
    f('source', 'text', ['lead_source', 'channel', 'utm_source']),
    f('status', 'enum', ['stage', 'lead_status'], { values: ['new', 'contacted', 'qualified', 'won', 'lost'] }),
    f('location_code', 'text', ['location', 'site', 'studio', 'store']),
    f('marketing_email', 'boolean', ['email_opt_in', 'accepts_marketing', 'marketing_consent']),
  ],
};

/** Which entities an industry can import (memberships for class businesses; products for retail and food; rooms or listings). */
export function importEntitiesFor(industry: Industry | string): ImportEntity[] {
  const out: ImportEntity[] = ['locations', 'staff', 'customers'];
  if (industry === 'studios') out.push('memberships');
  if (industry === 'commerce' || industry === 'foods') out.push('products');
  if (industry === 'hospitality' || industry === 'realty') out.push('properties');
  out.push('leads');
  return out;
}

/** "Email Address" → "email_address"; also strips BOMs, punctuation and accents. */
export function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, '').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface MigrationTemplate {
  key: string;
  vendor: 'mindbody' | 'glofox' | 'square' | 'shopify' | 'fresha' | 'vagaro';
  entity: ImportEntity;
  /** BranchHarbor field → header names in the vendor's standard export (as exported, not normalised). */
  columns: Record<string, readonly string[]>;
  /** Headers whose presence identifies the export. */
  signature: readonly string[];
  dateFormat: 'ymd' | 'mdy' | 'dmy';
}

/**
 * Column maps for the standard customer exports of the platforms franchisees most often leave. Based on the vendors'
 * documented export columns; the wizard always shows the detected mapping for review before anything is written.
 */
export const MIGRATION_TEMPLATES: readonly MigrationTemplate[] = [
  {
    key: 'mindbody_clients', vendor: 'mindbody', entity: 'customers', dateFormat: 'mdy', signature: ['Client ID', 'First Name', 'Last Name'],
    columns: { first_name: ['First Name'], last_name: ['Last Name'], email: ['Email'], phone: ['Mobile Phone', 'Cell Phone', 'Home Phone'], date_of_birth: ['Birth Date', 'Birthday'], location_code: ['Home Location'], notes: ['Notes'], marketing_email: ['Send Promotional Emails', 'Email Opt-in', 'Promotional Emails'], marketing_sms: ['Send Promotional Texts', 'SMS Opt-in'] },
  },
  {
    key: 'glofox_members', vendor: 'glofox', entity: 'customers', dateFormat: 'dmy', signature: ['First Name', 'Last Name', 'Membership', 'Member Since'],
    columns: { first_name: ['First Name'], last_name: ['Last Name'], email: ['Email'], phone: ['Phone', 'Phone Number'], date_of_birth: ['Date of Birth', 'Birthday'], location_code: ['Branch'], marketing_email: ['Receive Marketing', 'Consent Email', 'Email Marketing'], marketing_sms: ['Consent SMS', 'SMS Marketing'] },
  },
  {
    key: 'square_customers', vendor: 'square', entity: 'customers', dateFormat: 'ymd', signature: ['Square Customer ID', 'Email Address'],
    columns: { first_name: ['First Name'], last_name: ['Surname', 'Last Name'], email: ['Email Address'], phone: ['Phone Number'], date_of_birth: ['Birthday'], notes: ['Memo'], marketing_email: ['Email Subscription Status'] },
  },
  {
    key: 'shopify_customers', vendor: 'shopify', entity: 'customers', dateFormat: 'ymd', signature: ['First Name', 'Last Name', 'Accepts Email Marketing', 'Total Spent'],
    columns: { first_name: ['First Name'], last_name: ['Last Name'], email: ['Email'], phone: ['Phone', 'Default Address Phone'], notes: ['Note'], marketing_email: ['Accepts Email Marketing', 'Accepts Marketing'], marketing_sms: ['Accepts SMS Marketing'] },
  },
  {
    key: 'fresha_clients', vendor: 'fresha', entity: 'customers', dateFormat: 'dmy', signature: ['First Name', 'Last Name', 'Mobile Number', 'Accepts Marketing', 'Client Source'],
    columns: { first_name: ['First Name'], last_name: ['Last Name'], name: ['Full Name'], email: ['Email'], phone: ['Mobile Number', 'Telephone'], date_of_birth: ['Date of Birth', 'Birthday'], notes: ['Note', 'Notes'], marketing_email: ['Accepts Marketing'], marketing_sms: ['Accepts SMS Marketing'] },
  },
  {
    key: 'vagaro_customers', vendor: 'vagaro', entity: 'customers', dateFormat: 'mdy', signature: ['First Name', 'Last Name', 'Cell Phone', 'Customer Since'],
    columns: { first_name: ['First Name'], last_name: ['Last Name'], email: ['Email'], phone: ['Cell Phone', 'Day Phone', 'Night Phone'], date_of_birth: ['Birthday'], notes: ['Notes'], marketing_email: ['Email Promotions', 'Email Marketing'], marketing_sms: ['SMS Promotions', 'Text Marketing'] },
  },
  {
    key: 'mindbody_memberships', vendor: 'mindbody', entity: 'memberships', dateFormat: 'mdy', signature: ['Client ID', 'Pricing Option', 'Remaining'],
    columns: { customer_email: ['Email'], customer_name: ['Client Name', 'Client'], plan: ['Pricing Option', 'Contract'], starts_on: ['Activation Date', 'Sale Date'], ends_on: ['Expiration Date'], credits_remaining: ['Remaining'], credits_total: ['Count'], location_code: ['Home Location', 'Location'] },
  },
  {
    key: 'glofox_memberships', vendor: 'glofox', entity: 'memberships', dateFormat: 'dmy', signature: ['Membership Name', 'Membership Start Date'],
    columns: { customer_email: ['Email'], customer_name: ['Member Name', 'Name'], plan: ['Membership Name', 'Membership'], starts_on: ['Membership Start Date', 'Start Date'], ends_on: ['Membership Expiry Date', 'Expiry Date'], credits_remaining: ['Credits Remaining', 'Credits'], location_code: ['Branch'] },
  },
];

export const migrationTemplate = (key: string | null | undefined) => (key ? MIGRATION_TEMPLATES.find((t) => t.key === key) : undefined);

/** The vendor export these headers most likely come from (every signature column present), or null. */
export function detectTemplate(headers: readonly string[], entity?: ImportEntity): MigrationTemplate | null {
  const have = new Set(headers.map(normalizeHeader));
  const hits = MIGRATION_TEMPLATES.filter((t) => (!entity || t.entity === entity) && t.signature.every((s) => have.has(normalizeHeader(s))));
  return hits.sort((a, b) => b.signature.length - a.signature.length)[0] ?? null;
}

export type ImportMapping = Record<string, number | null>;

/**
 * Auto-detects which column feeds each field: a migration template's column names first, then exact synonyms, then
 * a header that starts with a synonym. Each column is used once. Returns field → column index (or null).
 */
export function autoDetectMapping(entity: ImportEntity, headers: readonly string[], template?: MigrationTemplate | null): { mapping: ImportMapping; matched: number } {
  const norm = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: ImportMapping = {};
  const take = (i: number) => { used.add(i); return i; };
  for (const fd of IMPORT_FIELDS[entity]) {
    let idx = -1;
    for (const col of template?.columns[fd.key] ?? []) {
      idx = norm.findIndex((h, i) => !used.has(i) && h === normalizeHeader(col));
      if (idx >= 0) break;
    }
    if (idx < 0) idx = norm.findIndex((h, i) => !used.has(i) && fd.synonyms.includes(h));
    mapping[fd.key] = idx >= 0 ? take(idx) : null;
  }
  for (const fd of IMPORT_FIELDS[entity]) {
    if (mapping[fd.key] !== null) continue;
    const idx = norm.findIndex((h, i) => !used.has(i) && h.length > 2 && fd.synonyms.some((s) => s.length > 3 && (h.startsWith(`${s}_`) || h.endsWith(`_${s}`))));
    mapping[fd.key] = idx >= 0 ? take(idx) : null;
  }
  return { mapping, matched: Object.values(mapping).filter((v) => v !== null).length };
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', 't', '1', 'x', 'subscribed', 'opted_in', 'opt_in', 'accepted', 'granted', 'on', 'oui', 'si', 'sim', 'ja']);
const FALSE_WORDS = new Set(['no', 'n', 'false', 'f', '0', 'unsubscribed', 'not_subscribed', 'opted_out', 'opt_out', 'declined', 'off', 'non', 'nao', 'nein', 'never_subscribed']);

/** Yes / no in the usual export spellings. Empty or unknown = null (consent is never assumed). */
export function parseBooleanish(v: string | null | undefined): boolean | null {
  const s = normalizeHeader(v ?? '');
  if (!s) return null;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

/** A date in ISO, or in day/month or month/day order as the export uses; returns YYYY-MM-DD or null. */
export function parseDateish(v: string | null | undefined, order: 'ymd' | 'mdy' | 'dmy' = 'ymd'): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let mm = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (mm) [y, m, d] = [Number(mm[1]), Number(mm[2]), Number(mm[3])];
  else if ((mm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T].*)?$/.exec(s))) {
    const a = Number(mm[1]);
    const b = Number(mm[2]);
    y = Number(mm[3]!.length === 2 ? `${Number(mm[3]) > 50 ? 19 : 20}${mm[3]}` : mm[3]);
    // Unambiguous when one part is above 12; otherwise follow the export's order.
    if (a > 12) [d, m] = [a, b];
    else if (b > 12) [m, d] = [a, b];
    else [m, d] = order === 'dmy' ? [b, a] : [a, b];
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Common staff titles in other systems → BranchHarbor role templates (the wizard shows this for review). */
const ROLE_WORDS: Array<[RegExp, Role]> = [
  [/\b(owner|franchisee|proprietor)\b/i, 'franchise_owner'],
  [/\b(general manager|gm|store manager|studio manager|location manager|manager|supervisor|lead)\b/i, 'location_manager'],
  [/\b(market|social|brand)\w*/i, 'content_social'],
  [/\b(admin|administrator|hq)\b/i, 'hq_admin'],
  [/\b(accountant|bookkeeper)\b/i, 'accountant'],
  [/\bfinance\b/i, 'finance_lead'],
];
export function suggestRole(label: string | null | undefined): Role {
  const s = (label ?? '').trim();
  for (const [re, role] of ROLE_WORDS) if (re.test(s)) return role;
  return 'staff';
}

/** Roles an import may assign (never the owner role: ownership is transferred deliberately, not by spreadsheet). */
export const IMPORTABLE_ROLES: readonly Role[] = ['hq_admin', 'operations_lead', 'marketing_lead', 'finance_lead', 'accountant', 'franchise_owner', 'location_manager', 'staff', 'content_social'];

/** Undo window for an import batch. */
export const IMPORT_UNDO_HOURS = 24;
export const IMPORT_MAX_ROWS = 5000;

/* ------------------------------------------------------------------ */
/* Bulk location launch                                                */
/* ------------------------------------------------------------------ */

export const LAUNCH_STEPS = ['location', 'website', 'listing', 'staff'] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];
export type LaunchItemStatus = 'queued' | 'running' | 'done' | 'failed';
/** Columns the launch spreadsheet accepts besides the location columns: staff emails and roles, listing details. */
export const LAUNCH_EXTRA_COLUMNS = ['staff_emails', 'staff_role', 'manager_email', 'listing_description', 'listing_categories', 'opening_date'] as const;

/* ------------------------------------------------------------------ */
/* Network benchmarks                                                  */
/* ------------------------------------------------------------------ */

export const BENCHMARK_METRICS = ['revenue_per_location', 'bookings_per_location', 'occupancy_pct', 'review_rating', 'audit_pass_rate', 'royalty_on_time_rate'] as const;
export type BenchmarkMetric = (typeof BENCHMARK_METRICS)[number];
/** Money metrics are compared within one currency only (never converted). */
export const MONEY_BENCHMARKS: ReadonlySet<BenchmarkMetric> = new Set(['revenue_per_location']);

/** Minimum number of distinct organisations in a cohort before anything about it is published. */
export const BENCHMARK_MIN_COHORT = 10;

export const BENCHMARK_REGIONS = ['north_america', 'latin_america', 'uk_ireland', 'europe', 'oceania', 'asia', 'middle_east_africa'] as const;
export type BenchmarkRegion = (typeof BENCHMARK_REGIONS)[number];
const REGION_OF: Record<string, BenchmarkRegion> = {
  US: 'north_america', CA: 'north_america',
  MX: 'latin_america', BR: 'latin_america', AR: 'latin_america', CL: 'latin_america', CO: 'latin_america', PE: 'latin_america',
  GB: 'uk_ireland', IE: 'uk_ireland',
  AU: 'oceania', NZ: 'oceania',
  JP: 'asia', SG: 'asia', HK: 'asia', IN: 'asia', MY: 'asia', PH: 'asia', ID: 'asia', KR: 'asia', TH: 'asia', VN: 'asia',
  AE: 'middle_east_africa', SA: 'middle_east_africa', ZA: 'middle_east_africa', NG: 'middle_east_africa', KE: 'middle_east_africa', GH: 'middle_east_africa', EG: 'middle_east_africa', IL: 'middle_east_africa', TR: 'middle_east_africa',
};
export function benchmarkRegion(country: string | null | undefined): BenchmarkRegion {
  return REGION_OF[(country ?? '').toUpperCase()] ?? 'europe';
}

export interface PercentilePoints { p10: number; p25: number; p50: number; p75: number; p90: number }

/** Linear-interpolated percentiles of a sample (no rounding). */
export function percentilePoints(values: readonly number[]): PercentilePoints | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (p: number) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return v[lo]! + (v[hi]! - v[lo]!) * (i - lo);
  };
  return { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}

/** FNV-1a 32-bit hash → [0, 1). Deterministic so a published cohort never changes between reads (no averaging attack). */
export function seededUnit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 0x1_0000_0000;
}

/** A Laplace(0, scale) draw from a seed (inverse CDF). */
export function laplaceNoise(seed: string, scale: number): number {
  const u = Math.min(0.999999, Math.max(0.000001, seededUnit(seed))) - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

/**
 * Publishes percentiles of a cohort with privacy protection: nothing below k organisations; Laplace noise scaled to
 * the cohort's spread and size (scale = IQR × 0.5 / n, at least `minScale`), then monotone and clamped to `bounds`.
 * The seed makes the noise fixed per cohort and period.
 */
export function privatePercentiles(values: readonly number[], seed: string, opts: { k?: number; minScale?: number; bounds?: [number, number]; digits?: number } = {}): (PercentilePoints & { cohortSize: number }) | null {
  const k = opts.k ?? BENCHMARK_MIN_COHORT;
  if (values.length < k) return null;
  const p = percentilePoints(values)!;
  const scale = Math.max(opts.minScale ?? 0, ((p.p75 - p.p25) * 0.5) / values.length);
  const keys = ['p10', 'p25', 'p50', 'p75', 'p90'] as const;
  const out = { ...p };
  const pow = 10 ** (opts.digits ?? 2);
  let prev = -Infinity;
  for (const key of keys) {
    let x = p[key] + laplaceNoise(`${seed}:${key}`, scale);
    if (opts.bounds) x = Math.min(opts.bounds[1], Math.max(opts.bounds[0], x));
    x = Math.max(prev, Math.round(x * pow) / pow);
    out[key] = x;
    prev = x;
  }
  // Cohort sizes are published in bands of 5 so the exact number of participants is not revealed.
  return { ...out, cohortSize: Math.floor(values.length / 5) * 5 };
}

/** Where a value sits among published percentile points, as a percentile rounded to 5 (0–100). */
export function percentileOf(value: number, p: PercentilePoints): number {
  const pts: Array<[number, number]> = [[10, p.p10], [25, p.p25], [50, p.p50], [75, p.p75], [90, p.p90]];
  let pct: number;
  if (value <= p.p10) pct = p.p10 > 0 && value >= 0 ? Math.max(0, 10 * (value / p.p10)) : value < p.p10 ? 5 : 10;
  else if (value >= p.p90) pct = 95;
  else {
    pct = 50;
    for (let i = 0; i < pts.length - 1; i++) {
      const [pa, va] = pts[i]!;
      const [pb, vb] = pts[i + 1]!;
      if (value >= va && value <= vb) { pct = vb === va ? pb : pa + ((value - va) / (vb - va)) * (pb - pa); break; }
    }
  }
  return Math.min(100, Math.max(0, Math.round(pct / 5) * 5));
}
