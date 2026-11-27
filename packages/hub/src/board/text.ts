/** Text helpers for card, note and speech fields that end up in DTOs (zod counts UTF-16 code units). */

export const ELLIPSIS = '…';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** At most `max` UTF-16 units, `…` included when cut, never splitting a surrogate pair. */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 1) return '';
  let end = max - 1;
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** Like clipUnits, and says whether it cut. */
export function cutUnits(text: string, max: number): { text: string; truncated: boolean } {
  const clipped = clipUnits(text, max);
  return { text: clipped, truncated: clipped !== text };
}

/** Runs of whitespace (newlines included) become one space. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
