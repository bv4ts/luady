import { createHash } from 'node:crypto';

/**
 * Every page carries a Content-Security-Policy in a <meta> tag, written by the build after Next.js has exported it:
 * scripts, styles, pictures, fonts and media from the site's own origin only, and the page's own inline scripts by
 * their SHA-256 hash (Next.js puts the page data in small inline scripts). Nothing can be loaded from or sent to
 * another site, and no other inline script can run.
 */
const OTHER_SOURCES = [
  ['style-src', "'self'"],
  ['img-src', "'self'"],
  ['font-src', "'self'"],
  ['media-src', "'self'"],
  ['connect-src', "'self'"],
  ['manifest-src', "'self'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
];

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

/**
 * The bodies of the inline scripts of a page (scripts without a src), exactly as the browser hashes them. A script
 * ends where the browser ends it: at `</script` followed by `>`, a space, tab, line break or `/` (`</script >` too).
 */
export function inlineScripts(html) {
  const bodies = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi)) {
    if (/\ssrc\s*=/i.test(match[1])) continue;
    bodies.push(match[2]);
  }
  return bodies;
}

/** The policy for a page whose inline scripts are `scripts`: 'self' plus one hash per distinct script. */
export function pagePolicy(scripts) {
  const hashes = [...new Set(scripts.map(sha256))];
  const policy = [['default-src', "'none'"], ['script-src', ["'self'", ...hashes].join(' ')], ...OTHER_SOURCES];
  return policy.map(([name, value]) => `${name} ${value}`).join('; ');
}

/** The policy of a page that runs nothing but its own inline scripts and loads nothing (the old-address pages). */
export function scriptOnlyPolicy(scripts) {
  const hashes = [...new Set(scripts.map(sha256))];
  return [`default-src 'none'`, `script-src ${hashes.join(' ') || "'none'"}`, "base-uri 'none'", "form-action 'none'"].join('; ');
}

const CHARSET = /<meta charSet="utf-8"\s*\/?>|<meta charset="utf-8"\s*\/?>/i;

const NEXT_INIT = '(self.__next_f=self.__next_f||[]).push([0])';
const NEXT_DATA = /^self\.__next_f\.push\(\[(\d{1,2})(?:,("(?:[^"\\<]|\\.)*"))?\]\)$/;
const TURBOPACK = /^\(globalThis\["TURBOPACK"\] \|\| \(globalThis\["TURBOPACK"\] = \[\]\)\)\.push\((\{[^<]*\})\);$/;

/**
 * Whether an inline script is one Next.js writes into every page: the start of its page data, a piece of that data
 * (one JSON string, nothing else), or the Turbopack start-up list of chunk files. Anything else (a script that came
 * from a document, say) is not, and the build refuses to give it a hash.
 */
export function isNextScript(body, attributes = '') {
  if (body === NEXT_INIT && attributes.trim() === '') return true;
  const data = NEXT_DATA.exec(body);
  if (data !== null && attributes.trim() === '') {
    if (data[2] === undefined) return true;
    try {
      return typeof JSON.parse(data[2]) === 'string';
    } catch {
      return false;
    }
  }
  const boot = TURBOPACK.exec(body);
  if (boot !== null && attributes.trim() === 'id="_R_"') {
    try {
      const list = JSON.parse(boot[1]);
      const keys = Object.keys(list).sort().join(',');
      return (keys === 'otherChunks,runtimeModuleIds' || keys === 'otherChunks')
        && Array.isArray(list.otherChunks) && list.otherChunks.every((path) => /^static\/chunks\/[\w.-]+\.js$/.test(path))
        && (list.runtimeModuleIds === undefined || (Array.isArray(list.runtimeModuleIds) && list.runtimeModuleIds.every(Number.isInteger)));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The page with its policy as the first thing after the charset line, before any script or stylesheet, so it covers
 * everything the page loads. Throws when the page has no charset line, already has a policy, or holds an inline
 * script that Next.js did not write (`where` names the page in the message).
 */
export function withPolicy(html, where = 'a page') {
  if (/http-equiv="Content-Security-Policy"/i.test(html)) throw new Error('csp: the page already has a policy');
  const match = CHARSET.exec(html);
  if (match === null) throw new Error('csp: the page has no <meta charset="utf-8"> to put the policy after');
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script(?:[\t\n\f\r /][^>]*)?>/gi)) {
    if (/\ssrc\s*=/i.test(script[1])) continue;
    if (!isNextScript(script[2], script[1])) {
      throw new Error(`csp: ${where} holds an inline script that Next.js did not write, so it gets no hash: ${script[2].slice(0, 80)}`);
    }
  }
  const policy = pagePolicy(inlineScripts(html));
  const at = match.index + match[0].length;
  return `${html.slice(0, at)}<meta http-equiv="Content-Security-Policy" content="${policy}"/>${html.slice(at)}`;
}
