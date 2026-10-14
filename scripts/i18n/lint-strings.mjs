#!/usr/bin/env node
/**
 * Heuristic lint for hard-coded UI strings in React / React Native components.
 *
 * Flags, in .tsx files under the given roots:
 *  - JSX text nodes that contain a word (two or more letters), e.g. <p>Save changes</p>;
 *  - string literals used directly as JSX children, e.g. {open ? 'Open' : 'Closed'};
 *  - string literals in user-facing props: aria-label, placeholder, title, alt, accessibilityLabel,
 *    accessibilityHint (static strings, or literal branches of ?: / || / ??).
 *
 * Anything produced by a translation call (t('…'), t.rich(…), ct(…), …) is an expression, so it is not flagged.
 * Exceptions live in an allowlist JSON file:
 *   { "files": ["glob", …], "texts": ["exact text", …], "patterns": ["regex", …] }
 * "files" skips whole files (for example payment components owned elsewhere), "texts" / "patterns" skip
 * individual strings such as brand names, symbols or sample data.
 *
 * Usage: node scripts/i18n/lint-strings.mjs --root <dir> [--root <dir>] [--allow <file>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const roots = [];
let allowFile = null;
let asJson = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i]);
  else if (args[i] === '--allow') allowFile = args[++i];
  else if (args[i] === '--json') asJson = true;
}
if (!roots.length) roots.push('.');

const allow = allowFile && fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, 'utf8')) : {};
const globToRe = (g) =>
  new RegExp(
    '^' +
      g
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') +
      '$',
  );
const fileRes = (allow.files ?? []).map(globToRe);
const texts = new Set(allow.texts ?? []);
const patterns = (allow.patterns ?? []).map((p) => new RegExp(p, 'u'));

/** Text-bearing keys of navigator screen `options` objects (Expo Router / React Navigation). */
const OPTION_PROPS = new Set(['title', 'headerTitle', 'tabBarLabel', 'headerBackTitle', 'tabBarAccessibilityLabel']);
const PROPS = new Set([
  'aria-label', 'placeholder', 'title', 'alt', 'accessibilityLabel', 'accessibilityHint',
  // Common text props of the design-system components (Field, Banner, EmptyState, ScreenHeader, …).
  'label', 'hint', 'description', 'subtitle', 'body', 'kicker', 'heading', 'caption', 'emptyText', 'confirmLabel', 'cancelLabel', 'actionLabel',
]);
const WORD = /\p{L}{2,}/u;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

const allowed = (s) => texts.has(s) || patterns.some((re) => re.test(s));
const findings = [];

for (const root of roots) {
  for (const file of walk(root, [])) {
    const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
    if (fileRes.some((re) => re.test(rel))) continue;
    const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const report = (node, kind, text) => {
      const s = text.replace(/\s+/g, ' ').trim();
      if (!WORD.test(s) || allowed(s)) return;
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
      findings.push({ file: rel, line: line + 1, kind, text: s });
    };
    // String literals reachable as the value of an expression (through ?:, ||, ??, &&, parentheses).
    const literalLeaves = (e, cb) => {
      if (!e) return;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) cb(e, e.text);
      else if (ts.isTemplateExpression(e)) cb(e, [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' '));
      else if (ts.isParenthesizedExpression(e)) literalLeaves(e.expression, cb);
      else if (ts.isConditionalExpression(e)) {
        literalLeaves(e.whenTrue, cb);
        literalLeaves(e.whenFalse, cb);
      } else if (ts.isBinaryExpression(e)) {
        const k = e.operatorToken.kind;
        if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken) {
          literalLeaves(e.left, cb);
          literalLeaves(e.right, cb);
        } else if (k === ts.SyntaxKind.AmpersandAmpersandToken) literalLeaves(e.right, cb);
      }
    };
    const visit = (node) => {
      if (ts.isJsxText(node)) report(node, 'text', node.text);
      else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        literalLeaves(node.expression, (n, s) => report(n, 'child', s));
      } else if (ts.isJsxAttribute(node)) {
        const name = node.name.getText(src);
        if (PROPS.has(name) && node.initializer) {
          if (ts.isStringLiteral(node.initializer)) report(node, name, node.initializer.text);
          else if (ts.isJsxExpression(node.initializer)) literalLeaves(node.initializer.expression, (n, s) => report(n, name, s));
        }
        // Navigator screen options: <Tabs.Screen options={{ title: 'Appointments' }} />
        if (name === 'options' && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression && ts.isObjectLiteralExpression(node.initializer.expression)) {
          for (const p of node.initializer.expression.properties) {
            const key = p.name && ts.isIdentifier(p.name) ? p.name.text : '';
            if (ts.isPropertyAssignment(p) && OPTION_PROPS.has(key)) literalLeaves(p.initializer, (n, s) => report(n, `options.${key}`, s));
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(src);
  }
}

if (asJson) {
  console.log(JSON.stringify(findings, null, 1));
} else if (findings.length) {
  for (const f of findings) console.error(`${f.file}:${f.line}  [${f.kind}]  ${f.text}`);
  console.error(
    `\n✗ ${findings.length} hard-coded UI string(s). Move them to the message catalogue (t('…')) or, for brand names, symbols or sample data, add them to ${allowFile ?? 'an allowlist'}.`,
  );
  process.exit(1);
} else {
  console.log('✓ No hard-coded UI strings found.');
}
