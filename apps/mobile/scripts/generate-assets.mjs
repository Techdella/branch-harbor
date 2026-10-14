#!/usr/bin/env node
/**
 * Generates the app icon, Android adaptive icon, splash image, notification icon and web favicon from the
 * BranchHarbor harbour mark (packages/icons logoSvg / design/prototype Brand Sheet): an ink rounded square,
 * two white H posts joined by a crossbar, a 35% stem and the lime hub.
 *
 *   pnpm --filter @bh/mobile assets        (writes apps/mobile/assets/*.png)
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const INK = '#141414';
const LIME = '#D6F26B';
const CANVAS = '#F3F2EE';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');

/** The mark's strokes on the 40×40 grid (same geometry as logoSvg in @bh/icons). */
const glyph = ({ fg = '#FFFFFF', hub = LIME, stroke = 3.4, hubR = 4.2, stem = true } = {}) =>
  `<path d="M11 11v18M29 11v18M11 20h18" stroke="${fg}" stroke-width="${stroke}" stroke-linecap="round" fill="none"/>` +
  (stem ? `<path d="M20 20 20 11" stroke="${fg}" stroke-width="${stroke}" stroke-linecap="round" opacity=".35"/>` : '') +
  (hub ? `<circle cx="20" cy="20" r="${hubR}" fill="${hub}"/>` : '');

/** Square canvas of `size` px; the 40-unit mark is scaled to `scale` of the canvas and centred. */
function svg(size, { background = null, rounded = false, scale = 1, ...g } = {}) {
  const k = (size * scale) / 40;
  const off = (size - size * scale) / 2;
  const bg = background ? `<rect width="${size}" height="${size}" ${rounded ? `rx="${size * 0.3}"` : ''} fill="${background}"/>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}<g transform="translate(${off} ${off}) scale(${k})">${glyph(g)}</g></svg>`);
}

/** Rounded ink tile with the mark (used for the splash and favicon). */
function tile(size, { stroke = 3.4, hubR = 4.2, stem = true } = {}) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40"><rect width="40" height="40" rx="12" fill="${INK}"/>${glyph({ stroke, hubR, stem })}</svg>`);
}

const files = /** @type {[string, Buffer, number][]} */ ([
  // iOS / store icon: full-bleed ink (the OS applies its own corner mask), mark scaled so the H spans ~43% of the tile.
  ['icon.png', svg(1024, { background: INK, scale: 0.95 }), 1024],
  // Android adaptive foreground: transparent, mark inside the 66% safe zone; background colour comes from app.config.
  ['adaptive-icon.png', svg(1024, { scale: 0.8 }), 1024],
  // Monochrome adaptive icon (Android 13 themed icons).
  ['adaptive-icon-monochrome.png', svg(1024, { scale: 0.8, fg: '#FFFFFF', hub: '#FFFFFF' }), 1024],
  // Splash: rounded ink tile on a transparent canvas; app.config sets the canvas background and width.
  ['splash-icon.png', tile(1024), 1024],
  // Android notification small icon: white silhouette on transparent.
  ['notification-icon.png', svg(96, { scale: 0.86, fg: '#FFFFFF', hub: '#FFFFFF', stroke: 4, hubR: 4.6 }), 96],
  // Web favicon: the small-size variant (heavier strokes, no stem) from the brand sheet.
  ['favicon.png', tile(48, { stroke: 5, hubR: 5, stem: false }), 48],
]);

await mkdir(out, { recursive: true });
for (const [name, src, size] of files) {
  const file = path.join(out, name);
  // Rasterise at high density, then downsample for crisp edges at the exact target size.
  await sharp(src, { density: 288 }).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
  const meta = await sharp(file).metadata();
  console.log(`${name.padEnd(30)} ${meta.width}×${meta.height}`);
}
console.log(`Splash background ${CANVAS} (light) / ${INK} (dark) is set in app.config.ts.`);
