import { LIMITS, type BoardEventKind, type BoardState, managerName } from '@luady/shared';
import type { BoardActor, BoardPatch } from '../core/contracts.js';
import { RefusedError, ValidationError } from '../core/errors.js';
import type { CardRow } from './store.js';
import { clipUnits, oneLine } from './text.js';

/**
 * A card's life: open → queued (Run) → running (a session has it) → done; review = needs the owner.
 * A done card can only be reopened or sent to work again; it never goes to review.
 */
export const NEXT_STATES: Readonly<Record<BoardState, readonly BoardState[]>> = {
  open: ['queued', 'running', 'review', 'done'],
  queued: ['open', 'running', 'review', 'done'],
  running: ['open', 'queued', 'review', 'done'],
  review: ['open', 'queued', 'running', 'done'],
  done: ['open', 'queued', 'running'],
};

/** The log line each lane change writes. */
export const ENTER_KIND: Readonly<Record<BoardState, BoardEventKind>> = {
  open: 'reopened',
  queued: 'queued',
  running: 'started',
  review: 'blocked',
  done: 'done',
};

const DEFAULT_TEXT: Readonly<Record<BoardState, string>> = {
  open: 'Back to To do.',
  queued: 'Sent to work.',
  running: 'A session took it.',
  review: 'Needs the owner.',
  done: 'Done.',
};

const BY: Readonly<Record<BoardActor, string>> = { owner: 'the owner', manager: managerName(), hub: 'the hub' };

/** What the hub itself may also change: the run a card belongs to and whether it is a mission's automatic card. */
export interface CardPatch extends BoardPatch {
  readonly runId?: string | null;
  readonly auto?: boolean;
  /** A note without a lane change is logged as `note`, or as `report` when a session sent it (`#12 progress: …`). */
  readonly noteKind?: 'note' | 'report';
}

/** Columns of `todos` a change may write. */
export type CardColumns = Partial<Pick<CardRow,
  'text' | 'details' | 'project' | 'server' | 'today' | 'priority' | 'state' | 'done' | 'done_at' | 'result' | 'session_id'
  | 'run_id' | 'auto' | 'due_at' | 'snooze_until' | 'updated_at'>>;

export interface LogLine { readonly kind: BoardEventKind; readonly text: string }

export interface ChangePlan {
  readonly columns: CardColumns;
  readonly logs: readonly LogLine[];
}

export function cleanTitle(title: string): string {
  const clean = oneLine(title);
  if (clean === '' || clean.length > LIMITS.boardTitleMax) {
    throw new ValidationError(`A card title needs 1-${LIMITS.boardTitleMax} characters`);
  }
  return clean;
}

export function cleanDetails(details: string): string {
  if (details.length > LIMITS.boardDetailsMax) throw new ValidationError(`Card details are at most ${LIMITS.boardDetailsMax} characters`);
  return details.trim();
}

export function cleanProject(project: string | null | undefined): string | null {
  if (project === undefined || project === null) return null;
  const clean = project.trim();
  if (clean.length > LIMITS.boardProjectMax) throw new ValidationError(`A project name is at most ${LIMITS.boardProjectMax} characters`);
  return clean === '' ? null : clean;
}

export const logText = (text: string): string => clipUnits(text.trim(), LIMITS.boardEventTextMax);

/** Which edit fields differ, for one "edited" log line. */
function edits(row: CardRow, patch: CardPatch, by: BoardActor): { columns: CardColumns; names: string[] } {
  const columns: { -readonly [K in keyof CardColumns]: CardColumns[K] } = {};
  const names: string[] = [];
  const set = <K extends keyof CardColumns>(key: K, value: CardColumns[K], name: string | null): void => {
    if (row[key] === value) return;
    columns[key] = value;
    if (name !== null) names.push(name);
  };
  if (patch.title !== undefined) {
    set('text', cleanTitle(patch.title), 'title');
    // Someone named the card: a mission's new title no longer renames it.
    if (columns.text !== undefined && by !== 'hub') columns.auto = 0;
  }
  if (patch.details !== undefined) set('details', cleanDetails(patch.details), 'details');
  if (patch.project !== undefined) set('project', cleanProject(patch.project), 'project');
  if (patch.server !== undefined) set('server', patch.server, 'office');
  if (patch.today !== undefined) set('today', patch.today ? 1 : 0, 'today');
  if (patch.priority !== undefined) set('priority', patch.priority, 'priority');
  if (patch.dueAt !== undefined) set('due_at', patch.dueAt, 'due date');
  if (patch.snoozeUntil !== undefined) set('snooze_until', patch.snoozeUntil, 'snooze');
  if (patch.result !== undefined) set('result', patch.result === null ? null : clipUnits(oneLine(patch.result), LIMITS.boardResultMax), null);
  if (patch.sessionId !== undefined) set('session_id', patch.sessionId, null);
  if (patch.runId !== undefined) set('run_id', patch.runId, null);
  if (patch.auto !== undefined) set('auto', patch.auto ? 1 : 0, null);
  return { columns, names };
}

/** The columns a lane change writes: `done`/`done_at` follow `state` so a rolled-back release reads the same list. */
function laneColumns(next: BoardState, nowIso: string, patch: CardPatch): CardColumns {
  const unlinks = (next === 'open' || next === 'queued') && patch.sessionId === undefined;
  return {
    state: next,
    done: next === 'done' ? 1 : 0,
    done_at: next === 'done' ? nowIso : null,
    ...(unlinks ? { session_id: null } : {}),
  };
}

/**
 * Pure: what one change does to a card (columns and log lines), or null when nothing changes.
 * Throws RefusedError for a lane change the life of a card does not allow.
 */
export function planChange(row: CardRow, patch: CardPatch, by: BoardActor, nowIso: string): ChangePlan | null {
  const { columns, names } = edits(row, patch, by);
  const logs: LogLine[] = [];
  if (names.length > 0) logs.push({ kind: 'edited', text: logText(`${capitalise(names.join(', '))} changed by ${BY[by]}.`) });
  let lane: CardColumns = {};
  if (patch.state !== undefined && patch.state !== row.state) {
    if (!NEXT_STATES[row.state].includes(patch.state)) {
      throw new RefusedError(`Card #${row.id} is ${row.state}; it cannot go to ${patch.state}.`);
    }
    lane = laneColumns(patch.state, nowIso, patch);
    const said = patch.note ?? (patch.state === 'done' ? patch.result ?? undefined : undefined);
    logs.push({ kind: ENTER_KIND[patch.state], text: logText(said ?? DEFAULT_TEXT[patch.state]) });
  } else if (patch.note !== undefined && patch.note.trim() !== '') {
    logs.push({ kind: patch.noteKind ?? 'note', text: logText(patch.note) });
  }
  const all: CardColumns = { ...columns, ...lane };
  if (Object.keys(all).length === 0 && logs.length === 0) return null;
  return { columns: { ...all, updated_at: nowIso }, logs };
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
