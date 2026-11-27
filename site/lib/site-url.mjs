/**
 * The one build setting: the address the site is served from, such as `https://bv4ts.github.io/luady/` or
 * `https://example.com/luady/`. It comes from `--base-url <url>` or, when that flag is absent, the `SITE_URL`
 * environment variable (the Pages workflow sets it; demo.mjs takes the same value).
 *
 * From it come the base path every link and file starts with (`/luady` for the addresses above; Next.js's basePath)
 * and the tags that need an absolute URL: the canonical link, Open Graph and Twitter card tags, sitemap.xml and
 * robots.txt. Without it the site is built for the root of a host (`/`) and writes no absolute URL at all.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Checks and normalises a site URL: https (http only for this machine), no user, query or #fragment, ends in `/`. */
export function parseSiteUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const raw = String(value).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`site: SITE_URL is not a URL (got "${raw}")`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`site: SITE_URL must start with https:// (got "${raw}")`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`site: SITE_URL must be a plain address, with no user, query or #fragment (got "${raw}")`);
  }
  const last = url.pathname.split('/').at(-1);
  if (last.includes('.')) throw new Error(`site: SITE_URL must be the folder the site is served from, not a file (got "${raw}")`);
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url.href;
}

/** The setting from the command line (`--base-url <url>`) or the environment (`SITE_URL`); null when neither is set. */
export function siteUrlFrom(argv, env) {
  const at = argv.indexOf('--base-url');
  if (at !== -1 && (argv[at + 1] === undefined || argv[at + 1].startsWith('--'))) {
    throw new Error('site: --base-url needs a URL, such as https://bv4ts.github.io/luady/');
  }
  return parseSiteUrl(at === -1 ? env.SITE_URL : argv[at + 1]);
}

/** The absolute URL of a file of the site: `absoluteUrl('https://example.com/luady/', 'rooms.html')`. */
export function absoluteUrl(siteUrl, path) {
  return new URL(path, siteUrl).href;
}

/** The path part of the site URL (`/luady/`); `/` without a setting, since the site is then built for the root. */
export function sitePathOf(siteUrl) {
  return siteUrl === null ? '/' : new URL(siteUrl).pathname;
}

/** Next.js's basePath: the site path without its last `/` (`/luady`), and '' for the root of a host. */
export function basePathOf(siteUrl) {
  return sitePathOf(siteUrl).replace(/\/$/, '');
}
