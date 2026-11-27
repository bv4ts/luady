#!/usr/bin/env node
/**
 * The literal gate, run by `npm run typecheck`. Two parts:
 *
 * 1. Structural: no host-id-shaped string literal is compared with a host-like field or argument, and no fleet call
 *    takes a literal host, outside ids.ts and test fixtures.
 * 2. Value-based: the self-host id appears as a literal (quoted, or as an object key or property) only in ids.ts and in
 *    the files of check-literals.allow.json (the HQ room key and the HQ palette id). Any SQL string that holds the quoted
 *    id fails everywhere, ids.ts and the allow-list included.
 *
 * Scanned: packages/<name>/src, server-kit and preview, without their test folders.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IDS_FILE = 'packages/shared/src/ids.ts';
export const ALLOW_FILE = 'scripts/check-literals.allow.json';

const SELF_HOST = 'hq';
const EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test', 'tests', '__pycache__', '.venv']);

/** Part 1. The literal must look like a host id, so URL hosts ('api.example.com'), '::1' and '' are not hits. */
export const STRUCTURAL_RULES = Object.freeze([
  { id: 'host-compare', re: /\b(?:host|server|hostId)\s*[!=]==?\s*(['"`])[a-z0-9][a-z0-9-]*\1/ },
  { id: 'host-call', re: /\b(?:client|tailEvents|openShell)\(\s*['"`]/ },
]);

/** Part 2. A quoted literal, an object key (`hq:`, not `hq::`), or a property (`.hq`, not a spread `...hq`). */
export const SELF_HOST_RULES = Object.freeze([
  { id: 'self-host-literal', re: new RegExp(`(['"\`])${SELF_HOST}\\1`) },
  { id: 'self-host-key', re: new RegExp(`(?:^|[{,(\\s])${SELF_HOST}\\s*:(?!:)`) },
  { id: 'self-host-property', re: new RegExp(`(?<!\\.)\\.${SELF_HOST}\\b`) },
]);

const SQL_WORDS = /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|VALUES|FROM|JOIN|CREATE|ALTER)\b/;
const QUOTED_SELF_HOST = new RegExp(`'${SELF_HOST}'`);

/** Every string literal of a source text: backtick templates (multi-line) and single- or double-quoted strings. */
function stringsOf(text) {
  const found = [];
  const re = /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    found.push({ value: match[0], line: text.slice(0, match.index).split('\n').length });
  }
  return found;
}

/** Lines that are only a comment do not count: prose may name the id. */
const isCommentLine = (line) => /^\s*(?:\/\/|\/?\*|#)/.test(line);

/** Checks one file's text; `allowed` lifts part 2's literal rules (never the SQL rule). */
export function checkText(path, text, { allowed = false } = {}) {
  const hits = [];
  const isIds = path === IDS_FILE;
  text.split('\n').forEach((line, index) => {
    if (isCommentLine(line)) return;
    const at = { path, line: index + 1, text: line.trim() };
    if (!isIds) {
      for (const rule of STRUCTURAL_RULES) if (rule.re.test(line)) hits.push({ ...at, rule: rule.id });
    }
    if (!isIds && !allowed) {
      for (const rule of SELF_HOST_RULES) if (rule.re.test(line)) hits.push({ ...at, rule: rule.id });
    }
  });
  for (const literal of stringsOf(text)) {
    if (SQL_WORDS.test(literal.value) && QUOTED_SELF_HOST.test(literal.value)) {
      hits.push({ path, line: literal.line, text: literal.value.slice(0, 120), rule: 'self-host-sql' });
    }
  }
  return hits;
}

function walk(root, dir, out) {
  let names;
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of names) {
    const rel = dir === '' ? name : `${dir}/${name}`;
    const stats = statSync(join(root, rel));
    if (stats.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(root, rel, out);
    } else if (EXTENSIONS.has(extname(name)) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) && !/^test_.*\.py$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

/** The scanned files, relative to the repository root, with forward slashes. */
export function scannedFiles(root) {
  const packages = readdirSync(join(root, 'packages')).filter((name) => statSync(join(root, 'packages', name)).isDirectory());
  return [
    ...packages.flatMap((name) => walk(root, `packages/${name}/src`, [])),
    ...walk(root, 'server-kit', []),
    ...walk(root, 'preview', []),
  ].sort();
}

/** The allow-list: `{ files: [{ path, reason }] }`. Every entry needs a reason and must exist. */
export function readAllowList(root) {
  const raw = JSON.parse(readFileSync(join(root, ALLOW_FILE), 'utf8'));
  const files = Array.isArray(raw.files) ? raw.files : [];
  const problems = [];
  for (const entry of files) {
    if (typeof entry?.path !== 'string' || typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`${ALLOW_FILE}: every entry needs a path and a reason (${JSON.stringify(entry)})`);
    }
  }
  return { paths: new Set(files.map((entry) => entry.path)), problems };
}

/** Runs the whole gate over the repository at `root`. */
export function checkRepository(root) {
  const { paths, problems } = readAllowList(root);
  const files = scannedFiles(root);
  const missing = [...paths].filter((path) => !files.includes(path)).map((path) => `${ALLOW_FILE}: ${path} is not a scanned file`);
  const hits = files.flatMap((path) => checkText(path, readFileSync(join(root, path), 'utf8'), { allowed: paths.has(path) }));
  return { hits, problems: [...problems, ...missing], scanned: files.length };
}

function main() {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const { hits, problems, scanned } = checkRepository(root);
  for (const problem of problems) console.error(problem);
  for (const hit of hits) console.error(`${hit.path.split('/').join(sep)}:${hit.line}: ${hit.rule}: ${hit.text}`);
  if (hits.length > 0 || problems.length > 0) {
    console.error(`check-literals: ${hits.length} hit(s), ${problems.length} problem(s). Compare hosts through isSelfHost() or fleet membership.`);
    process.exit(1);
  }
  console.log(`check-literals: ok (${scanned} files)`);
}

if (process.argv[1] !== undefined && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') main();
