#!/usr/bin/env node
// BranchHarbor UI audit: visits every route of every app across viewports, devices, colour schemes and zoom,
// and records overflow, clipped text, small tap targets, unsized images/layout shift, console errors,
// axe-core WCAG 2.2 AA violations, missing focus indicators and full-page screenshots.
//
//   node audit.mjs [--apps=web,app,sites,mobile] [--mode=standard|full|smoke] [--label=before]
//                  [--only=<substring>] [--concurrency=4] [--no-shots]
//
// Results: report/results-<label>.json (+ screenshots under report/screenshots/<label>/). `node report.mjs` writes the markdown.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { APPS, AXE_TAGS, BASE, TAP_MIN, TAP_MIN_AA, tiers } from './lib/config.mjs';
import { coverage, routesFor } from './lib/routes.mjs';
import { sessionCookies, storageFor } from './lib/session.mjs';
import { INIT_SCRIPT, LARGE_TEXT_CSS, focusCheck, pageChecks } from './lib/checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const apps = String(args.apps ?? APPS.join(',')).split(',');
const mode = String(args.mode ?? 'standard');
const label = String(args.label ?? 'latest');
const only = args.only ? String(args.only) : null;
const concurrency = Number(args.concurrency ?? 4);
const shots = !args['no-shots'];
const OUT = path.join(HERE, 'report');
const SHOTS = path.join(OUT, 'screenshots', label);
fs.mkdirSync(SHOTS, { recursive: true });

const STORAGE_COOKIE = 'bh_audit_ls';
// Seeds localStorage from a cookie before any app script runs (per-route personas without extra navigations).
const STORAGE_INIT = `
(() => {
  try {
    const m = document.cookie.match(/(?:^|; )${STORAGE_COOKIE}=([^;]*)/);
    if (!m) return;
    const data = JSON.parse(decodeURIComponent(m[1]));
    if (sessionStorage.getItem('__bh_audit_seeded') === m[1]) return;
    localStorage.clear();
    for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
    sessionStorage.setItem('__bh_audit_seeded', m[1]);
  } catch (e) {}
})();
`;

const slug = (s) => s.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120) || 'root';

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"], .bh-skeleton'), null, { timeout: 6000 })
    .catch(() => {});
  await page.waitForTimeout(350);
}

async function runTask(page, ctx, task, logs) {
  const { route, config } = task;
  const url = BASE[route.app] + route.path;
  const host = new URL(BASE[route.app]).hostname;
  await ctx.clearCookies();
  const storage = await storageFor(route);
  if (storage) {
    await ctx.addCookies([{ name: STORAGE_COOKIE, value: encodeURIComponent(JSON.stringify(storage)), domain: host, path: '/' }]);
  }
  for (const c of sessionCookies(route)) await ctx.addCookies([{ ...c, domain: host, path: '/' }]);
  logs.console.length = 0;
  logs.failed.length = 0;
  let status = null;
  const t0 = Date.now();
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    status = res?.status() ?? null;
  } catch (e) {
    return { error: String(e.message).split('\n')[0] };
  }
  await settle(page);
  if (config.largeText) {
    // The re-layout caused by injecting the large-text style is the audit's own doing, not a page layout shift.
    const shifts = await page.evaluate(() => (window.__bhShifts || []).slice());
    await page.addStyleTag({ content: LARGE_TEXT_CSS });
    await page.waitForTimeout(250);
    await page.evaluate((s) => (window.__bhShifts = s), shifts);
  }
  const checks = await page.evaluate(pageChecks, { touch: !!config.hasTouch, tapMin: TAP_MIN, tapMinAA: TAP_MIN_AA });
  let axe = null;
  if (config.axe) {
    try {
      const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      axe = r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 6).map((n) => ({ target: n.target.join(' '), summary: (n.failureSummary || '').split('\n').slice(1, 2).join(' ').slice(0, 200), html: n.html.slice(0, 160) })) }));
    } catch (e) {
      axe = [{ id: 'axe-error', impact: 'n/a', help: String(e.message).slice(0, 200), nodes: 0, targets: [] }];
    }
  }
  let focus = null;
  if (config.focus) focus = await focusCheck(page).catch((e) => ({ checked: 0, missing: [], error: String(e.message) }));
  let shot = null;
  if (shots) {
    const dir = path.join(SHOTS, route.app, config.id);
    fs.mkdirSync(dir, { recursive: true });
    shot = path.join(dir, `${slug(route.label ?? route.path)}.jpg`);
    await page.screenshot({ path: shot, fullPage: true, type: 'jpeg', quality: 50, timeout: 30000 }).catch(() => (shot = null));
  }
  return {
    status,
    ms: Date.now() - t0,
    ...checks,
    axe,
    focus,
    console: [...logs.console],
    failed: [...logs.failed],
    shot: shot ? path.relative(OUT, shot) : null,
  };
}

async function runConfig(browser, config, tasks, results, progress) {
  const queue = [...tasks];
  const worker = async () => {
    const ctx = await browser.newContext({
      viewport: config.viewport,
      deviceScaleFactor: config.deviceScaleFactor,
      isMobile: config.isMobile,
      hasTouch: config.hasTouch,
      userAgent: config.userAgent,
      colorScheme: config.scheme ?? 'light',
      reducedMotion: 'reduce',
      locale: 'en-US',
      timezoneId: 'America/Toronto',
    });
    await ctx.addInitScript(INIT_SCRIPT);
    await ctx.addInitScript(STORAGE_INIT);
    // External assets (stock photos, fonts) are not reachable from CI sandboxes: fail fast instead of hanging.
    await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => (/fonts\.(googleapis|gstatic)/.test(r.request().url()) ? r.continue() : r.abort()));
    // A fresh page per task: Chromium drops touch emulation (`pointer: coarse`) after a full-page screenshot
    // resizes the viewport, so reusing a page would audit later routes as if on a mouse device.
    const logs = { console: [], failed: [] };
    const openPage = async () => {
      const page = await ctx.newPage();
      page.on('console', (m) => {
        const t = m.text();
        if (m.type() === 'error' && !/Failed to load resource/.test(t)) logs.console.push({ type: 'error', text: t.slice(0, 300) });
        else if (/hydrat/i.test(t)) logs.console.push({ type: m.type(), text: t.slice(0, 300) });
      });
      page.on('pageerror', (e) => logs.console.push({ type: 'pageerror', text: String(e.message).slice(0, 300) }));
      page.on('response', (r) => {
        if (r.status() >= 400 && /localhost|127\.0\.0\.1/.test(r.url())) logs.failed.push({ status: r.status(), url: r.url().slice(0, 160) });
      });
      return page;
    };
    while (queue.length) {
      const task = queue.shift();
      const page = await openPage();
      let r;
      try {
        r = await runTask(page, ctx, task, logs);
      } catch (e) {
        r = { error: String(e.message).split('\n')[0] };
      }
      await page.close().catch(() => {});
      results.push({ app: task.route.app, path: task.route.path, label: task.route.label ?? task.route.path, pattern: task.route.pattern, key: !!task.route.key, config: config.id, scheme: config.scheme ?? 'light', width: config.viewport.width, touch: !!config.hasTouch, ...r });
      progress();
    }
    await ctx.close();
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

const started = Date.now();
const browser = await chromium.launch();
const { routes: routeConfigs, matrix } = tiers(mode);
const results = [];
const cover = {};
const plan = [];
for (const app of apps) {
  let rs = await routesFor(app);
  cover[app] = { ...coverage(app, rs), visited: rs.length };
  if (only) rs = rs.filter((r) => (r.label ?? r.path).includes(only));
  for (const c of routeConfigs) plan.push({ config: c, tasks: rs.map((route) => ({ route, config: c })) });
  for (const c of matrix) plan.push({ config: c, tasks: rs.filter((r) => r.key).map((route) => ({ route, config: c })) });
}
const total = plan.reduce((a, p) => a + p.tasks.length, 0);
let done = 0;
const progress = () => {
  done++;
  if (done % 25 === 0 || done === total) console.log(`[ui-audit] ${done}/${total} (${Math.round((Date.now() - started) / 1000)}s)`);
};
console.log(`[ui-audit] mode=${mode} apps=${apps.join(',')} tasks=${total}`);
for (const p of plan) if (p.tasks.length) await runConfig(browser, p.config, p.tasks, results, progress);
await browser.close();

const file = path.join(OUT, `results-${label}.json`);
fs.writeFileSync(file, JSON.stringify({ meta: { label, mode, apps, started: new Date(started).toISOString(), seconds: Math.round((Date.now() - started) / 1000), base: BASE, coverage: cover, configs: [...routeConfigs, ...matrix].map((c) => c.id + (c.scheme === 'dark' && !c.id.endsWith('-dark') ? '-dark' : '')) }, results }, null, 1));
console.log(`[ui-audit] wrote ${path.relative(process.cwd(), file)} (${results.length} page loads)`);
