/**
 * Text a server printed, made safe to show as text (remote output is hostile). Dropped: the C0 and C1
 * control characters and DEL, the bidirectional embeddings, overrides, isolates and marks (which can make a line read
 * differently from what it holds), and the line and paragraph separators U+2028 and U+2029. Then trimmed and clipped.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/gu;

export function cleanText(text: string, max: number): string {
  const flat = text.replace(UNSAFE, '').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Remote text for the manager's prompt or memory: every run of whitespace (newlines included) becomes one space, then
 * cleanText. On one line, it can never start a line of its own, so it cannot pass for the hub's or the owner's words.
 */
export function flatText(text: string, max: number): string {
  return cleanText(text.replace(/\s+/g, ' '), max);
}
