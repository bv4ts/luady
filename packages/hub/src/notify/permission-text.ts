import { CUT_FOR_CHAT_NOTE, LIMITS, hiddenNote, permissionAllowOffered, type PermissionOffer, type PermissionPreview } from '@luady/shared';
import { charCount, truncateChars } from './format.js';

const FENCE = '`'.repeat(3);
const REDACTED = '[redacted]';
/** Above this many lines on either side a line-by-line comparison is skipped: every line counts as changed. */
const DIFF_LINES_MAX = 300;
export const HIDDEN_NOTE = '_Part of this is hidden._';
/** In place of HIDDEN_NOTE when the request offers no Allow: the reason (hiddenNote, or the chat's own cut), in italics. */
export function terminalOnlyNote(reason: string): string {
  return `_${reason}_`;
}

export interface LineChange { readonly sign: '-' | '+'; readonly line: string }

const linesOf = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/** The changed lines of one edit, in order (removed before added within each run), from a longest common subsequence. */
export function lineChanges(before: string, after: string): LineChange[] {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > DIFF_LINES_MAX || b.length > DIFF_LINES_MAX) {
    return [...a.map((line) => ({ sign: '-' as const, line })), ...b.map((line) => ({ sign: '+' as const, line }))];
  }
  const keep: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      keep[i]![j] = a[i] === b[j] ? keep[i + 1]![j + 1]! + 1 : Math.max(keep[i + 1]![j]!, keep[i]![j + 1]!);
    }
  }
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j >= b.length || (i < a.length && keep[i + 1]![j]! >= keep[i]![j + 1]!)) {
      changes.push({ sign: '-', line: a[i]! });
      i += 1;
    } else {
      changes.push({ sign: '+', line: b[j]! });
      j += 1;
    }
  }
  return changes;
}

function headline(preview: PermissionPreview): string {
  if (preview.path !== null) return `Wants to use *${preview.tool}* on ${preview.path}`;
  if (preview.cwd !== null) return `Wants to use *${preview.tool}* in ${preview.cwd}`;
  return `Wants to use *${preview.tool}*`;
}

/**
 * What the chat shows of a request: the lines before its fence (a file change's "−N +M lines") and the one text it puts
 * in the fence, before any cut: the command, the changed lines of a file change, or the input (an MCP tool, a request
 * of kit 1). The chat text and the chat's yes both read it (chatCut), so they can never disagree.
 */
function chatParts(inputPreview: string, preview: PermissionPreview | null | undefined): { lead: string[]; text: string | null } {
  if (preview == null) return { lead: [], text: inputPreview };
  if (preview.kind === 'command' && preview.command !== null) return { lead: [], text: preview.command };
  if (preview.kind === 'edit' || preview.kind === 'write') {
    const changes = preview.edits.flatMap((edit) => lineChanges(edit.old, edit.new));
    const removed = changes.filter((change) => change.sign === '-').length;
    const text = changes.map((change) => `${change.sign} ${change.line}`).join('\n');
    return { lead: [`−${removed} +${changes.length - removed} lines`], text: changes.length > 0 ? text : null };
  }
  return { lead: [], text: inputPreview };
}

/** The chat had to cut this request (any kind): its fenced text is longer than LIMITS.chatPermissionPreview characters. */
export function chatCut(offer: PermissionOffer): boolean {
  const { text } = chatParts(offer.inputPreview, offer.preview);
  return text !== null && charCount(text) > LIMITS.chatPermissionPreview;
}

/**
 * Why a chat reply may not allow this request, or null when it may. Part of it hidden (the kit withholds Allow): the
 * hidden-part reason, since the website offers only Deny then too. Allowed but cut by the chat: the owner would allow
 * what they could not read here, so they answer on the website (which shows it whole) or in the terminal.
 */
export function chatNoAllowReason(offer: PermissionOffer): string | null {
  if (!permissionAllowOffered(offer)) return hiddenNote(offer);
  return chatCut(offer) ? CUT_FOR_CHAT_NOTE : null;
}

/** The fenced part, cut to the chat preview limit. */
export function chatFence(text: string): string {
  return `${FENCE}${truncateChars(text, LIMITS.chatPermissionPreview)}${FENCE}`;
}

interface Body { readonly lines: string[]; readonly cut: boolean; readonly redacted: boolean }

function bodyOf(inputPreview: string, preview: PermissionPreview): Body {
  const { lead, text } = chatParts(inputPreview, preview);
  const shown = [preview.command ?? '', inputPreview, ...preview.edits.flatMap((edit) => [edit.old, edit.new])];
  const redacted = (preview.kind === 'other' ? [inputPreview] : shown).some((part) => part.includes(REDACTED));
  return {
    lines: [...lead, ...(text === null ? [] : [chatFence(text)])],
    cut: chatCut({ toolName: preview.tool, inputPreview, preview }), redacted,
  };
}

/**
 * The lines between the header and the reply hint for a request with a structured preview (kit 2): tool and file
 * first, then the command, or "−N +M lines" and the first changed lines; and a note when anything is hidden (the
 * reason in full, `noAllowReason`, when Allow is not offered).
 */
export function permissionBody(inputPreview: string, preview: PermissionPreview, noAllowReason: string | null = null): string[] {
  const body = bodyOf(inputPreview, preview);
  const hidden = preview.truncated || body.cut || body.redacted;
  const note = noAllowReason !== null ? [terminalOnlyNote(noAllowReason)] : hidden ? [HIDDEN_NOTE] : [];
  return [headline(preview), ...body.lines, ...note];
}
