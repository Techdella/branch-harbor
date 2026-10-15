/**
 * Social publishing adapters. Meta (Facebook pages, Instagram business) publishes live when the account was
 * connected through Meta OAuth (page token stored encrypted) and META_APP_ID/SECRET are set. LinkedIn and Google
 * Business Profile adapters are sandboxed: they validate and record the post but never claim it was published.
 *
 * OAuth: `oauthStartUrl` builds the provider consent URL (state is HMAC-signed); `exchangeMetaCode` turns the
 * callback code into the pages the user manages. Other networks return null until their apps are configured.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SocialNetworkKey } from '@bh/shared';
import type { Config } from '../config.ts';

export interface PublishInput { network: SocialNetworkKey; mode: string; externalId: string | null; token: string | null; body: string; media: Array<{ url: string; alt?: string }>; link: string | null }
export interface PublishOutput { status: 'published' | 'sandboxed' | 'failed'; externalId?: string | null; error?: string | null }

const GRAPH = 'https://graph.facebook.com/v21.0';

export function socialNetworkLive(cfg: Config, network: SocialNetworkKey): boolean {
  if (network === 'facebook' || network === 'instagram') return !!(cfg.META_APP_ID && cfg.META_APP_SECRET);
  return false; // LinkedIn and Google Business Profile publishing are sandboxed adapters.
}

export async function publishToNetwork(cfg: Config, p: PublishInput, fetchImpl: typeof fetch = fetch): Promise<PublishOutput> {
  if (p.mode !== 'live' || !p.token || !p.externalId || !socialNetworkLive(cfg, p.network)) return { status: 'sandboxed' };
  try {
    if (p.network === 'facebook') {
      const body = new URLSearchParams({ message: p.body, access_token: p.token, ...(p.link ? { link: p.link } : {}) });
      const res = await fetchImpl(`${GRAPH}/${p.externalId}/feed`, { method: 'POST', body });
      const j = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      return res.ok ? { status: 'published', externalId: j.id ?? null } : { status: 'failed', error: j.error?.message ?? `Facebook error ${res.status}` };
    }
    if (p.network === 'instagram') {
      const img = p.media[0]?.url;
      if (!img) return { status: 'failed', error: 'Instagram posts need an image' };
      const c = await fetchImpl(`${GRAPH}/${p.externalId}/media`, { method: 'POST', body: new URLSearchParams({ image_url: img, caption: p.body, access_token: p.token }) });
      const cj = (await c.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!c.ok || !cj.id) return { status: 'failed', error: cj.error?.message ?? `Instagram error ${c.status}` };
      const pub = await fetchImpl(`${GRAPH}/${p.externalId}/media_publish`, { method: 'POST', body: new URLSearchParams({ creation_id: cj.id, access_token: p.token }) });
      const pj = (await pub.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      return pub.ok ? { status: 'published', externalId: pj.id ?? null } : { status: 'failed', error: pj.error?.message ?? `Instagram error ${pub.status}` };
    }
    return { status: 'sandboxed' };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

/* ── OAuth scaffolding ── */

const sign = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function signState(secret: string, payload: Record<string, unknown>) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 15 * 60_000 })).toString('base64url');
  return `${data}.${sign(secret, data)}`;
}
export function readState<T>(secret: string, state: string): T | null {
  const [data, sig] = state.split('.');
  if (!data || !sig) return null;
  const expected = sign(secret, data);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const p = JSON.parse(Buffer.from(data, 'base64url').toString()) as T & { exp: number };
  return p.exp > Date.now() ? p : null;
}

export const socialCallbackUrl = (cfg: Config, provider: string) => `${cfg.PUBLIC_API_URL.replace(/\/$/, '')}/v1/oauth/social/${provider}/callback`;

/** Provider consent URL, or null when the platform app isn't configured. */
export function oauthStartUrl(cfg: Config, provider: 'meta' | 'linkedin' | 'google', state: string): string | null {
  if (provider === 'meta' && cfg.META_APP_ID) {
    const q = new URLSearchParams({ client_id: cfg.META_APP_ID, redirect_uri: socialCallbackUrl(cfg, 'meta'), state, scope: 'pages_show_list,pages_manage_posts,pages_read_engagement,pages_messaging,instagram_basic,instagram_content_publish,instagram_manage_messages,business_management' });
    return `https://www.facebook.com/v21.0/dialog/oauth?${q}`;
  }
  if (provider === 'linkedin' && cfg.LINKEDIN_CLIENT_ID) {
    const q = new URLSearchParams({ response_type: 'code', client_id: cfg.LINKEDIN_CLIENT_ID, redirect_uri: socialCallbackUrl(cfg, 'linkedin'), state, scope: 'w_organization_social r_organization_social' });
    return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
  }
  if (provider === 'google' && cfg.GOOGLE_OAUTH_CLIENT_ID) {
    const q = new URLSearchParams({ response_type: 'code', client_id: cfg.GOOGLE_OAUTH_CLIENT_ID, redirect_uri: socialCallbackUrl(cfg, 'google'), state, scope: 'https://www.googleapis.com/auth/business.manage', access_type: 'offline', prompt: 'consent' });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  return null;
}

/** Exchange a Meta OAuth code for the pages (and linked Instagram business accounts) the user manages. */
export async function exchangeMetaCode(cfg: Config, code: string, fetchImpl: typeof fetch = fetch) {
  const tq = new URLSearchParams({ client_id: cfg.META_APP_ID!, client_secret: cfg.META_APP_SECRET!, redirect_uri: socialCallbackUrl(cfg, 'meta'), code });
  const t = await fetchImpl(`${GRAPH}/oauth/access_token?${tq}`);
  const tj = (await t.json()) as { access_token?: string };
  if (!t.ok || !tj.access_token) throw new Error('Meta did not return an access token');
  const pages = await fetchImpl(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(tj.access_token)}`);
  const pj = (await pages.json()) as { data?: Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }> };
  return pj.data ?? [];
}
