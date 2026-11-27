import { posix } from 'node:path';

/** Where the project lives in public. Links to files outside docs/ point there. */
export const REPO_URL = 'https://github.com/bv4ts/luady';
export const BRANCH = 'main';

/**
 * Every page has a clean folder address (no `index.html` in the address bar). The paths here are relative to the
 * site's root; `withBase` puts the site's base path in front.
 *   the landing page     ''              -> /luady/
 *   the docs overview    'docs/'         -> /luady/docs/          (from docs/README.md)
 *   a docs page          'docs/rooms/'   -> /luady/docs/rooms/    (from docs/rooms.md)
 *   the live demo        'demo/'         -> /luady/demo/
 */
export const HOME_PATH = '';
export const DOCS_PATH = 'docs/';
export const DEMO_PATH = 'demo/';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The route slug of a Markdown file in docs/: `rooms.md` gives `rooms`; README.md is the docs overview and has none. */
export function slugOfFile(file) {
  if (file === 'README.md') return null;
  return file.replace(/\.md$/, '');
}

/** The site path of a Markdown file in docs/: `README.md` is `docs/`, `rooms.md` is `docs/rooms/`. */
export function pathOfDoc(file) {
  const slug = slugOfFile(file);
  return slug === null ? DOCS_PATH : `${DOCS_PATH}${slug}/`;
}

/**
 * The address the old site gave a Markdown file (`docs.html`, `rooms.html`). The build keeps a small page at each one
 * that forwards to the new address, so links people saved keep working.
 */
export function oldPageOf(file) {
  return file === 'README.md' ? 'docs.html' : file.replace(/\.md$/, '.html');
}

/** `/luady` + `docs/rooms/` = `/luady/docs/rooms/`; with no base path, `/docs/rooms/`. Keeps a #hash or ?query. */
export function withBase(basePath, path) {
  const clean = String(path).replace(/^\/+/, '');
  return `${basePath}/${clean}`;
}

/** Splits `path#hash` (a query string stays with the path). */
function splitHash(href) {
  const at = href.indexOf('#');
  return at === -1 ? { path: href, hash: '' } : { path: href.slice(0, at), hash: href.slice(at) };
}

/**
 * Rewrites a link written in a docs/ Markdown file so it works on the site:
 * - another docs page (`rooms.md#remove-a-room`) becomes its folder address (`/luady/docs/rooms/#remove-a-room`);
 * - a file under docs/assets/ becomes `/luady/assets/...` (the build copies the folder);
 * - anything else in the repository (`../SECURITY.md`, `../packages/addon-sdk/`) becomes a GitHub link;
 * - absolute URLs, `mailto:` and in-page `#anchors` are left alone.
 * `docsPages` is the set of Markdown file names directly in docs/; `basePath` is '' or a path such as '/luady'.
 */
export function rewriteHref(href, docsPages, basePath = '') {
  if (href === '' || href.startsWith('#') || href.startsWith('//') || SCHEME.test(href)) return href;
  const { path, hash } = splitHash(href);
  const isFolder = path.endsWith('/');
  const repoPath = posix.normalize(posix.join('docs', path));
  if (repoPath.startsWith('../')) return href;
  if (posix.dirname(repoPath) === 'docs' && docsPages.has(posix.basename(repoPath))) {
    return withBase(basePath, pathOfDoc(posix.basename(repoPath))) + hash;
  }
  if (repoPath.startsWith('docs/assets/')) return withBase(basePath, repoPath.slice('docs/'.length)) + hash;
  const kind = isFolder || repoPath === '.' || repoPath === 'docs' ? 'tree' : 'blob';
  const clean = repoPath === '.' ? '' : repoPath.replace(/\/$/, '');
  return `${REPO_URL}/${kind}/${BRANCH}/${clean}${hash}`;
}
