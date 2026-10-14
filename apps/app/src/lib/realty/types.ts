/** View models for Real Estate screens — the shapes returned by /v1/orgs/:orgId/realty/* (and the sample layer). */
import type { Money } from '@bh/shared';

export type ListingStatus = 'draft' | 'coming_soon' | 'active' | 'under_offer' | 'sold' | 'let' | 'withdrawn';
export type AreaUnit = 'sqft' | 'sqm';
export interface AreaView { value: number; unit: AreaUnit; label: string; sqm: number }
export interface Media { url: string; caption?: string | null; alt?: string | null }
export interface Disclosure { key: string; label: string; text: string }
export interface FairHousingFinding { phrase: string; characteristic: string }

export interface RealtyListing {
  id: string;
  locationId: string;
  reference: string;
  title: string;
  description: string | null;
  transaction: 'sale' | 'rent';
  propertyType: string;
  status: ListingStatus;
  price: Money;
  rentPeriod: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area: AreaView | null;
  lot: AreaView | null;
  areaUnit: AreaUnit;
  yearBuilt: number | null;
  features: string[];
  address: { line1: string; line2: string | null; city: string; region: string | null; postalCode: string | null; country: string };
  addressLines: string[];
  hideStreet: boolean;
  photos: Media[];
  floorPlans: Media[];
  virtualTourUrl: string | null;
  disclosures: Disclosure[];
  approval: { status: 'not_required' | 'pending' | 'approved' | 'rejected'; requestedStatus: ListingStatus | null; pendingChanges: Record<string, unknown> | null; requestedBy: string | null; comment: string | null; decidedAt: string | null };
  tier: 'managed' | 'standard' | 'flexible' | null;
  agents: Array<{ id: string; name: string; role: string }>;
  daysOnMarket: number | null;
  closedPrice: Money | null;
  fairHousingWarnings: FairHousingFinding[];
  updatedAt: string;
  counts?: { enquiries: number; upcomingViewings: number; openOffers: number | null };
  permissions?: { canEdit: boolean; canApprove: boolean; canSeeOffers: boolean; canSeeClients?: boolean; isRequester?: boolean };
}

export interface ListingDetail extends RealtyListing {
  office: { id: string; name: string; timeZone: string; currency: string; country: string; tier: string; areaUnit: AreaUnit; disclosures: Disclosure[] };
  history: Array<{ from: string | null; to: string; at: string; note: string | null }>;
  openHouses: Array<{ id: string; startsAt: string; endsAt: string; status: string; agentId: string | null; rsvps: number }>;
  syndication: Array<{ portal: string; optedIn: boolean; lastStatus: string; lastIssues: string[]; lastExportedAt: string | null }>;
  vendor: { id: string; kind?: string; name?: string; email?: string | null; phone?: string | null; restricted?: boolean } | null;
  allowedTransitions: ListingStatus[];
}

export interface ListingInput {
  locationId?: string;
  transaction?: 'sale' | 'rent';
  propertyType?: string;
  title?: string;
  description?: string | null;
  priceMinor?: number;
  rentPeriod?: 'month' | 'week' | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  area?: { value: number; unit: AreaUnit } | null;
  yearBuilt?: number | null;
  features?: string[];
  photos?: Media[];
  floorPlans?: Media[];
  virtualTourUrl?: string | null;
  disclosures?: Disclosure[];
  hideStreet?: boolean;
  address?: { line1: string; line2?: string | null; city: string; region?: string | null; postalCode?: string | null };
  leadAgentId?: string;
}

export interface Enquiry {
  id: string;
  locationId: string;
  listingId: string | null;
  listing: { title: string; reference: string } | null;
  source: string;
  kind: string;
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  assignedAgentId: string | null;
  agentName: string | null;
  routedBy: string;
  status: 'new' | 'contacted' | 'viewing_booked' | 'offer_made' | 'closed' | 'lost';
  createdAt: string;
}

export interface Viewing {
  id: string;
  listingId: string;
  locationId: string;
  agentId: string;
  agentName: string | null;
  listing: { title: string; reference: string } | null;
  startsAt: string;
  endsAt: string;
  timeZone: string | null;
  kind: string;
  status: 'requested' | 'confirmed' | 'completed' | 'no_show' | 'cancelled';
  contact: { name: string; email: string | null; phone: string | null };
  feedback: { interestLevel: string | null; rating: number | null; notes: string | null; at: string } | null;
  mine?: boolean;
  officeName?: string;
}

export interface OfferEvent { id: string; action: string; party: string; amount: Money | null; conditions: string[] | null; note: string | null; at: string }
export interface Offer {
  id: string;
  listingId: string;
  locationId: string;
  buyerName: string;
  submittedByAgentId: string | null;
  submittedByAgentName: string | null;
  amount: Money;
  deposit: Money | null;
  conditions: string[];
  expiresAt: string | null;
  status: 'submitted' | 'countered' | 'accepted' | 'rejected' | 'withdrawn';
  createdAt: string;
  updatedAt: string;
  events?: OfferEvent[];
  listing?: { id: string; title: string; reference: string; status: string; price: Money };
}

export interface Agent {
  id: string;
  locationId: string;
  userId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  licenceNumber: string | null;
  photoUrl: string | null;
  languages: string[];
  availability: Array<{ weekday: number; start: string; end: string }>;
  acceptsLeads: boolean;
  active: boolean;
  isMe?: boolean;
  workload: { upcomingViewings: number; openEnquiries: number; liveListings: number };
}

export interface Office {
  locationId: string;
  name: string;
  city: string;
  country: string;
  currency: string;
  timeZone: string;
  tier: 'managed' | 'standard' | 'flexible';
  areaUnit: AreaUnit;
  leadRouting: 'listing_agent' | 'round_robin' | 'office_pool';
  viewingMinutes: number;
  viewingBufferMinutes: number;
  disclosures: Disclosure[];
  brokerageLicence: string | null;
  agentCount: number;
}

export interface VolumeRow { currency: string; count: number; volumeMinor: number }
export interface OfficeReport {
  locationId: string;
  name: string;
  country: string;
  currency: string;
  listings: { comingSoon: number; active: number; underOffer: number; draft: number; awaitingApproval: number };
  daysOnMarket: { liveMedian: number | null; liveCount: number; closedMedian: number | null; closedCount: number };
  funnel: { enquiries: number; viewings: number; offers: number; acceptedOffers: number; enquiryToViewing: number | null; viewingToOffer: number | null };
  sold: VolumeRow[];
  let: VolumeRow[];
}
export interface RealtyReport {
  period: { from: string; to: string } | null;
  generatedAt?: string;
  source?: string;
  definitions?: Record<string, string>;
  locations: OfficeReport[];
  network: null | {
    listings: { active: number; underOffer: number; comingSoon: number; awaitingApproval: number };
    daysOnMarket: { liveMedian: number | null; liveCount: number };
    funnel: { enquiries: number; viewings: number; offers: number; acceptedOffers: number };
    sold: VolumeRow[];
    let: VolumeRow[];
    combinedVolume: null;
  };
}

export interface Portal { id: string; name: string; description: string; format: 'xml' | 'json'; countries: string[]; mode: 'sandbox'; live: false; status: string; optedInListings: number; lastExportedAt: string | null }
export interface FeedPreview { portal: string; name: string; format: 'xml' | 'json'; notice: string; included: Array<{ listingId: string; reference: string }>; excluded: Array<{ listingId: string; reference: string; issues: string[] }>; content: string }

export interface AiProposal { id: string; kind: string; status: string; output: Record<string, unknown>; createdAt: string }
export interface AiResult { proposal: AiProposal | null; refusals: string[]; unavailable?: boolean }

export interface RealtyMe { agents: Array<{ id: string; name: string; locationId: string }>; clients: 'all' | string[]; approve: 'all' | string[]; reports: 'all' | string[] }
