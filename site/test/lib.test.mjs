/** The site's build tools on their own, without building the site. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { urlsInCss, urlsInHtml } from '../check-links.mjs';
import { BACK_LINK, demoCsp, demoPage, demoSource } from '../demo.mjs';
import { inlineScripts, pagePolicy, withPolicy } from '../lib/csp.mjs';
import { forwarderPage } from '../lib/forwarders.mjs';
import { oldPageOf, pathOfDoc, rewriteHref, withBase } from '../lib/links.mjs';
import { codeChip, renderDoc, rewriteRawHtml } from '../lib/markdown.mjs';
import { pageMetadata, robotsTxt, sitemapXml } from '../lib/meta.mjs';
import { navFor } from '../lib/pages.mjs';
import { bullets, paragraphs, readmeHref, section } from '../lib/readme.mjs';
import { absoluteUrl, basePathOf, parseSiteUrl, sitePathOf, siteUrlFrom } from '../lib/site-url.mjs';
import { headingIdsOf, slugOf } from '../lib/slug.mjs';

const PAGES = new Set(['README.md', 'rooms.md', 'servers.md']);

test('heading ids follow GitHub', () => {
  assert.equal(slugOf('Remove a room'), 'remove-a-room');
  assert.equal(slugOf('The doctor command: what it checks'), 'the-doctor-command-what-it-checks');
  assert.equal(slugOf('Node 22.12 or newer'), 'node-2212-or-newer');
  assert.deepEqual([...headingIdsOf('# A\n## Same\n## Same\n```\n# not a heading\n```\n### `code` here')], ['a', 'same', 'same-1', 'code-here']);
});

test('docs pages have clean folder addresses, and the old .html names are remembered', () => {
  assert.equal(pathOfDoc('README.md'), 'docs/');
  assert.equal(pathOfDoc('rooms.md'), 'docs/rooms/');
  assert.equal(oldPageOf('README.md'), 'docs.html');
  assert.equal(oldPageOf('rooms.md'), 'rooms.html');
  assert.equal(withBase('', 'docs/'), '/docs/');
  assert.equal(withBase('/luady', 'docs/rooms/'), '/luady/docs/rooms/');
  assert.equal(withBase('/luady', ''), '/luady/');
});

test('links in the docs go to the site\'s pages and pictures, the rest to GitHub', () => {
  assert.equal(rewriteHref('rooms.md#remove-a-room', PAGES, '/luady'), '/luady/docs/rooms/#remove-a-room');
  assert.equal(rewriteHref('README.md', PAGES), '/docs/');
  assert.equal(rewriteHref('README.md#where-to-start', PAGES, '/luady'), '/luady/docs/#where-to-start');
  assert.equal(rewriteHref('assets/office.png', PAGES, '/luady'), '/luady/assets/office.png');
  assert.equal(rewriteHref('../SECURITY.md', PAGES), 'https://github.com/bv4ts/luady/blob/main/SECURITY.md');
  assert.equal(rewriteHref('../packages/addon-sdk/', PAGES), 'https://github.com/bv4ts/luady/tree/main/packages/addon-sdk');
  assert.equal(rewriteHref('./', PAGES), 'https://github.com/bv4ts/luady/tree/main/docs');
  assert.equal(rewriteHref('https://example.com/a.md', PAGES), 'https://example.com/a.md');
  assert.equal(rewriteHref('#here', PAGES), '#here');
});

test('a page renders with ids, anchors, a title, callouts, and without comments', () => {
  const page = renderDoc('# Rooms\n\nA room holds sessions.\n\n<!-- verify at launch: x -->\n\n## Add one\n\n> [!NOTE]\n> Read [servers](servers.md).\n', PAGES, { basePath: '/luady' });
  assert.equal(page.title, 'Rooms');
  assert.equal(page.description, 'A room holds sessions.');
  assert.match(page.html, /<h1 id="rooms">Rooms<\/h1>/);
  assert.match(page.html, /<h2 id="add-one">Add one <a class="heading-anchor" href="#add-one" aria-label="Link to the section Add one">#<\/a><\/h2>/);
  assert.match(page.html, /class="callout callout--note"/);
  assert.match(page.html, /href="\/luady\/docs\/servers\/"/);
  assert.doesNotMatch(page.html, /verify at launch/);
});

test('two-column tables stack on a phone; wider ones scroll and are named regions', () => {
  const two = renderDoc('| Command | What it does |\n|---|---|\n| `npm run luady -- setup-code` | Prints a code |\n', PAGES).html;
  assert.match(two, /<div class="table-wrap table-wrap--stack"><table>/);
  assert.doesNotMatch(two, /table-wrap--stack" tabindex/);
  const three = renderDoc('| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n', PAGES).html;
  assert.match(three, /<div class="table-wrap table-wrap--scroll" tabindex="0" role="region" aria-label="Table, scrolls sideways"><table>/);
});

test('code chips never break mid-word, code blocks get a hidden Copy button, wide ones are named regions', () => {
  assert.equal(codeChip('npm test'), '<code>npm test</code>');
  assert.equal(codeChip('a <b>'), '<code>a &lt;b&gt;</code>');
  assert.equal(codeChip('ssh -L 7410:127.0.0.1:7410 you@ash.example.com -N -o ExitOnForwardFailure=yes'),
    '<code class="code-long">ssh -L 7410:127.0.0.1:7410 you@ash.example.com -N -o ExitOnForwardFailure=yes</code>');
  assert.equal(codeChip('packages/web/src/features/agency/assets/characters.png'), '<code class="code-scroll">packages/web/src/features/agency/assets/characters.png</code>');
  const html = renderDoc('Run `npm test`.\n\n```sh\nnpm ci\n```\n\n```\n' + 'x'.repeat(90) + '\n```\n', PAGES).html;
  assert.match(html, /Run <code>npm test<\/code>\./);
  assert.match(html, /<div class="codeblock"><pre><code class="language-sh">npm ci<\/code><\/pre><button type="button" class="codeblock__copy" hidden>Copy<\/button><\/div>/);
  assert.match(html, /<pre tabindex="0" role="region" aria-label="Code, scrolls sideways"><code>x{90}<\/code><\/pre>/);
});

test('long pages get an "On this page" list after their title', () => {
  const sections = Array.from({ length: 5 }, (_, i) => `## Part ${i + 1}\n\nText.\n`).join('\n');
  const html = renderDoc(`# Long\n\nIntro.\n\n${sections}`, PAGES).html;
  assert.match(html, /<\/h1>\n<nav class="toc" aria-label="On this page"><p class="toc__title">On this page<\/p><ul><li><a href="#part-1">Part 1<\/a><\/li>/);
  assert.doesNotMatch(renderDoc('# Short\n\n## One\n\n## Two\n', PAGES).html, /class="toc"/);
});

test('pictures get their size and a titled picture becomes a figure; raw HTML is rewritten too', () => {
  const sizeOf = (path) => (path.endsWith('a.png') ? { width: 800, height: 500 } : null);
  const md = renderDoc('![A room](assets/a.png "The Cedar room")\n', PAGES, { basePath: '/luady', sizeOf }).html;
  assert.match(md, /<figure><img src="\/luady\/assets\/a.png" alt="A room" width="800" height="500" loading="lazy" decoding="async"><figcaption>The Cedar room<\/figcaption><\/figure>/);
  const raw = rewriteRawHtml('<p><a href="rooms.md"><img src="assets/a.png" width="400" alt="A"></a></p>\n<p class="caption"><sub>Run `npm test` here.</sub></p>', PAGES, '/luady', sizeOf);
  assert.match(raw, /href="\/luady\/docs\/rooms\/"/);
  assert.match(raw, /<img height="250" src="\/luady\/assets\/a.png" width="400" alt="A">/);
  assert.match(raw, /<sub>Run <code>npm test<\/code> here.<\/sub>/);
});

test('the menu lists the docs pages that exist in reading order, and puts unknown ones under More', () => {
  const files = ['README.md', 'getting-started.md', 'quickstart.md', 'setup-wizard.md', 'rooms.md', 'servers.md', 'configuration.md',
    'manager.md', 'addons.md', 'security.md', 'security-notes.md', 'verifying-releases.md', 'troubleshooting.md', 'faq.md', 'new-page.md'];
  const groups = navFor(files);
  assert.deepEqual(groups[0].pages.map((p) => p.file), ['README.md', 'getting-started.md', 'setup-wizard.md', 'quickstart.md']);
  assert.deepEqual(groups[1].pages.map((p) => p.file), ['rooms.md', 'servers.md', 'configuration.md', 'manager.md', 'addons.md']);
  assert.equal(groups.at(-1).group, 'More');
  assert.deepEqual(groups.at(-1).pages.map((page) => page.file), ['new-page.md']);
  const fewer = navFor(files.filter((file) => file !== 'configuration.md' && file !== 'new-page.md'));
  assert.deepEqual(fewer[1].pages.map((p) => p.file), ['rooms.md', 'servers.md', 'manager.md', 'addons.md'], 'a page not written yet is left out');
  assert.notEqual(fewer.at(-1).group, 'More');
  assert.throws(() => navFor(['rooms.md']), /README\.md, the docs overview, is missing/);
});

test('README sections, bullets and links are read the way the landing page needs them', () => {
  const readme = '# T\n\n## Not yet\n\nThis is early. It does not have:\n\n- a thing;\n- another one, over\n  two lines.\n\n## Next\n\nNo.\n';
  const notYet = section(readme, 'Not yet');
  assert.deepEqual(bullets(notYet), ['a thing;', 'another one, over two lines.']);
  assert.deepEqual(paragraphs(notYet), ['This is early. It does not have:']);
  assert.throws(() => section(readme, 'Missing'), /no "## Missing" section/);
  const pages = new Set(['getting-started.md']);
  assert.equal(readmeHref('docs/getting-started.md#try-the-demo', pages, '/luady'), '/luady/docs/getting-started/#try-the-demo');
  assert.equal(readmeHref('SECURITY.md', pages, '/luady'), 'https://github.com/bv4ts/luady/blob/main/SECURITY.md');
  assert.equal(readmeHref('#run-it-for-real', pages, ''), 'https://github.com/bv4ts/luady#run-it-for-real');
});

test('the site URL setting is checked and normalised, and absent means the root', () => {
  assert.equal(parseSiteUrl(undefined), null);
  assert.equal(parseSiteUrl('  '), null);
  assert.equal(parseSiteUrl('https://bv4ts.github.io/luady'), 'https://bv4ts.github.io/luady/');
  assert.equal(parseSiteUrl('https://example.com'), 'https://example.com/');
  assert.equal(parseSiteUrl('http://127.0.0.1:8080/luady/'), 'http://127.0.0.1:8080/luady/');
  assert.throws(() => parseSiteUrl('http://example.com/luady/'), /https/);
  assert.throws(() => parseSiteUrl('example.com/luady'), /not a URL/);
  assert.throws(() => parseSiteUrl('https://example.com/luady/?a=1'), /plain address/);
  assert.throws(() => parseSiteUrl('https://example.com/luady/index.html'), /folder/);
  assert.equal(siteUrlFrom(['node', 'build.mjs'], {}), null);
  assert.equal(siteUrlFrom(['node', 'build.mjs', '--base-url', 'https://bv4ts.github.io/luady/'], { SITE_URL: 'https://example.com/x/' }),
    'https://bv4ts.github.io/luady/', 'the flag wins over the environment');
  assert.throws(() => siteUrlFrom(['node', 'build.mjs', '--base-url'], {}), /needs a URL/);
  assert.equal(sitePathOf('https://example.com/luady/'), '/luady/');
  assert.equal(sitePathOf(null), '/');
  assert.equal(basePathOf('https://example.com/luady/'), '/luady');
  assert.equal(basePathOf('https://example.com/'), '');
  assert.equal(basePathOf(null), '');
  assert.equal(absoluteUrl('https://example.com/luady/', 'brand/social-card.png'), 'https://example.com/luady/brand/social-card.png');
});

test('absolute tags, sitemap and robots.txt come only from the site URL', () => {
  assert.deepEqual(pageMetadata({ siteUrl: null, path: '', title: 'T', description: 'D' }), { title: 'T', description: 'D' });
  const home = pageMetadata({ siteUrl: 'https://example.com/luady/', path: '', title: 'T', description: 'D' });
  assert.equal(home.alternates.canonical, 'https://example.com/luady/');
  assert.equal(home.openGraph.images[0].url, 'https://example.com/luady/brand/social-card.png');
  assert.equal(home.twitter.card, 'summary_large_image');
  assert.equal(pageMetadata({ siteUrl: 'https://example.com/luady/', path: 'docs/rooms/', title: 'R', description: '' }).alternates.canonical,
    'https://example.com/luady/docs/rooms/');
  assert.deepEqual(pageMetadata({ siteUrl: null, path: '', title: 'T', description: 'D', noindex: true }).robots, { index: false, follow: true });
  const map = sitemapXml('https://example.com/luady/', ['', 'docs/rooms/']);
  assert.match(map, /<loc>https:\/\/example\.com\/luady\/<\/loc>/);
  assert.match(map, /<loc>https:\/\/example\.com\/luady\/docs\/rooms\/<\/loc>/);
  assert.equal(robotsTxt('https://example.com/luady/'), 'User-agent: *\nDisallow:\n\nSitemap: https://example.com/luady/sitemap.xml\n');
});

test('every page\'s policy names its own inline scripts by hash and allows nothing from elsewhere', () => {
  const first = '(self.__next_f=self.__next_f||[]).push([0])';
  const data = 'self.__next_f.push([1,"0:\\"page data\\"\\n"])';
  const html = '<!DOCTYPE html><html><head><meta charSet="utf-8"/><script src="/a.js" async=""></script></head>'
    + `<body><script>${first}</script><script>${data}</script></body></html>`;
  assert.deepEqual(inlineScripts(html), [first, data]);
  const done = withPolicy(html);
  const hash = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
  assert.match(done, /^<!DOCTYPE html><html><head><meta charSet="utf-8"\/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' /);
  assert.ok(done.includes(hash(first)) && done.includes(hash(data)));
  assert.match(pagePolicy([]), /style-src 'self'; img-src 'self'; font-src 'self'; media-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'$/);
  assert.throws(() => withPolicy('<html><head></head></html>'), /no <meta charset/);
  assert.throws(() => withPolicy(done), /already has a policy/);
});

test('an old address forwards to the new one, keeping its #section', () => {
  const page = forwarderPage({ basePath: '/luady', siteUrl: 'https://example.com/luady/', newPath: 'docs/rooms/', title: 'Rooms' });
  assert.match(page, /<script>location\.replace\("\/luady\/docs\/rooms\/"\+location\.hash\)<\/script>/);
  assert.match(page, /<meta http-equiv="refresh" content="0; url=\/luady\/docs\/rooms\/">/);
  assert.match(page, /<link rel="canonical" href="https:\/\/example\.com\/luady\/docs\/rooms\/">/);
  assert.match(page, /<meta name="robots" content="noindex">/);
  const script = /<script>([^<]*)<\/script>/.exec(page)[1];
  assert.ok(page.includes(`'sha256-${createHash('sha256').update(script).digest('base64')}'`));
  assert.doesNotMatch(forwarderPage({ basePath: '', siteUrl: null, newPath: 'docs/', title: 'Docs' }), /canonical/);
});

test('the demo page gets a policy narrowed to its own folder, a way back, and refuses root-relative builds', () => {
  const built = '<head>\n    <meta charset="utf-8" />\n    <title>Luady office page demo</title>\n    <script type="module" src="./assets/a.js"></script>\n</head>\n<body>\n</body>';
  const source = demoSource('https://bv4ts.github.io/luady');
  assert.equal(source, 'https://bv4ts.github.io/luady/demo/');
  const page = demoPage(built, source);
  assert.ok(page.includes(demoCsp(source)));
  assert.match(page, /connect-src https:\/\/bv4ts\.github\.io\/luady\/demo\/;/);
  assert.match(page, /<title>Luady live demo \(pretend data\)<\/title>\n    <link rel="stylesheet" href=".\/site-back.css" \/>/);
  assert.ok(page.includes(`<body>\n    ${BACK_LINK}`));
  assert.match(BACK_LINK, /href="\.\.\/"/);
  assert.throws(() => demoPage(built.replace('./assets', '/assets')), /--base/);
  assert.throws(() => demoSource('http://example.com/luady/'), /https/);
});

test('the link checker finds the files a page and a stylesheet point at, and ignores script data', () => {
  const css = '@font-face { src: url(\'fonts/a.ttf\') format(\'truetype\'); } a { background: url(b.png), url("c d.png"); }';
  assert.deepEqual(urlsInCss(css), ['fonts/a.ttf', 'b.png', 'c d.png']);
  const html = '<a href="/x/">x</a><img src="a.png" srcset="a.png 1x, b.png 2x"><script>self.push("<a href=\\"/y/\\">")</script>'
    + '<script src="/_next/static/chunks/a.js" async=""></script>';
  assert.deepEqual(urlsInHtml(html).map((u) => `${u.tag}:${u.url}`),
    ['script:/_next/static/chunks/a.js', 'a:/x/', 'img:a.png', 'img:a.png', 'img:b.png']);
});
