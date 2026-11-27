import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url).href);
const src = fileURLToPath(new URL('../../src/', import.meta.url).href);
const read = (file: string): string => readFileSync(join(dist, file), 'utf8');

function listFiles(prefix = ''): string[] {
  return readdirSync(join(dist, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(relative) : [relative];
  });
}

const scripts = (): string[] => listFiles().filter((file) => file.startsWith('assets/') && file.endsWith('.js'));

/** The script index.html loads, e.g. 'assets/index-abc123.js'. */
function entryScript(): string {
  const match = /<script\b[^>]*\bsrc="\/(assets\/[^"]+\.js)"/.exec(read('index.html'));
  if (!match?.[1]) throw new Error('index.html references no script');
  return match[1];
}

/** Chunks a chunk imports statically (`import{a}from"./x.js"`, `import"./x.js"`); dynamic `import("./x.js")` is skipped. */
function staticImports(file: string): string[] {
  const code = read(file);
  const found = [...code.matchAll(/\bimport\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']\.\/([^"']+\.js)["']/g)];
  return found.map((m) => `assets/${m[1] ?? ''}`);
}

/** The entry script and everything it loads before the page can run: the eagerly loaded "main" code. */
function eagerChunks(): Set<string> {
  const seen = new Set<string>();
  const queue = [entryScript()];
  while (queue.length > 0) {
    const next = queue.pop() ?? '';
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...staticImports(next));
  }
  return seen;
}

/**
 * Code-generation sites that ship in the bundle but never run. The minifier writes `new Function(a, b)` as
 * `Function(a, b)`, so call sites are matched in both forms and identified by their parameter names (chunk names
 * change with how the page imports the stage). Each may appear at most once.
 * - PixiJS: `import 'pixi.js/unsafe-eval'` (scene/pixi-setup.ts) swaps every generator for an eval-free polyfill
 *   at runtime and overrides the unsafeEvalSupported() probe, but the originals stay in the code: the probe,
 *   the shader, uniform and UBO sync generators, and the particle updater.
 * - zod: its eval probe, never called because src/zod-csp.ts turns on jitless mode before any schema is built.
 */
const ALLOWED_FUNCTION_SITES: readonly string[] = Object.freeze([
  'param1,param2,param3,', // PixiJS unsafeEvalSupported()
  'r,s,sD,', // PixiJS generateShaderSyncCode
  'ud,uv,renderer,syncData,', // PixiJS generateUniformsSync
  'uv,data,dataInt32,offset,', // PixiJS createUboSyncFunction
  'ps,f32v,u32v,', // PixiJS generateParticleUpdateFunction
  "''", // zod allowsEval: Function('')
]);

/** Identifies every `Function(` / `new Function(` call by its leading parameter names, e.g. 'r,s,sD,'. */
function functionSites(code: string): string[] {
  const calls = [...code.matchAll(/(?:^|[^.\w$])(?:new\s+)?Function\(((?:\s*(?:`[^`]*`|"[^"]*"|'[^']*')\s*,?)*)(.{0,30})/gs)];
  return calls.map((m) => {
    const args = [...(m[1] ?? '').matchAll(/`([^`]*)`|"([^"]*)"|'([^']*)'/g)].map((a) => a[1] ?? a[2] ?? a[3] ?? '');
    const named = args.filter((a) => /^\w+$/.test(a));
    if (named.length > 0) return `${named.join(',')},`;
    if (args.length === 1 && args[0] === '' && (m[2] ?? '').startsWith(')')) return "''";
    return `unknown: Function(${m[1] ?? ''}${m[2] ?? ''}`;
  });
}

/** True once a page of the app lazy-loads the agency stage. */
const agencyRouted = (): boolean => {
  const appSource = readFileSync(join(src, 'App.tsx'), 'utf8');
  return /features\/agency\//.test(appSource);
};

describe('production build (packages/web/dist)', () => {
  it('exists', () => {
    expect(existsSync(join(dist, 'index.html'))).toBe(true);
  });

  it('index.html contains no inline script, style or event handler', () => {
    const html = read('index.html');
    const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(tags.length).toBeGreaterThan(0);
    for (const [, attrs = '', body = ''] of tags) {
      expect(attrs).toMatch(/\bsrc="\/assets\/[^"]+\.js"/);
      expect(body.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/);
  });

  it('references only same-origin files', () => {
    const html = read('index.html');
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => !ref.startsWith('/'))).toEqual([]);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('bundles every asset as a file, with no CDN, font or data: URLs in CSS', () => {
    const files = listFiles();
    expect(files).toEqual(expect.arrayContaining(['manifest.webmanifest', 'icon.svg', 'icon-maskable.svg']));
    const styles = files.filter((file) => file.endsWith('.css'));
    expect(styles.length).toBeGreaterThan(0);
    for (const file of styles) expect(read(file)).not.toMatch(/@import|url\(\s*['"]?(https?:|data:)/i);
  });

  it('splits the terminal into its own lazy chunk', () => {
    expect(scripts().length).toBeGreaterThan(1);
  });

  it('keeps PixiJS out of the main chunk', () => {
    const eager = eagerChunks();
    expect(eager.has(entryScript())).toBe(true);
    for (const file of eager) expect(read(file), file).not.toContain('preferWorkers');
    // Without an agency route nothing imports the stage, so the build has no PixiJS at all.
    if (!agencyRouted()) return;
    const lazy = scripts().filter((file) => !eager.has(file) && read(file).includes('preferWorkers'));
    expect(lazy.length).toBeGreaterThan(0);
  });

  it('has no `new Function(` left in any chunk', () => {
    for (const file of scripts()) expect(read(file), file).not.toMatch(/\bnew Function\(/);
  });

  it('has no code generation through Function() beyond the pinned, never-run sites', () => {
    const sites = scripts().flatMap((file) => functionSites(read(file)));
    expect(sites.filter((site) => !ALLOWED_FUNCTION_SITES.includes(site))).toEqual([]);
    for (const site of ALLOWED_FUNCTION_SITES) {
      expect(sites.filter((s) => s === site).length, site).toBeLessThanOrEqual(1);
    }
  });
});
