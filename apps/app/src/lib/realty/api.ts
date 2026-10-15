'use client';

/** Real Estate data layer: /v1/orgs/:orgId/realty/* (see apps/api/README.md → realty). */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { http } from '../http/client';
import { orgId } from '../http/workspace';
import type { ViewRole } from '../types';
import type {
  Agent, AiResult, Enquiry, FeedPreview, ListingDetail, ListingInput, Offer, Office, Portal, RealtyListing, RealtyMe, RealtyReport, SyndicationRow, Viewing,
} from './types';
import { useLocalizeErrorRef } from '../useErrorText';

export interface RealtyCtx {
  role: ViewRole;
  /** Locations in the selected scope. */
  locationIds: string[];
  scope: { kind: 'organization' | 'region' | 'owner_group' | 'location'; id: string | null };
}

export interface RealtyApi {
  me(c: RealtyCtx): Promise<RealtyMe>;
  offices(c: RealtyCtx): Promise<Office[]>;
  saveOffice(c: RealtyCtx, locationId: string, body: Partial<Office>): Promise<Office>;
  listings(c: RealtyCtx, q?: { status?: string; mine?: boolean; approval?: 'pending' }): Promise<RealtyListing[]>;
  listing(c: RealtyCtx, id: string): Promise<ListingDetail>;
  createListing(c: RealtyCtx, body: ListingInput): Promise<ListingDetail>;
  updateListing(c: RealtyCtx, id: string, body: ListingInput): Promise<{ result: 'applied' | 'pending_approval'; listing: ListingDetail }>;
  setStatus(c: RealtyCtx, id: string, to: string, extra?: { closedPriceMinor?: number; note?: string }): Promise<{ result: 'applied' | 'pending_approval'; listing: ListingDetail; cancelledViewings: number }>;
  decideApproval(c: RealtyCtx, id: string, decision: 'approve' | 'reject', comment?: string): Promise<ListingDetail>;
  setSyndication(c: RealtyCtx, id: string, portal: string, optedIn: boolean): Promise<{ issues: string[] }>;
  enquiries(c: RealtyCtx, view: 'all' | 'mine' | 'pool'): Promise<Enquiry[]>;
  assignEnquiry(c: RealtyCtx, id: string, agentId: string | null): Promise<Enquiry>;
  enquiryStatus(c: RealtyCtx, id: string, status: Enquiry['status']): Promise<Enquiry>;
  viewings(c: RealtyCtx, from: string, to: string): Promise<Viewing[]>;
  confirmViewing(c: RealtyCtx, id: string): Promise<Viewing>;
  cancelViewing(c: RealtyCtx, id: string, reason?: string): Promise<Viewing>;
  viewingFeedback(c: RealtyCtx, id: string, body: { outcome: 'completed' | 'no_show'; interestLevel?: string; rating?: number; notes?: string }): Promise<Viewing>;
  offers(c: RealtyCtx): Promise<Offer[]>;
  offer(c: RealtyCtx, id: string): Promise<Offer>;
  offerAction(c: RealtyCtx, id: string, body: { action: string; amountMinor?: number; note?: string }): Promise<Offer>;
  agents(c: RealtyCtx): Promise<Agent[]>;
  updateAgent(c: RealtyCtx, id: string, body: Partial<Pick<Agent, 'acceptsLeads' | 'active'>>): Promise<Agent>;
  reports(c: RealtyCtx): Promise<RealtyReport>;
  portals(c: RealtyCtx): Promise<Portal[]>;
  feed(c: RealtyCtx, portal: string): Promise<FeedPreview>;
  exportFeed(c: RealtyCtx, portal: string): Promise<{ transmitted: boolean; results: Array<{ listingId: string; reference: string; status: string; issues: string[] }> }>;
  syndicationListings(c: RealtyCtx): Promise<SyndicationRow[]>;
  aiDescription(c: RealtyCtx, listingId: string, instructions?: string): Promise<AiResult>;
  aiFeedback(c: RealtyCtx, listingId: string): Promise<AiResult>;
  aiDecision(c: RealtyCtx, proposalId: string, decision: 'apply' | 'dismiss'): Promise<{ status: string; result?: Record<string, unknown> }>;
}

const R = (p: string) => `/orgs/${orgId()}/realty${p}`;
const items = <T,>(r: { items: T[] }) => r.items;
const inScope = (c: RealtyCtx) => (lid: string) => c.locationIds.includes(lid);

const live: RealtyApi = {
  me: () => http.get(R('/me')),
  offices: async (c) => (await http.get<{ items: Office[] }>(R('/offices'))).items.filter((o) => inScope(c)(o.locationId)),
  saveOffice: (_c, id, body) => http.put(R(`/offices/${id}`), body),
  listings: async (c, q = {}) => (await http.get<{ items: RealtyListing[] }>(R('/listings'), { status: q.status, mine: q.mine || undefined, approval: q.approval })).items.filter((l) => inScope(c)(l.locationId)),
  listing: (_c, id) => http.get(R(`/listings/${id}`)),
  createListing: (_c, body) => http.post(R('/listings'), body),
  updateListing: (_c, id, body) => http.patch(R(`/listings/${id}`), body),
  setStatus: (_c, id, to, extra = {}) => http.post(R(`/listings/${id}/status`), { to, ...extra }),
  decideApproval: (_c, id, decision, comment) => http.post(R(`/listings/${id}/approval`), { decision, comment }),
  setSyndication: (_c, id, portal, optedIn) => http.put(R(`/listings/${id}/syndication/${portal}`), { optedIn }),
  enquiries: async (c, view) => (await http.get<{ items: Enquiry[] }>(R('/enquiries'), { view })).items.filter((e) => inScope(c)(e.locationId)),
  assignEnquiry: (_c, id, agentId) => http.post(R(`/enquiries/${id}/assign`), { agentId }),
  enquiryStatus: (_c, id, status) => http.post(R(`/enquiries/${id}/status`), { status }),
  viewings: async (c, from, to) => (await http.get<{ items: Viewing[] }>(R('/viewings'), { from, to })).items.filter((v) => inScope(c)(v.locationId)),
  confirmViewing: (_c, id) => http.post(R(`/viewings/${id}/confirm`)),
  cancelViewing: (_c, id, reason) => http.post(R(`/viewings/${id}/cancel`), { reason }),
  viewingFeedback: (_c, id, body) => http.post(R(`/viewings/${id}/feedback`), body),
  offers: async (c) => (await http.get<{ items: Offer[] }>(R('/offers'))).items.filter((o) => inScope(c)(o.locationId)),
  offer: (_c, id) => http.get(R(`/offers/${id}`)),
  offerAction: (_c, id, body) => http.post(R(`/offers/${id}/actions`), body),
  agents: async (c) => (await http.get<{ items: Agent[] }>(R('/agents'))).items.filter((a) => inScope(c)(a.locationId) || a.isMe),
  updateAgent: (_c, id, body) => http.patch(R(`/agents/${id}`), body),
  reports: (c) => http.get(R('/reports'), c.scope.kind === 'organization' ? {} : { scopeKind: c.scope.kind, scopeId: c.scope.id ?? undefined }),
  portals: async (_c) => items(await http.get<{ items: Portal[] }>(R('/syndication/portals'))),
  feed: (_c, portal) => http.get(R(`/syndication/${portal}/feed`)),
  exportFeed: (_c, portal) => http.post(R(`/syndication/${portal}/export`), {}),
  syndicationListings: async (_c) => items(await http.get<{ items: SyndicationRow[] }>(R('/syndication/listings'))),
  aiDescription: (_c, id, instructions) => http.post(R(`/listings/${id}/ai/description`), { instructions: instructions || undefined }),
  aiFeedback: (_c, id) => http.post(R(`/listings/${id}/ai/feedback-summary`), {}),
  aiDecision: (_c, id, decision) => http.post(R(`/ai/proposals/${id}/decision`), { decision }),
};

/** The live Real Estate client. */
export async function getRealtyApi(): Promise<RealtyApi> {
  return live;
}

type Res<T> = { status: 'loading'; data?: T; error?: undefined } | { status: 'ready'; data: T; error?: undefined } | { status: 'error'; data?: T; error: ApiError };
const asErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError('unknown_error', e instanceof Error ? e.message : 'Something went wrong.'));

/** Loads realty data; same contract as useApi (loading / ready / error, reload, setData). */
export function useRealty<T>(fn: (api: RealtyApi) => Promise<T>, deps: unknown[]) {
  const [res, setRes] = useState<Res<T>>({ status: 'loading' });
  const localize = useLocalizeErrorRef();
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const load = useCallback((keep = false) => {
    const id = ++seq.current;
    setRes((r) => ({ status: 'loading', data: keep ? r.data : undefined }));
    (async () => {
      try {
        const data = await fnRef.current(await getRealtyApi());
        if (id === seq.current) setRes({ status: 'ready', data });
      } catch (e) {
        if (id === seq.current) setRes({ status: 'error', error: localize.current(asErr(e)) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => load(), [load]);
  return { ...res, reload: useCallback(() => load(true), [load]), setData: useCallback((data: T) => setRes({ status: 'ready', data }), []) };
}

export function useRealtyMutation<A extends unknown[], R>(fn: (api: RealtyApi, ...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const localize = useLocalizeErrorRef();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fnRef.current(await getRealtyApi(), ...args);
    } catch (e) {
      setError(localize.current(asErr(e)));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  return { run, pending, error, clearError: () => setError(null) };
}
