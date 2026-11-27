#!/usr/bin/env node
/**
 * Puts the live web demo into the built site: the office page of the website's demo build (the real office page
 * against a pretend hub that lives in the browser) becomes site/dist/demo/index.html, with its assets. build.mjs does
 * this by itself when the demo's build is there; this script does it on its own for an existing site/dist.
 *
 * Build the demo first, with relative paths so it works under any folder:
 *   (cd packages/web && npx vite build --config vite.demo.config.ts --base ./)
 *   node site/demo.mjs --base-url https://bv4ts.github.io/luady/
 *
 * The page gets a Content-Security-Policy that allows only its own files. With `--base-url <site URL>` (the Pages
 * workflow passes it) every source is narrowed to the demo's own folder, so the page cannot load or send anything
 * anywhere else, not even to another path of the same host. Without it the sources are 'self', the policy the demo
 * config tests the bundle under. A small link at the corner of the page leads back to the website.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = dirname(fileURLToPath(import.meta.url));
/** Where the demo's build is: packages/web/demo/dist, or LUADY_DEMO_BUILD (the tests point it at a stand-in). */
export function demoBuildDir() {
  return process.env.LUADY_DEMO_BUILD || join(SITE, '..', 'packages', 'web', 'demo', 'dist');
}

/** The demo's policy: every kind of request may go only to `source` (the demo folder's URL, or 'self'). */
export function demoCsp(source = "'self'") {
  return [
    "default-src 'none'", `script-src ${source}`, `style-src ${source}`, `img-src ${source} data:`, `font-src ${source}`,
    `connect-src ${source}`, "base-uri 'none'", "form-action 'none'",
  ].join('; ');
}

/** The folder URL the demo is served from, from the site's URL: https://host/luady/ gives https://host/luady/demo/. */
export function demoSource(baseUrl) {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !local) throw new Error(`demo: --base-url must be https (got ${baseUrl})`);
  return new URL('demo/', url).href;
}

/** The way back from the demo to the website: a small fixed link, styled by its own file (no inline style). */
export const BACK_LINK = '<a class="luady-site-back" href="../">Back to the Luady website</a>';
export const BACK_CSS = `/* The link from the live demo back to the Luady website. */
.luady-site-back {
  position: fixed;
  left: 50%;
  bottom: calc(76px + env(safe-area-inset-bottom, 0px));
  z-index: 2147483000;
  transform: translateX(-50%);
  padding: 8px 14px;
  border: 2px solid #3cc3b0;
  border-radius: 2px;
  background: #1b1731;
  box-shadow: 0 4px 0 #070b18;
  color: #fff4dc;
  font: 600 14px/1.2 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  text-decoration: none;
}
.luady-site-back:hover { background: #3cc3b0; color: #0b1022; }
.luady-site-back:focus-visible { outline: 3px solid #ffd84d; outline-offset: 3px; }
@media print { .luady-site-back { display: none; } }
`;

/** The page: the policy first in <head>, a plain title, the way back, and asset paths that must stay relative. */
export function demoPage(html, source = "'self'") {
  if (!html.includes('<meta charset="utf-8" />')) throw new Error('demo: office.html has no charset line to anchor the policy');
  if (/(src|href)="\/(?!\/)/.test(html)) throw new Error('demo: office.html has root-relative paths; build it with --base ./');
  if (!/<body>/.test(html)) throw new Error('demo: office.html has no <body> to put the way back in');
  const policy = `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${demoCsp(source)}" />`;
  return html
    .replace('<meta charset="utf-8" />', policy)
    .replace(/<title>[^<]*<\/title>/, '<title>Luady live demo (pretend data)</title>\n    <link rel="stylesheet" href="./site-back.css" />')
    .replace('<body>', `<body>\n    ${BACK_LINK}`);
}

/** Copies the demo build into `dist`/demo/ for a site served at `baseUrl` (or null). */
export async function installDemo({ dist, baseUrl = null }) {
  const from = demoBuildDir();
  const page = join(from, 'office.html');
  if (!existsSync(page)) throw new Error(`demo: ${page} is missing; build the demo first (see the top of site/demo.mjs)`);
  if (!existsSync(join(dist, 'index.html'))) throw new Error('demo: build the site first (npm run build --prefix site)');
  const out = join(dist, 'demo');
  const source = baseUrl === null || baseUrl === undefined ? "'self'" : demoSource(baseUrl);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(from, 'assets'), join(out, 'assets'), { recursive: true });
  await writeFile(join(out, 'index.html'), demoPage(await readFile(page, 'utf8'), source));
  await writeFile(join(out, 'site-back.css'), BACK_CSS);
  return { page: join(out, 'index.html'), source };
}

function baseUrlArg(argv) {
  const at = argv.indexOf('--base-url');
  return at === -1 ? null : argv[at + 1] ?? null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  installDemo({ dist: join(SITE, 'dist'), baseUrl: baseUrlArg(process.argv) || process.env.SITE_URL || null })
    .then(({ page, source }) => console.log(`demo: office page written to ${page} (requests allowed only to ${source})`))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
