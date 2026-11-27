import { Marked } from 'marked';
import { rewriteHref } from './links.mjs';
import { safeUrl, sanitizeHtml } from './sanitize.mjs';
import { createSlugger, plainText } from './slug.mjs';

/** The address schemes a link in the docs may use; any other address (javascript:, data:, ...) is dropped. */
export const LINK_SCHEMES = ['http', 'https', 'mailto'];

const escapeAttr = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescape = (value) => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

const ALERTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

/** A code chip longer than this (in characters) is "long": it wraps at its spaces or scrolls, never mid-word. */
export const LONG_CODE = 40;
/** A code block line longer than this is likely to need sideways scrolling on a phone. */
export const LONG_LINE = 78;
/** Pages with at least this many sections get an "On this page" list under their title. */
export const TOC_MIN = 5;

/** GitHub alerts (`> [!NOTE]`) become a titled callout; any other quote stays a quote. */
function alerts(html) {
  return html.replace(/<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/g, (_all, kind) =>
    `<blockquote class="callout callout--${kind.toLowerCase()}"><p><strong class="callout__title">${ALERTS[kind]}</strong><br>`);
}

/**
 * Tables: one with two columns (a command or option, then what it does) becomes stacked rows on a phone; one with
 * three or more keeps a minimum width and scrolls sideways, and only that one is a focusable, named region.
 */
function tables(html) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (_all, inner) => {
    const head = /<thead>([\s\S]*?)<\/thead>/.exec(inner)?.[1] ?? '';
    const columns = (head.match(/<th\b/g) ?? []).length;
    if (columns === 2) return `<div class="table-wrap table-wrap--stack"><table>${inner}</table></div>`;
    return `<div class="table-wrap table-wrap--scroll" tabindex="0" role="region" aria-label="Table, scrolls sideways"><table>${inner}</table></div>`;
  });
}

/** The "On this page" list for long pages, right after the page title. */
function tableOfContents(html, sections) {
  if (sections.length < TOC_MIN) return html;
  const items = sections.map(({ id, text }) => `<li><a href="#${id}">${escapeText(text)}</a></li>`).join('');
  const nav = `<nav class="toc" aria-label="On this page"><p class="toc__title">On this page</p><ul>${items}</ul></nav>`;
  const end = html.indexOf('</h1>');
  return end === -1 ? `${nav}${html}` : `${html.slice(0, end + 5)}\n${nav}${html.slice(end + 5)}`;
}

/** Finishing touches: no comments, callouts, tables, and the list of sections. */
function finish(html, sections) {
  return tableOfContents(tables(alerts(html).replace(/<!--[\s\S]*?-->\n?/g, '')), sections);
}

/** An inline code chip: short ones never break; long ones wrap at their spaces, or scroll if they have none. */
export function codeChip(raw) {
  const text = escapeText(raw);
  if (raw.length <= LONG_CODE) return `<code>${text}</code>`;
  return /\s/.test(raw.trim()) ? `<code class="code-long">${text}</code>` : `<code class="code-scroll">${text}</code>`;
}

/**
 * Renders one docs/ Markdown file to HTML for the site. Returns the body HTML, the page title (its first H1), a short
 * description (its first paragraph), and the heading ids (for the link checker and the tests).
 *
 * Options: `basePath` ('' or a path such as '/luady') for links to other pages and pictures; `sizeOf(path)` gives
 * `{ width, height }` for a picture under docs/ (every picture gets both, so the page does not jump while it loads),
 * or null.
 *
 * Headings get an id the way GitHub makes them, and a small `#` link to themselves. Code blocks get a Copy button that
 * stays hidden until the page's script turns it on, so without JavaScript there is no button that does nothing. A
 * picture with a title (`![alt](src "caption")`) becomes a figure with that caption.
 */
export function renderDoc(markdown, docsPages, { basePath = '', sizeOf = () => null } = {}) {
  const slug = createSlugger();
  let title = null;
  let description = null;
  const ids = [];
  const sections = [];
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = plainText(inner);
        const id = slug(text);
        ids.push(id);
        if (depth === 1 && title === null) title = text;
        if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
        if (depth === 2) sections.push({ id, text });
        const anchor = `<a class="heading-anchor" href="#${id}" aria-label="Link to the section ${escapeAttr(text)}">#</a>`;
        return `<h${depth} id="${id}">${inner} ${anchor}</h${depth}>\n`;
      },
      paragraph({ tokens }) {
        const inner = this.parser.parseInline(tokens);
        if (description === null && !inner.startsWith('<')) description = plainText(inner).slice(0, 180);
        return `<p>${inner}</p>\n`;
      },
      link({ href, title: linkTitle, tokens }) {
        const inner = this.parser.parseInline(tokens);
        // A javascript:, data: or other address is not a link on the site: only its text stays.
        if (!safeUrl(href, LINK_SCHEMES)) return inner;
        const target = rewriteHref(href, docsPages, basePath);
        const titleAttr = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : '';
        return `<a href="${escapeAttr(target)}"${titleAttr}>${inner}</a>`;
      },
      image({ href, title: caption, text }) {
        // Pictures come from the site itself; anything else shows its alt text.
        if (!safeUrl(href, [])) return escapeText(text);
        const target = rewriteHref(href, docsPages, basePath);
        const size = sizeOf(href);
        const sizeAttr = size ? ` width="${size.width}" height="${size.height}"` : '';
        const img = `<img src="${escapeAttr(target)}" alt="${escapeAttr(text)}"${sizeAttr} loading="lazy" decoding="async">`;
        return caption ? `<figure>${img}<figcaption>${escapeText(caption)}</figcaption></figure>` : img;
      },
      codespan({ text }) {
        return codeChip(unescape(text));
      },
      code({ text, lang }) {
        const language = (lang ?? '').trim().split(/\s+/)[0];
        const cls = language === '' ? '' : ` class="language-${escapeAttr(language)}"`;
        const wide = text.split('\n').some((line) => line.length > LONG_LINE);
        const region = wide ? ' tabindex="0" role="region" aria-label="Code, scrolls sideways"' : '';
        return `<div class="codeblock"><pre${region}><code${cls}>${escapeText(text)}</code></pre>`
          + '<button type="button" class="codeblock__copy" hidden>Copy</button></div>\n';
      },
      // Raw HTML written in the Markdown (a <picture>, a caption): only the allowed tags and attributes stay (see
      // sanitize.mjs), then its paths are rewritten like Markdown links.
      html({ text }) {
        return rewriteRawHtml(sanitizeHtml(text), docsPages, basePath, sizeOf);
      },
    },
  });
  const html = finish(marked.parse(markdown), sections);
  return { html, title: title ?? 'Luady', description: description ?? '', ids, sections };
}

/**
 * Rewrites a piece of raw HTML from docs/ for the site: its `href`, `src` and single-URL `srcset` paths like Markdown
 * links; a picture without a height gets one from the file (kept in proportion to its width); and `code` written in
 * backticks inside a caption paragraph becomes a code chip, as it would in Markdown.
 */
export function rewriteRawHtml(html, docsPages, basePath = '', sizeOf = () => null) {
  const sized = html.replace(/<img\b[^>]*>/g, (tag) => sizeTag(tag, sizeOf));
  const paths = sized.replace(/\b(href|src|srcset)="([^"]+)"/g, (_all, name, value) => {
    const [url, ...rest] = value.replace(/&amp;/g, '&').split(/\s+/);
    const target = [rewriteHref(url, docsPages, basePath), ...rest].join(' ');
    return `${name}="${escapeAttr(target)}"`;
  });
  return paths.replace(/(<p class="caption">)([\s\S]*?)(<\/p>)/g, (_all, open, body, close) =>
    `${open}${body.replace(/`([^`]+)`/g, (_m, code) => codeChip(unescape(code)))}${close}`);
}

/** An <img> tag (with its path as written in docs/) given the width and height it lacks. */
function sizeTag(tag, sizeOf) {
  const src = /\ssrc="([^"]+)"/.exec(tag)?.[1];
  if (src === undefined) return tag;
  const size = sizeOf(src);
  if (size === null) return tag;
  const width = /\swidth="(\d+)"/.exec(tag)?.[1];
  const height = /\sheight="(\d+)"/.exec(tag)?.[1];
  if (width !== undefined && height !== undefined) return tag;
  if (width !== undefined) return tag.replace(/<img\b/, `<img height="${Math.round((Number(width) * size.height) / size.width)}"`);
  if (height !== undefined) return tag.replace(/<img\b/, `<img width="${Math.round((Number(height) * size.width) / size.height)}"`);
  return tag.replace(/<img\b/, `<img width="${size.width}" height="${size.height}"`);
}
