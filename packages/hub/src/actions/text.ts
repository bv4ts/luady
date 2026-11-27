import type { SessionDTO } from '@luady/shared';

const ELLIPSIS = '…';

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair, then appends `marker`. */
export function clipText(text: string, max: number, marker: string = ELLIPSIS): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}${marker}`;
}

/** Collapses all whitespace, including newlines, into single spaces and clips the result. */
export function oneLine(text: string, max: number): string {
  return clipText(text.replace(/\s+/g, ' ').trim(), max);
}

/** The label: `{host} · {displayName}`. */
export function sessionLabel(session: Pick<SessionDTO, 'host' | 'displayName'>): string {
  return `${session.host} · ${session.displayName}`;
}
