/**
 * Shared message-catalogue checks (same rules as apps/web/scripts/check-messages.mjs):
 *  - every key (and array item) of the source locale exists in each locale, with the same shape;
 *  - no extra keys;
 *  - no empty strings;
 *  - placeholders preserved — ICU arguments ({name}, {count, plural, …}) with the same argument types for
 *    next-intl catalogues, or %{name} / {{name}} / {name} for i18n-js style catalogues;
 *  - braces balanced; non-string values identical to the source.
 * Strings left identical to English are counted (proper nouns and loanwords are expected there).
 */

/**
 * Collects ICU arguments as "name:type" (type is "" for simple arguments) with a small recursive parser:
 * {name}, {name, number|date|time[, style]}, {name, plural|select|selectordinal, sel {msg} …}.
 * Throws on malformed messages (unbalanced braces, missing option bodies).
 */
export function icuArgs(str) {
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
      } else if (c === '<') {
        // next-intl rich-text tags: <b>…</b> — tag names are collected like arguments.
        const m = /^<\/?([A-Za-z][\w-]*)\s*\/?>/.exec(str.slice(i));
        if (m) {
          if (!m[0].startsWith('</')) args.add(`<${m[1]}>`);
          i += m[0].length;
        } else i++;
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
          ident();
          if (str[i] !== '{') throw new Error(`expected "{" after selector in ${name}`);
          i++;
          message(true);
          i++;
          options++;
          ws();
        }
        if (!options) throw new Error(`no options for ${name}`);
      } else if (str[i] === ',') {
        while (i < str.length && str[i] !== '}') i++;
      }
    }
    if (str[i] !== '}') throw new Error(`unbalanced "{" in argument ${name}`);
    i++;
    args.add(`${name}:${type}`);
  };
  message(false);
  // Inside plural/select branches a translation may repeat the argument as {count} instead of "#".
  for (const a of [...args]) {
    const [name, type] = a.split(':');
    if (!type && [...args].some((b) => b !== a && b.startsWith(`${name}:`))) args.delete(a);
  }
  return args;
}

/** Placeholders of i18n-js / simple template strings: %{name}, {{name}} and {name}. */
export function simpleArgs(str) {
  const args = new Set();
  for (const m of str.matchAll(/%\{(\w+)\}|\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g)) args.add(m[1] ?? m[2] ?? m[3]);
  const open = (str.match(/\{/g) ?? []).length;
  const close = (str.match(/\}/g) ?? []).length;
  if (open !== close) throw new Error('unbalanced braces');
  return args;
}

export const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * Compares `other` against `en`. Pushes problems to `errors` and identical-to-English strings to `same`.
 * opts.args: placeholder extractor (icuArgs or simpleArgs); opts.codePaths: regexes of paths that must equal English.
 */
export function compare(en, other, at, errors, same, opts) {
  const te = typeOf(en);
  const to = typeOf(other);
  if (to === 'undefined') return void errors.push(`missing: ${at}`);
  if (te !== to) return void errors.push(`type mismatch at ${at}: expected ${te}, got ${to}`);
  if (te === 'array') {
    if (en.length !== other.length) errors.push(`array length at ${at}: expected ${en.length}, got ${other.length}`);
    en.forEach((v, i) => compare(v, other[i], `${at}[${i}]`, errors, same, opts));
    return;
  }
  if (te === 'object') {
    for (const k of Object.keys(en)) compare(en[k], other[k], at ? `${at}.${k}` : k, errors, same, opts);
    for (const k of Object.keys(other)) if (!(k in en)) errors.push(`extra key: ${at ? `${at}.${k}` : k}`);
    return;
  }
  if (te === 'string') {
    if (other.trim() === '') return void errors.push(`empty string: ${at}`);
    if ((opts.codePaths ?? []).some((re) => re.test(at)) && other !== en) return void errors.push(`code value changed at ${at}: "${en}" → "${other}"`);
    let a;
    let b;
    try {
      a = opts.args(en);
    } catch (e) {
      return void errors.push(`source ${at}: ${e.message}`);
    }
    try {
      b = opts.args(other);
    } catch (e) {
      return void errors.push(`${at}: ${e.message}`);
    }
    const missing = [...a].filter((x) => !b.has(x));
    const extra = [...b].filter((x) => !a.has(x));
    if (missing.length || extra.length) errors.push(`placeholders differ at ${at}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
    if (other === en && /[a-z]{4,}\s+[a-z]{3,}/i.test(en)) same.push(at);
    return;
  }
  if (en !== other) errors.push(`value changed at ${at}: ${JSON.stringify(en)} → ${JSON.stringify(other)}`);
}

/**
 * Checks catalogue sets. sets: [{ name, source: object, locales: { [locale]: object | undefined } }].
 * Returns true when everything passes; prints a report.
 */
export function report(sets, opts) {
  let failed = false;
  const verbose = process.argv.includes('--verbose');
  for (const set of sets) {
    {
      const errors = [];
      compare(set.source, set.source, '', errors, [], opts);
      if (errors.length) {
        failed = true;
        console.error(`✗ ${set.name} [source]:\n  ${errors.join('\n  ')}`);
      }
    }
    for (const [locale, data] of Object.entries(set.locales)) {
      if (data === undefined) {
        failed = true;
        console.error(`✗ ${set.name} [${locale}]: catalogue is missing`);
        continue;
      }
      const errors = [];
      const same = [];
      compare(set.source, data, '', errors, same, opts);
      const note = locale.startsWith('en') ? '' : ` · ${same.length} strings identical to English`;
      if (errors.length) {
        failed = true;
        console.error(`✗ ${set.name} [${locale}]: ${errors.length} problem(s)${note}\n  ${errors.slice(0, 50).join('\n  ')}${errors.length > 50 ? `\n  … and ${errors.length - 50} more` : ''}`);
      } else console.log(`✓ ${set.name} [${locale}]${note}`);
      if (verbose && same.length && !locale.startsWith('en')) console.log(`  identical: ${same.join(', ')}`);
    }
  }
  if (failed) console.error('\nMessage check failed.');
  else console.log('\nAll catalogues complete with placeholders preserved.');
  return !failed;
}
