import { LIMITS } from './limits.js';
import type { PermissionPreview } from './spool.js';

/** What the kit writes where it removed a secret. */
export const REDACTED_MARK = '[redacted]';

/** Why a command offers no Allow; the website, the chat text and the hub's refusal all say this. */
export const HIDDEN_COMMAND_NOTE = 'Part of this command is hidden. Answer it in the terminal, where you can see all of it.';
/** The same for any other request (a file change, an MCP tool). */
export const HIDDEN_REQUEST_NOTE = 'Part of this request is hidden. Answer it in the terminal, where you can see all of it.';

/** Why the chat offers no Allow for a request (any kind) it cannot show in full; the chat text and its refusal say this. */
export const CUT_FOR_CHAT_NOTE = 'This request is too long to show here in full. Answer it on the website or in the terminal, where you can see all of it.';

/** The parts of a permission request that decide which answers it offers. */
export interface PermissionOffer {
  readonly toolName: string;
  readonly inputPreview: string;
  readonly preview?: PermissionPreview | null | undefined;
}

/** Three blank lines in a row, or 200 whitespace characters in a row: what follows is pushed out of the preview box. */
const PADDING_RE = /\s{200,}|(?:^|\n)(?:[^\S\n]*\n){3}/;
/** Invisible format characters: bidirectional overrides, zero-width spaces and joiners, the byte-order mark. */
const FORMAT_CHAR_RE = /\p{Cf}/u;

/** True when a text, shown whole, can still keep part of itself off the screen (the kit's preview.hides_itself). */
export function hidesItself(text: string): boolean {
  return PADDING_RE.test(text) || FORMAT_CHAR_RE.test(text);
}

/** The kit's one-line preview ends with `…` at exactly this many characters when it was cut. */
function oneLineHidden(inputPreview: string): boolean {
  if (inputPreview.includes(REDACTED_MARK)) return true;
  return inputPreview.endsWith('…') && Array.from(inputPreview).length >= LIMITS.permissionInputPreview;
}

/**
 * Whether the owner may allow this request from afar: only when what the owner is shown is the whole request. The kit
 * decides and says so in its preview (`allow`); the hub checks the same on what it got, so a kit that does not say is
 * treated the same way. A request shown redacted or cut (a command, a file change, an MCP tool's input), or a command
 * that hides part of itself on screen, offers only Deny and answering in the terminal: the hidden part could be what
 * it really does.
 */
export function permissionAllowOffered(permission: PermissionOffer): boolean {
  const preview = permission.preview ?? null;
  if (preview === null) return !oneLineHidden(permission.inputPreview) && !hidesItself(permission.inputPreview);
  if (preview.allow === false || preview.truncated) return false;
  if (preview.kind === 'other') return !oneLineHidden(permission.inputPreview) && !hidesItself(permission.inputPreview);
  const shown = [preview.command ?? '', preview.path ?? '', ...preview.edits.flatMap((edit) => [edit.old, edit.new])];
  if (shown.some((text) => text.includes(REDACTED_MARK))) return false;
  return preview.kind !== 'command' || !hidesItself(preview.command ?? '');
}

/** The sentence that says why a request offers no Allow. */
export function hiddenNote(permission: PermissionOffer): string {
  return permission.toolName === 'Bash' || permission.preview?.kind === 'command' ? HIDDEN_COMMAND_NOTE : HIDDEN_REQUEST_NOTE;
}

