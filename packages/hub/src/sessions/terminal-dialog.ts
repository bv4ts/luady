import type { HostId, SpoolEvent } from '@luady/shared';
import { sessionIdForEvent } from './naming.js';

/**
 * Sessions whose question or permission request went back to the terminal: answered there ("Answer in terminal"),
 * timed out, or refused by the kit. Claude Code's own dialog is then on that screen, and text typed into the pane now
 * (a `send`, the line a resume types) would answer it: Enter picks the highlighted choice, digits pick options.
 *
 * A session leaves the set at its next event that shows the dialog is gone: a new prompt, the end of the turn (stop or
 * a failure), a new question or permission request (the hook only fires once Claude Code moved on), a mid-turn report,
 * or a new or ended Claude session. A notification does not count: Claude Code sends one while its dialog waits.
 * Kept in memory: after a hub restart sends are allowed again until the next hand-back.
 */
export interface TerminalDialogs {
  apply(host: HostId, event: SpoolEvent): void;
  isOpen(sessionId: string): boolean;
}

/** The outcomes after which the hook printed nothing, so the terminal dialog decides. */
const BACK_TO_TERMINAL: ReadonlySet<string> = new Set(['released', 'timeout', 'error']);
const DIALOG_GONE: ReadonlySet<SpoolEvent['event']> = new Set([
  'prompt', 'stop', 'stop_failure', 'question', 'permission', 'report', 'session_start', 'session_end',
]);

export function createTerminalDialogs(): TerminalDialogs {
  let open: ReadonlySet<string> = new Set();
  return {
    apply(host, event) {
      const id = sessionIdForEvent(host, event);
      if (id === null) return;
      if ((event.event === 'question_resolved' || event.event === 'permission_resolved') && BACK_TO_TERMINAL.has(event.data.outcome)) {
        open = new Set([...open, id]);
      } else if (DIALOG_GONE.has(event.event) && open.has(id)) {
        open = new Set([...open].filter((other) => other !== id));
      }
    },
    isOpen: (sessionId) => open.has(sessionId),
  };
}

/** Why a send or a resume is refused while the session's own dialog waits in its terminal. */
export function dialogOpenText(label: string): string {
  return `${label} has a question waiting in its terminal. Answer it there first: a message sent now would be typed into that dialog.`;
}
