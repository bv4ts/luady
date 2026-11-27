/**
 * Heading ids the way GitHub makes them, so an anchor such as `rooms.md#remove-a-room` works on github.com and on the
 * docs site alike: lower case, everything but letters, digits, `_`, `-` and spaces dropped, spaces become `-`, and a
 * repeated heading gets `-1`, `-2`, ...
 */
export function slugOf(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** A slugger for one page: remembers the ids it gave out and numbers the repeats. */
export function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugOf(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

/** The plain text of a bit of inline HTML: tags removed, the common entities decoded. */
export function plainText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (_all, name) => ENTITIES[name])
    .trim();
}

/** The heading ids of a Markdown file, as GitHub would give them (ATX headings outside code fences). */
export function headingIdsOf(markdown) {
  const slug = createSlugger();
  const ids = new Set();
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(```|~~~)/.exec(line);
    if (marker !== null) {
      if (fence === null) fence = marker[1];
      else if (marker[1] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const text = heading[1]
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
      .replace(/<[^>]+>/g, '');
    ids.add(slug(text));
  }
  // An explicit <a id="..."> or id="..." in raw HTML is an anchor too.
  for (const match of markdown.matchAll(/\b(?:id|name)="([^"]+)"/g)) ids.add(match[1]);
  return ids;
}
