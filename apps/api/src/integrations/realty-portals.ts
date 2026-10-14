/**
 * Property-portal feed generators and validators.
 *
 *  - rightmove  (GB)      Rightmove Real Time Datafeed (RTDF v1.4.1) JSON — PUSH: SendProperty / RemoveProperty over
 *                         mutual TLS (see integrations/partners/rightmove.ts).
 *  - idealista  (ES/PT/IT) idealista JSON import format (customer + customerProperties[]) — PULL: signed hosted URL
 *                         (idealista can also take the same file by FTP; that upload is not automated here).
 *  - reso_xml   (US/CA)   Zillow-compatible listing feed XML (Zillow Listing Feed layout; RESO Data Dictionary names in
 *                         comments) — PULL: signed hosted URL registered with the portal / syndicator.
 *  - reaxml     (AU/NZ)   REAXML (realestate.com.au / Domain) — PULL: signed hosted URL; withdrawn/sold/leased
 *                         listings stay in the file with their status so portals remove them.
 *
 * Pure functions only: given listings + office config they validate and render. Delivery (push, hosted URL,
 * status per office) lives in services/realty-portals.ts. Nothing here claims a portal is live.
 *
 * ASSUMPTIONS (confirm with each portal during onboarding — codes come from their schemas, which are issued to
 * certified feed providers): Rightmove single-select integer codes (property_type, status, price_qualifier,
 * tenure_type, rent_frequency, media_type); idealista `featuresType` values; REAXML category names.
 */
import { fromSqm } from '@bh/shared';

export type PortalId = 'rightmove' | 'idealista' | 'reso_xml' | 'reaxml';
/** Old sandbox ids → new portal ids (kept so existing opt-ins keep working). */
export const LEGACY_PORTAL_IDS: Record<string, PortalId> = { rightmove_style: 'rightmove', idealista_style: 'idealista', zillow_style: 'reso_xml', realtor_ca_style: 'reso_xml' };

export interface PortalFields { priceQualifier: string | null; tenure: string | null; councilTaxBand: string | null; energyRating: string | null; availableFrom: string | null }

export interface FeedListing {
  id: string;
  reference: string;
  transaction: 'sale' | 'rent';
  propertyType: string;
  status: string;
  title: string;
  description: string | null;
  address: { line1: string; line2: string | null; city: string; region: string | null; postalCode: string | null; country: string };
  hideStreet: boolean;
  geo: { lat: number; lng: number } | null;
  price: { amount: number; currency: string };
  rentPeriod: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  areaSqm: number | null;
  lotSqm?: number | null;
  yearBuilt?: number | null;
  photos: Array<{ url: string; caption?: string | null }>;
  floorPlans: Array<{ url: string }>;
  virtualTourUrl: string | null;
  features: string[];
  agent: { name: string; email: string | null; phone: string | null; licence?: string | null } | null;
  office: { name: string; phone: string | null; email?: string | null; brokerageLicence: string | null };
  disclosures: Array<{ label: string; text: string }>;
  portalFields?: PortalFields;
  createdAt?: string;
  updatedAt?: string;
  listingUrl?: string | null;
}

export interface FeedMeta {
  generatedAt: string;
  organization: string;
  /** Office-level portal configuration (network/branch ids, customer code, agent id …). */
  config?: Record<string, unknown>;
  /** Sandbox output carries a visible notice; live output is exactly the portal format. */
  sandbox?: boolean;
}

export interface RemovedListing { id: string; reference: string; transaction: 'sale' | 'rent'; status: string; at: string; country?: string }

export interface PortalConfigField { key: string; label: string; required: boolean; secret?: boolean; help?: string }

export interface PortalAdapter {
  id: PortalId;
  name: string;
  description: string;
  format: 'xml' | 'json';
  countries: string[];
  /** push = we call the portal API; pull = the portal fetches our signed feed URL. */
  delivery: 'push' | 'pull';
  configFields: PortalConfigField[];
  validate(l: FeedListing): string[];
  build(listings: FeedListing[], meta: FeedMeta, removed?: RemovedListing[]): string;
}

// ───────── helpers ─────────

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const exp = (c: string) => (c === 'JPY' ? 0 : 2);
export const major = (m: { amount: number; currency: string }) => m.amount / 10 ** exp(m.currency);
const isHttp = (u: string) => /^https?:\/\//i.test(u);
const disclosure = (l: FeedListing, re: RegExp) => l.disclosures.find((d) => re.test(d.label))?.text?.trim() || null;

/** Business-supplied portal fields first, then a matching disclosure (e.g. a "Tenure" disclosure saying "Freehold"). */
export function portalFact(l: FeedListing, key: keyof PortalFields): string | null {
  const v = l.portalFields?.[key];
  if (v) return v;
  if (key === 'tenure') { const t = disclosure(l, /tenure/i); const m = t && /share of freehold|freehold|leasehold|commonhold|feudal|strata/i.exec(t); return m ? m[0].toLowerCase().replace(/ /g, '_') : null; }
  if (key === 'councilTaxBand') { const t = disclosure(l, /council tax/i); const m = t && (/\bband\s*([A-I])\b/i.exec(t) ?? /^([A-I])$/i.exec(t)); return m ? m[1]!.toUpperCase() : t && /exempt/i.test(t) ? 'exempt' : null; }
  if (key === 'energyRating') { const t = disclosure(l, /energ|epc|certificado/i); const m = t && /\b(A\+|A[1-4]?|B-?|[C-G])\b/.exec(t); return m ? m[1]! : t && /tr[aá]mite|in process/i.test(t) ? 'inProcess' : t && /exent|exempt/i.test(t) ? 'exempt' : null; }
  return null;
}

const common = (l: FeedListing, opts: { minPhotos?: number; minDescription?: number } = {}) => {
  const issues: string[] = [];
  const minPhotos = opts.minPhotos ?? 1;
  if (l.photos.length < minPhotos) issues.push(minPhotos === 1 ? 'At least one photo is required' : `At least ${minPhotos} photos are required`);
  if (l.photos.some((p) => !isHttp(p.url))) issues.push('Photo URLs must be public http(s) links');
  if (!l.description || l.description.trim().length < (opts.minDescription ?? 50)) issues.push(`Description must be at least ${opts.minDescription ?? 50} characters`);
  if (!(l.price.amount > 0) && portalFact(l, 'priceQualifier') !== 'poa') issues.push('Price is required');
  if (!l.agent) issues.push('A listing agent is required');
  return issues;
};
const onlyIn = (l: FeedListing, countries: string[], label: string) => (countries.includes(l.address.country) ? [] : [`Only ${label} listings fit this feed`]);

// ───────── Rightmove RTDF ─────────

const UK_POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/i;
/** RTDF single-select codes (assumed from the RTDF schema; confirm with the Rightmove Data Feed team). */
export const RIGHTMOVE_CODES = {
  channel: { sale: 1, rent: 2 },
  status: { available: 1, sstc: 2, under_offer: 4, reserved: 5, let_agreed: 6 },
  priceQualifier: { default: 0, poa: 1, guide_price: 2, fixed_price: 3, offers_in_excess_of: 4, oiro: 5, sale_by_tender: 6, from: 7, offers_over: 10, coming_soon: 15 } as Record<string, number>,
  tenure: { freehold: 1, leasehold: 2, feudal: 3, commonhold: 4, share_of_freehold: 5 } as Record<string, number>,
  rentFrequency: { week: 52, month: 12, quarter: 4, year: 1 } as Record<string, number>,
  media: { image: 1, floorplan: 2, virtual_tour: 4 },
  propertyType: { house: 0, townhouse: 22, apartment: 8, condo: 8, land: 20, other: 0 } as Record<string, number>,
};
const rmDate = (iso?: string) => {
  if (!iso) return undefined;
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

/** RTDF SendProperty body for one listing. */
export function rightmoveSendProperty(l: FeedListing, cfg: Record<string, unknown>) {
  const pc = UK_POSTCODE.exec((l.address.postalCode ?? '').trim());
  const qualifier = l.status === 'coming_soon' ? 'coming_soon' : portalFact(l, 'priceQualifier') ?? 'default';
  const tenure = portalFact(l, 'tenure');
  const band = portalFact(l, 'councilTaxBand');
  const status = l.status === 'under_offer' ? (l.transaction === 'sale' ? RIGHTMOVE_CODES.status.under_offer : RIGHTMOVE_CODES.status.let_agreed) : RIGHTMOVE_CODES.status.available;
  return {
    network: { network_id: Number(cfg.networkId) },
    branch: { branch_id: Number(cfg.branchId), channel: RIGHTMOVE_CODES.channel[l.transaction], overseas: false },
    property: {
      agent_ref: l.reference, published: true, property_type: RIGHTMOVE_CODES.propertyType[l.propertyType] ?? 0, status,
      create_date: rmDate(l.createdAt), update_date: rmDate(l.updatedAt),
      ...(l.transaction === 'rent' && portalFact(l, 'availableFrom') ? { date_available: portalFact(l, 'availableFrom')!.split('-').reverse().join('-') } : {}),
      address: {
        house_name_number: l.address.line1, address_2: l.address.line2 ?? undefined, town: l.address.city,
        postcode_1: pc?.[1]?.toUpperCase() ?? null, postcode_2: pc?.[2]?.toUpperCase() ?? null,
        // Public address: street name (no house number), town and outward postcode; the full address stays private to Rightmove.
        display_address: [l.hideStreet ? null : l.address.line1.replace(/^\s*(flat|apartment)?\s*[\d/-]+[a-z]?\s*,?\s*/i, ''), l.address.city, pc?.[1]?.toUpperCase()].filter(Boolean).join(', '),
        ...(l.geo ? { latitude: l.geo.lat, longitude: l.geo.lng } : {}),
      },
      price_information: {
        price: major(l.price), price_qualifier: RIGHTMOVE_CODES.priceQualifier[qualifier] ?? 0,
        ...(l.transaction === 'rent' ? { rent_frequency: RIGHTMOVE_CODES.rentFrequency[l.rentPeriod ?? 'month'] ?? 12 } : {}),
        ...(l.transaction === 'sale' && tenure && RIGHTMOVE_CODES.tenure[tenure] ? { tenure_type: RIGHTMOVE_CODES.tenure[tenure] } : {}),
      },
      details: {
        summary: l.title.slice(0, 1000), description: (l.description ?? '').slice(0, 32000), features: l.features.slice(0, 10).map((f) => f.slice(0, 200)),
        bedrooms: l.bedrooms ?? 0, ...(l.bathrooms != null ? { bathrooms: Math.floor(l.bathrooms) } : {}), ...(l.yearBuilt ? { year_built: l.yearBuilt } : {}),
        ...(band ? { council_tax_band: band === 'exempt' ? undefined : band, ...(band === 'exempt' ? { council_tax_exempt: true } : {}) } : {}),
      },
      media: [
        ...l.photos.map((p, i) => ({ media_type: RIGHTMOVE_CODES.media.image, media_url: p.url, caption: p.caption ?? undefined, sort_order: i + 1 })),
        ...l.floorPlans.map((p, i) => ({ media_type: RIGHTMOVE_CODES.media.floorplan, media_url: p.url, sort_order: i + 1 })),
        ...(l.virtualTourUrl ? [{ media_type: RIGHTMOVE_CODES.media.virtual_tour, media_url: l.virtualTourUrl }] : []),
      ],
    },
  };
}

export function rightmoveRemoveProperty(r: { reference: string; transaction: 'sale' | 'rent'; status: string; at?: string }, cfg: Record<string, unknown>) {
  const closed = r.status === 'sold' || r.status === 'let';
  return {
    network: { network_id: Number(cfg.networkId) },
    branch: { branch_id: Number(cfg.branchId), channel: RIGHTMOVE_CODES.channel[r.transaction] },
    property: { agent_ref: r.reference, ...(closed && r.at ? { transaction_date: rmDate(r.at)!.slice(0, 10) } : {}) },
  };
}

const rightmove: PortalAdapter = {
  id: 'rightmove', name: 'Rightmove', description: 'Rightmove Real Time Datafeed (RTDF) — UK sales and lettings, pushed per listing', format: 'json', countries: ['GB'], delivery: 'push',
  configFields: [
    { key: 'networkId', label: 'Network ID', required: true, help: 'Issued by the Rightmove Data Feed team for BranchHarbor as your feed provider' },
    { key: 'branchId', label: 'Branch ID', required: true, help: 'Your branch id on Rightmove' },
    { key: 'baseUrl', label: 'API base URL', required: false, help: 'Leave empty for production (https://adfapi.rightmove.co.uk); Rightmove issues separate test URLs' },
    { key: 'certificatePfxBase64', label: 'Client certificate (PKCS#12, base64)', required: true, secret: true },
    { key: 'certificatePassword', label: 'Certificate password', required: false, secret: true },
  ],
  validate: (l) => {
    const qualifier = portalFact(l, 'priceQualifier');
    const issues = [...common(l), ...onlyIn(l, ['GB'], 'UK')];
    if (!UK_POSTCODE.test((l.address.postalCode ?? '').trim())) issues.push('A full UK postcode is required (e.g. NW3 6TR)');
    if (l.bedrooms == null) issues.push('Number of bedrooms is required');
    if (l.title.length > 1000) issues.push('Summary must be 1,000 characters or fewer');
    if (l.propertyType === 'commercial') issues.push('Commercial property is not accepted on this residential feed');
    if (qualifier && RIGHTMOVE_CODES.priceQualifier[qualifier] === undefined) issues.push(`Unsupported price qualifier "${qualifier}"`);
    if (l.transaction === 'rent' && qualifier && !['default', 'poa'].includes(qualifier)) issues.push('Lettings accept only the default or POA price qualifier');
    if (l.transaction === 'rent' && !l.rentPeriod) issues.push('Rent frequency (weekly or monthly) is required');
    if (l.transaction === 'sale' && !portalFact(l, 'tenure')) issues.push('Tenure is required (material information supplied by the business)');
    if (!portalFact(l, 'councilTaxBand')) issues.push('Council tax band is required (material information supplied by the business)');
    if (l.floorPlans.some((p) => !isHttp(p.url))) issues.push('Floor plan URLs must be public http(s) links');
    return issues;
  },
  build: (ls, meta, removed = []) => JSON.stringify({
    ...(meta.sandbox ? { _notice: 'SANDBOX PREVIEW — the RTDF calls BranchHarbor would send. Nothing has been transmitted to Rightmove.' } : {}),
    generated: meta.generatedAt,
    send_property: ls.map((l) => rightmoveSendProperty(l, meta.config ?? {})),
    remove_property: removed.map((r) => rightmoveRemoveProperty(r, meta.config ?? {})),
  }, null, 2),
};

// ───────── idealista ─────────

const IDEALISTA_TYPES: Record<string, string> = { house: 'house_independent', townhouse: 'house_terraced', apartment: 'flat', condo: 'flat', land: 'land', commercial: 'premises', other: 'flat' };
const IDEALISTA_ENERGY = ['A', 'A+', 'A1', 'A2', 'A3', 'A4', 'B', 'B-', 'C', 'D', 'E', 'F', 'G', 'inProcess', 'exempt'];
const IDEALISTA_COUNTRY: Record<string, string> = { ES: 'Spain', PT: 'Portugal', IT: 'Italy' };
const IDEALISTA_LANG: Record<string, string> = { ES: 'spanish', PT: 'portuguese', IT: 'italian' };

export function idealistaProperty(l: FeedListing) {
  const energy = portalFact(l, 'energyRating');
  const m = /^(.*?)[\s,]+(\d+[A-Za-z]?)\s*$/.exec(l.address.line1);
  return {
    propertyCode: l.id, propertyReference: l.reference, propertyVisibility: 'idealista',
    propertyOperation: { operationType: l.transaction, operationPrice: major(l.price) },
    propertyContact: { contactName: l.agent?.name ?? l.office.name, contactEmail: l.agent?.email ?? l.office.email ?? undefined, contactPrimaryPhoneNumber: l.agent?.phone ?? l.office.phone ?? undefined },
    propertyAddress: {
      addressVisibility: l.hideStreet ? 'hidden' : 'full', addressStreetName: m ? m[1] : l.address.line1, addressStreetNumber: m ? m[2] : undefined,
      addressPostalCode: l.address.postalCode ?? undefined, addressTown: l.address.city, addressCountry: IDEALISTA_COUNTRY[l.address.country] ?? l.address.country,
      ...(l.geo ? { addressCoordinatesLatitude: l.geo.lat, addressCoordinatesLongitude: l.geo.lng, addressCoordinatesPrecision: l.hideStreet ? 'moved' : 'exact' } : {}),
    },
    propertyFeatures: {
      featuresType: IDEALISTA_TYPES[l.propertyType] ?? 'flat', featuresAreaConstructed: l.areaSqm ? Math.round(l.areaSqm) : undefined,
      ...(l.lotSqm ? { featuresAreaPlot: Math.round(l.lotSqm) } : {}), featuresBedroomNumber: l.bedrooms ?? undefined, featuresBathroomNumber: l.bathrooms != null ? Math.floor(l.bathrooms) : undefined,
      ...(l.yearBuilt ? { featuresBuiltYear: l.yearBuilt } : {}), featuresEnergyCertificateRating: energy ?? undefined,
    },
    propertyDescriptions: [{ descriptionLanguage: IDEALISTA_LANG[l.address.country] ?? 'spanish', descriptionText: (l.description ?? '').slice(0, 4000) }],
    propertyImages: [
      ...l.photos.map((p, i) => ({ imageOrder: i + 1, imageUrl: p.url, ...(p.caption ? { imageLabel: p.caption } : {}) })),
      ...l.floorPlans.map((p, i) => ({ imageOrder: l.photos.length + i + 1, imageUrl: p.url, imageLabel: 'plan' })),
    ],
    ...(l.virtualTourUrl ? { propertyVirtualTours: [{ virtualTourUrl: l.virtualTourUrl }] } : {}),
    ...(l.listingUrl ? { propertyUrl: l.listingUrl } : {}),
  };
}

const idealista: PortalAdapter = {
  id: 'idealista', name: 'idealista', description: 'idealista JSON import file (Spain, Portugal, Italy) served at a signed URL', format: 'json', countries: ['ES', 'PT', 'IT'], delivery: 'pull',
  configFields: [
    { key: 'customerCode', label: 'idealista customer code', required: true, help: 'Your idealista professional account code (e.g. ilc…)' },
    { key: 'contactEmail', label: 'Contact email for the account', required: true },
    { key: 'contactPhone', label: 'Contact phone', required: false },
  ],
  validate: (l) => {
    const issues = [...common(l, { minDescription: 30 }), ...onlyIn(l, ['ES', 'PT', 'IT'], 'Spain, Portugal and Italy')];
    if (l.areaSqm == null) issues.push('Built area (m²) is required');
    if (!l.address.postalCode) issues.push('Postal code is required');
    const e = portalFact(l, 'energyRating');
    if (!e) issues.push('Energy certificate rating supplied by the business is required (or "in process" / "exempt")');
    else if (!IDEALISTA_ENERGY.includes(e)) issues.push(`Energy rating "${e}" is not a valid certificate rating`);
    if (l.transaction === 'rent' && l.rentPeriod && l.rentPeriod !== 'month') issues.push('idealista rentals are priced per month');
    return issues;
  },
  build: (ls, meta) => {
    const c = meta.config ?? {};
    return JSON.stringify({
      ...(meta.sandbox ? { _notice: 'SANDBOX PREVIEW — idealista has not been configured to fetch this file.' } : {}),
      customerCountry: IDEALISTA_COUNTRY[ls[0]?.address.country ?? 'ES'] ?? 'Spain', customerCode: String(c.customerCode ?? ''), customerReference: meta.organization,
      customerSendDate: meta.generatedAt.replace('T', ' ').replace(/-/g, '/').slice(0, 19),
      customerContact: { contactName: meta.organization, contactEmail: c.contactEmail ?? undefined, contactPrimaryPhoneNumber: c.contactPhone ?? undefined },
      customerProperties: ls.map(idealistaProperty),
    }, null, 2);
  },
};

// ───────── Zillow-compatible / RESO ─────────

const ZILLOW_TYPES: Record<string, string> = { house: 'SingleFamily', townhouse: 'Townhouse', apartment: 'Condo', condo: 'Condo', land: 'Unimproved Land', commercial: 'Commercial', other: 'Miscellaneous' };
const zillowStatus = (l: FeedListing) => (l.status === 'under_offer' ? 'Pending' : l.status === 'coming_soon' ? 'Coming Soon' : l.transaction === 'rent' ? 'For Rent' : 'Active');

const resoXml: PortalAdapter = {
  id: 'reso_xml', name: 'Zillow / RESO XML', description: 'Zillow-compatible listing feed (XML) for US and Canadian listings, served at a signed URL', format: 'xml', countries: ['US', 'CA'], delivery: 'pull',
  configFields: [
    { key: 'feedId', label: 'Portal feed / account id', required: true, help: 'The id the portal gives your feed when they approve it (Zillow Listing Feed, syndicator, MLS)' },
    { key: 'brokerageName', label: 'Brokerage name (as licensed)', required: true },
    { key: 'brokerageEmail', label: 'Brokerage email', required: false },
  ],
  validate: (l) => {
    const issues = [...common(l), ...onlyIn(l, ['US', 'CA'], 'US and Canadian')];
    if (!l.address.postalCode) issues.push(l.address.country === 'US' ? 'ZIP code is required' : 'Postal code is required');
    if (!l.address.region) issues.push(l.address.country === 'US' ? 'State is required' : 'Province is required');
    if (!['land', 'commercial'].includes(l.propertyType)) {
      if (l.bedrooms == null) issues.push('Bedrooms are required for residential listings');
      if (l.bathrooms == null) issues.push('Bathrooms are required for residential listings');
    }
    if (l.agent && !l.agent.email) issues.push('The listing agent needs an email address');
    if (l.address.country === 'CA' && !l.office.brokerageLicence) issues.push('Brokerage name/licence disclosure is required');
    return issues;
  },
  build: (ls, meta) => {
    const c = meta.config ?? {};
    const sqft = (sqm: number | null | undefined) => (sqm ? Math.round(fromSqm(sqm, 'sqft')) : '');
    return `<?xml version="1.0" encoding="UTF-8"?>\n${meta.sandbox ? '<!-- SANDBOX PREVIEW: no portal has been configured to fetch this feed. -->\n' : ''}<!-- Element names follow the Zillow Listing Feed layout; RESO Data Dictionary equivalents: MlsId=ListingKey, Price=ListPrice, Status=StandardStatus, LivingArea=LivingArea(SquareFeet). -->\n<Listings generated="${esc(meta.generatedAt)}" feedId="${esc(c.feedId)}" source="${esc(meta.organization)}">\n${ls.map((l) => {
      const [first, ...rest] = (l.agent?.name ?? '').split(' ');
      const baths = l.bathrooms ?? 0;
      return `  <Listing>
    <Location><StreetAddress>${esc(l.hideStreet ? '' : l.address.line1)}</StreetAddress><UnitNumber>${esc(l.hideStreet ? '' : l.address.line2)}</UnitNumber><City>${esc(l.address.city)}</City><State>${esc(l.address.region)}</State><Zip>${esc(l.address.postalCode)}</Zip><Country>${esc(l.address.country)}</Country>${l.geo && !l.hideStreet ? `<Lat>${l.geo.lat}</Lat><Long>${l.geo.lng}</Long>` : ''}<DisplayAddress>${l.hideStreet ? 'No' : 'Yes'}</DisplayAddress></Location>
    <ListingDetails><Status>${esc(zillowStatus(l))}</Status><Price>${major(l.price)}</Price><Currency>${esc(l.price.currency)}</Currency><ListingUrl>${esc(l.listingUrl)}</ListingUrl><MlsId>${esc(l.reference)}</MlsId><ProviderListingId>${esc(l.id)}</ProviderListingId>${l.transaction === 'rent' ? `<RentPeriod>${esc(l.rentPeriod === 'week' ? 'Weekly' : 'Monthly')}</RentPeriod>` : ''}</ListingDetails>
    <BasicDetails><PropertyType>${esc(ZILLOW_TYPES[l.propertyType] ?? 'Miscellaneous')}</PropertyType><Title>${esc(l.title)}</Title><Description>${esc(l.description)}</Description><Bedrooms>${esc(l.bedrooms)}</Bedrooms><Bathrooms>${esc(l.bathrooms)}</Bathrooms><FullBathrooms>${Math.floor(baths)}</FullBathrooms><HalfBathrooms>${baths % 1 >= 0.5 ? 1 : 0}</HalfBathrooms><LivingArea>${sqft(l.areaSqm)}</LivingArea><LotSize>${sqft(l.lotSqm)}</LotSize><YearBuilt>${esc(l.yearBuilt)}</YearBuilt></BasicDetails>
    <Pictures>${l.photos.map((p) => `<Picture><PictureUrl>${esc(p.url)}</PictureUrl><Caption>${esc(p.caption)}</Caption></Picture>`).join('')}</Pictures>
    <Agent><FirstName>${esc(first)}</FirstName><LastName>${esc(rest.join(' '))}</LastName><EmailAddress>${esc(l.agent?.email)}</EmailAddress><OfficeLineNumber>${esc(l.agent?.phone)}</OfficeLineNumber><LicenseNum>${esc(l.agent?.licence)}</LicenseNum></Agent>
    <Office><BrokerageName>${esc(c.brokerageName ?? l.office.name)}</BrokerageName><BrokerPhone>${esc(l.office.phone)}</BrokerPhone><BrokerEmail>${esc(c.brokerageEmail ?? l.office.email)}</BrokerEmail><BrokerageLicense>${esc(l.office.brokerageLicence)}</BrokerageLicense></Office>
    <RichDetails><AdditionalFeatures>${esc(l.features.join(', '))}</AdditionalFeatures></RichDetails>${l.virtualTourUrl ? `\n    <VirtualTourUrl>${esc(l.virtualTourUrl)}</VirtualTourUrl>` : ''}
  </Listing>`;
    }).join('\n')}\n</Listings>\n`;
  },
};

// ───────── REAXML ─────────

const REA_CATEGORY: Record<string, string> = { house: 'House', townhouse: 'Townhouse', apartment: 'Apartment', condo: 'Unit', land: 'Land', commercial: 'Commercial', other: 'Other' };
const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'];
const reaTime = (iso: string) => { const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`; };
const REA_IMG_IDS = 'mabcdefghijklnopqrstuvwxyz'.split('');
const reaRemovedStatus = (r: RemovedListing) => (r.status === 'sold' ? 'sold' : r.status === 'let' ? 'leased' : 'withdrawn');

const reaxml: PortalAdapter = {
  id: 'reaxml', name: 'REAXML (realestate.com.au / Domain)', description: 'REAXML feed for Australian and New Zealand listings, served at a signed URL', format: 'xml', countries: ['AU', 'NZ'], delivery: 'pull',
  configFields: [
    { key: 'agentId', label: 'Portal agent / office id', required: true, help: 'The agency id issued by realestate.com.au or Domain' },
  ],
  validate: (l) => {
    const issues = [...common(l), ...onlyIn(l, ['AU', 'NZ'], 'Australian and New Zealand')];
    if (!l.address.postalCode) issues.push('Postcode is required');
    if (l.address.country === 'AU' && !AU_STATES.includes((l.address.region ?? '').toUpperCase())) issues.push('State must be one of NSW, VIC, QLD, WA, SA, TAS, ACT, NT');
    if (l.title.length > 80) issues.push('Headline must be 80 characters or fewer');
    if (l.photos.length > REA_IMG_IDS.length) issues.push(`At most ${REA_IMG_IDS.length} photos can be sent`);
    if (l.transaction === 'rent' && l.rentPeriod !== 'week') issues.push('Australian rentals must be priced per week');
    if (l.propertyType === 'commercial') issues.push('Commercial listings need the commercial REAXML feed');
    return issues;
  },
  build: (ls, meta, removed = []) => {
    const c = meta.config ?? {};
    const mod = (iso?: string) => reaTime(iso ?? meta.generatedAt);
    const body = ls.map((l) => {
      const tag = l.transaction === 'rent' ? 'rental' : l.propertyType === 'land' ? 'land' : 'residential';
      const q = portalFact(l, 'priceQualifier');
      const priceView = q === 'poa' ? 'Contact agent' : q === 'offers_over' ? `Offers over ${major(l.price)}` : q === 'from' ? `From ${major(l.price)}` : '';
      const m = /^(\d+[A-Za-z]?)\s+(.*)$/.exec(l.address.line1);
      return `  <${tag} modTime="${mod(l.updatedAt)}" status="current">
    <agentID>${esc(c.agentId)}</agentID>
    <uniqueID>${esc(l.reference)}</uniqueID>
    <underOffer value="${l.status === 'under_offer' ? 'yes' : 'no'}"/>
    <listingAgent id="1"><name>${esc(l.agent?.name)}</name><telephone type="BH">${esc(l.agent?.phone ?? l.office.phone)}</telephone><email>${esc(l.agent?.email)}</email></listingAgent>
    ${tag === 'rental' ? `<rent period="week" display="yes">${major(l.price)}</rent>${portalFact(l, 'availableFrom') ? `\n    <dateAvailable>${esc(portalFact(l, 'availableFrom'))}</dateAvailable>` : ''}` : `<price display="${q === 'poa' ? 'no' : 'yes'}">${major(l.price)}</price>${priceView ? `\n    <priceView>${esc(priceView)}</priceView>` : ''}`}
    <address display="${l.hideStreet ? 'no' : 'yes'}"><streetNumber>${esc(m?.[1])}</streetNumber><street>${esc(m ? m[2] : l.address.line1)}</street><suburb display="yes">${esc(l.address.city)}</suburb><state>${esc(l.address.region)}</state><postcode>${esc(l.address.postalCode)}</postcode><country>${l.address.country === 'NZ' ? 'NZ' : 'AUS'}</country></address>
    <category name="${esc(REA_CATEGORY[l.propertyType] ?? 'Other')}"/>
    <headline>${esc(l.title)}</headline>
    <description>${esc(l.description)}</description>
    <features><bedrooms>${esc(l.bedrooms)}</bedrooms><bathrooms>${esc(l.bathrooms != null ? Math.floor(l.bathrooms) : '')}</bathrooms></features>
    ${l.areaSqm ? `<buildingDetails><area unit="squareMeter">${Math.round(l.areaSqm)}</area></buildingDetails>` : ''}${l.lotSqm ? `<landDetails><area unit="squareMeter">${Math.round(l.lotSqm)}</area></landDetails>` : ''}
    <images>${l.photos.slice(0, REA_IMG_IDS.length).map((p, i) => `<img id="${REA_IMG_IDS[i]}" modTime="${mod(l.updatedAt)}" url="${esc(p.url)}"/>`).join('')}</images>
    <objects>${l.floorPlans.map((p, i) => `<floorplan id="${i + 1}" modTime="${mod(l.updatedAt)}" url="${esc(p.url)}"/>`).join('')}</objects>${l.virtualTourUrl ? `\n    <videoLink href="${esc(l.virtualTourUrl)}"/>` : ''}
  </${tag}>`;
    });
    const gone = removed.map((r) => `  <${r.transaction === 'rent' ? 'rental' : 'residential'} modTime="${mod(r.at)}" status="${reaRemovedStatus(r)}"><agentID>${esc(c.agentId)}</agentID><uniqueID>${esc(r.reference)}</uniqueID></${r.transaction === 'rent' ? 'rental' : 'residential'}>`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${meta.sandbox ? '<!-- SANDBOX PREVIEW: no portal has been configured to fetch this feed. -->\n' : ''}<propertyList date="${reaTime(meta.generatedAt)}">\n${[...body, ...gone].join('\n')}\n</propertyList>\n`;
  },
};

export const PORTAL_ADAPTERS: Record<PortalId, PortalAdapter> = { rightmove, idealista, reso_xml: resoXml, reaxml };
export const PORTAL_IDS = Object.keys(PORTAL_ADAPTERS) as PortalId[];
export const normalizePortalId = (id: string): PortalId | null => (id in PORTAL_ADAPTERS ? (id as PortalId) : LEGACY_PORTAL_IDS[id] ?? null);
