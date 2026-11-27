/**
 * Mail text as `email_read` hands it on. A stranger writes the mail, so only the first MAIL_SCAN_MAX characters are
 * read, and every pattern here is linear: none can be made to backtrack over a long run of `<` or of spaces.
 */
export const MAIL_SCAN_MAX = 512 * 1024;

/** An opening or closing style or script tag; `[^<>]*` stops at the next `<`, so a failed try costs one short run. */
const BLOCK_TAG_RE = /<(\/?)(style|script)\b[^<>]*>/gi;
const TAG_RE = /<[^<>]*>/g;

/** Drops every style and script block; one that is never closed runs to the end. */
function dropBlocks(html: string): string {
  let kept = '';
  let from = 0;
  let open: string | null = null;
  for (const match of html.matchAll(BLOCK_TAG_RE)) {
    const name = (match[2] ?? '').toLowerCase();
    const closing = match[1] === '/';
    if (open === null && !closing) {
      kept += html.slice(from, match.index);
      open = name;
    } else if (open === name && closing) {
      from = match.index + match[0].length;
      open = null;
    }
  }
  return open === null ? kept + html.slice(from) : kept;
}

/** An HTML-only mail as plain text: style and script blocks dropped, every tag replaced by a space. */
export function htmlToText(html: string): string {
  return dropBlocks(html.slice(0, MAIL_SCAN_MAX)).replace(TAG_RE, ' ');
}

/** Trailing whitespace off every line, the lines left empty dropped, the whole trimmed. */
export function tidyMailBody(text: string): string {
  return text
    .slice(0, MAIL_SCAN_MAX)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
}
