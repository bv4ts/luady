/**
 * Luady's "nothing for the owner" reply to a background turn (an Event or a reminder). The hub keeps it in the thread
 * and sends it nowhere (hub luady/replies.ts uses the same rule); the website never shows it as an answer either.
 */
const NO_UPDATE_RE = /^\s*\**NO_UPDATE\**\s*\.?\s*$/;

export function isNoUpdate(text: string): boolean {
  return NO_UPDATE_RE.test(text);
}
