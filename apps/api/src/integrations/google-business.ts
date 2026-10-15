/**
 * Google Business Profile adapter for review monitoring and replies (docs/API_INTEGRATIONS.md "Reviews").
 *
 * - OAuth 2.0 (web server flow, `https://www.googleapis.com/auth/business.manage`, offline access): HQ connects one
 *   Google account that manages many locations, or a location connects its own. The refresh token is stored
 *   encrypted; access tokens are minted per call and cached until shortly before expiry.
 * - Accounts: Account Management API v1. Locations: Business Information API v1. Reviews and replies: the My Business
 *   v4 reviews endpoints (still the only reviews API; access requires Google's Business Profile API approval).
 * - Sandbox: without GOOGLE_OAUTH_CLIENT_ID/SECRET nothing is called. A sandbox connection fetches NO reviews (the
 *   adapter never invents data) and replies are kept in BranchHarbor, labelled as not posted to Google.
 *
 * Every HTTP call goes through the injected `fetch` (Services.partnerFetch), so tests use a Google fake.
 */
import type { Config } from '../config.ts';
import { PartnerHttpError, TokenCache, requestJson, type FetchLike } from './partners/http.ts';

export const GOOGLE_BUSINESS_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCOUNTS_URL = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts';
const INFO_URL = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const REVIEWS_URL = 'https://mybusiness.googleapis.com/v4';

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export interface GoogleLocation { accountName: string; name: string; title: string; reviewUrl: string | null }
export interface GoogleReview {
  /** Full resource name: accounts/{a}/locations/{l}/reviews/{r}. */
  name: string;
  authorName: string | null;
  rating: number;
  comment: string | null;
  createTime: string;
  updateTime: string;
  reply: { comment: string; updateTime: string } | null;
}

export interface GoogleBusinessAdapter {
  /** True when the platform OAuth client is configured (live mode possible). */
  readonly configured: boolean;
  authUrl(state: string): string | null;
  redirectUri(): string;
  exchangeCode(code: string): Promise<{ refreshToken: string; email: string | null }>;
  listLocations(refreshToken: string): Promise<GoogleLocation[]>;
  listReviews(refreshToken: string, accountName: string, locationName: string, pageToken?: string | null): Promise<{ reviews: GoogleReview[]; nextPageToken: string | null; averageRating: number | null; total: number | null }>;
  reply(refreshToken: string, reviewName: string, comment: string): Promise<void>;
}

const tokens = new TokenCache();

export function createGoogleBusiness(cfg: Config, fetchImpl: FetchLike): GoogleBusinessAdapter {
  const configured = !!(cfg.GOOGLE_OAUTH_CLIENT_ID && cfg.GOOGLE_OAUTH_CLIENT_SECRET);
  const redirectUri = () => `${cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/oauth/reviews/google/callback`;

  const accessToken = async (refreshToken: string) => {
    const key = `gbp:${refreshToken}`;
    const cached = tokens.get(key, Date.now());
    if (cached) return cached;
    const { data } = await requestJson<{ access_token: string; expires_in: number }>('Google', fetchImpl, TOKEN_URL, {
      form: { client_id: cfg.GOOGLE_OAUTH_CLIENT_ID!, client_secret: cfg.GOOGLE_OAUTH_CLIENT_SECRET!, refresh_token: refreshToken, grant_type: 'refresh_token' },
    });
    tokens.set(key, data.access_token, Date.now() + (data.expires_in ?? 3600) * 1000);
    return data.access_token;
  };

  const get = async <T>(refreshToken: string, url: string) => (await requestJson<T>('Google', fetchImpl, url, { headers: { Authorization: `Bearer ${await accessToken(refreshToken)}` } })).data;

  return {
    configured,
    redirectUri,
    authUrl(state) {
      if (!configured) return null;
      const q = new URLSearchParams({ response_type: 'code', client_id: cfg.GOOGLE_OAUTH_CLIENT_ID!, redirect_uri: redirectUri(), state, scope: `${GOOGLE_BUSINESS_SCOPE} openid email`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' });
      return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
    },
    async exchangeCode(code) {
      if (!configured) throw new PartnerHttpError('Google', 503, 'Google OAuth is not configured');
      const { data } = await requestJson<{ refresh_token?: string; id_token?: string }>('Google', fetchImpl, TOKEN_URL, {
        form: { code, client_id: cfg.GOOGLE_OAUTH_CLIENT_ID!, client_secret: cfg.GOOGLE_OAUTH_CLIENT_SECRET!, redirect_uri: redirectUri(), grant_type: 'authorization_code' },
      });
      if (!data.refresh_token) throw new PartnerHttpError('Google', 400, 'Google did not return a refresh token (remove BranchHarbor from the Google account’s third-party access and connect again)');
      let email: string | null = null;
      try {
        const payload = data.id_token?.split('.')[1];
        if (payload) email = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { email?: string }).email ?? null;
      } catch { /* display only */ }
      return { refreshToken: data.refresh_token, email };
    },
    async listLocations(refreshToken) {
      const out: GoogleLocation[] = [];
      const accounts = await get<{ accounts?: Array<{ name: string }> }>(refreshToken, ACCOUNTS_URL);
      for (const a of accounts.accounts ?? []) {
        let pageToken: string | undefined;
        do {
          const q = new URLSearchParams({ readMask: 'name,title,metadata', pageSize: '100', ...(pageToken ? { pageToken } : {}) });
          const page = await get<{ locations?: Array<{ name: string; title?: string; metadata?: { newReviewUri?: string } }>; nextPageToken?: string }>(refreshToken, `${INFO_URL}/${a.name}/locations?${q}`);
          for (const l of page.locations ?? []) out.push({ accountName: a.name, name: l.name, title: l.title ?? l.name, reviewUrl: l.metadata?.newReviewUri ?? null });
          pageToken = page.nextPageToken;
        } while (pageToken);
      }
      return out;
    },
    async listReviews(refreshToken, accountName, locationName, pageToken) {
      const q = new URLSearchParams({ pageSize: '50', orderBy: 'updateTime desc', ...(pageToken ? { pageToken } : {}) });
      const loc = locationName.startsWith('locations/') ? locationName : `locations/${locationName}`;
      const data = await get<{
        reviews?: Array<{ name: string; reviewer?: { displayName?: string; isAnonymous?: boolean }; starRating?: string; comment?: string; createTime: string; updateTime: string; reviewReply?: { comment: string; updateTime: string } }>;
        nextPageToken?: string; averageRating?: number; totalReviewCount?: number;
      }>(refreshToken, `${REVIEWS_URL}/${accountName}/${loc}/reviews?${q}`);
      return {
        reviews: (data.reviews ?? []).filter((r) => STARS[r.starRating ?? '']).map((r) => ({
          name: r.name, authorName: r.reviewer?.isAnonymous ? null : r.reviewer?.displayName ?? null, rating: STARS[r.starRating!]!, comment: r.comment ?? null,
          createTime: r.createTime, updateTime: r.updateTime, reply: r.reviewReply ? { comment: r.reviewReply.comment, updateTime: r.reviewReply.updateTime } : null,
        })),
        nextPageToken: data.nextPageToken ?? null, averageRating: data.averageRating ?? null, total: data.totalReviewCount ?? null,
      };
    },
    async reply(refreshToken, reviewName, comment) {
      await requestJson('Google', fetchImpl, `${REVIEWS_URL}/${reviewName}/reply`, { method: 'PUT', headers: { Authorization: `Bearer ${await accessToken(refreshToken)}` }, body: { comment } });
    },
  };
}
