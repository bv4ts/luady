#!/usr/bin/env node
/**
 * Builds the Luady website into site/dist/: a Next.js static export (the landing page, the docs from docs/*.md, the
 * 404 page), finished here so it keeps every promise of a plain static site:
 *
 *   npm ci --prefix site && npm run build --prefix site
 *
 * One setting, the address the site is served from, gives the base path every link starts with and turns on the tags
 * that need an absolute URL (canonical, Open Graph, Twitter card), sitemap.xml and robots.txt:
 *
 *   SITE_URL=https://bv4ts.github.io/luady/ npm run build --prefix site
 *   node site/build.mjs --base-url https://example.com/luady/
 *
 * Without it the site is built for the root of a host and has no absolute tags. After Next.js has written the pages:
 * - every page gets its Content-Security-Policy (only the site's own files, its own inline scripts by hash);
 * - the old addresses (docs.html, rooms.html, ...) get small pages that forward to the new ones;
 * - the font's licence text is copied next to where the font is named;
 * - the live demo is copied into demo/ when its build is there (packages/web/demo/dist), and the pages link to it
 *   only then, so no link leads nowhere.
 * Next.js's telemetry is off for every run.
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPolicy } from './lib/csp.mjs';
import { docsFiles, loadDocs } from './lib/docs.mjs';
import { forwarderPage } from './lib/forwarders.mjs';
import { oldPageOf, pathOfDoc } from './lib/links.mjs';
import { robotsTxt, sitemapXml } from './lib/meta.mjs';
import { basePathOf, siteUrlFrom } from './lib/site-url.mjs';
import { demoBuildDir, installDemo } from './demo.mjs';
import { runNext } from './scripts/run-next.mjs';

const SITE = dirname(fileURLToPath(import.meta.url));
const REPO = join(SITE, '..');
export const DIST = join(SITE, 'dist');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])));
  return nested.flat();
}

/** docs/assets/ into public/assets/, so the pictures have one home and are served at assets/. */
async function copyPictures() {
  const target = join(SITE, 'public', 'assets');
  await rm(target, { recursive: true, force: true });
  await cp(join(REPO, 'docs', 'assets'), target, { recursive: true });
}

/** The site paths of every page, home first: '', 'docs/', 'docs/<name>/'. */
export function sitePaths(repoDir = REPO) {
  return ['', ...docsFiles(repoDir).map(pathOfDoc).sort((a, b) => (a === 'docs/' ? -1 : b === 'docs/' ? 1 : a.localeCompare(b)))];
}

async function finishExport(out, { siteUrl, basePath }) {
  if (!existsSync(join(out, 'index.html'))) throw new Error(`site: Next.js wrote no index.html to ${out}`);
  if (!existsSync(join(out, '404.html'))) throw new Error('site: Next.js wrote no 404.html');
  // The 404 page is 404.html; a copy at a folder address would be a page of its own.
  for (const extra of ['404', '_not-found']) await rm(join(out, extra), { recursive: true, force: true });

  await mkdir(join(out, 'fonts', 'pixelify-sans'), { recursive: true });
  await cp(join(SITE, 'fonts', 'pixelify-sans', 'OFL.txt'), join(out, 'fonts', 'pixelify-sans', 'OFL.txt'));

  for (const file of await walk(out)) {
    if (!file.endsWith('.html')) continue;
    await writeFile(file, withPolicy(await readFile(file, 'utf8'), relative(out, file).split(sep).join('/')));
  }

  const docs = loadDocs(REPO, basePath);
  for (const file of docs.files) {
    const page = docs.pages.get(file);
    const html = forwarderPage({ basePath, siteUrl, newPath: page.path, title: file === 'README.md' ? 'The Luady docs' : page.title });
    await writeFile(join(out, oldPageOf(file)), html);
  }

  if (siteUrl !== null) {
    await writeFile(join(out, 'sitemap.xml'), sitemapXml(siteUrl, sitePaths()));
    await writeFile(join(out, 'robots.txt'), robotsTxt(siteUrl));
  }
}

/**
 * Builds the whole site. `siteUrl` is the normalised setting (lib/site-url.mjs) or null; `distName` the folder under
 * site/ to write to (the tests use their own); `demo` true, false or 'auto' (copy it in when its build is there).
 * Returns where it wrote, and whether the demo is in.
 */
export async function build({ siteUrl = null, distName = 'dist', demo = 'auto' } = {}) {
  const out = join(SITE, distName);
  if (relative(SITE, out).startsWith('..') || relative(SITE, out).includes(sep)) throw new Error(`site: the output folder must be directly in site/ (got ${distName})`);
  const basePath = basePathOf(siteUrl);
  const withDemo = demo === 'auto' ? existsSync(join(demoBuildDir(), 'office.html')) : demo;
  await copyPictures();
  const code = await runNext(['build'], {
    SITE_URL: siteUrl ?? '',
    LUADY_DIST_DIR: distName,
    LUADY_DEMO: withDemo ? '1' : '',
  });
  if (code !== 0) throw new Error(`site: next build failed (exit code ${code})`);
  await finishExport(out, { siteUrl, basePath });
  if (withDemo) await installDemo({ dist: out, baseUrl: siteUrl });
  return { out, demo: withDemo };
}

async function main() {
  const siteUrl = siteUrlFrom(process.argv, process.env);
  const noDemo = process.argv.includes('--no-demo');
  const { out, demo } = await build({ siteUrl, demo: noDemo ? false : 'auto' });
  const where = siteUrl === null ? 'for the root of a host (no SITE_URL, so no absolute tags, sitemap or robots.txt)' : `for ${siteUrl}`;
  console.log(`site: written to ${out} ${where}; the live demo is ${demo ? 'in demo/' : 'not included (no demo build found)'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`site build failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
