#!/usr/bin/env node
/**
 * Verifies every locale in messages/ against messages/en.json:
 *  - every key (and array item) in en.json exists, with the same shape;
 *  - no extra keys that en.json does not have;
 *  - no empty strings;
 *  - ICU arguments are preserved ({name}, {count, plural, …}) with the same argument types;
 *  - braces are balanced;
 *  - non-string values (numbers) and code values (resources item categories, matrix statuses) are identical to English.
 *
 * Also lists strings left identical to English as warnings (proper nouns are expected there).
 * Usage: node scripts/check-messages.mjs [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'messages');
const verbose = process.argv.includes('--verbose');
/** Values read as codes by components (not shown as text): must stay identical to English. */
const CODE_PATHS = [/^resources\.items\[\d+\]\.cat$/, /^wordpress\.matrix\[\d+\]\.status$/];
const SOURCE = 'en';
/** Locales expected to exist (kept in sync with @bh/shared SUPPORTED_LOCALES). */
const EXPECTED = ['en', 'en-GB', 'fr', 'es', 'de', 'pt-BR', 'nl', 'it', 'ar'];

const read = (l) => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));
const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * Collects ICU arguments as "name:type" (type is "" for simple arguments) with a small recursive
 * parser: {name}, {name, number|date|time[, style]}, {name, plural|select|selectordinal, sel {msg} …}.
 * Throws on malformed messages (unbalanced braces, missing option bodies).
 */
function icuArgs(str) {
  const args = new Set();
  let i = 0;
  const ws = () => {
    while (i < str.length && /\s/.test(str[i])) i++;
  };
  const ident = () => {
    ws();
    const m = /^[^\s{},]+/.exec(str.slice(i));
    if (!m) throw new Error(`expected a name at ${i}`);
    i += m[0].length;
    ws();
    return m[0];
  };
  // Reads message text until an unmatched "}" (or end when top-level).
  const message = (nested) => {
    while (i < str.length) {
      const c = str[i];
      if (c === "'") {
        if (str[i + 1] === "'") i += 2;
        else if (str[i + 1] === '{' || str[i + 1] === '}' || str[i + 1] === '#') {
          const close = str.indexOf("'", i + 1);
          i = close === -1 ? str.length : close + 1;
        } else i++;
      } else if (c === '{') {
        i++;
        argument();
      } else if (c === '}') {
        if (!nested) throw new Error('unbalanced "}"');
        return;
      } else i++;
    }
    if (nested) throw new Error('unbalanced "{"');
  };
  const argument = () => {
    const name = ident();
    let type = '';
    if (str[i] === ',') {
      i++;
      type = ident();
      if (type === 'plural' || type === 'select' || type === 'selectordinal') {
        if (str[i] !== ',') throw new Error(`expected options for ${name}`);
        i++;
        ws();
        if (/^offset:/.test(str.slice(i))) ident();
        let options = 0;
        while (i < str.length && str[i] !== '}') {
          ident(); // selector, e.g. one / other / =0
          if (str[i] !== '{') throw new Error(`expected "{" after selector in ${name}`);
          i++;
          message(true);
          i++; // closing }
          options++;
          ws();
        }
        if (!options) throw new Error(`no options for ${name}`);
      } else if (str[i] === ',') {
        // number/date/time style: skip to the closing brace
        while (i < str.length && str[i] !== '}') i++;
      }
    }
    if (str[i] !== '}') throw new Error(`unbalanced "{" in argument ${name}`);
    i++;
    args.add(`${name}:${type}`);
  };
  message(false);
  // Inside plural/select branches a translation may repeat the argument as {count} instead of "#"
  // (e.g. Arabic, to control digit shapes). That is the same argument, not an extra one.
  for (const a of [...args]) {
    const [name, type] = a.split(':');
    if (!type && [...args].some((b) => b !== a && b.startsWith(`${name}:`))) args.delete(a);
  }
  return args;
}

function compare(en, other, at, errors, same) {
  const te = typeOf(en);
  const to = typeOf(other);
  if (to === 'undefined') return void errors.push(`missing: ${at}`);
  if (te !== to) return void errors.push(`type mismatch at ${at}: expected ${te}, got ${to}`);
  if (te === 'array') {
    if (en.length !== other.length) errors.push(`array length at ${at}: expected ${en.length}, got ${other.length}`);
    en.forEach((v, i) => compare(v, other[i], `${at}[${i}]`, errors, same));
    return;
  }
  if (te === 'object') {
    for (const k of Object.keys(en)) compare(en[k], other[k], at ? `${at}.${k}` : k, errors, same);
    for (const k of Object.keys(other)) if (!(k in en)) errors.push(`extra key: ${at ? `${at}.${k}` : k}`);
    return;
  }
  if (te === 'string') {
    if (other.trim() === '') return void errors.push(`empty string: ${at}`);
    if (CODE_PATHS.some((re) => re.test(at)) && other !== en) return void errors.push(`code value changed at ${at}: "${en}" → "${other}"`);
    let a;
    let b;
    try {
      a = icuArgs(en);
    } catch (e) {
      return void errors.push(`en.json ${at}: ${e.message}`);
    }
    try {
      b = icuArgs(other);
    } catch (e) {
      return void errors.push(`${at}: ${e.message}`);
    }
    const missing = [...a].filter((x) => !b.has(x));
    const extra = [...b].filter((x) => !a.has(x));
    if (missing.length || extra.length) errors.push(`ICU arguments differ at ${at}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
    if (other === en && /[a-z]{4,}\s+[a-z]{3,}/i.test(en)) same.push(at);
    return;
  }
  if (en !== other) errors.push(`value changed at ${at}: ${JSON.stringify(en)} → ${JSON.stringify(other)}`);
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const source = read(SOURCE);
let failed = false;

for (const l of EXPECTED) {
  if (!files.includes(l)) {
    console.error(`✗ ${l}: messages/${l}.json is missing`);
    failed = true;
  }
}

// Validate English itself (placeholders parse).
{
  const errors = [];
  compare(source, source, '', errors, []);
  if (errors.length) {
    failed = true;
    console.error(`✗ ${SOURCE}:\n  ${errors.join('\n  ')}`);
  }
}

for (const l of files.filter((f) => f !== SOURCE).sort()) {
  const errors = [];
  const same = [];
  compare(source, read(l), '', errors, same);
  // en-GB is expected to match English almost everywhere.
  const sameNote = l.startsWith('en') ? '' : ` · ${same.length} strings identical to English`;
  if (errors.length) {
    failed = true;
    console.error(`✗ ${l}: ${errors.length} problem(s)${sameNote}\n  ${errors.slice(0, 50).join('\n  ')}${errors.length > 50 ? `\n  … and ${errors.length - 50} more` : ''}`);
  } else {
    console.log(`✓ ${l}${sameNote}`);
  }
  if (verbose && same.length && !l.startsWith('en')) console.log(`  identical: ${same.join(', ')}`);
}

if (failed) {
  console.error('\nMessage check failed.');
  process.exit(1);
}
console.log(`\nAll ${files.length} locales have every key of ${SOURCE}.json with ICU arguments preserved.`);
