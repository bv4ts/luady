#!/usr/bin/env node
/**
 * Makes the built SDK self-contained.
 *
 * The SDK's source imports the protocol's schemas from the workspace package `@luady/shared`, which is not published:
 * installed outside this repository, that name would be looked up on the public registry. So after `tsc -b` this
 * script copies the compiled modules the SDK uses (Add-on Protocol v1, `addon.js`, and the modules it imports) from
 * `packages/shared/dist` into `dist/vendor/shared`, code and types, and points every `@luady/shared` import of the
 * SDK's `dist` at that copy. It fails when anything in `dist` still names a workspace package afterwards.
 *
 * Run by `npm run build` (the SDK's build script).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(SDK, 'dist');
const SHARED_DIST = join(SDK, '..', 'shared', 'dist');
const VENDOR = join(DIST, 'vendor', 'shared');
/** The one module of the shared package the SDK uses: Add-on Protocol v1. */
const ENTRY = 'addon.js';
/** `'@luady/shared'` or `"@luady/shared"`, as tsc writes it in code and in declarations. */
const SHARED_SPECIFIER = /(['"])@luady\/shared\1/g;
const WORKSPACE_SPECIFIER = /(['"])@luady\/[^'"]*\1/;
/** The relative imports of a compiled module: `from './ids.js'`. */
const RELATIVE_IMPORT = /\bfrom\s+'(\.\/[^']+\.js)'/g;
const SOURCE_MAP_LINE = /\n\/\/# sourceMappingURL=\S+\s*$/;

function fail(message) {
  console.error(`vendor-shared: ${message}`);
  process.exit(1);
}

/** The entry and every module it imports, transitively (shared's modules import one another by `./name.js`). */
function closure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const file = join(SHARED_DIST, name);
    if (!existsSync(file)) fail(`${file} is missing: build packages/shared first`);
    seen.add(name);
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) queue.push(match[1].slice(2));
  }
  return [...seen].sort();
}

/** Copies one compiled module and its declarations, without the source-map comment (the maps point at shared's src). */
function vendor(name) {
  for (const file of [name, name.replace(/\.js$/, '.d.ts')]) {
    const from = join(SHARED_DIST, file);
    if (!existsSync(from)) fail(`${from} is missing: build packages/shared first`);
    const to = join(VENDOR, file);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    writeFileSync(to, `${readFileSync(to, 'utf8').replace(SOURCE_MAP_LINE, '')}\n`);
  }
}

/** Every built `.js` and `.d.ts` file under `dir`. */
function builtFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return builtFiles(path);
    return /\.(?:js|d\.ts)$/.test(entry.name) ? [path] : [];
  });
}

/** The import specifier, relative to `file`, of the vendored entry. */
function specifierFrom(file) {
  const path = relative(dirname(file), join(VENDOR, ENTRY)).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

if (!existsSync(join(DIST, 'index.js'))) fail(`${DIST} has no build: run tsc -b first`);
const modules = closure(ENTRY);
for (const name of modules) vendor(name);
const own = builtFiles(DIST).filter((file) => !file.startsWith(VENDOR + sep));
for (const file of own) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(SHARED_SPECIFIER, (_all, quote) => `${quote}${specifierFrom(file)}${quote}`);
  if (next !== text) writeFileSync(file, next);
}
const left = builtFiles(DIST).filter((file) => WORKSPACE_SPECIFIER.test(readFileSync(file, 'utf8')));
if (left.length > 0) fail(`still naming a workspace package: ${left.map((file) => relative(SDK, file)).join(', ')}`);
console.log(`vendor-shared: ${modules.join(', ')} copied into dist/vendor/shared`);
