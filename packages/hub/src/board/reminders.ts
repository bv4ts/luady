import { ownerFormat } from '@luady/shared';
import type { Clock, Db, Logger, OutboundChannel } from '../core/contracts.js';
import { clock12 } from '../core/time.js';
import type { BoardCore } from './service.js';
import { logText } from './machine.js';
import { oneLine } from './text.js';

/** Snooze and due dates: the board looks once a minute. */
export const REMINDER_TICK_MS = 60_000;
export const BACK_TEXT = 'Back from snooze.';

interface TimedRow { id: number; text: string; done: number; due_at: string | null; snooze_until: string | null }

export interface ReminderDeps {
  db: Db;
  core: BoardCore;
  clock: Clock;
  log: Logger;
  /** A hub notice of kind `system`: website first, the chat after 10 minutes or when the website is closed. */
  reminders?: OutboundChannel;
}

export interface BoardReminders {
  /** One look: snoozes that ended, due times that passed. Exposed for tests. */
  check(): Promise<void>;
  start(): void;
  stop(): void;
}

const DAY_FORMAT = ownerFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** The log line that marks "the due notice for this due time went out": the owner reads it, and it makes the notice once only. */
export function dueMark(dueAt: string): string {
  const at = new Date(dueAt);
  return `Due ${DAY_FORMAT.format(at)}, ${clock12(at)}: reminder sent.`;
}

const passed = (value: string | null, now: number): boolean => {
  if (value === null) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now;
};

/** "Back on your board: …" when a snooze ends, "Due now: …" once per card and due time. */
export function createBoardReminders(deps: ReminderDeps): BoardReminders {
  const timed = deps.db.prepare<[], TimedRow>(
    'SELECT id, text, done, due_at, snooze_until FROM todos WHERE snooze_until IS NOT NULL OR (due_at IS NOT NULL AND done = 0)',
  );
  const marked = deps.db.prepare<[number, string], { n: number }>(
    "SELECT COUNT(*) AS n FROM todo_events WHERE todo_id = ? AND kind = 'note' AND text = ?",
  );
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;

  async function tell(text: string): Promise<void> {
    if (deps.reminders === undefined) return;
    try {
      await deps.reminders.send(text, null);
    } catch (err) {
      deps.log.warn({ err }, 'board: reminder notice not sent');
    }
  }

  async function wake(row: TimedRow): Promise<void> {
    await deps.core.change(row.id, { snoozeUntil: null, note: BACK_TEXT }, 'hub');
    if (row.done === 0) await tell(`Back on your board: ${oneLine(row.text)}`);
  }

  async function due(row: TimedRow, dueAt: string): Promise<void> {
    const mark = logText(dueMark(dueAt));
    if ((marked.get(row.id, mark)?.n ?? 0) > 0) return;
    // The mark is written first: a notice that fails is not repeated every minute.
    await deps.core.change(row.id, { note: mark }, 'hub');
    await tell(`Due now: ${oneLine(row.text)}`);
  }

  async function pass(): Promise<void> {
    const now = deps.clock.now().getTime();
    for (const row of timed.all()) {
      try {
        if (passed(row.snooze_until, now)) await wake(row);
        if (row.done === 0 && row.due_at !== null && passed(row.due_at, now)) await due(row, row.due_at);
      } catch (err) {
        deps.log.warn({ err, card: row.id }, 'board: reminder check failed for a card');
      }
    }
  }

  function check(): Promise<void> {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    check,
    start() {
      timer ??= setInterval(() => {
        check().catch((err: unknown) => deps.log.error({ err }, 'board: reminder check failed'));
      }, REMINDER_TICK_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
