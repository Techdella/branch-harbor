#!/usr/bin/env node
/**
 * Verifies every app locale against English for each catalogue set (messages/*.json and the namespace folders
 * single/, foods/, partners/, payments/, data/, access/, franchise/, network/, comms/): every key present, no extra keys, no empty strings, ICU arguments preserved.
 * Rules are shared with the marketing site (scripts/i18n/catalog.mjs). Usage: node scripts/check-messages.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icuArgs, report } from '../../../scripts/i18n/catalog.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'messages');
/** Kept in sync with src/i18n/config.ts APP_LOCALES. */
const LOCALES = ['en', 'fr', 'es', 'de', 'pt-BR'];
const SETS = ['', 'single', 'foods', 'partners', 'payments', 'data', 'access', 'franchise', 'network', 'comms', 'mkt'];

const read = (dir, l) => {
  const f = path.join(root, dir, `${l}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
};

const sets = SETS.map((dir) => ({
  name: `messages/${dir ? `${dir}/` : ''}`,
  source: read(dir, 'en'),
  locales: Object.fromEntries(LOCALES.filter((l) => l !== 'en').map((l) => [l, read(dir, l)])),
}));

// Catalogue files for locales the app does not offer would never load: flag them.
for (const dir of SETS) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (f.endsWith('.json') && !LOCALES.includes(f.replace(/\.json$/, ''))) console.warn(`! messages/${dir}/${f} is not an app locale`);
  }
}

if (!report(sets, { args: icuArgs })) process.exit(1);
