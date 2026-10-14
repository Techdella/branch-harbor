/**
 * Partner adapters without a database: every HTTP call goes to an injected mock fetch — never a real service.
 */
import { describe, expect, it } from 'vitest';
import { hmacHex, TokenCache, type FetchLike } from '../src/integrations/partners/http.ts';
import { createUberDirectClient, parseUberWebhook, UBER_STATUS_MAP, uberAvailableIn, verifyUberSignature } from '../src/integrations/partners/uber-direct.ts';
import { buildChannelOrder, buildMenuSnapshot, createDeliverectClient, deliverectWebhookKind, parseInboundOrder, pluToId, verifyDeliverectSignature } from '../src/integrations/partners/deliverect.ts';
import { createRightmoveClient } from '../src/integrations/partners/rightmove.ts';
import { PORTAL_ADAPTERS, portalFact, type FeedListing } from '../src/integrations/realty-portals.ts';

export interface MockCall { url: string; method: string; headers: Record<string, string>; body: string | undefined }
/** Route table → mock fetch; records every call. */
export function mockFetch(routes: Array<[RegExp, (c: MockCall) => { status?: number; body: unknown }]>) {
  const calls: MockCall[] = [];
  const f: FetchLike = async (url, init = {}) => {
    const c = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body };
    calls.push(c);
    const r = routes.find(([re]) => re.test(url));
    if (!r) return { ok: false, status: 599, text: async () => JSON.stringify({ message: `no mock for ${url}` }) };
    const out = r[1](c);
    const status = out.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(out.body) };
  };
  return { fetch: f, calls };
}

describe('Uber Direct client', () => {
  const creds = { clientId: 'cid_123456789', clientSecret: 'secret_abcdef', customerId: 'cust-1' };
  const quoteInput = {
    pickup: { address: { line1: '5410 22nd Ave NW', city: 'Seattle', region: 'WA', postalCode: '98107', country: 'US' }, phone: '+12065550100', lat: 47.66, lng: -122.38 },
    dropoff: { address: { line1: '5500 Ballard Ave NW', city: 'Seattle', postalCode: '98107', country: 'US' }, phone: null },
    pickupReadyAt: new Date('2026-10-14T18:00:00Z'), valueMinor: 2400,
  };

  it('caches the OAuth token until shortly before expiry and refreshes after', async () => {
    let now = Date.parse('2026-10-14T12:00:00Z');
    let tokenNo = 0;
    const m = mockFetch([
      [/auth\.uber\.com/, () => ({ body: { access_token: `tok${++tokenNo}`, expires_in: 3600, token_type: 'Bearer' } })],
      [/delivery_quotes/, () => ({ body: { kind: 'delivery_quote', id: 'dqt_1', fee: 799, currency: 'usd', currency_type: 'USD', expires: '2026-10-14T12:15:00Z', duration: 32 } })],
    ]);
    const c = createUberDirectClient({ creds, fetch: m.fetch, now: () => now, tokens: new TokenCache() });
    await c.quote(quoteInput);
    await c.quote(quoteInput);
    expect(m.calls.filter((x) => /auth/.test(x.url))).toHaveLength(1);
    const auth = m.calls[0]!;
    expect(auth.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(auth.body).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(auth.body).get('scope')).toBe('eats.deliveries');
    const q = m.calls[1]!;
    expect(q.url).toBe('https://api.uber.com/v1/customers/cust-1/delivery_quotes');
    expect(q.headers.Authorization).toBe('Bearer tok1');
    const body = JSON.parse(q.body!);
    expect(JSON.parse(body.pickup_address)).toEqual({ street_address: ['5410 22nd Ave NW'], city: 'Seattle', state: 'WA', zip_code: '98107', country: 'US' });
    expect(body).toMatchObject({ pickup_ready_dt: '2026-10-14T18:00:00.000Z', manifest_total_value: 2400, pickup_latitude: 47.66 });
    now += 3600_000 - 30_000; // within the 60 s refresh margin
    await c.quote(quoteInput);
    expect(m.calls.filter((x) => /auth/.test(x.url))).toHaveLength(2);
    expect(m.calls.at(-1)!.headers.Authorization).toBe('Bearer tok2');
  });

  it('creates deliveries with external_id + idempotency_key and maps the response', async () => {
    const m = mockFetch([
      [/auth/, () => ({ body: { access_token: 't', expires_in: 3600 } })],
      [/\/deliveries$/, (c) => ({ body: { id: 'del_abc', status: 'pending', tracking_url: 'https://track.uber.com/abc', fee: 812, currency: 'usd', external_id: JSON.parse(c.body!).external_id, live_mode: false } })],
      [/cancel$/, () => ({ body: { id: 'del_abc', status: 'canceled' } })],
    ]);
    const c = createUberDirectClient({ creds, fetch: m.fetch, tokens: new TokenCache() });
    const d = await c.createDelivery({ ...quoteInput, quoteId: 'dqt_1', externalId: 'b1c3e7a0-0000-4000-8000-000000000001', pickupName: 'Ballard', dropoffName: 'Jo Guest', items: [{ name: 'Salad', quantity: 2, priceMinor: 1200 }] });
    expect(d).toMatchObject({ id: 'del_abc', status: 'pending', trackingUrl: 'https://track.uber.com/abc', feeMinor: 812, currency: 'USD', liveMode: false });
    const body = JSON.parse(m.calls.find((x) => /\/deliveries$/.test(x.url))!.body!);
    expect(body).toMatchObject({ quote_id: 'dqt_1', external_id: 'b1c3e7a0-0000-4000-8000-000000000001', idempotency_key: 'b1c3e7a0-0000-4000-8000-000000000001', manifest_items: [{ name: 'Salad', quantity: 2, price: 1200, size: 'small' }] });
    expect((await c.cancel('del_abc')).status).toBe('canceled');
  });

  it('verifies webhook signatures (x-uber-signature / x-postmates-signature) and maps statuses', () => {
    const raw = Buffer.from(JSON.stringify({ id: 'evt_1', kind: 'event.delivery_status', status: 'pickup_complete', delivery_id: 'del_abc', customer_id: 'cust-1', data: { id: 'del_abc', status: 'pickup_complete', tracking_url: 'https://track.uber.com/abc', courier: { name: 'Sam Rider' } } }));
    const sig = hmacHex('whkey', raw);
    expect(verifyUberSignature(raw, { 'x-uber-signature': sig }, 'whkey')).toBe(true);
    expect(verifyUberSignature(raw, { 'x-postmates-signature': sig }, 'whkey')).toBe(true);
    expect(verifyUberSignature(raw, { 'x-uber-signature': sig }, 'other')).toBe(false);
    expect(verifyUberSignature(Buffer.concat([raw, Buffer.from(' ')]), { 'x-uber-signature': sig }, 'whkey')).toBe(false);
    expect(verifyUberSignature(raw, {}, 'whkey')).toBe(false);
    expect(parseUberWebhook(JSON.parse(raw.toString()))).toMatchObject({ id: 'evt_1', deliveryId: 'del_abc', status: 'pickup_complete', courierName: 'Sam Rider', trackingUrl: 'https://track.uber.com/abc' });
    expect(UBER_STATUS_MAP).toEqual({ pending: 'pending', pickup: 'assigned', pickup_complete: 'picked_up', dropoff: 'picked_up', delivered: 'delivered', canceled: 'cancelled', returned: 'failed' });
    // Non-https tracking links never reach customer pages.
    expect(parseUberWebhook({ data: { tracking_url: 'javascript:alert(1)' } }).trackingUrl).toBeNull();
  });

  it('checks country availability (overridable)', () => {
    expect(uberAvailableIn('US')).toBe(true);
    expect(uberAvailableIn('gb')).toBe(true);
    expect(uberAvailableIn('AE')).toBe(false);
    expect(uberAvailableIn('AE', 'AE,US')).toBe(true);
  });
});

describe('Deliverect', () => {
  const order = {
    _id: 'dlv_ord_1', account: 'acc1', location: 'dloc1', channelLink: 'cl_ubereats', channel: 7, channelOrderId: 'UE-998877', channelOrderDisplayId: '8877', status: 10, orderType: 2, decimalDigits: 2,
    items: [{ plu: 'bh-11111111-1111-4111-8111-111111111111', name: 'Ember bowl', price: 1200, quantity: 2, remark: 'no onions', subItems: [{ plu: 'bhm-22222222-2222-4222-8222-222222222222', name: 'Smoked chili', price: 80, quantity: 1 }] }, { plu: 'UNKNOWN-1', name: 'Mystery side', price: 300, quantity: 1, subItems: [] }],
    taxes: [{ name: 'VAT', taxClassId: 1, total: 0 }], taxTotal: 0, deliveryCost: 199, serviceCharge: 0, bagFee: 20, tip: 100, driverTip: 150, discountTotal: -200,
    payment: { amount: 2879, type: 3, due: 0 }, orderIsAlreadyPaid: true,
    customer: { name: 'Alex M', phoneNumber: '+447700900000', email: 'masked@ubereats.example', note: 'Ring twice' },
    deliveryAddress: { street: '1 Rivington St', postalCode: 'EC2A 3DT', city: 'London', country: 'United Kingdom', extraAddressInfo: 'Flat 2', coordinates: { coordinates: [-0.08, 51.52] } },
    deliveryTime: '2026-10-14T19:30:00Z', note: 'Leave at door',
  };

  it('verifies HMAC (production secret or staging channel link)', () => {
    const raw = Buffer.from(JSON.stringify(order));
    expect(verifyDeliverectSignature(raw, hmacHex('prod-secret', raw), ['prod-secret'])).toBe(true);
    expect(verifyDeliverectSignature(raw, hmacHex('cl_ubereats', raw), [undefined, 'cl_ubereats'])).toBe(true);
    expect(verifyDeliverectSignature(raw, hmacHex('wrong', raw), ['prod-secret', 'cl_ubereats'])).toBe(false);
    expect(verifyDeliverectSignature(raw, undefined, ['prod-secret'])).toBe(false);
  });

  it('parses marketplace orders with channel attribution, currency digits, tax and fees', () => {
    const p = parseInboundOrder(order, 2);
    expect(p).toMatchObject({
      deliverectId: 'dlv_ord_1', channelOrderId: 'UE-998877', channel: { id: 7, key: 'uber_eats', name: 'Uber Eats' }, orderType: 'delivery', isCancellation: false,
      subtotalMinor: 2 * (1200 + 80) + 300, taxMinor: 0, deliveryFeeMinor: 199, serviceChargeMinor: 20, tipMinor: 100, driverTipMinor: 150, discountMinor: 200, totalMinor: 2879, paid: true,
      address: { line1: '1 Rivington St', city: 'London', postalCode: 'EC2A 3DT', instructions: 'Flat 2', lat: 51.52, lng: -0.08 },
    });
    // JPY (no minor units) with decimalDigits 2: 120000 → ¥1200
    expect(parseInboundOrder({ ...order, items: [{ plu: 'x', name: 'Ramen', price: 120000, quantity: 1 }], payment: { amount: 120000 } }, 0)).toMatchObject({ subtotalMinor: 1200, totalMinor: 1200 });
    expect(parseInboundOrder({ ...order, status: 100 }, 2).isCancellation).toBe(true);
    expect(deliverectWebhookKind(order)).toBe('order');
    expect(deliverectWebhookKind({ accountId: 'a', locationId: 'l', status: 'PAUSED' })).toBe('busy_mode');
    expect(deliverectWebhookKind({ channelOrderId: 'x', status: 20 })).toBe('channel_status');
    expect(pluToId('bh-11111111-1111-4111-8111-111111111111')).toEqual({ kind: 'item', id: '11111111-1111-4111-8111-111111111111' });
    expect(pluToId('bhm-22222222-2222-4222-8222-222222222222')?.kind).toBe('modifier');
    expect(pluToId('UNKNOWN-1')).toBeNull();
  });

  it('builds the channel order for POS injection and posts it with a cached token', async () => {
    const m = mockFetch([
      [/oauth\/token/, (c) => ({ body: { access_token: 'dtok', expires_at: Math.floor(Date.now() / 1000) + 3600, audience: JSON.parse(c.body!).audience } })],
      [/\/branchharbor\/order\/cl_pos/, () => ({ body: { message: 'ok' } })],
      [/orderStatus/, () => ({ body: {} })],
    ]);
    const c = createDeliverectClient({ creds: { clientId: 'dc', clientSecret: 'ds' }, config: { environment: 'staging', channelName: 'branchharbor', channelLinkId: 'cl_pos' }, fetch: m.fetch, tokens: new TokenCache() });
    const payload = buildChannelOrder({
      id: 'ord-1', orderNumber: 'LON-AB12C', channel: 'pickup', currency: 'GBP', currencyExponent: 2,
      lines: [{ menuItemId: 'item-1', name: 'Ember bowl', quantity: 1, unitPriceMinor: 1200, modifiers: [{ id: 'mod-1', name: 'Chili', priceMinor: 80 }], notes: 'extra hot' }],
      subtotalMinor: 1280, taxMinor: 256, deliveryFeeMinor: 0, serviceChargeMinor: 0, tipMinor: 0, totalMinor: 1536, paid: true, contact: { name: 'Jo Guest', phone: '+44 20 0000 0000' }, notes: null, promisedAt: new Date('2026-10-14T12:30:00Z'),
    });
    await c.injectOrder(payload);
    await c.updateOrderStatus('dlv_ord_1', 20, { at: new Date('2026-10-14T12:00:00Z') });
    expect(m.calls.filter((x) => /oauth/.test(x.url))).toHaveLength(1);
    expect(JSON.parse(m.calls[0]!.body!)).toMatchObject({ grant_type: 'client_credentials', audience: 'https://api.staging.deliverect.com', client_id: 'dc' });
    expect(m.calls[1]!.url).toBe('https://api.staging.deliverect.com/branchharbor/order/cl_pos');
    expect(JSON.parse(m.calls[1]!.body!)).toMatchObject({
      channelOrderId: 'ord-1', channelOrderDisplayId: 'LON-AB12C', orderType: 1, decimalDigits: 2, pickupTime: '2026-10-14T12:30:00Z', orderIsAlreadyPaid: true, taxTotal: 256,
      items: [{ plu: 'bh-item-1', price: 1200, quantity: 1, remark: 'extra hot', subItems: [{ plu: 'bhm-mod-1', price: 80, quantity: 1 }] }], payment: { amount: 1536 },
    });
    expect(JSON.parse(m.calls[2]!.body!)).toEqual({ orderId: 'dlv_ord_1', status: 20, timeStamp: '2026-10-14T12:00:00Z' });
  });

  it('menu snapshot: location prices, sold-out snoozes, allergens only when declared by the business', () => {
    const snap = buildMenuSnapshot([
      { id: 'i1', name: 'Ember bowl', description: 'Grain bowl', category: 'Bowls', categoryId: 'c1', price: { amount: 1200 }, available: true, soldOut: false, imageUrl: null, allergens: ['cereals_gluten', 'wheat'], allergensDeclared: true,
        modifierGroups: [{ id: 'g1', name: 'Sauce', minSelect: 1, maxSelect: 1, modifiers: [{ id: 'm1', name: 'Chili', price: { amount: 80 }, available: false, soldOut: true, allergens: ['mustard'] }] }] },
      { id: 'i2', name: 'Lemonade', description: null, category: 'Drinks', categoryId: 'c2', price: { amount: 400 }, available: false, soldOut: true, imageUrl: null, allergens: ['milk'], allergensDeclared: false, modifierGroups: [] },
      { id: 'i3', name: 'No price', description: null, category: 'Drinks', categoryId: 'c2', price: null, available: false, soldOut: false, imageUrl: null, allergens: [], allergensDeclared: false, modifierGroups: [] },
    ], { accountId: 'acc', locationId: 'loc' }, 2000);
    expect(snap.categories).toEqual([{ name: 'Bowls', posCategoryId: 'c1' }, { name: 'Drinks', posCategoryId: 'c2' }]);
    const bowl = snap.products.find((p) => p.plu === 'bh-i1')!;
    expect(bowl).toMatchObject({ productType: 1, price: 1200, visible: true, deliveryTax: 20000, productTags: [101], subProducts: ['bhg-g1'] });
    expect(snap.products.find((p) => p.plu === 'bh-i2')).toMatchObject({ visible: true, productTags: [] }); // not declared → no tags, never inferred
    expect(snap.products.find((p) => p.plu === 'bhm-m1')).toMatchObject({ productType: 2, price: 80, productTags: [108] });
    expect(snap._meta).toEqual({ soldOutPlus: ['bhm-m1', 'bh-i2'], unmappedAllergens: [{ plu: 'bh-i1', allergen: 'wheat' }], skipped: [{ id: 'i3', name: 'No price', reason: 'No price in the location currency' }] });
  });
});

// ───────── Property portals ─────────

const base = (over: Partial<FeedListing> = {}): FeedListing => ({
  id: '0b6f2c3e-7d1a-4c5b-9e8f-000000000001', reference: 'LON-0001', transaction: 'sale', propertyType: 'house', status: 'active', title: 'Victorian terrace on Flask Walk',
  description: 'Three-bedroom Victorian terraced house with a south-facing garden and original fireplaces.',
  address: { line1: '14 Flask Walk', line2: null, city: 'London', region: null, postalCode: 'NW3 1HE', country: 'GB' }, hideStreet: false, geo: { lat: 51.5567, lng: -0.1781 },
  price: { amount: 2_450_000_00, currency: 'GBP' }, rentPeriod: null, bedrooms: 3, bathrooms: 2, areaSqm: 152.4, lotSqm: null, yearBuilt: 1880,
  photos: [{ url: 'https://img.example.com/a.jpg', caption: 'Front' }, { url: 'https://img.example.com/b.jpg' }], floorPlans: [{ url: 'https://img.example.com/plan.pdf' }], virtualTourUrl: null,
  features: ['Garden', 'Original fireplaces'], agent: { name: 'James Okafor', email: 'james@example.com', phone: '+44 20 7946 0271', licence: null },
  office: { name: 'London Hampstead', phone: '+44 20 7946 0270', email: 'lon@example.com', brokerageLicence: null }, disclosures: [],
  portalFields: { priceQualifier: 'guide_price', tenure: 'freehold', councilTaxBand: 'H', energyRating: null, availableFrom: null },
  createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-10-01T10:30:00.000Z', ...over,
});
const meta = { generatedAt: '2026-10-14T12:00:00.000Z', organization: 'Keystone Realty Network' };

describe('portal feeds', () => {
  it('Rightmove RTDF: validation and SendProperty/RemoveProperty output', () => {
    const rm = PORTAL_ADAPTERS.rightmove;
    expect(rm.validate(base())).toEqual([]);
    const bad = base({ address: { ...base().address, postalCode: 'NW3' }, portalFields: undefined, bedrooms: null, photos: [] });
    expect(rm.validate(bad)).toEqual(expect.arrayContaining([
      'At least one photo is required', 'A full UK postcode is required (e.g. NW3 6TR)', 'Number of bedrooms is required',
      'Tenure is required (material information supplied by the business)', 'Council tax band is required (material information supplied by the business)',
    ]));
    expect(rm.validate(base({ transaction: 'rent', rentPeriod: null, portalFields: { ...base().portalFields!, priceQualifier: 'offers_over' } }))).toEqual(expect.arrayContaining(['Lettings accept only the default or POA price qualifier', 'Rent frequency (weekly or monthly) is required']));
    // Disclosures supplied by the business are honoured when no explicit portal fields exist.
    expect(rm.validate(base({ portalFields: undefined, disclosures: [{ label: 'Tenure', text: 'Leasehold, 120 years remaining' }, { label: 'Council tax', text: 'Band F' }] }))).toEqual([]);
    expect(portalFact(base({ portalFields: undefined, disclosures: [{ label: 'Council tax', text: 'Band F' }] }), 'councilTaxBand')).toBe('F');
    const out = rm.build([base()], { ...meta, config: { networkId: '1234', branchId: '5678' } }, [{ id: 'x', reference: 'LON-0003', transaction: 'rent', status: 'let', at: '2026-10-10T09:00:00.000Z' }]);
    expect(JSON.parse(out)).toMatchSnapshot();
  });

  it('idealista: validation and JSON import file', () => {
    const idl = PORTAL_ADAPTERS.idealista;
    const l = base({ reference: 'MAD-0001', title: 'Piso exterior en Salamanca', description: 'Piso exterior de tres dormitorios con balcones a la calle, ascensor y portero.', address: { line1: 'Calle de Velázquez 58', line2: '3º Izq.', city: 'Madrid', region: 'Madrid', postalCode: '28001', country: 'ES' }, price: { amount: 1_150_000_00, currency: 'EUR' }, areaSqm: 142, portalFields: { priceQualifier: null, tenure: null, councilTaxBand: null, energyRating: 'D', availableFrom: null } });
    expect(idl.validate(l)).toEqual([]);
    expect(idl.validate({ ...l, areaSqm: null, portalFields: undefined })).toEqual(expect.arrayContaining(['Built area (m²) is required', 'Energy certificate rating supplied by the business is required (or "in process" / "exempt")']));
    expect(idl.validate({ ...l, portalFields: { ...l.portalFields!, energyRating: 'Z' } })).toContain('Energy rating "Z" is not a valid certificate rating');
    expect(idl.validate(base())).toContain('Only Spain, Portugal and Italy listings fit this feed');
    expect(JSON.parse(idl.build([l], { ...meta, config: { customerCode: 'ilc0000sample', contactEmail: 'mad@example.com' } }))).toMatchSnapshot();
  });

  it('Zillow / RESO XML: validation and feed', () => {
    const z = PORTAL_ADAPTERS.reso_xml;
    const l = base({ reference: 'TOR-0001', address: { line1: '42 Birchmount Cres', line2: null, city: 'Toronto', region: 'ON', postalCode: 'M1N 1A1', country: 'CA' }, price: { amount: 1_649_000_00, currency: 'CAD' }, office: { ...base().office, name: 'Toronto Midtown', brokerageLicence: 'Keystone Midtown Inc., Brokerage' }, bathrooms: 2.5 });
    expect(z.validate(l)).toEqual([]);
    expect(z.validate({ ...l, office: { ...l.office, brokerageLicence: null }, bathrooms: null, address: { ...l.address, region: null } })).toEqual(['Province is required', 'Bathrooms are required for residential listings', 'Brokerage name/licence disclosure is required']);
    const xml = z.build([l, { ...l, id: 'h', reference: 'TOR-0002', hideStreet: true, title: 'Condo <with> "quotes" & more' }], { ...meta, config: { feedId: 'zfeed-1', brokerageName: 'Keystone Midtown Inc.' } });
    expect(xml).toContain('Condo &lt;with&gt; &quot;quotes&quot; &amp; more');
    expect(xml).not.toContain('SANDBOX');
    expect(xml).toMatchSnapshot();
    expect(z.build([l], { ...meta, sandbox: true })).toContain('SANDBOX PREVIEW');
  });

  it('REAXML: validation, feed, and withdrawn/sold entries so portals remove them', () => {
    const r = PORTAL_ADAPTERS.reaxml;
    const l = base({ reference: 'SYD-0001', propertyType: 'townhouse', title: 'Paddington terrace with courtyard', address: { line1: '21 Glenmore Rd', line2: null, city: 'Paddington', region: 'NSW', postalCode: '2021', country: 'AU' }, price: { amount: 2_350_000_00, currency: 'AUD' }, areaSqm: 118, lotSqm: 120 });
    expect(r.validate(l)).toEqual([]);
    expect(r.validate({ ...l, address: { ...l.address, region: 'Sydney' }, transaction: 'rent', rentPeriod: 'month' })).toEqual(['State must be one of NSW, VIC, QLD, WA, SA, TAS, ACT, NT', 'Australian rentals must be priced per week']);
    const xml = r.build([l, { ...l, id: 'r', reference: 'SYD-0003', transaction: 'rent', rentPeriod: 'week', price: { amount: 950_00, currency: 'AUD' } }], { ...meta, config: { agentId: 'XYZ123' } }, [
      { id: 's', reference: 'SYD-0002', transaction: 'sale', status: 'sold', at: '2026-10-12T00:00:00.000Z' }, { id: 'w', reference: 'SYD-0009', transaction: 'rent', status: 'withdrawn', at: '2026-10-13T00:00:00.000Z' },
    ]);
    expect(xml).toContain('<residential modTime="2026-10-12-00:00:00" status="sold"><agentID>XYZ123</agentID><uniqueID>SYD-0002</uniqueID></residential>');
    expect(xml).toContain('status="withdrawn"><agentID>XYZ123</agentID><uniqueID>SYD-0009</uniqueID></rental>');
    expect(xml).toContain('<rent period="week" display="yes">950</rent>');
    expect(xml).toMatchSnapshot();
  });

  it('Rightmove client parses success, warnings and errors', async () => {
    const m = mockFetch([
      [/sendpropertydetails/, () => ({ body: { request_id: 'r1', message: 'Property sent', success: true, property: { agent_ref: 'LON-0001', rightmove_id: 123456, rightmove_url: 'https://www.rightmove.co.uk/properties/123456', change_type: 'CREATE' }, warnings: [{ warning_code: 'W001', warning_description: 'Feature truncated' }] } })],
      [/removeproperty/, () => ({ status: 400, body: { success: false, message: 'Error', errors: [{ error_code: 'E051', error_description: 'Property not found' }] } })],
    ]);
    const c = createRightmoveClient({ fetch: m.fetch, baseUrl: 'https://adfapi.test.example' });
    expect(await c.sendProperty({})).toMatchObject({ ok: true, rightmoveId: '123456', changeType: 'CREATE', warnings: ['W001 Feature truncated'] });
    expect(await c.removeProperty({})).toMatchObject({ ok: false, errors: ['E051 Property not found'] });
    expect(m.calls[0]!.url).toBe('https://adfapi.test.example/v1/property/sendpropertydetails');
  });
});
