// Route enumeration. Every app's routes come from its file-system router; dynamic segments are resolved
// from seeded data (sites: crawled from the server-rendered HTML), sample-mode personas (dashboard) or
// fixture ids (mobile). `coverage()` reports which file-system routes were not visited.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE } from './config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir, file, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, file, acc);
    else if (file(e.name)) acc.push(p);
  }
  return acc;
}

/** Next.js App Router: `page.tsx` files → route patterns (route groups removed). */
export function nextPatterns(appDir) {
  return walk(appDir, (n) => n === 'page.tsx')
    .map((f) => '/' + path.relative(appDir, path.dirname(f)).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s)).join('/'))
    .map((p) => (p === '/' ? '/' : p.replace(/\/$/, '')))
    .sort();
}

/** Expo Router: screen files → patterns (layouts and groups removed). */
export function expoPatterns(appDir) {
  return walk(appDir, (n) => /\.tsx$/.test(n) && !n.startsWith('_layout'))
    .map((f) => {
      const rel = path.relative(appDir, f).replace(/\.tsx$/, '');
      const segs = rel.split(path.sep).filter((s) => !/^\(.*\)$/.test(s));
      if (segs.at(-1) === 'index') segs.pop();
      return '/' + segs.join('/');
    })
    .map((p) => (p === '/' ? '/' : p))
    .sort();
}

export const patternToRegex = (p) =>
  new RegExp('^' + p.replace(/\[\.\.\.[^\]]+\]/g, '.+').replace(/\[[^\]]+\]/g, '[^/]+') + '/?$');

// ───────────────────────── web (marketing) ─────────────────────────
const INDUSTRIES = ['studios', 'sports', 'wellness', 'commerce', 'foods', 'realty'];
const WEB_KEY = new Set(['/en', '/en/pricing', '/en/industries/foods', '/en/demo', '/de', '/ar']);

export function webRoutes() {
  const patterns = nextPatterns(path.join(ROOT, 'apps/web/app'));
  const out = [];
  for (const p of patterns) {
    if (!p.startsWith('/[locale]')) continue;
    const rest = p.slice('/[locale]'.length);
    if (rest === '/[...rest]') {
      out.push({ path: '/en/this-page-does-not-exist', pattern: p });
      continue;
    }
    if (rest.includes('[industry]')) {
      for (const i of INDUSTRIES) out.push({ path: `/en${rest.replace('[industry]', i)}`, pattern: p });
      continue;
    }
    out.push({ path: `/en${rest}`, pattern: p });
  }
  // Long-word and RTL locales on a representative subset.
  for (const loc of ['de', 'fr', 'ar']) for (const r of ['', '/pricing', '/industries/commerce', '/demo']) out.push({ path: `/${loc}${r}`, pattern: `/[locale]${r || ''}` || '/[locale]' });
  return dedupe(out).map((r) => ({ ...r, app: 'web', key: WEB_KEY.has(r.path) }));
}

// ───────────────────────── app (dashboard, sample mode) ─────────────────────────
const OPS = parseOps();
function parseOps() {
  const src = fs.readFileSync(path.join(ROOT, 'apps/app/src/lib/nav.ts'), 'utf8');
  const block = src.slice(src.indexOf('export const OPS'), src.indexOf('export const INDUSTRY_UI'));
  const ops = {};
  let cur = null;
  for (const line of block.split('\n')) {
    const ind = line.match(/^\s{2}(\w+): \[/);
    if (ind) (cur = ind[1]), (ops[cur] = []);
    const k = line.match(/key: '([\w-]+)'/);
    if (k && cur) ops[cur].push(k[1]);
  }
  return ops;
}
const SHARED = ['/overview', '/locations', '/locations/new', '/approvals', '/customers', '/websites', '/marketing', '/payments', '/team', '/community', '/reports', '/connections', '/settings'];
const appState = (industry, role = 'hq', business = 'network') => ({ bh_app_state: JSON.stringify({ industry, role, scopeId: 'all', aiOpen: false, navCollapsed: false, orgId: null, business }) });
const APP_KEY = new Set(['studios /overview', 'foods /ops/kitchen', 'commerce /ops/orders', 'sports /ops/registrations', 'studios /payments', 'realty /ops/listings', 'auth /sign-in']);

export function appRoutes() {
  const patterns = nextPatterns(path.join(ROOT, 'apps/app/src/app'));
  const out = [];
  for (const p of ['/sign-in', '/sign-up', '/forgot-password', '/verify-email', '/onboarding']) out.push({ path: p, pattern: p, label: `auth ${p}`, storage: {} });
  for (const ind of Object.keys(OPS)) {
    for (const s of SHARED) out.push({ path: s, pattern: s, label: `${ind} ${s}`, storage: appState(ind) });
    for (const k of OPS[ind]) out.push({ path: `/ops/${k}`, pattern: '/ops/[screen]', label: `${ind} /ops/${k}`, storage: appState(ind) });
  }
  // Personas on the overview and one ops screen.
  for (const role of ['local', 'staff']) {
    out.push({ path: '/overview', pattern: '/overview', label: `studios(${role}) /overview`, storage: appState('studios', role) });
    out.push({ path: '/ops/classes', pattern: '/ops/[screen]', label: `studios(${role}) /ops/classes`, storage: appState('studios', role) });
  }
  out.push({ path: '/overview', pattern: '/overview', label: 'independent /overview', storage: appState('studios', 'hq', 'independent') });
  out.push({ path: '/settings', pattern: '/settings', label: 'independent /settings', storage: appState('studios', 'hq', 'independent') });
  out.push({ path: '/does-not-exist', pattern: '(not-found)', label: 'not-found', storage: {} });
  const covered = new Set(out.map((r) => r.pattern));
  for (const p of patterns) if (p !== '/' && !covered.has(p)) out.push({ path: p, pattern: p, label: `extra ${p}`, storage: appState('studios') });
  return out.map((r) => ({ ...r, app: 'app', key: APP_KEY.has(r.label) }));
}

// ───────────────────────── sites (customer websites) ─────────────────────────
export const SITE_BRANDS = (process.env.UI_AUDIT_SITE_BRANDS ?? 'stillwater-yoga,maple-and-ember,north-shore-football,harbourline-wellness,fieldnote-goods,keystone-realty,lumen-pilates,cafe-alfama').split(',');
const MANAGE = {
  studios: ['manage/booking/00000000-0000-0000-0000-000000000000?token=x', 'manage/waitlist/00000000-0000-0000-0000-000000000000?token=x'],
  wellness: ['manage/appointment/00000000-0000-0000-0000-000000000000?token=x', 'manage/package/00000000-0000-0000-0000-000000000000?token=x', 'manage/voucher/00000000-0000-0000-0000-000000000000?token=x', 'manage/wellness-waitlist/00000000-0000-0000-0000-000000000000?token=x'],
  foods: ['manage/meal-plan/00000000-0000-0000-0000-000000000000?token=x', 'orders/00000000-0000-0000-0000-000000000000?token=x', 'catering/00000000-0000-0000-0000-000000000000'],
  commerce: ['shop/orders/00000000-0000-0000-0000-000000000000?token=x'],
  realty: ['manage/viewing/00000000-0000-0000-0000-000000000000?token=x'],
};
const SITES_KEY = new Set(['/stillwater-yoga', '/stillwater-yoga/queen-west', '/stillwater-yoga/queen-west/classes', '/maple-and-ember/ballard/order', '/fieldnote-goods/portland/shop', '/keystone-realty/properties', '/north-shore-football/toronto/programmes', '/harbourline-wellness/yorkville/book']);

async function hrefs(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return [];
    const html = await res.text();
    return [...html.matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&')).filter((h) => !/\.(xml|txt|css|js|png|svg|ico|webmanifest)$/.test(h) && !h.startsWith('/_next') && !h.startsWith('/api/'));
  } catch {
    return [];
  }
}

async function brandInfo(brand) {
  try {
    const r = await fetch(`${BASE.api}/v1/public/locations/${brand}`);
    const j = await r.json();
    return { industry: j.organization?.industry ?? null, slugs: (j.items ?? []).map((i) => i.slug) };
  } catch {
    return { industry: null, slugs: [] };
  }
}

/** Where a location's pages live: `/{brand}/{location}`, or `/{brand}` for single-location (independent) sites. */
async function locationBase(brand, slug) {
  try {
    const r = await fetch(`${BASE.sites}/${brand}/${slug}`, { redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && new URL(r.headers.get('location'), BASE.sites).pathname === `/${brand}`) return `/${brand}`;
  } catch {
    /* fall through */
  }
  return `/${brand}/${slug}`;
}

const depth = (h) => h.split('?')[0].split('/').length - 1;

export async function sitesRoutes() {
  const patterns = nextPatterns(path.join(ROOT, 'apps/sites/app'));
  const out = [{ path: '/', pattern: '/' }, { path: '/site-unavailable', pattern: '/site-unavailable' }, { path: '/unknown-host', pattern: '/unknown-host' }, { path: '/t/SEABL1', pattern: '/t/[code]' }, { path: '/no-such-brand', pattern: '/[brand]' }];
  for (const brand of SITE_BRANDS) {
    const { industry, slugs } = await brandInfo(brand);
    out.push({ path: `/${brand}`, pattern: '/[brand]' });
    out.push({ path: `/${brand}/pages/about-us`, pattern: '/[brand]/pages/[page]' });
    if (industry === 'realty') {
      out.push({ path: `/${brand}/properties` });
      const props = (await hrefs(`${BASE.sites}/${brand}/properties`)).filter((h) => new RegExp(`^/${brand}/properties/[^/?]+$`).test(h));
      if (props[0]) out.push({ path: props[0] });
      out.push({ path: `/${brand}/saved-search/00000000-0000-0000-0000-000000000000?token=x` });
    }
    const bases = [];
    for (const s of slugs) bases.push({ base: await locationBase(brand, s), slug: s });
    const independent = bases.length === 1 && bases[0].base === `/${brand}`;
    // Single-location sites serve the location at /{brand}/…: map them onto the location patterns for coverage.
    const pat = (h) => (independent ? matchPattern(patterns, `/${brand}/${bases[0].slug}${h.split('?')[0].slice(brand.length + 1)}`) : undefined);
    const seen = new Set();
    for (const { base } of bases) {
      if (!independent) out.push({ path: base });
      const level1 = [...new Set((await hrefs(`${BASE.sites}${base}`)).map((h) => h.split('?')[0].split('#')[0]).filter((h) => h.startsWith(`${base}/`) && depth(h) === depth(base) + 1))];
      for (const h of level1) out.push({ path: h, pattern: pat(h) });
      // One detail page per pattern, from whichever location first links to it.
      for (const h of level1) {
        for (const d of await hrefs(`${BASE.sites}${h}`)) {
          const clean = d.split('#')[0];
          if (!clean.startsWith(`${base}/`) || depth(clean) < depth(base) + 2) continue;
          const key = clean.split('?')[0].split('/').slice(depth(base) + 1, depth(base) + 2).join('/') + ':' + (depth(clean) - depth(base));
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ path: clean, pattern: pat(clean) });
        }
      }
    }
    const first = bases[0]?.base;
    if (!first) continue;
    const extra = [...(MANAGE[industry] ?? []), 'about-us'];
    if (industry === 'foods') extra.push('table/SEABL1');
    if (industry === 'commerce') extra.push('shop/cart');
    for (const m of extra) out.push({ path: `${first}/${m}`, pattern: pat(`${first}/${m}`) });
  }
  return dedupe(out).map((r) => ({ ...r, app: 'sites', pattern: r.pattern ?? matchPattern(patterns, r.path.split('?')[0]), key: SITES_KEY.has(r.path) }));
}

// ───────────────────────── mobile (Expo web export) ─────────────────────────
const mobileState = (experience, brand = 'stillwater') => ({ 'bh.token': 'mock.audit', 'bh.experience': experience, 'bh.brand': brand });
const MOBILE_KEY = new Set(['/customer/home', '/customer/book', '/staff/today', '/owner/pulse', '/customer/checkout']);

export function mobileRoutes() {
  const patterns = expoPatterns(path.join(ROOT, 'apps/mobile/app'));
  const out = [{ path: '/', pattern: '/', label: 'sign-in', storage: {} }];
  for (const p of patterns) {
    if (p === '/') continue;
    const concrete = p.replace(/\[id\]/, 'audit-placeholder');
    const exp = p.startsWith('/staff') ? 'staff' : p.startsWith('/owner') ? 'owner' : 'customer';
    const brands = p.startsWith('/customer/') && /\/(home|bookings|inbox|profile|checkout|locations)$/.test(p) ? ['stillwater', 'maple'] : [p.includes('/order') || /item|delivery|meal-plans|orders/.test(p) ? 'maple' : 'stillwater'];
    for (const b of brands) out.push({ path: concrete, pattern: p, label: `${b} ${concrete}`, storage: mobileState(exp, b), key: MOBILE_KEY.has(concrete) && b === 'stillwater' });
  }
  return out.map((r) => ({ ...r, app: 'mobile' }));
}

function matchPattern(patterns, p) {
  const sorted = [...patterns].sort((a, b) => (b.match(/\[/g)?.length ?? 0) - (a.match(/\[/g)?.length ?? 0) || b.length - a.length);
  // Prefer the most specific (fewest dynamic segments) match.
  const hits = sorted.filter((pat) => patternToRegex(pat).test(p));
  hits.sort((a, b) => (a.match(/\[/g)?.length ?? 0) - (b.match(/\[/g)?.length ?? 0));
  return hits[0] ?? '(unmatched)';
}

function dedupe(rs) {
  const seen = new Set();
  return rs.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}

/** File-system routes of an app that the route list did not visit. */
export function coverage(app, routes) {
  const patterns =
    app === 'web' ? nextPatterns(path.join(ROOT, 'apps/web/app')) : app === 'app' ? nextPatterns(path.join(ROOT, 'apps/app/src/app')) : app === 'sites' ? nextPatterns(path.join(ROOT, 'apps/sites/app')) : expoPatterns(path.join(ROOT, 'apps/mobile/app'));
  const visited = new Set(routes.map((r) => r.pattern));
  return { total: patterns.length, missing: patterns.filter((p) => !visited.has(p) && !(app === 'app' && p === '/')) };
}

export async function routesFor(app) {
  if (app === 'web') return webRoutes();
  if (app === 'app') return appRoutes();
  if (app === 'sites') return sitesRoutes();
  return mobileRoutes();
}
