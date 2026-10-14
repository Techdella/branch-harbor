/** View models for the commerce screens (mirror the /v1/orgs/:orgId/commerce/* responses). */
export interface M { amount: number; currency: string }

export interface CatalogueItem {
  id: string; sku: string; name: string; status: 'draft' | 'active' | 'archived'; vendor: string | null; productType: string | null; image: string | null;
  variantCount: number; options: Array<{ name: string; values: string[] }>; prices: Array<Record<string, number>>; translations: string[]; collectionIds: string[];
  eligibility: { mode: 'all' | 'selected'; locationIds: string[] }; contentVersion: number; publish: { listedAt: number; outdated: number }; updatedAt: string;
}

export interface VariantRow { id: string; sku: string; name: string; options: Record<string, string>; prices: Record<string, number>; barcode: string | null; imageUrl: string | null; status: 'active' | 'archived' }

export interface ProductDetail {
  id: string; sku: string; name: string; description: string | null; slug: string | null; vendor: string | null; productType: string | null; tags: string[];
  status: 'draft' | 'active' | 'archived'; options: Array<{ name: string; values: string[] }>; specs: Record<string, string>;
  eligibility: { mode: 'all' | 'selected'; locationIds: string[] }; priceBounds: Record<string, { minPct: number; maxPct: number }>;
  allowBackorder: boolean; returnable: boolean; contentVersion: number; variants: VariantRow[];
  images: Array<{ url: string; alt: string; variantId: string | null }>; translations: Record<string, { name?: string; description?: string }>;
  collectionIds: string[]; lockedFields: string[];
  listings: Array<{ locationId: string; locationName: string | null; status: string; contentVersion: number; upToDate: boolean; pendingChanges: string[]; updatedAt: string }>;
}

export interface PlanItem {
  locationId: string; locationName: string; currency: string; productId: string; productName: string; action: 'list' | 'update' | 'delist' | 'none';
  status: 'ready' | 'skipped' | 'blocked'; message: string | null; changes: string[];
  overridesOutOfBounds: Array<{ variantId: string; variantName: string; priceMinor: number; minMinor: number | null; maxMinor: number | null }>;
}

export interface Distribution {
  id: string; status: 'completed' | 'partial' | 'failed'; summary: { synced: number; skipped: number; failed: number }; createdAt: string; createdByName?: string | null;
  productIds: string[]; locationIds: string[];
  results?: Array<{ id: string; locationId: string; locationName: string | null; productId: string; productName: string; status: 'synced' | 'skipped' | 'failed'; action: string; message: string | null; changes: { changes?: string[] } }>;
}

export interface AssortmentVariant {
  variantId: string; sku: string; name: string; options: Record<string, string>; hqPrice: M | null; localPrice: M | null; effectivePrice: M | null;
  priceOrigin: 'hq' | 'local'; bounds: { min: M; max: M } | null; priceSetBy: string | null; priceSetAt: string | null;
  available: boolean; availabilityOrigin: 'hq' | 'local'; onHand: number; reserved: number; availableQty: number; inTransit: number;
  reorderPoint: number | null; reorderQty: number | null; allowBackorder: boolean | null; productAllowsBackorder: boolean;
}
export interface AssortmentItem { productId: string; productName: string; sku: string; listingStatus: string; distributedVersion: number; masterVersion: number; updateAvailable: boolean; productStatus: string; lockedFields: string[]; variants: AssortmentVariant[] }

export interface OrderLine { variantId: string; sku: string; name: string; quantity: number; unitPrice: M; lineTotal: M; allocated?: number; backordered?: number; unmapped?: boolean }
export interface Fulfilment { id: string; locationId: string; method: 'pickup' | 'local_delivery' | 'shipping'; status: string; lines: Array<{ variantId: string; sku: string; name: string; quantity: number; picked: number }>; carrier: string | null; trackingNumber: string | null; next: string[]; createdAt: string; completedAt: string | null }
export interface SalesOrder {
  id: string; number: string; source: string; externalId: string | null; authoritativeSystem: string; locationId: string; locationName: string | null; timeZone: string | null;
  fulfilmentLocationId: string; fulfilmentLocationName: string | null; crossLocation: boolean;
  status: string; paymentStatus: string; fulfilmentStatus: string; fulfilmentMethod: 'pickup' | 'local_delivery' | 'shipping'; externalStatus: string | null;
  currency: string; lines: OrderLine[]; subtotal: M; fulfilmentFee: M; taxLines: Array<{ name: string; rateBps: number; inclusive: boolean; amount: M }>; total: M;
  creditApplied: M; amountDue: M; refunded: M; reservationExpiresAt: string | null; attention: string | null;
  customer: { name: string | null; email?: string | null; phone?: string | null }; shippingAddress: Record<string, string> | null; notes: string | null;
  history: Array<{ at: string; event: string; by?: string | null; note?: string }>; createdAt: string; paidAt: string | null; fulfilledAt: string | null;
  fulfilments: Fulfilment[]; transfer: { id: string; number: string; status: string } | null;
  payment?: { id: string; state: string; refundState: string } | null; returns?: ReturnView[];
}

export interface StockRow { locationId: string; locationName: string; variantId: string; sku: string; name: string; productName: string; onHand: number; reserved: number; available: number; reorderPoint: number | null; lowStock: boolean; sellable: boolean; price: M | { amount: null; currency: string }; lastMovementAt: string | null }
export interface Movement { id: string; locationId: string; variantId: string; quantity: number; reason: string; reasonLabel: string; note: string | null; reference: string | null; affectsOnHand: boolean; balanceAfter: number | null; createdAt: string; createdByName: string; variant: { sku: string; name: string; productName: string }; location: { name: string; timeZone: string } }
export interface Alert { locationId: string; locationName: string; variantId: string; sku: string; name: string; onHand: number; reserved: number; available: number; reorderPoint: number | null; onOrder: number; incoming: number; backordered: number; suggestedQty: number; severity: 'low' | 'out' }
export interface CountSummary { id: string; locationId: string; locationName: string | null; name: string; status: string; lines: number; counted: number; varianceUnits: number; createdAt: string }
export interface CountDetail { id: string; locationId: string; name: string; status: string; lines: Array<{ variantId: string; sku: string; barcode: string | null; name: string; expectedQty: number | null; countedQty: number | null; variance: number | null; countedAt: string | null }> }

export interface TransferView {
  id: string; number: string; fromLocationId: string; toLocationId: string; fromLocationName: string | null; toLocationName: string | null; status: string; reason: string | null; orderId: string | null;
  lines: Array<{ variantId: string; sku: string; name: string; quantity: number; shipped: number; received: number }>; carrier: string | null; trackingNumber: string | null; receiveNote: string | null; decisionNote: string | null;
  totals: { requested: number; shipped: number; received: number; inTransit: number }; history: Array<{ at: string; event: string; note?: string }>; createdAt: string; shippedAt: string | null; receivedAt: string | null;
}

export interface Supplier { id: string; name: string; email: string | null; phone: string | null; currency: string; leadTimeDays: number | null; notes: string | null }
export interface PurchaseOrderView { id: string; number: string; locationId: string; locationName: string | null; supplierId: string; supplierName: string; status: string; currency: string; lines: Array<{ variantId: string; sku: string; name: string; quantity: number; received: number; unitCostMinor: number }>; total: M; units: { ordered: number; received: number }; expectedAt: string | null; createdAt: string }

export interface ReturnView {
  id: string; rmaNumber: string | null; orderId: string; orderNumber: string | null; locationId: string; locationName: string | null; status: string; requestedVia: string; reason: string | null;
  resolution: string | null; decisionNote: string | null; lines: Array<{ variantId: string; quantity: number; reason?: string; disposition?: 'restock' | 'write_off'; receivedQty?: number; unitPrice: M | null; name?: string; sku?: string }>;
  value: M; requestedValue: M; refundAmount: M | null; approvalId: string | null; approvalStatus: string | null; giftCardId: string | null; exchangeOrderId: string | null;
  history: Array<{ at: string; event: string; note?: string }>; createdAt: string;
}

export interface GiftCard { id: string; kind: 'gift_card' | 'store_credit'; code: string; last4: string; status: string; customerEmail: string | null; initial: M; balance: M; issuedReason: string | null; createdAt: string; expiresAt: string | null; ledger?: Array<{ id: string; kind: string; amount: M; balanceAfter: M; note: string | null; createdAt: string }> }

export interface StoreSettings {
  location: { id: string; name: string; currency: string; country: string };
  settings: {
    configured: boolean; storefrontEnabled: boolean; pickupEnabled: boolean; pickupInstructions: string | null; pickupReadyMinutes: number; localDeliveryEnabled: boolean; deliveryFeeMinor: number; freeDeliveryOverMinor: number | null;
    deliveryPostcodes: string[]; shippingEnabled: boolean; shippingFeeMinor: number; shippingCountries: string[]; crossLocationPickup: boolean; reservationMinutes: number; returnWindowDays: number;
  };
  taxRates: Array<{ id: string; name: string; rateBps: number; inclusive: boolean; appliesToFulfilment: boolean }>;
}

export interface Collection { id: string; slug: string; title: string; description: string | null; imageUrl: string | null; status: string; position: number; productIds: string[]; translations: Record<string, { title?: string; description?: string }> }

export interface Overview {
  asOf: string;
  orders: { toFulfil: number; readyForPickup: number; backordered: number; awaitingTransfer: number; needsAttention: number; awaitingPayment: number };
  sales: Array<{ locationId: string; locationName: string; currency: string; timeZone: string; today: { orders: number; gross: M }; last7Days: { orders: number; gross: M; refunds: M } }> | null;
  salesUnavailableReason: string | null;
  revenueByCurrency: Array<{ currency: string; today: M; last7Days: M; orders7: number }>;
  stock: { low: number; out: number; top: Alert[] };
  transfers: { requested: number; toShip: number; inTransit: number };
  returns: { open: number; awaitingApproval: number };
  connections: Array<{ id: string; provider: string; locationId: string | null; authoritative: string; state: string; lastSuccessAt: string | null; lastError: string | null }>;
}

export interface Report {
  period: { from: string; to: string };
  salesByLocation: Array<{ locationId: string; locationName: string; currency: string; orders: number; gross: M; refunds: M; net: M; averageOrder: M | null; bySource: Array<{ source: string; orders: number; gross: M }> }>;
  totalsByCurrency: Array<{ currency: string; orders: number; gross: M; refunds: M; net: M }>;
  combinedRevenue: null; combinedRevenueReason: string;
  topProducts: Array<{ productId: string | null; name: string; units: number; revenueByCurrency: M[]; locations: number }>;
  stockTurnover: Array<{ locationId: string; locationName: string; unitsSold: number; averageUnits: number; turnover: number | null; turnoverUnavailableReason: string | null; daysOfCover: number | null }>;
  inventoryDrift: Array<{ locationId: string; locationName: string; countVarianceUnits: number; countAdjustments: number; writeOffUnits: number; transitLossUnits: number; ledgerMismatches: number }>;
  returnsRate: Array<{ locationId: string; locationName: string; returns: number; returnedUnits: number; unitsSold: number; rate: number | null; rateUnavailableReason: string | null }>;
  sources: Array<{ source: string; authoritative: string; note: string }>;
}

export interface Suggestion { kind: string; title: string; detail: string; locationId: string | null; productId: string | null; citations: Array<{ type: string; id: string; label: string }> }
export interface StockExplanation { item: { sku: string; name: string }; periodDays: number; opening: number; closing: number; observations: string[]; hypotheses: string[]; findings: Array<{ reason: string; label: string; units: number; citations: Array<{ type: string; id: string }>; more: number }>; narrative: string | null; aiAvailable: boolean; source: string; asOf: string }
export interface CopyDraft { draft: { title: string; description: string; bullets: string[] }; removedClaims: Array<{ sentence: string; term: string }>; sources: Array<{ key: string; value: string }>; note: string }
