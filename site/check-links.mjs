#!/usr/bin/env node
/**
 * Checks every internal link, offline:
 * 1. the built site (site/dist): each href, src and srcset in a page, and each url() in a stylesheet, points at a file
 *    that exists (a folder address at its index.html), each #anchor at an id on the target page, and no link spells
 *    out index.html (the address bar never needs it);
 * 2. the Markdown on GitHub (README.md and docs/*.md): each relative link and picture points at a file or folder in the
 *    repository, and each #anchor at a heading GitHub will make.
 * Links to other sites are counted, never fetched.
 *
 * The pages link from the site's base path (/luady/... under a folder, /... at the root of a host). Give the checker
 * the same SITE_URL (or --base-url) the site was built with. A root-relative link outside that folder is an error, and
 * so is a relative link on the 404 page, which a host serves at any depth.
 *
 * With --strict (the Pages workflow runs it that way) the live demo must be there.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sitePathOf, siteUrlFrom } from './lib/site-url.mjs';
import { headingIdsOf } from './lib/slug.mjs';

const SITE = dirname(fileURLToPath(import.meta.url));
const REPO = join(SITE, '..');
const DIST = join(SITE, 'dist');

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : decodeURIComponent(url.slice(hashAt + 1));
  const path = (hashAt === -1 ? url : url.slice(0, hashAt)).split('?')[0];
  return { path: decodeURIComponent(path), hash };
}

function idsOfHtml(file, cache) {
  if (!cache.has(file)) {
    const html = readFileSync(file, 'utf8');
    cache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])));
  }
  return cache.get(file);
}

/** The page without its scripts (their data is not markup), each ending where the browser ends it (`</script >` too). */
const withoutScripts = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:[\t\n\f\r /][^>]*)?>/gi, '');

/** href, src and every srcset candidate in a page, with the tag each came from (a script's src included). */
export function urlsInHtml(html) {
  const urls = [];
  for (const match of html.matchAll(/<script\b[^>]*\ssrc="([^"]*)"/gi)) urls.push({ url: match[1].replace(/&amp;/g, '&'), tag: 'script' });
  const markup = withoutScripts(html);
  for (const match of markup.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const tag = match[0];
    const name = match[1].toLowerCase();
    for (const attr of tag.matchAll(/\s(href|src)="([^"]*)"/g)) urls.push({ url: attr[2].replace(/&amp;/g, '&'), tag: name });
    for (const attr of tag.matchAll(/\ssrcset="([^"]*)"/gi)) {
      for (const part of attr[1].split(',')) urls.push({ url: part.trim().split(/\s+/)[0], tag: name });
    }
  }
  return urls;
}

/** url(...) references in a stylesheet (fonts, pictures), without their quotes. */
export function urlsInCss(css) {
  return [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((match) => match[2]);
}

/**
 * Checks the built site in `dist`. `sitePath` is the site's folder on its host ('/luady/', or '/' for a site built
 * without SITE_URL). Returns the number of pages, the errors, the warnings, and how many links go to other sites.
 */
export function checkSite(dist, sitePath = '/', { strict = false } = {}) {
  const result = { pages: 0, errors: [], warnings: [], external: 0 };
  if (!existsSync(join(dist, 'index.html'))) {
    result.errors.push('site/dist is not built: run "npm run build --prefix site" first');
    return result;
  }
  const ids = new Map();
  const files = walk(dist).filter((file) => !relative(dist, file).split(sep).join('/').startsWith('demo/'));
  const pages = files.filter((file) => file.endsWith('.html'));
  const sheets = files.filter((file) => file.endsWith('.css'));
  const check = (from, url, tag = '') => {
    if (url === '' || url.startsWith('data:') || url.startsWith('blob:')) return;
    if (SCHEME.test(url) || url.startsWith('//')) {
      result.external += 1;
      return;
    }
    const where = relative(dist, from).split(sep).join('/');
    const { path, hash } = splitUrl(url);
    if (tag === 'a' && /(^|\/)index\.html$/.test(path)) {
      result.errors.push(`${where}: "${url}" spells out index.html; link to the folder address instead`);
    }
    let target;
    if (path === '') target = from;
    else if (path.startsWith('/')) {
      if (!path.startsWith(sitePath)) {
        result.errors.push(`${where}: "${url}" is outside the site's folder ${sitePath} (build and check with the same SITE_URL)`);
        return;
      }
      target = join(dist, path.slice(sitePath.length));
    } else {
      if (where === '404.html') {
        result.errors.push(`404.html: "${url}" is relative, and the 404 page is served at any depth`);
        return;
      }
      target = join(dirname(from), path);
    }
    if (path.endsWith('/') || (existsSync(target) && statSync(target).isDirectory())) target = join(target, 'index.html');
    if (!existsSync(target)) {
      const demo = relative(dist, target).split(sep).join('/') === 'demo/index.html';
      if (demo && !strict) result.warnings.push('the live demo is not in site/dist yet (build it, then run demo.mjs)');
      else result.errors.push(`${where}: "${url}" points at a missing file`);
      return;
    }
    if (hash !== '' && target.endsWith('.html') && !idsOfHtml(target, ids).has(hash)) {
      result.errors.push(`${where}: "${url}" points at a missing anchor #${hash}`);
    }
  };
  for (const page of pages) for (const { url, tag } of urlsInHtml(readFileSync(page, 'utf8'))) check(page, url, tag);
  for (const sheet of sheets) for (const url of urlsInCss(readFileSync(sheet, 'utf8'))) check(sheet, url);
  if (strict && !existsSync(join(dist, 'demo', 'index.html'))) result.errors.push('the live demo is missing from site/dist/demo/');
  result.pages = pages.length;
  return result;
}

/** Links in Markdown outside code: [text](url), ![alt](url) and raw href/src/srcset attributes. */
function urlsInMarkdown(markdown) {
  const text = markdown.replace(/^\s{0,3}(```|~~~)[\s\S]*?^\s{0,3}\1\s*$/gm, '').replace(/`[^`\n]*`/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const urls = [];
  for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) urls.push(match[1]);
  return [...urls, ...urlsInHtml(text).map(({ url }) => url)];
}

function checkMarkdown(file, result) {
  const where = relative(REPO, file).split(sep).join('/');
  const markdown = readFileSync(file, 'utf8');
  for (const url of urlsInMarkdown(markdown)) {
    if (SCHEME.test(url) || url.startsWith('//')) {
      result.external += 1;
      continue;
    }
    const { path, hash } = splitUrl(url);
    const target = path === '' ? file : join(dirname(file), path);
    const repoPath = relative(REPO, target).split(sep).join('/');
    if (repoPath.startsWith('..')) {
      result.errors.push(`${where}: "${url}" leaves the repository`);
      continue;
    }
    if (!existsSync(target)) {
      result.errors.push(`${where}: "${url}" points at a missing file (${repoPath})`);
      continue;
    }
    if (hash !== '' && target.endsWith('.md') && !headingIdsOf(readFileSync(target, 'utf8')).has(hash)) {
      result.errors.push(`${where}: "${url}" points at a missing heading #${hash}`);
    }
  }
}

function main() {
  const strict = process.argv.includes('--strict');
  const sitePath = sitePathOf(siteUrlFrom(process.argv, process.env));
  const result = checkSite(DIST, sitePath, { strict });
  const docs = readdirSync(join(REPO, 'docs')).filter((name) => name.endsWith('.md')).map((name) => join(REPO, 'docs', name));
  const markdown = [join(REPO, 'README.md'), ...docs];
  for (const file of markdown) checkMarkdown(file, result);
  const warnings = new Set(result.warnings);
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of result.errors) console.error(`error: ${error}`);
  console.log(`links: ${result.pages} site pages and ${markdown.length} Markdown files checked; ${result.external} links to other sites not fetched; `
    + `${result.errors.length} errors, ${warnings.size} warnings`);
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
