import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SDK is used outside this repository (from a packed copy), where the workspace package `@luady/shared` does not
 * exist and its name would be looked up on the public registry. So the built SDK must carry what it needs itself:
 * no run-time dependency names a workspace package, and no import of the built code or its types does.
 */
const SDK = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(SDK, 'dist');
const WORKSPACE = '@luady/';

interface PackageJson {
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')) as PackageJson;
const runtimeDeps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });

/** Every built `.js` and `.d.ts` file: the code that runs and the types an editor reads. */
function builtFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return builtFiles(path);
    return /\.(?:js|d\.ts)$/.test(entry.name) ? [path] : [];
  });
}

/** The module specifiers of one file: static imports and exports, side-effect imports, `import()` and `require()`. */
function specifiers(text: string): string[] {
  const patterns = [/\bfrom\s*(['"])([^'"]+)\1/g, /\bimport\s*(['"])([^'"]+)\1/g, /\bimport\s*\(\s*(['"])([^'"]+)\1/g, /\brequire\s*\(\s*(['"])([^'"]+)\1/g];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[2] ?? ''));
}

/** The npm package a bare specifier names: `zod`, `ws`, `@scope/name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier;
}

function built(): string[] {
  if (!existsSync(join(DIST, 'index.js'))) throw new Error(`${DIST} has no build: run npm run build first`);
  return builtFiles(DIST);
}

describe('the built SDK is self-contained', () => {
  it('no run-time dependency is a workspace package', () => {
    expect(runtimeDeps.filter((name) => name.startsWith(WORKSPACE))).toEqual([]);
  });

  it('no file of the built code or its types imports a workspace package', () => {
    const files = built();
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) => specifiers(readFileSync(file, 'utf8'))
      .filter((specifier) => specifier.startsWith(WORKSPACE))
      .map((specifier) => `${file.slice(SDK.length)}: ${specifier}`));
    expect(offenders).toEqual([]);
  });

  it('every import of the built code and its types is a file inside dist, a declared dependency or a Node module', () => {
    const builtins = new Set(builtinModules);
    const unresolved = built().flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier);
        const exists = existsSync(target) || existsSync(target.replace(/\.js$/, '.d.ts'));
        return exists && target.startsWith(DIST) ? [] : [`${file.slice(SDK.length)}: ${specifier}`];
      }
      if (specifier.startsWith('node:') || builtins.has(specifier)) return [];
      return runtimeDeps.includes(packageOf(specifier)) ? [] : [`${file.slice(SDK.length)}: ${specifier}`];
    }));
    expect(unresolved).toEqual([]);
  });

  it('the built entry loads and offers the client', async () => {
    built();
    const sdk = (await import(pathToFileURL(join(DIST, 'index.js')).href)) as Record<string, unknown>;
    expect(typeof sdk.createAddonClient).toBe('function');
    expect(typeof sdk.readAddonToken).toBe('function');
  });
});
