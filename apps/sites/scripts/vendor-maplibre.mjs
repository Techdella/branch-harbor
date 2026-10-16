#!/usr/bin/env node
/**
 * Copies MapLibre GL's CSS and web worker (with its shared chunk) to public/vendor/maplibre/, so the territory map can
 * load the worker from a stable URL instead of relying on the bundler (see packages/ui/src/map/TerritoryMap.tsx).
 * Runs before `dev` and `build`; the copies are not committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = path.dirname(require.resolve('maplibre-gl/package.json'));
const out = path.join(here, '..', 'public', 'vendor', 'maplibre');
fs.mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl.css', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) fs.copyFileSync(path.join(pkg, 'dist', f), path.join(out, f));
