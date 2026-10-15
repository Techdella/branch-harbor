// Shared configuration for the UI audit and the cross-browser smoke tests.
import { devices } from 'playwright';

/** Base URLs of the four apps (production builds). Override with env vars. */
export const BASE = {
  web: process.env.UI_AUDIT_WEB_URL ?? 'http://localhost:6401',
  app: process.env.UI_AUDIT_APP_URL ?? 'http://localhost:6402',
  sites: process.env.UI_AUDIT_SITES_URL ?? 'http://localhost:6403',
  mobile: process.env.UI_AUDIT_MOBILE_URL ?? 'http://localhost:6404',
  api: process.env.UI_AUDIT_API_URL ?? 'http://localhost:6400',
};

export const APPS = ['web', 'app', 'sites', 'mobile'];

/** Plain viewport widths audited. Heights follow a typical aspect for the class of device. */
export const WIDTHS = [320, 360, 390, 414, 768, 834, 1024, 1280, 1440, 1920];
const heightFor = (w) => (w < 600 ? 780 : w < 1100 ? 1024 : 900);

const vp = (w, h = heightFor(w), extra = {}) => ({
  id: `w${w}${h !== heightFor(w) ? `x${h}` : ''}`,
  viewport: { width: w, height: h },
  deviceScaleFactor: w < 1024 ? 2 : 1,
  isMobile: w < 1024,
  hasTouch: w < 1024,
  ...extra,
});

const fromDevice = (id, name, override = {}) => {
  const d = devices[name];
  if (!d) throw new Error(`Unknown Playwright device: ${name}`);
  return { id, viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: d.isMobile, hasTouch: d.hasTouch, userAgent: d.userAgent, ...override };
};

/** Every config the audit knows. `scheme` defaults to light. */
export function allConfigs() {
  const widths = WIDTHS.map((w) => vp(w));
  const landscape = { ...vp(844, 390), id: 'phone-landscape-844x390', isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
  const devs = [
    fromDevice('iphone-15', 'iPhone 15'),
    fromDevice('pixel-8', 'Pixel 7', { id: 'pixel-8', viewport: { width: 412, height: 915 } }),
    fromDevice('ipad-air', 'iPad Pro 11', { id: 'ipad-air', viewport: { width: 820, height: 1180 } }),
    fromDevice('ipad-landscape', 'iPad Pro 11 landscape', { id: 'ipad-landscape', viewport: { width: 1180, height: 820 } }),
    { id: 'galaxy-fold-280', viewport: { width: 280, height: 653 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  ];
  // 200% browser zoom on a 1280×800 window == 640×400 CSS px at DPR 2. "Large text" doubles the root font size.
  const zoom = [
    { id: 'zoom200-1280', viewport: { width: 640, height: 400 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
    { id: 'text200-390', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, largeText: true },
  ];
  return { widths, landscape, devs, zoom };
}

const dark = (c) => ({ ...c, id: `${c.id}-dark`, scheme: 'dark' });
const light = (c) => ({ ...c, scheme: 'light' });

/**
 * Tiers:
 *  - `routes`: run for EVERY route. Three breakpoints in light + one phone in dark. Axe at 1440 light and 390 dark.
 *  - `matrix`: run for the KEY routes of each app: every width, landscape phone, device emulations, light and dark, 200% zoom/large text.
 */
export function tiers(mode = 'standard') {
  const { widths, landscape, devs, zoom } = allConfigs();
  const byW = Object.fromEntries(widths.map((c) => [c.viewport.width, c]));
  const routes = [
    { ...light(byW[360]), axe: false, focus: false },
    { ...light(byW[768]), axe: false, focus: false },
    { ...light(byW[1440]), axe: true, focus: true },
    { ...dark(byW[390]), axe: true, focus: false },
  ];
  if (mode === 'smoke') return { routes: [routes[0], routes[2]], matrix: [] };
  const matrix = [
    ...widths.filter((c) => ![360, 768, 1440].includes(c.viewport.width)).map(light),
    light(landscape),
    ...devs.map(light),
    ...devs.map(dark),
    ...widths.filter((c) => [360, 1440].includes(c.viewport.width)).map(dark),
    ...zoom.map(light),
  ].map((c) => ({ ...c, axe: false, focus: false }));
  if (mode === 'full') return { routes: [...routes, ...matrix], matrix: [] };
  return { routes, matrix };
}

/** WCAG 2.2 AA rule tags for axe-core. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Design-system minimum control size (px) and the WCAG 2.2 AA (2.5.8) minimum. */
export const TAP_MIN = 44;
export const TAP_MIN_AA = 24;
