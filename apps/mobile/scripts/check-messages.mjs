#!/usr/bin/env node
/**
 * Verifies every mobile locale against English, for the core catalogue (src/i18n/*.ts) and each feature string
 * module: every key present, no extra keys, no empty strings, placeholders (%{x}, {{x}}, {x}) preserved.
 * Rules are shared with the web catalogues (scripts/i18n/catalog.mjs).
 *
 * The modules are TypeScript: they are transpiled in memory and evaluated with only local imports resolved
 * (packages such as react or i18n-js are stubbed — the string tables do not need them at load time).
 * Usage: node scripts/check-messages.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { report, simpleArgs } from '../../../scripts/i18n/catalog.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const appRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(appRoot, 'src');
/** Kept in sync with src/i18n/index.tsx APP_LOCALES. */
const LOCALES = ['en', 'fr', 'es', 'de', 'pt-BR'];

/** Stands in for any package import: callable, constructible, every property is itself a stub. */
const stub = new Proxy(function stub() {}, {
  get: (_, k) => (k === '__esModule' ? false : k === Symbol.toPrimitive ? () => '' : stub),
  set: () => true,
  apply: () => stub,
  construct: () => stub,
});
const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file).exports;
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  cache.set(file, mod);
  const localRequire = (spec) => {
    let target = null;
    if (spec.startsWith('@/')) target = path.join(src, spec.slice(2));
    else if (spec.startsWith('.')) target = path.join(path.dirname(file), spec);
    if (!target) return stub;
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) if (fs.existsSync(target + ext)) return load(target + ext);
    throw new Error(`cannot resolve ${spec} from ${file}`);
  };
  vm.runInNewContext(`(function (exports, require, module) {${code}\n})`, {}, { filename: file })(mod.exports, localRequire, mod);
  return mod.exports;
}

const core = Object.fromEntries(
  LOCALES.map((l) => [l, load(path.join(src, 'i18n', `${l === 'pt-BR' ? 'ptBR' : l}.ts`)).default]),
);
const foods = load(path.join(src, 'features', 'foods', 'i18n.ts'));
const foodsByLocale = { en: foods.foodsxEn, fr: foods.foodsxFr, es: foods.foodsxEs, de: foods.foodsxDe, 'pt-BR': foods.foodsxPt };

const sets = [
  { name: 'src/i18n', source: core.en, locales: Object.fromEntries(LOCALES.slice(1).map((l) => [l, core[l]])) },
  { name: 'features/foods/i18n', source: foodsByLocale.en, locales: Object.fromEntries(LOCALES.slice(1).map((l) => [l, foodsByLocale[l]])) },
];

// Feature string modules export STRINGS = { en, fr, es, de, 'pt-BR' }.
for (const mod of ['commerce/strings.ts', 'realty/strings.ts', 'wellness/strings.ts', 'hospitality/strings.ts', 'network/strings.ts', 'quality/strings.ts']) {
  const tables = load(path.join(src, 'features', mod)).STRINGS;
  if (!tables) {
    console.error(`✗ features/${mod} does not export STRINGS`);
    process.exitCode = 1;
    continue;
  }
  sets.push({ name: `features/${mod.replace(/\.ts$/, '')}`, source: tables.en, locales: Object.fromEntries(LOCALES.slice(1).map((l) => [l, tables[l]])) });
}

if (!report(sets, { args: simpleArgs })) process.exit(1);
