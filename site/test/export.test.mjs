/**
 * Tests on the built site: the whole export, built into folders of its own (site/dist-test-*): without the SITE_URL
 * setting (for the root of a host), for https://example.com/luady/ (under a sub-path), and once more for that address
 * with a stand-in for the live demo's build. Each build runs `next build`, so this file takes a minute or two.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, sitePaths } from '../build.mjs';
import { checkSite, urlsInCss } from '../check-links.mjs';
import { docsFiles } from '../lib/docs.mjs';
import { oldPageOf, pathOfDoc } from '../lib/links.mjs';
import { bullets, readmeOf, section } from '../lib/readme.mjs';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(SITE, '..');
const SITE_URL = 'https://example.com/luady/';
const PLAIN = 'dist-test-plain';
const SUB = 'dist-test-sub';
const DEMO = 'dist-test-demo';
/** A stand-in for the web package's demo build: the shape vite writes, with one script. */
const DEMO_PAGE = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Luady office page demo</title>\n'
  + '    <script type="module" crossorigin src="./assets/office.js"></script>\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n';
/** What a visitor's browser fetches for the landing page on first paint, and in all when scrolled to the end. */
const FULL_BUDGET = 2.8 * 1024 * 1024;
const FIRST_BUDGET = 1.1 * 1024 * 1024;

let plain;
let sub;
let withDemo;
let demoBuild;
let tsconfig;

before(async () => {
  // Next.js adds its own type folders to tsconfig.json for each output folder; the file is put back afterwards.
  tsconfig = readFileSync(join(SITE, 'tsconfig.json'), 'utf8');
  plain = (await build({ siteUrl: null, distName: PLAIN, demo: false })).out;
  sub = (await build({ siteUrl: SITE_URL, distName: SUB, demo: false })).out;
  demoBuild = await mkdtemp(join(tmpdir(), 'luady-demo-'));
  await mkdir(join(demoBuild, 'assets'));
  await writeFile(join(demoBuild, 'office.html'), DEMO_PAGE);
  await writeFile(join(demoBuild, 'assets', 'office.js'), 'document.getElementById("root").textContent = "office";\n');
  process.env.LUADY_DEMO_BUILD = demoBuild;
  try {
    withDemo = (await build({ siteUrl: SITE_URL, distName: DEMO, demo: 'auto' })).out;
  } finally {
    delete process.env.LUADY_DEMO_BUILD;
  }
}, { timeout: 900_000 });

after(async () => {
  if (tsconfig !== undefined) writeFileSync(join(SITE, 'tsconfig.json'), tsconfig);
  for (const name of [PLAIN, SUB, DEMO]) await rm(join(SITE, name), { recursive: true, force: true });
  if (demoBuild !== undefined) await rm(demoBuild, { recursive: true, force: true });
});

const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
const nameOf = (dir, file) => relative(dir, file).split(sep).join('/');
const oldPages = () => new Set(docsFiles(REPO).map(oldPageOf));
const htmlPages = (dir) => walk(dir).filter((file) => file.endsWith('.html'));
/** The pages Next.js wrote (not the small old-address pages). */
const sitePages = (dir) => htmlPages(dir).filter((file) => !oldPages().has(nameOf(dir, file)));
const markup = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const tagsOf = (html, name) => [...markup(html).matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => m[0]);
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1];
const textOf = (html) => markup(html).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const normalise = (text) => text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/`/g, '').replace(/\*\*/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').replace(/\s([,.;:!?)])/g, '$1').replace(/\(\s/g, '(').trim();
const OTHER_ORIGIN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

test('every docs page is in the export at its folder address, and every old address forwards to it', () => {
  for (const file of docsFiles(REPO)) {
    for (const [dir, base] of [[plain, ''], [sub, '/luady']]) {
      const page = join(dir, pathOfDoc(file), 'index.html');
      assert.ok(existsSync(page), `docs/${file} should build to ${pathOfDoc(file)}`);
      const old = read(dir, oldPageOf(file));
      assert.ok(old.includes(`location.replace("${base}/${pathOfDoc(file)}"+location.hash)`), `${oldPageOf(file)} forwards`);
      assert.ok(old.includes(`url=${base}/${pathOfDoc(file)}"`), `${oldPageOf(file)} forwards without JavaScript too`);
    }
  }
  assert.match(read(plain, 'docs/index.html'), /<h1 id="luady-documentation">/);
  assert.ok(existsSync(join(plain, '404.html')));
  assert.ok(existsSync(join(plain, 'index.html')));
  assert.ok(existsSync(join(plain, 'fonts', 'pixelify-sans', 'OFL.txt')), 'the font\'s licence travels with the site');
});

test('every internal link and anchor resolves, without the setting and under a sub-path', () => {
  const atRoot = checkSite(plain, '/');
  assert.deepEqual(atRoot.errors, []);
  assert.ok(atRoot.pages >= 28);
  const underFolder = checkSite(sub, '/luady/');
  assert.deepEqual(underFolder.errors, []);
  assert.deepEqual([...atRoot.warnings, ...underFolder.warnings], []);
  assert.ok(checkSite(sub, '/').errors.length > 0, 'checked for the wrong folder, the links do not resolve');
  assert.ok(checkSite(plain, '/luady/').errors.some((error) => error.includes('outside the site\'s folder')), 'the checker knows the folder');
});

test('no page asks for anything from another site: scripts, styles, fonts, pictures, media and frames are the site\'s own', () => {
  const sourced = ['img', 'source', 'video', 'audio', 'iframe', 'embed', 'track', 'input'];
  for (const [dir, base] of [[plain, ''], [sub, '/luady']]) {
    for (const file of htmlPages(dir)) {
      const html = read(dir, nameOf(dir, file));
      const where = nameOf(dir, file);
      // Scripts are looked at in the page as written (the other checks read it without script contents).
      for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
        const src = attr(match[0], 'src');
        if (src === undefined) continue;
        assert.doesNotMatch(src, OTHER_ORIGIN, `${where}: a script from elsewhere: ${src}`);
        assert.ok(src.startsWith(`${base}/_next/static/`), `${where}: a script that is not one of the site's own builds: ${src}`);
      }
      for (const name of sourced) {
        for (const tag of tagsOf(html, name)) {
          for (const url of [attr(tag, 'src'), attr(tag, 'poster'), ...(attr(tag, 'srcset') ?? '').split(',').map((p) => p.trim().split(/\s+/)[0])]) {
            if (url) assert.doesNotMatch(url, OTHER_ORIGIN, `${where}: <${name}> from elsewhere: ${url}`);
          }
        }
      }
      for (const tag of tagsOf(html, 'link')) {
        if (attr(tag, 'rel') === 'canonical') continue;
        assert.doesNotMatch(attr(tag, 'href') ?? '', OTHER_ORIGIN, `${where}: ${tag}`);
      }
      for (const tag of tagsOf(html, 'object')) assert.doesNotMatch(attr(tag, 'data') ?? '', OTHER_ORIGIN, `${where}: ${tag}`);
      assert.doesNotMatch(markup(html), /<form\b/i, `${where} has a form`);
    }
    for (const sheet of walk(dir).filter((file) => file.endsWith('.css'))) {
      for (const url of urlsInCss(readFileSync(sheet, 'utf8'))) assert.doesNotMatch(url, OTHER_ORIGIN, `${nameOf(dir, sheet)}: ${url}`);
    }
    for (const script of walk(dir).filter((file) => file.endsWith('.js'))) {
      assert.doesNotMatch(readFileSync(script, 'utf8'), /fonts\.googleapis|fonts\.gstatic|googletagmanager|google-analytics|vercel-insights|vitals\.vercel/,
        `${nameOf(dir, script)} names a tracking or font service`);
    }
  }
});

test('every page carries its security policy before anything it loads, and only its own inline scripts can run', () => {
  const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  for (const dir of [plain, sub]) {
    for (const file of htmlPages(dir)) {
      const html = readFileSync(file, 'utf8');
      const where = nameOf(dir, file);
      const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"\/?>/.exec(html);
      assert.ok(meta !== null, `${where} has no policy`);
      const policy = meta[1];
      assert.match(policy, /^default-src 'none'; script-src /, where);
      assert.match(policy, /base-uri 'none'; form-action 'none'$/, where);
      const first = html.search(/<(?:script|link|style)\b/i);
      assert.ok(first === -1 || meta.index < first, `${where}: the policy comes after something it should cover`);
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\ssrc=/.test(match[1])) continue;
        assert.ok(policy.includes(hash(match[2])), `${where}: an inline script is not in the policy`);
      }
      assert.doesNotMatch(markup(html), /\sstyle="/i, `${where} has an inline style`);
      assert.doesNotMatch(html, /<style\b/i, `${where} has a style element`);
      assert.doesNotMatch(markup(html), /\son[a-z]+="/i, `${where} has an event handler attribute`);
      if (!oldPages().has(where)) assert.match(policy, /style-src 'self'; img-src 'self'; font-src 'self'; media-src 'self'; connect-src 'self';/, where);
    }
  }
});

test('without the setting the site is built for the root, with no absolute tags, sitemap or robots.txt', () => {
  for (const file of sitePages(plain)) {
    const html = readFileSync(file, 'utf8');
    assert.doesNotMatch(html, /rel="canonical"|property="og:|name="twitter:/, nameOf(plain, file));
    assert.doesNotMatch(html, /\s(?:href|src)="\/luady\//, nameOf(plain, file));
  }
  assert.match(read(plain, 'index.html'), /<a href="\/docs\/">Docs<\/a>/);
  assert.ok(!existsSync(join(plain, 'sitemap.xml')));
  assert.ok(!existsSync(join(plain, 'robots.txt')));
});

test('with the setting the canonical link, Open Graph, the Twitter card, sitemap.xml and robots.txt point at the site', () => {
  const home = read(sub, 'index.html');
  assert.match(home, /<link rel="canonical" href="https:\/\/example\.com\/luady\/"\/>/);
  assert.match(home, /<meta property="og:url" content="https:\/\/example\.com\/luady\/"\/>/);
  assert.match(home, /<meta property="og:image" content="https:\/\/example\.com\/luady\/brand\/social-card\.png"\/>/);
  assert.match(home, /<meta property="og:image:alt" content="The Luady logo/);
  assert.match(home, /<meta name="twitter:card" content="summary_large_image"\/>/);
  assert.match(home, /<meta name="twitter:image" content="https:\/\/example\.com\/luady\/brand\/social-card\.png"\/>/);
  assert.match(home, /<meta property="og:title" content="Luady: a pixel-art office for your Claude Code sessions"\/>/);
  assert.match(home, /<a href="\/luady\/docs\/">Docs<\/a>/);
  assert.ok(existsSync(join(sub, 'brand', 'social-card.png')));
  assert.match(read(sub, 'docs/rooms/index.html'), /<link rel="canonical" href="https:\/\/example\.com\/luady\/docs\/rooms\/"\/>/);
  const map = read(sub, 'sitemap.xml');
  for (const path of sitePaths(REPO)) assert.ok(map.includes(`<loc>${SITE_URL}${path}</loc>`), path);
  assert.doesNotMatch(map, /404|\.html/);
  assert.match(read(sub, 'robots.txt'), /^Sitemap: https:\/\/example\.com\/luady\/sitemap\.xml$/m);
  assert.doesNotMatch(home, /github\.io/, 'the setting, not a guess, makes the absolute URLs');
});

test('the 404 page stays out of search results and links from the site\'s folder, so it works at any depth', () => {
  const page = read(sub, '404.html');
  assert.match(page, /<meta name="robots" content="noindex, follow"\/>/);
  assert.match(page, /<h1 id="not-found">Not found<\/h1>/);
  for (const tag of [...tagsOf(page, 'a'), ...tagsOf(page, 'img'), ...tagsOf(page, 'link'), ...tagsOf(page, 'script')]) {
    const url = attr(tag, 'href') ?? attr(tag, 'src');
    if (url === undefined || url.startsWith('#') || OTHER_ORIGIN.test(url)) continue;
    assert.match(url, /^\/luady\//, `404.html: ${tag}`);
  }
  assert.doesNotMatch(page, /rel="canonical"/);
});

test('no link spells out index.html, and without the demo build no page links to the demo', () => {
  for (const dir of [plain, sub]) {
    for (const file of htmlPages(dir)) {
      for (const tag of tagsOf(readFileSync(file, 'utf8'), 'a')) {
        const href = attr(tag, 'href') ?? '';
        if (OTHER_ORIGIN.test(href)) continue;
        assert.doesNotMatch(href, /index\.html/, `${nameOf(dir, file)}: ${tag}`);
        assert.doesNotMatch(href, /(?:^|\/)demo\//, `${nameOf(dir, file)} links to a demo that is not there: ${tag}`);
      }
    }
  }
  assert.match(read(plain, 'index.html'), /Run the demo on your computer/);
});

test('the landing page: one h1, its sections in order, a skip link, and every picture sized and described', () => {
  const html = read(plain, 'index.html');
  assert.equal(tagsOf(html, 'h1').length, 1);
  const order = ['hero-title', 'from-terminals', 'what-you-see', 'set-up', 'how-it-works', 'security', 'open-source', 'last-title'];
  const positions = order.map((id) => html.indexOf(`id="${id}"`));
  for (const [i, at] of positions.entries()) assert.ok(at > -1, `#${order[i]} is missing`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'the sections are in order');
  for (const heading of ['What you see', 'Set up from your browser', 'How it works', 'Careful by default', 'Open source']) {
    assert.match(html, new RegExp(`class="plate" id="[a-z-]+-title">${heading}</h2>`));
  }
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /A tiny office to play with\. The real one is one click away\./);
  const heroEnd = html.indexOf('class="pile"');
  for (const match of markup(html).matchAll(/<img\b[^>]*>/g)) {
    const tag = match[0];
    assert.ok(attr(tag, 'width') && attr(tag, 'height'), `no size: ${tag}`);
    assert.notEqual(attr(tag, 'alt'), undefined, `no alt: ${tag}`);
    if (/assets\//.test(attr(tag, 'src'))) assert.ok(attr(tag, 'alt').length > 30, `a screenshot needs a real description: ${tag}`);
  }
  for (const match of markup(html.slice(html.indexOf('<main'))).matchAll(/<img\b[^>]*>/g)) {
    const tag = match[0];
    if (html.indexOf(tag) > heroEnd) assert.equal(attr(tag, 'loading'), 'lazy', `below the first screen but not lazy: ${tag}`);
  }
  assert.match(html, /<svg class="how__svg"[^>]*aria-labelledby="how-t how-d"/, 'the diagram is inline, with its title and description');
  assert.doesNotMatch(html, /Headings use the Pixelify Sans font/, 'the landing page has no font small print');
  assert.match(read(plain, 'docs/rooms/index.html'), /Headings use the Pixelify Sans font, under the SIL Open Font License/);
});

test('the landing page says what the README says', () => {
  const readme = readmeOf(REPO);
  const text = normalise(textOf(read(plain, 'index.html')));
  assert.doesNotMatch(read(plain, 'index.html'), /id="not-yet"/, 'the landing page has no "Not yet" section; the README keeps its own');
  const whatItIs = bullets(section(readme, 'What it is'));
  for (const item of whatItIs.slice(0, 2)) assert.ok(text.includes(normalise(item).slice(1)), `What it is: "${item.slice(0, 60)}..."`);
  for (const card of [...section(readme, 'What makes it different').matchAll(/<p><strong>([^<]+)<\/strong>([\s\S]*?)<\/p>/g)].slice(0, 3)) {
    const words = normalise(textOf(card[2]));
    if (/manager|server|room/i.test(card[1])) assert.ok(text.includes(words), `card "${card[1]}"`);
  }
  for (const name of ['How it works', 'Security']) {
    for (const item of bullets(section(readme, name))) assert.ok(text.includes(normalise(item)), `${name}: "${item.slice(0, 60)}..."`);
  }
  const permission = /Sessions started from Luady run Claude Code with its permission prompts bypassed[^.]*\./.exec(readme.replace(/\s*\n\s*/g, ' '));
  assert.ok(permission !== null, 'the README still has the permission sentence');
  assert.ok(text.includes(normalise(permission[0])));
  assert.ok(text.includes('Luady is not affiliated with Anthropic. "Claude" and "Claude Code" are Anthropic\'s names'));
  assert.ok(text.includes('For developers who run Claude Code on more than one machine and want to see and steer it all from one browser tab'));
  assert.doesNotMatch(text, /\b20\d\d\b|\bQ[1-4]\b|coming soon/i, 'no dates or promises');
});

test('docs pages: two-column tables stack on a phone, code never breaks mid-word, and every picture has a size', () => {
  let stacked = 0;
  for (const file of docsFiles(REPO)) {
    const html = read(plain, join(pathOfDoc(file), 'index.html'));
    stacked += (html.match(/table-wrap--stack/g) ?? []).length;
    const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    for (const tag of tagsOf(article, 'img')) assert.ok(attr(tag, 'width') && attr(tag, 'height'), `${file}: no size: ${tag}`);
    assert.doesNotMatch(article, /<pre tabindex="0">/, `${file}: a code block is focusable without being named`);
  }
  assert.ok(stacked > 0, 'the docs have two-column tables, and they stack');
});

/**
 * Bytes a browser fetches for the landing page: the page, its styles, scripts, fonts and pictures. Pictures inside a
 * closed <details> (the real screens on the cards) load only when someone opens one, so they are not counted.
 */
function landingWeight(dir) {
  const html = read(dir, 'index.html').replace(/<details\b[\s\S]*?<\/details>/g, '');
  const size = (url) => {
    const file = join(dir, url.replace(/^\/+/, '').split('#')[0]);
    return existsSync(file) && statSync(file).isFile() ? statSync(file).size : 0;
  };
  const first = new Set();
  const all = new Set();
  for (const tag of tagsOf(html, 'link')) {
    if (['stylesheet', 'preload'].includes(attr(tag, 'rel')) && attr(tag, 'href') !== undefined) first.add(attr(tag, 'href'));
  }
  for (const match of html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g)) first.add(match[1]);
  for (const sheet of [...first].filter((url) => url.endsWith('.css'))) for (const url of urlsInCss(read(dir, sheet))) if (url.startsWith('/')) all.add(url);
  for (const tag of tagsOf(html, 'img')) {
    const urls = [attr(tag, 'src'), ...(attr(tag, 'srcset') ?? '').split(',').map((p) => p.trim().split(/\s+/)[0])].filter(Boolean);
    const biggest = urls.sort((a, b) => size(b) - size(a))[0];
    (attr(tag, 'loading') === 'lazy' ? all : first).add(biggest);
  }
  for (const tag of tagsOf(html, 'source')) all.add(attr(tag, 'srcset'));
  // The pixel art the office toy and the scenes load once the page runs.
  for (const name of ['office-world.png', 'sprites.png', 'rooms.png']) first.add(`/pixel/${name}`);
  const sum = (set) => [...set].reduce((total, url) => total + size(url), 0);
  return { first: sum(first), all: sum(first) + sum(all) };
}

test('the landing page stays under its weight budget', (t) => {
  const weight = landingWeight(plain);
  t.diagnostic(`first paint ${(weight.first / 1024).toFixed(0)} KB, everything ${(weight.all / 1024 / 1024).toFixed(2)} MB`);
  assert.ok(weight.first < FIRST_BUDGET, `the first paint fetches ${(weight.first / 1024).toFixed(0)} KB`);
  assert.ok(weight.all < FULL_BUDGET, `the whole page fetches ${(weight.all / 1024 / 1024).toFixed(2)} MB`);
});

test('with the demo\'s build there, the pages link to it, it is copied in with its own policy, and it leads back', () => {
  const home = read(withDemo, 'index.html');
  assert.match(home, /<a class="btn btn--primary" href="\/luady\/demo\/">Try the live demo<\/a>/);
  assert.match(home, /<a class="btn btn--primary" href="\/luady\/demo\/">Open the full live demo<\/a>/);
  assert.match(home, /<a class="topbar__demo" href="\/luady\/demo\/">Live demo<\/a>/);
  assert.match(read(withDemo, '404.html'), /href="\/luady\/demo\/">The live demo<\/a>/);
  const demo = read(withDemo, 'demo/index.html');
  assert.match(demo, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https:\/\/example\.com\/luady\/demo\/;/);
  assert.match(demo, /connect-src https:\/\/example\.com\/luady\/demo\/;/);
  assert.match(demo, /<a class="luady-site-back" href="\.\.\/">Back to the Luady website<\/a>/);
  assert.match(demo, /<title>Luady live demo \(pretend data\)<\/title>/);
  assert.ok(existsSync(join(withDemo, 'demo', 'site-back.css')));
  assert.ok(existsSync(join(withDemo, 'demo', 'assets', 'office.js')));
  assert.deepEqual(checkSite(withDemo, '/luady/', { strict: true }).errors, []);
});
