/**
 * Raw HTML written in docs/*.md or README.md, made safe for the website. Markdown lets a file hold any HTML, and
 * GitHub's rendered view hides some of it, so a change to a document alone must never be able to run code on the
 * site, send visitors elsewhere, or load anything.
 *
 * Only the tags and attributes the docs and the README really use (and a few plain text ones) are kept, rebuilt from
 * what was parsed; every other tag is shown as text, every other attribute is dropped, and an address is kept only
 * when it is relative (a picture) or relative, http(s) or mailto (a link). Every `<` that is not the start of a kept tag is written as
 * `&lt;`, so nothing the browser could read as a tag gets through. Comments are dropped.
 */

/** Tag -> the attributes it may keep. */
export const ALLOWED_TAGS = Object.freeze({
  a: ['href', 'title'],
  p: ['class', 'align'],
  br: [],
  strong: [],
  em: [],
  b: [],
  i: [],
  sub: [],
  sup: [],
  code: [],
  kbd: [],
  img: ['src', 'alt', 'width', 'height', 'title'],
  picture: [],
  source: ['srcset', 'media', 'width', 'height'],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['align', 'valign', 'width'],
  td: ['align', 'valign', 'width'],
});
const VOID = new Set(['br', 'img', 'source']);

/** What each attribute's value must look like (addresses are checked separately). */
const VALUE = {
  class: /^[a-z][a-z0-9 _-]{0,60}$/i,
  align: /^(?:left|right|center|justify)$/i,
  valign: /^(?:top|middle|bottom|baseline)$/i,
  width: /^\d{1,4}%?$/,
  height: /^\d{1,4}%?$/,
  media: /^[a-z0-9 ():,.-]{1,120}$/i,
  alt: /^[^]*$/,
  title: /^[^]*$/,
};

const escapeAttr = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' };

/** An attribute value as the browser would read it: character references decoded. */
export function decodeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return NAMED[ref.toLowerCase()] ?? all;
  });
}

/**
 * Whether an address may stay: relative (no scheme), or a scheme on the list. Control characters and spaces, which
 * browsers skip inside a scheme, are taken out before looking.
 */
export function safeUrl(value, schemes) {
  // eslint-disable-next-line no-control-regex
  const compact = decodeEntities(value).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (compact.startsWith('//')) return schemes.includes('https');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  return scheme === null || schemes.includes(scheme[1].toLowerCase());
}

const HREF_SCHEMES = ['http', 'https', 'mailto'];
/** Pictures come from the site itself: a relative address only. */
const SRC_SCHEMES = [];

function keepAttribute(tag, name, value) {
  if (!(ALLOWED_TAGS[tag] ?? []).includes(name)) return false;
  if (name === 'href') return safeUrl(value, HREF_SCHEMES);
  if (name === 'src') return safeUrl(value, SRC_SCHEMES);
  if (name === 'srcset') return value.split(',').every((part) => safeUrl(part.trim().split(/\s+/)[0] ?? '', SRC_SCHEMES));
  return (VALUE[name] ?? /^$/).test(decodeEntities(value));
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const COMMENT = /<!--[\s\S]*?-->/y;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Rebuilds one parsed tag from its kept parts, or returns null when the tag is not on the list. */
function rebuild(closing, rawName, rawAttributes) {
  const tag = rawName.toLowerCase();
  if (!Object.hasOwn(ALLOWED_TAGS, tag)) return null;
  if (closing) return VOID.has(tag) ? '' : `</${tag}>`;
  const kept = [];
  const seen = new Set();
  for (const match of rawAttributes.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (seen.has(name) || !keepAttribute(tag, name, value)) continue;
    seen.add(name);
    kept.push(` ${name}="${escapeAttr(decodeEntities(value))}"`);
  }
  return `<${tag}${kept.join('')}>`;
}

/**
 * A drawing from docs/assets/ that a page puts inline (the how-it-works diagram), checked to be a drawing only: no
 * script, styles, embedded HTML, event handlers or links out of the file. Returns it unchanged, or throws.
 * @param {string} svg
 * @param {string} [name]
 * @returns {string}
 */
export function plainSvg(svg, name = 'the drawing') {
  const active = /<script\b|<style\b|<foreignObject\b|<iframe\b|<a\b|<!ENTITY|\son[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#)/i.exec(svg);
  if (active !== null) throw new Error(`site: ${name} holds "${active[0]}"; a page only puts a plain drawing inline`);
  return svg;
}

/** Raw HTML from a document, with only the allowed tags and attributes left as HTML. */
export function sanitizeHtml(html) {
  const text = String(html);
  let out = '';
  let at = 0;
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt === -1) {
      out += text.slice(at).replace(/>/g, '&gt;');
      break;
    }
    out += text.slice(at, lt).replace(/>/g, '&gt;');
    COMMENT.lastIndex = lt;
    if (COMMENT.test(text)) {
      at = COMMENT.lastIndex;
      continue;
    }
    TAG.lastIndex = lt;
    const match = TAG.exec(text);
    const rebuilt = match === null ? null : rebuild(match[1] === '/', match[2], match[3]);
    if (match === null || rebuilt === null) {
      out += '&lt;';
      at = lt + 1;
      continue;
    }
    out += rebuilt;
    at = TAG.lastIndex;
  }
  return out;
}

