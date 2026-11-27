import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';

// No runtime imports from any build here: these checks must run before the build is known to exist.

const PRODUCTION_FILES = ['LUADY_CONFIG', 'LUADY_SECRETS'] as const;

/** What `npm run build` must have produced before the preview can start. */
const BUILD_OUTPUTS = [
  ['packages', 'shared', 'dist', 'index.js'],
  ['packages', 'hub', 'dist', 'app.js'],
  ['packages', 'web', 'dist', 'index.html'],
] as const;

/**
 * A build folder and the sources it is made from. The build's time is its newest file: `tsc -b` is incremental and
 * rewrites only the outputs that changed, so one fixed output (app.js) can stay older than a source built after it.
 */
const STALE_CHECKS = [
  { build: ['packages', 'hub', 'dist'], src: ['packages', 'hub', 'src'], what: 'hub' },
  { build: ['packages', 'web', 'dist'], src: ['packages', 'web', 'src'], what: 'website' },
] as const;

/** Throws `preview-refused: …` for anything that looks like a production machine. */
export function assertPreviewAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('preview-refused: NODE_ENV is "production". The preview only runs on a developer machine.');
  }
  for (const name of PRODUCTION_FILES) {
    if (env[name] !== undefined) {
      throw new Error(`preview-refused: ${name} is set, so this looks like a real hub. Unset it to run the preview.`);
    }
  }
}

/** The file the preview leaves in a `--keep` folder it set up: the database there is then the preview's own. */
export const PREVIEW_MARKER = '.luady-preview';

/** An XDG base folder from the environment, or its fallback under the home folder; a relative value is ignored. */
function xdgBase(env: NodeJS.ProcessEnv, name: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME', fallback: string): string {
  const value = env[name]?.trim();
  return value !== undefined && value !== '' && isAbsolute(value) ? value : fallback;
}

/** A path by its real location when it exists (a symlink does not hide where it points), else as resolved. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The real hub's config and data folders, named as packages/hub/src/config/defaults.ts names them. */
export function realHubFolders(env: NodeJS.ProcessEnv, home: string): string[] {
  const folders = [
    join(xdgBase(env, 'XDG_CONFIG_HOME', join(home, '.config')), 'luady'),
    join(xdgBase(env, 'XDG_DATA_HOME', join(home, '.local', 'share')), 'luady'),
    join(home, '.config', 'luady'),
    join(home, '.local', 'share', 'luady'),
  ];
  return [...new Set(folders.flatMap((folder) => [resolve(folder), realOrResolved(folder)]))];
}

function isInside(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Throws `preview-refused: …` for a `--keep` folder that could hold anything real: one inside the real hub's config or
 * data folder, or one that is not empty and does not carry PREVIEW_MARKER. Only a missing folder, an empty one or one
 * the preview set up before is used. The preview would otherwise open a real database (turn the manager on, set the
 * PIN, mix its demo servers and sessions into it), or write into a real brain or run folder kept elsewhere.
 */
export function assertKeepFolder(dir: string, env: NodeJS.ProcessEnv, home: string): void {
  const target = realOrResolved(dir);
  for (const folder of realHubFolders(env, home)) {
    if (isInside(target, folder)) {
      throw new Error(`preview-refused: ${dir} is inside the hub's own folder ${folder}. Keep the preview's data elsewhere.`);
    }
  }
  if (!existsSync(target)) return;
  if (!statSync(target).isDirectory()) throw new Error(`preview-refused: ${dir} is not a folder.`);
  if (readdirSync(target).length > 0 && !existsSync(join(target, PREVIEW_MARKER))) {
    throw new Error(
      `preview-refused: ${dir} is not empty and the preview did not make it (no ${PREVIEW_MARKER} file). `
      + `Choose a new or empty folder; if this one is an older preview of yours, add an empty ${PREVIEW_MARKER} file to it.`,
    );
  }
}

/** Throws `preview-not-built: …` naming the first missing build output. */
export function assertBuilt(repoRoot: string): void {
  for (const parts of BUILD_OUTPUTS) {
    const path = join(repoRoot, ...parts);
    if (!existsSync(path)) throw new Error(`preview-not-built: run "npm run build" first (${path} is missing)`);
  }
}

export function portInUseMessage(port: number): string {
  return `Port ${port} is in use. Try: npm run preview -- --port ${port + 1}`;
}

/** The addresses `localhost` means; a machine without IPv6 simply has no `::1`. */
const LOOPBACKS = ['127.0.0.1', '::1'] as const;
const NO_SUCH_ADDRESS: ReadonlySet<string> = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/** Binds and releases host:port; resolves the error code, or null when the port was free. */
function probe(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'EUNKNOWN'));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(null)));
  });
}

/**
 * Fastify listening on `localhost` binds every loopback address it can and only warns about the others, so a port
 * that another program holds on one address would leave the preview half reachable. Refuse instead.
 */
export async function assertPortFree(port: number): Promise<void> {
  for (const host of LOOPBACKS) {
    const code = await probe(host, port);
    if (code === null || (host === '::1' && NO_SUCH_ADDRESS.has(code))) continue;
    if (code === 'EADDRINUSE') throw new Error(portInUseMessage(port));
    throw new Error(`Cannot listen on ${host}:${port} (${code}). Try: npm run preview -- --port ${port + 1}`);
  }
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

const SOURCE_RE = /\.tsx?$/;
/** What a build writes (code, pages, styles); not a typecheck's .tsbuildinfo, which says nothing about the code built. */
const BUILD_OUTPUT_RE = /\.(?:m?js|html|css)$/;

/** The newest file under `dir` whose name matches `names` (sources: `.ts`/`.tsx`), or null when there is none. */
function newestFile(dir: string, names: RegExp = SOURCE_RE): { path: string; mtimeMs: number } | null {
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => names.test(name));
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const name of found) {
    const path = join(dir, name);
    const time = mtimeMs(path);
    if (time !== null && (newest === null || time > newest.mtimeMs)) newest = { path, mtimeMs: time };
  }
  return newest;
}

/** A warning when a build output is older than its newest source file, else null. */
export function staleBuildWarning(repoRoot: string): string | null {
  for (const check of STALE_CHECKS) {
    const built = newestFile(join(repoRoot, ...check.build), BUILD_OUTPUT_RE)?.mtimeMs ?? null;
    const newest = newestFile(join(repoRoot, ...check.src));
    if (built !== null && newest !== null && newest.mtimeMs > built) {
      return `Warning: the ${check.what} build is older than ${newest.path}. Run "npm run build" to preview your latest changes.`;
    }
  }
  return null;
}
