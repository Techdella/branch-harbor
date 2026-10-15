import { apiGet } from './api';

export interface FranchiseFormConfig {
  enabled: boolean;
  brand: { name: string };
  currency?: string;
  homeCountry?: string;
  territories?: Array<{ id: string; name: string; country: string; region: string | null }>;
  countries?: string[];
}

/** The brand's "Own a franchise" form (null when off, not a franchise network, or the API is unreachable). */
export async function getFranchiseForm(brand: string): Promise<FranchiseFormConfig | null> {
  try {
    const c = await apiGet<FranchiseFormConfig>(`/v1/public/franchise/${encodeURIComponent(brand)}`, { revalidate: 60 });
    return c.enabled ? c : null;
  } catch {
    return null;
  }
}

export interface DisclosureView {
  brand: { name: string };
  prospectName: string;
  kind: 'disclosure' | 'agreement';
  document: { title: string; version: string; fileName: string; sizeBytes: number; sha256: string };
  deliveredAt: string;
  receiptSignedAt: string | null;
  receiptName: string | null;
}

export interface AgreementView {
  brand: { name: string };
  signerName: string;
  status: 'sent' | 'signed' | 'declined' | 'voided';
  signedAt: string | null;
  document: { title: string; version: string; fileName: string; sizeBytes: number };
  canSign: boolean;
  earliestSigningAt: string | null;
  waitingUntil: string | null;
  otherwiseBlocked: boolean;
  disclaimer: string;
}

export const getDisclosure = (token: string) => apiGet<DisclosureView>(`/v1/public/franchise/disclosures/${encodeURIComponent(token)}`);
export const getAgreement = (token: string) => apiGet<AgreementView>(`/v1/public/franchise/agreements/${encodeURIComponent(token)}`);
