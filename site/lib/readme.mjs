import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Marked } from 'marked';
import { BRANCH, REPO_URL, pathOfDoc, rewriteHref, withBase } from './links.mjs';
import { LINK_SCHEMES, codeChip } from './markdown.mjs';
import { safeUrl, sanitizeHtml } from './sanitize.mjs';

/**
 * Parts of the repository's README.md that the landing page shows as they are, read at build time: the "How it works"
 * list, the security list and its warning, and the commands to try and run it. The landing page
 * cannot say something the README does not, and a README edit reaches the website with the next build. A section
 * that is missing stops the build with a message that names it.
 */
export function readmeOf(repoDir) {
  return readFileSync(join(repoDir, 'README.md'), 'utf8');
}

/** The text of the `## <heading>` section, up to the next `## `. */
export function section(readme, heading) {
  const start = readme.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`site: README.md has no "## ${heading}" section, which the landing page shows`);
  const body = readme.slice(start + heading.length + 5);
  const end = body.search(/\n## /);
  return end === -1 ? body : body.slice(0, end);
}

/** The top-level bullets of a section, each joined into one line, as written. */
export function bullets(text) {
  const items = [];
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) items.push(line.slice(2).trim());
    else if (/^\s{2,}\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** The first fenced code block of a section, without its fences. */
export function firstCode(text) {
  const match = /```[a-z]*\n([\s\S]*?)\n```/.exec(text);
  if (match === null) throw new Error('site: a README section the landing page shows has no code block');
  return match[1];
}

/** The paragraphs of a section (not lists, code or HTML), each joined into one line. */
export function paragraphs(text) {
  return text.replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '' && !/^(?:- |\d+\. |<|```)/.test(block))
    .map((block) => block.replace(/\s*\n\s*/g, ' '));
}

/**
 * A link written in README.md, for the website: a docs page becomes the site's page, a docs picture the site's copy,
 * `#section` the README's section on GitHub, and any other repository file its page on GitHub.
 */
export function readmeHref(href, docsPages, basePath) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href;
  if (href.startsWith('#')) return `${REPO_URL}${href}`;
  const at = href.indexOf('#');
  const path = at === -1 ? href : href.slice(0, at);
  const hash = at === -1 ? '' : href.slice(at);
  const clean = posix.normalize(path).replace(/^\.\//, '');
  if (posix.dirname(clean) === 'docs' && docsPages.has(posix.basename(clean))) return withBase(basePath, pathOfDoc(posix.basename(clean))) + hash;
  if (clean.startsWith('docs/assets/')) return withBase(basePath, clean.slice('docs/'.length)) + hash;
  const kind = path.endsWith('/') ? 'tree' : 'blob';
  return `${REPO_URL}/${kind}/${BRANCH}/${clean.replace(/\/$/, '')}${hash}`;
}

/**
 * The href and src addresses of sanitized HTML, passed through `rewrite`. A picture whose address does not end up on
 * the site itself (a repository file becomes a GitHub address) loses its src rather than load from elsewhere.
 */
function rewriteAddresses(html, rewrite) {
  return html.replace(/\s(href|src)="([^"]*)"/g, (_all, name, value) => {
    const target = rewrite(value.replace(/&amp;/g, '&'));
    if (name === 'src' && /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) return '';
    return ` ${name}="${target.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
  });
}

/**
 * One line of README Markdown as inline HTML, with its links made right for the website. Raw HTML in it keeps only
 * the allowed tags and attributes (sanitize.mjs), and a link with an address that is not http(s), mailto or relative
 * keeps only its text.
 * @returns {string}
 */
export function inlineHtml(text, docsPages, basePath) {
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (!safeUrl(href, LINK_SCHEMES)) return inner;
        return `<a href="${readmeHref(href, docsPages, basePath).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${inner}</a>`;
      },
      image({ text: alt }) {
        return alt.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      },
      codespan({ text: code }) {
        return codeChip(code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
      },
      html({ text: raw }) {
        return rewriteAddresses(sanitizeHtml(raw), (url) => readmeHref(url, docsPages, basePath));
      },
    },
  });
  return String(marked.parseInline(text));
}

/**
 * The first paragraph after the title of docs/README.md (what Luady is, in the docs' own words), as inline HTML.
 * @returns {string}
 */
export function docsIntro(repoDir, docsPages, basePath) {
  const markdown = readFileSync(join(repoDir, 'docs', 'README.md'), 'utf8');
  const first = paragraphs(markdown.replace(/^# .*\n/, '')).find((p) => !p.startsWith('#'));
  if (first === undefined) throw new Error('site: docs/README.md has no paragraph under its title');
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      link({ href, tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (!safeUrl(href, LINK_SCHEMES)) return inner;
        return `<a href="${rewriteHref(href, docsPages, basePath).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">${inner}</a>`;
      },
      image({ text: alt }) {
        return alt.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      },
      html({ text: raw }) {
        return rewriteAddresses(sanitizeHtml(raw), (url) => rewriteHref(url, docsPages, basePath));
      },
    },
  });
  return String(marked.parseInline(first));
}

/** The first of `headings` the README has (a section may be renamed; the build stops only when none is there). */
export function sectionOf(readme, headings) {
  for (const heading of headings) {
    if (readme.includes(`\n## ${heading}\n`)) return section(readme, heading);
  }
  throw new Error(`site: README.md has none of the sections ${headings.map((h) => `"## ${h}"`).join(', ')}, which the landing page shows`);
}

/** The paragraph of `text` that starts with `start`, or a build error that names it. */
function paragraphStarting(text, start, where) {
  const found = paragraphs(text).find((p) => p.startsWith(start));
  if (found === undefined) throw new Error(`site: README.md's "${where}" section no longer has the paragraph that starts "${start}"`);
  return found;
}

/** The sentences of a paragraph up to and including the first one that matches `last`. */
function sentencesUpTo(paragraph, last) {
  const sentences = paragraph.match(/[^.!?]+(?:[.!?](?=\s|$)|$)/g) ?? [paragraph];
  const at = sentences.findIndex((s) => last.test(s));
  return (at === -1 ? sentences : sentences.slice(0, at + 1)).join('').trim();
}

/**
 * The feature cards of the README's "What makes it different" table, `<p><strong>Title.</strong> Text</p>`: the
 * title as plain text, the text with only the allowed tags and attributes, and its links made right for the website.
 */
export function featureCards(text, docsPages, basePath) {
  const cards = [];
  for (const match of text.matchAll(/<p><strong>([^<]+?)\.?<\/strong>\s*([\s\S]*?)<\/p>/g)) {
    const body = rewriteAddresses(sanitizeHtml(match[2].replace(/\s*\n\s*/g, ' ').trim()), (url) => readmeHref(url, docsPages, basePath));
    cards.push({ title: match[1].trim(), html: body });
  }
  return cards;
}

const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * Everything the landing page takes from the README, rendered for the site: what Luady is, the feature cards, how it
 * works, security and its warning, what is not there yet, and the commands to try and run it with their notes.
 */
export function landingCopy(repoDir, docsPages, basePath) {
  const readme = readmeOf(repoDir);
  const html = (text) => inlineHtml(text, docsPages, basePath);
  const what = sectionOf(readme, ['What it is']);
  const different = sectionOf(readme, ['What makes it different']);
  const how = sectionOf(readme, ['How it works']);
  const security = sectionOf(readme, ['Security']);
  const tryIt = sectionOf(readme, ['Try it', 'Try it in one minute']);
  const run = sectionOf(readme, ['Run it for real']);
  const warning = paragraphs(security).find((p) => /permission prompts bypassed/.test(p));
  if (warning === undefined) throw new Error('site: README.md\'s Security section no longer has the sentence about bypassed permission prompts');
  const sentence = /Sessions started from Luady[^.]*\./.exec(warning)?.[0];
  if (sentence === undefined) throw new Error('site: README.md\'s permission sentence changed shape; update site/lib/readme.mjs');
  const whatItems = bullets(what);
  if (whatItems.length < 2) throw new Error('site: README.md\'s "What it is" section has fewer than two points');
  const cards = featureCards(different, docsPages, basePath);
  const card = (start) => {
    const found = cards.find((c) => c.title.toLowerCase().startsWith(start));
    if (found === undefined) throw new Error(`site: README.md's "What makes it different" has no card that starts "${start}"`);
    return found;
  };
  const tryOnComputer = paragraphStarting(tryIt, 'Or run the demo on your computer', 'Try it').replace(/^Or run/, 'Run');
  const runNote = paragraphStarting(run, '`npm start` prints', 'Run it for real').replace(/:$/, '.');
  return {
    // "Luady runs on ... you get an office:" and its first point, as one sentence.
    lead: html(`${paragraphs(what)[0]} ${lowerFirst(whatItems[0])}`),
    talk: html(whatItems[1]),
    servers: card('several servers'),
    rooms: card('a room for each'),
    manager: card('an optional manager'),
    how: bullets(how).map(html),
    security: bullets(security).map(html),
    permission: html(sentence),
    tryLead: html(tryOnComputer),
    tryCode: firstCode(tryIt),
    tryNote: html(sentencesUpTo(paragraphStarting(tryIt, 'The first run', 'Try it'), /PIN/)),
    runCode: firstCode(run),
    runNeeds: html(paragraphs(run)[0] ?? ''),
    runNote: html(runNote),
  };
}
