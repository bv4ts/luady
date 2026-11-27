#!/usr/bin/env node
/**
 * Third-party licence gate, run by `npm run licence:check` and by CI.
 *
 * Reads every package-lock.json in the tree (the root one, tests/integration, and any other outside node_modules), and
 * judges the licence each lockfile entry declares:
 *
 * - FAIL: GPL, LGPL, AGPL, SSPL or UNLICENSED, in any spelling or SPDX expression that cannot be satisfied without one
 *   (`A OR B` passes when one side passes; `A AND B` fails when either side fails).
 * - FAIL: a licence that is not a licence expression at all (free text, "SEE LICENSE IN ...").
 * - FAIL: no licence, unless the package is on EXCEPTIONS below, matched on name and exact version.
 *
 * When everything passes it writes THIRD_PARTY_LICENSES.md (package, version, licence, grouped by licence). The file has no
 * date, so the same lockfiles always give the same bytes and CI can check that the committed file is current.
 * Uses only Node's own modules. `--root <dir>` runs it on another folder (the tests do).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUTPUT_FILE = 'THIRD_PARTY_LICENSES.md';
const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * Packages whose lockfile entry has no licence. One line of review each, written by a person who opened the package's own
 * files (node_modules/<name>/package.json and LICENSE after `npm ci`). Matched on name AND version: a new version of the
 * package is not covered, so a dependency bump that changes it has to be looked at again. An exception only fills a gap;
 * the licence it names is judged like any other, and a licence the package declares itself is never overridden.
 */
export const EXCEPTIONS = Object.freeze([
  {
    name: 'ssh2',
    version: '1.17.0',
    licence: 'MIT',
    reason: 'Its package.json has no "license" field, only the old "licenses" array.',
    verified: 'package.json "licenses" is [{ "type": "MIT" }] and its LICENSE file is the MIT licence text.',
  },
  {
    name: 'cpu-features',
    version: '0.0.10',
    licence: 'MIT',
    reason: 'Optional dependency of ssh2. Its package.json has no "license" field, only the old "licenses" array.',
    verified: 'package.json "licenses" is [{ "type": "MIT" }] and its LICENSE file is the MIT licence text.',
  },
  {
    name: 'buildcheck',
    version: '0.0.7',
    licence: 'MIT',
    reason: 'Dependency of cpu-features. Its package.json has no "license" field, only the old "licenses" array.',
    verified: 'package.json "licenses" is [{ "type": "MIT" }] and its LICENSE file is the MIT licence text.',
  },
]);

const DENIED_ID = [/^(?:A|L)?GPL/i, /^SSPL/i, /^UNLICENSED$/i];
const WEAK_COPYLEFT_ID = /^(?:MPL|EPL|CDDL|CPL|EUPL)/i;
const SPDX_ID = /^[A-Za-z0-9.+:-]+$/;

const isDeniedId = (id) => DENIED_ID.some((re) => re.test(id));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** SPDX expression to a tree: `{ id }`, `{ and: [...] }` or `{ or: [...] }`. Throws on anything else. */
function parseExpression(text) {
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const isWord = (word) => peek()?.toUpperCase() === word;
  const fail = (why) => {
    throw new Error(why);
  };

  function term() {
    const token = tokens[at];
    if (token === undefined) fail('unexpected end');
    if (token === '(') {
      at += 1;
      const inner = orExpression();
      if (tokens[at] !== ')') fail('missing )');
      at += 1;
      return inner;
    }
    if (token === ')' || !SPDX_ID.test(token) || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) fail(`unexpected "${token}"`);
    at += 1;
    if (isWord('WITH')) {
      at += 1;
      if (peek() === undefined || !SPDX_ID.test(peek())) fail('WITH needs an exception id');
      at += 1;
    }
    return { id: token };
  }
  function andExpression() {
    const items = [term()];
    while (isWord('AND')) {
      at += 1;
      items.push(term());
    }
    return items.length === 1 ? items[0] : { and: items };
  }
  function orExpression() {
    const items = [andExpression()];
    while (isWord('OR')) {
      at += 1;
      items.push(andExpression());
    }
    return items.length === 1 ? items[0] : { or: items };
  }

  const tree = orExpression();
  if (at !== tokens.length) fail(`unexpected "${tokens[at]}"`);
  return tree;
}

/** The identifiers matching `test` that cannot be avoided in `node` (none when an OR has a side without one). */
function unavoidable(node, test) {
  if ('id' in node) return test(node.id) ? [node.id] : [];
  const sides = (node.and ?? node.or).map((side) => unavoidable(side, test));
  return node.or ? (sides.every((side) => side.length > 0) ? sides.flat() : []) : sides.flat();
}

/** `{ verdict: 'ok' | 'denied' | 'unparseable' | 'missing', denied, weak, ids }` for one licence text (the lists hold identifiers). */
export function judgeLicence(text) {
  if (typeof text !== 'string' || text.trim() === '') return { verdict: 'missing', denied: [], weak: [], ids: [] };
  let tree;
  try {
    tree = parseExpression(text.trim());
  } catch (err) {
    return { verdict: 'unparseable', denied: [], weak: [], ids: [], error: err.message };
  }
  const ids = [];
  const gather = (node) => ('id' in node ? ids.push(node.id) : (node.and ?? node.or).forEach(gather));
  gather(tree);
  const denied = unavoidable(tree, isDeniedId);
  return { verdict: denied.length > 0 ? 'denied' : 'ok', denied, weak: unavoidable(tree, (id) => WEAK_COPYLEFT_ID.test(id)), ids };
}

/** The licence text of one lockfile entry, in the string form or the older object and array forms. */
export function licenceOfEntry(entry) {
  const pieces = [entry.license ?? entry.licenses].flat().map((item) => (typeof item === 'object' && item !== null ? item.type : item));
  const named = pieces.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
  if (named.length === 0) return undefined;
  return named.length === 1 ? named[0] : `(${named.join(' OR ')})`;
}

/** Every lockfile of the tree, as paths relative to `root` with forward slashes. */
export function findLockfiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) walk(join(dir, item.name));
      } else if (LOCKFILE_NAMES.has(item.name)) {
        found.push(relative(root, join(dir, item.name)).split('\\').join('/'));
      }
    }
  };
  walk(root);
  return found.sort(compare);
}

/** The packages of one lockfile: not the root, not workspace folders (own code), not links. Insertion order. */
function readLockfile(root, path) {
  let lock;
  try {
    lock = JSON.parse(readFileSync(join(root, path), 'utf8'));
  } catch (err) {
    throw new Error(`${path}: cannot read it (${err.message})`);
  }
  if (lock === null || typeof lock.packages !== 'object' || lock.packages === null) {
    throw new Error(`${path}: no "packages" map (needs lockfileVersion 2 or 3, which npm 7 and later write)`);
  }
  const marker = 'node_modules/';
  const packages = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    const cut = key.lastIndexOf(marker);
    if (key === '' || entry.link === true || cut === -1) continue;
    packages.push({
      name: entry.name ?? key.slice(cut + marker.length),
      version: entry.version ?? 'unknown',
      licence: licenceOfEntry(entry),
      dev: entry.dev === true,
      lockfile: path,
    });
  }
  return packages;
}

export function collectPackages(root) {
  const lockfiles = findLockfiles(root);
  return { lockfiles, packages: lockfiles.flatMap((path) => readLockfile(root, path)) };
}

function label(pkg, problem) {
  return `${pkg.name}@${pkg.version} (${pkg.lockfile}): ${problem}`;
}

/** Judges every package. `rows` is one row per name@version, `failures` one message per problem. */
export function evaluate(packages, exceptions = EXCEPTIONS) {
  const failures = [];
  const used = new Set();
  const merged = new Map();

  for (const pkg of packages) {
    let licence = pkg.licence;
    let fromException = false;
    if (licence === undefined) {
      const found = exceptions.find((entry) => entry.name === pkg.name && entry.version === pkg.version);
      if (found === undefined) {
        failures.push(label(pkg, 'no licence field, and not on the reviewed exceptions list in scripts/licence-check.mjs'));
      } else {
        licence = found.licence;
        fromException = true;
        used.add(found);
      }
    }
    if (licence !== undefined) {
      const judged = judgeLicence(licence);
      const source = fromException ? 'the reviewed exception names' : 'declares';
      if (judged.verdict === 'denied') failures.push(label(pkg, `${source} licence "${licence}" (${judged.denied.join(', ')}), which is not allowed`));
      if (judged.verdict === 'unparseable') failures.push(label(pkg, `${source} "${licence}", which is not a licence expression; review it by hand (${judged.error})`));
    }
    const key = `${pkg.name}@${pkg.version}`;
    const before = merged.get(key);
    merged.set(key, {
      name: pkg.name,
      version: pkg.version,
      licence: before?.licence ?? licence ?? 'UNKNOWN',
      dev: (before?.dev ?? true) && pkg.dev,
      fromException: (before?.fromException ?? false) || fromException,
    });
  }

  const rows = [...merged.values()].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  return {
    rows,
    failures: [...new Set(failures)],
    usedExceptions: exceptions.filter((entry) => used.has(entry)),
    unusedExceptions: exceptions.filter((entry) => !used.has(entry)),
  };
}

/** Rows grouped by licence, the group with the most packages first. */
function groupByLicence(rows) {
  const groups = new Map();
  for (const row of rows) groups.set(row.licence, [...(groups.get(row.licence) ?? []), row]);
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || compare(a[0], b[0]));
}

/** The text of THIRD_PARTY_LICENSES.md. Same rows and options give the same bytes. */
export function renderReport(rows, { lockfiles, usedExceptions }) {
  const sorted = [...rows].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  const groups = groupByLicence(sorted);
  const kind = (row) => (row.dev ? 'dev' : 'runtime');
  const lines = [
    '# Third-party licences',
    '',
    'Every third-party package that the lockfiles of this repository pull in, with the licence it declares. This file is',
    'generated by `npm run licence:check`; do not edit it by hand. CI fails when it is out of date or when a package',
    'carries a GPL, LGPL, AGPL or SSPL licence, or no licence.',
    '',
    `Lockfiles read: ${lockfiles.map((path) => `\`${path}\``).join(', ')}.`,
    '',
    '- **runtime**: part of the product (the hub, the website, the MCP server, the add-on SDK).',
    '- **dev**: only needed to build, test or type-check Luady; it is not part of what you run.',
    '',
    'This list names licences. The licence text and the copyright notice of each package stay in its own folder under',
    '`node_modules/` after `npm ci`, and travel inside the packages themselves. Notices for fonts and other bundled',
    'material are in [NOTICE](NOTICE) and [licenses/](licenses/).',
    '',
    '## Summary',
    '',
    '| Licence | Packages | Runtime |',
    '| --- | --- | --- |',
    ...groups.map(([licence, group]) => `| ${licence} | ${group.length} | ${group.filter((row) => !row.dev).length} |`),
    '',
  ];
  for (const [licence, group] of groups) {
    lines.push(`## ${licence} (${group.length})`, '', '| Package | Version | Kind |', '| --- | --- | --- |');
    for (const row of group) lines.push(`| ${row.name} | ${row.version} | ${kind(row)} |`);
    lines.push('');
  }
  if (usedExceptions.length > 0) {
    lines.push(
      '## Reviewed exceptions',
      '',
      'These packages declare no licence in the lockfile. Each was checked by hand against the package\'s own files, and the',
      'exception holds for that exact version only.',
      '',
      ...usedExceptions.map((entry) => `- \`${entry.name}@${entry.version}\`: ${entry.licence}. ${entry.reason} ${entry.verified}`),
      '',
    );
  }
  return `${lines.join('\n')}`;
}

/** Runs the gate on `root`. Returns `{ ok, failures, rows }`; writes the report only when everything passes. */
export function run(root, { write = true, exceptions = EXCEPTIONS, log = console.log, error = console.error } = {}) {
  let collected;
  try {
    collected = collectPackages(root);
  } catch (err) {
    error(`licence-check: ${err.message}`);
    return { ok: false, failures: [err.message], rows: [] };
  }
  if (collected.lockfiles.length === 0) {
    error('licence-check: no package-lock.json found');
    return { ok: false, failures: ['no package-lock.json found'], rows: [] };
  }

  const result = evaluate(collected.packages, exceptions);
  log(`licence-check: ${collected.lockfiles.length} lockfile(s) (${collected.lockfiles.join(', ')}), ${result.rows.length} packages`);
  for (const [licence, group] of groupByLicence(result.rows)) log(`  ${licence}: ${group.length}`);
  for (const [licence, group] of groupByLicence(result.rows)) {
    if (judgeLicence(licence).weak.length > 0) {
      log(`  note: ${licence} has file-level or weak copyleft terms: ${group.length} package(s), ${group.filter((row) => !row.dev).length} runtime`);
    }
  }
  for (const entry of result.usedExceptions) log(`  exception used: ${entry.name}@${entry.version} counted as ${entry.licence}`);
  for (const entry of result.unusedExceptions) log(`  warning: exception ${entry.name}@${entry.version} matched nothing; remove it from scripts/licence-check.mjs`);

  if (result.failures.length > 0) {
    for (const failure of result.failures) error(`FAIL ${failure}`);
    error(`licence-check: ${result.failures.length} problem(s); ${OUTPUT_FILE} was not written`);
    return { ok: false, failures: result.failures, rows: result.rows };
  }
  if (write) writeFileSync(join(root, OUTPUT_FILE), renderReport(result.rows, { lockfiles: collected.lockfiles, usedExceptions: result.usedExceptions }));
  log(`licence-check: ok${write ? `, wrote ${OUTPUT_FILE}` : ''}`);
  return { ok: true, failures: [], rows: result.rows };
}

function main() {
  const flag = process.argv.indexOf('--root');
  const root = flag === -1 ? join(fileURLToPath(new URL('.', import.meta.url)), '..') : process.argv[flag + 1];
  if (root === undefined) {
    console.error('licence-check: --root needs a folder');
    process.exit(2);
  }
  if (!run(root).ok) process.exit(1);
}

if (process.argv[1] !== undefined && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') main();
