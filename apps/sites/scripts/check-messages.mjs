#!/usr/bin/env node
/**
 * Verifies every customer-site locale against English for each catalogue set (messages/*.json and
 * messages/foods/*.json): every key present, no extra keys, no empty strings, ICU arguments preserved.
 * Customer pages serve all platform locales, so every locale in @bh/shared SUPPORTED_LOCALES must exist.
 * Rules are shared with the marketing site (scripts/i18n/catalog.mjs). Usage: node scripts/check-messages.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icuArgs, report } from '../../../scripts/i18n/catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'messages');

// Read the platform locales from @bh/shared so the check follows the product list.
const shared = fs.readFileSync(path.join(here, '..', '..', '..', 'packages', 'shared', 'src', 'locale.ts'), 'utf8');
const LOCALES = JSON.parse(
  /SUPPORTED_LOCALES\s*=\s*(\[[^\]]+\])/
    .exec(shared)[1]
    .replace(/'/g, '"'),
);
const SETS = ['', 'foods', 'fallback'];

const read = (dir, l) => {
  const f = path.join(root, dir, `${l}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
};

const sets = SETS.map((dir) => ({
  name: `messages/${dir ? `${dir}/` : ''}`,
  source: read(dir, 'en'),
  locales: Object.fromEntries(LOCALES.filter((l) => l !== 'en').map((l) => [l, read(dir, l)])),
}));

// i18n/request.ts must load every locale.
const request = fs.readFileSync(path.join(here, '..', 'i18n', 'request.ts'), 'utf8');
let ok = true;
for (const l of LOCALES.filter((x) => x !== 'en')) {
  if (!new RegExp(`['"]?${l}['"]?\s*:`).test(request)) {
    console.error(`✗ i18n/request.ts does not load '${l}'`);
    ok = false;
  }
}

if (!report(sets, { args: icuArgs }) || !ok) process.exit(1);
