// Real sessions against the seeded API (pnpm db:seed:demo): the dashboard and the mobile app have no sample-data
// mode, so audited pages sign in as demo accounts. Tokens are fetched when a route runs (and refreshed before they
// expire), then seeded into localStorage before the app's scripts run.
import { BASE } from './config.mjs';

export const PASSWORD = process.env.UI_AUDIT_PASSWORD ?? process.env.SEED_DEMO_PASSWORD ?? 'HarborDemo2026!';

/** Demo accounts used by the audit and the smoke tests (see apps/api/README.md). */
export const ACCOUNTS = {
  owner: 'demo@branchharbor.com', // owner of the demo business accounts (one industry each)
  manager: 'maya.rao@demo.branchharbor.com', // location manager, Stillwater Queen West
  staff: 'carlos.ortega@demo.branchharbor.com', // staff, Maple & Ember Ballard
  independent: 'hana@lumenpilates.demo.branchharbor.com', // independent studio owner
  cmo: 'hannah.cho@northlight.demo.branchharbor.com', // Northlight: marketing workspace
  franchisee: 'liam.oconnor@northlight.demo.branchharbor.com', // Northlight: franchise owner (owner group)
};

const cache = new Map();

async function login(email, mobile) {
  const key = `${email}|${mobile ? 'm' : 'w'}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt - Date.now() > 120_000) return hit;
  const headers = { 'content-type': 'application/json', ...(mobile ? { 'x-bh-client': 'mobile' } : {}) };
  const res = await fetch(`${BASE.api}/v1/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email, password: PASSWORD }) });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status} ${await res.text()}`);
  const s = await res.json();
  const me = await (await fetch(`${BASE.api}/v1/auth/me`, { headers: { authorization: `Bearer ${s.accessToken}` } })).json();
  const out = { token: s.accessToken, refresh: s.refreshToken ?? null, expiresAt: Date.now() + s.accessTokenExpiresIn * 1000, me };
  cache.set(key, out);
  return out;
}

/**
 * localStorage for a route: `route.session = { app: 'app' | 'mobile', as, industry?, workspace?, experience?, brand? }`.
 * Returns the route's static `storage` when it has no session.
 */
export async function storageFor(route) {
  const s = route.session;
  if (!s) return route.storage;
  if (s.as === 'guest') return { 'bh.token': 'guest', 'bh.experience': 'customer', ...(s.brand ? { 'bh.brand': s.brand } : {}) };
  const l = await login(ACCOUNTS[s.as] ?? s.as, s.app === 'mobile');
  const org = l.me.organizations.find((o) => !s.industry || o.industry === s.industry) ?? l.me.organizations[0];
  if (s.app === 'mobile') {
    return { 'bh.token': l.token, ...(l.refresh ? { 'bh.refresh': l.refresh } : {}), 'bh.experience': s.experience ?? 'staff', ...(org ? { 'bh.account': org.id } : {}), ...(s.brand ? { 'bh.brand': s.brand } : {}) };
  }
  return {
    bh_token: l.token,
    bh_token_exp: String(l.expiresAt - 30_000),
    bh_app_state: JSON.stringify({ orgId: org?.id ?? null, workspace: s.workspace ?? null, scopeId: 'all', aiOpen: false, navCollapsed: false }),
  };
}

/** Cookies the app's route guard needs (non-secret session marker). */
export const sessionCookies = (route) => (route.session && route.session.app === 'app' ? [{ name: 'bh_session', value: '1' }] : []);
