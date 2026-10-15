// Smoke tests: key pages of every app render, and nothing overflows horizontally at 360 / 768 / 1440 px
// (desktop projects resize; phone projects use the device viewport).
import { expect, test } from '@playwright/test';
import { BASE } from '../lib/config.mjs';

const appState = (industry) => ({ bh_app_state: JSON.stringify({ industry, role: 'hq', scopeId: 'all', aiOpen: false, navCollapsed: false, orgId: null, business: 'network' }) });
const mobileState = (experience, brand = 'stillwater') => ({ 'bh.token': 'mock.smoke', 'bh.experience': experience, 'bh.brand': brand });

/** [app, path, localStorage seed, text the page must show] */
const PAGES = [
  ['web', '/en', null, /BranchHarbor/i],
  ['web', '/en/pricing', null, /pric/i],
  ['web', '/en/industries/foods', null, /food/i],
  ['web', '/de/demo', null, /demo/i],
  ['app', '/sign-in', {}, /sign in/i],
  ['app', '/overview', appState('studios'), /overview/i],
  ['app', '/ops/classes', appState('studios'), /class/i],
  ['app', '/ops/kitchen', appState('foods'), /kitchen/i],
  ['app', '/ops/orders', appState('commerce'), /order/i],
  ['app', '/payments', appState('studios'), /payment/i],
  ['sites', '/stillwater-yoga', null, /stillwater/i],
  ['sites', '/stillwater-yoga/queen-west', null, /queen west/i],
  ['sites', '/stillwater-yoga/queen-west/classes', null, /class/i],
  ['sites', '/maple-and-ember/ballard/order', null, /order|menu/i],
  ['sites', '/fieldnote-goods/portland/shop', null, /shop|product/i],
  ['sites', '/keystone-realty/properties', null, /propert/i],
  ['mobile', '/', {}, /BranchHarbor/i],
  ['mobile', '/customer/home', mobileState('customer'), /Stillwater/i],
  ['mobile', '/staff/today', mobileState('staff'), /today/i],
  ['mobile', '/owner/pulse', mobileState('owner'), /pulse/i],
];

const apps = (process.env.SMOKE_APPS ?? 'web,app,sites,mobile').split(',');

async function overflow(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement || document.documentElement;
    return se.scrollWidth - se.clientWidth;
  });
}

for (const [app, path, seed, text] of PAGES.filter((p) => apps.includes(p[0]))) {
  test(`${app} ${path}`, async ({ page, isMobile }, info) => {
    // External photos/fonts may be unreachable in CI: abort them instead of waiting.
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    if (seed) {
      await page.addInitScript((data) => {
        if (sessionStorage.getItem('__seeded')) return;
        localStorage.clear();
        for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v);
        sessionStorage.setItem('__seeded', '1');
      }, seed);
    }
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(BASE[app] + path, { waitUntil: 'load' });
    expect(res?.status() ?? 200, 'HTTP status').toBeLessThan(400);
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('body')).toContainText(text);
    const widths = isMobile ? [page.viewportSize().width] : [360, 768, 1440];
    for (const w of widths) {
      if (!isMobile) await page.setViewportSize({ width: w, height: w < 600 ? 800 : 900 });
      await page.waitForTimeout(150);
      expect(await overflow(page), `horizontal overflow at ${w}px (${info.project.name})`).toBeLessThanOrEqual(0);
    }
    expect(errors, 'uncaught page errors').toEqual([]);
  });
}
