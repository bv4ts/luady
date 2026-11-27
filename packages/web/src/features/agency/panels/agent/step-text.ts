import { visualFor, type BubbleIcon } from '@luady/office';
import type { HelperDTO, SessionDetailDTO, SessionState, StepDTO, ToolKind } from '@luady/shared';
import { formatClock } from '../../hud/Clock.js';

export interface Line {
  readonly icon: BubbleIcon | null;
  readonly text: string;
}

/** The bubble the map shows for a tool kind (book, pencil, terminal, …; dots for the rest). */
export function kindIcon(kind: ToolKind): BubbleIcon {
  return visualFor({ state: 'working', idleMs: 0, silentMs: 0, tool: kind }).bubble ?? 'dots';
}

const STATE_LINES: Readonly<Record<string, Line>> = Object.freeze({
  idle: { icon: null, text: 'Idle' },
  starting: { icon: null, text: 'Starting' },
  waiting_question: { icon: 'bang', text: 'Waiting for your answer' },
  waiting_permission: { icon: 'key', text: 'Waiting for your answer' },
  error: { icon: 'cross', text: 'Stopped with an error' },
  ended: { icon: null, text: 'Ended' },
});

const stepText = (step: StepDTO): string => (step.title.trim() === '' ? step.tool : step.title);

/**
 * What the agent is doing right now, in one line. A pause counts only while the agent works or idles (like the map);
 * until the pause check really stopped it, it may still finish the step it is on.
 */
export function currentLine({ state, detail }: { state: SessionState; detail: SessionDetailDTO | null }): Line {
  const pausable = state === 'working' || state === 'idle';
  if (pausable && detail?.paused === true) {
    if (detail.pauseHit) return { icon: 'pause', text: 'Paused' };
    const running = detail.current === null ? '' : ` ${stepText(detail.current)}`;
    return { icon: 'pause', text: `Pausing after this step…${running}` };
  }
  const current = detail?.current ?? null;
  if (current !== null && state === 'working') return { icon: kindIcon(current.kind), text: stepText(current) };
  if (state === 'working') return { icon: 'dots', text: 'Thinking…' };
  return Object.hasOwn(STATE_LINES, state) ? (STATE_LINES[state] ?? { icon: null, text: state }) : { icon: null, text: state };
}

/** '+12 −3' for changed lines, 'failed' for a failed step, '' for an open one or one with nothing to count. */
export function stepSuffix(step: StepDTO): string {
  if (step.endedAt === null) return '';
  if (step.ok === false) return 'failed';
  const parts = [step.added === null ? null : `+${step.added}`, step.removed === null ? null : `−${step.removed}`];
  return parts.filter((part): part is string => part !== null).join(' ');
}

/** '3:20 PM' in owner time; '' for a time that cannot be read. */
export function clock(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? formatClock(at) : '';
}

/** '2 helpers: Explore, general-purpose'; null while there are none. */
export function helpersLine(helpers: readonly HelperDTO[]): string | null {
  if (helpers.length === 0) return null;
  const count = helpers.length === 1 ? '1 helper' : `${helpers.length} helpers`;
  const names = helpers.flatMap((helper) => (helper.agentType === null || helper.agentType === '' ? [] : [helper.agentType]));
  return names.length === 0 ? count : `${count}: ${names.join(', ')}`;
}
