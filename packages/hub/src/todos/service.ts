import type { Clock, Db, Logger, OutboundChannel } from '../core/contracts.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { ownerFormat } from '@luady/shared';
import { clock12 } from '../core/time.js';

const PINNED_DAY = ownerFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

/** The shortest chat pin (24 h); the "today" board lives exactly this long. */
export const BOARD_PIN_SECONDS = 86_400;
/** The owner asked for a reminder 4 hours before the board unpins. */
export const REMINDER_BEFORE_MS = 4 * 60 * 60_000;
const BOARD_LIFE_MS = BOARD_PIN_SECONDS * 1000;
const EDIT_WINDOW_MS = 14 * 60_000;
export const TODO_TICK_MS = 60_000;
const TEXT_MAX = 300;

export interface Todo { id: number; text: string; today: boolean; done: boolean; createdAt: string }

export interface TodoService {
  add(text: string, today: boolean): Promise<Todo>;
  list(): Todo[];
  done(id: number): Promise<Todo>;
  remove(id: number): Promise<void>;
  /** Text for /todo and the brain: open items, today's first. */
  render(): string;
  /**
   * The board (board/) changed a card that is or was on today's list: edit the pinned message. `create` also starts a
   * pinned list when none is live (a card just joined today).
   */
  refreshToday(create: boolean): Promise<void>;
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

interface TodoRow { id: number; text: string; today: number; done: number; created_at: string }
interface BoardRow { id: number; chat_msg_id: string | null; sent_at: string | null; pinned_at: string; reminded: number; closed: number }

export interface TodoDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  outbound: OutboundChannel;
  /** Today's list unpinned and these cards lost their today flag (the board tells the website: board.updated). */
  onTodayCleared?: (ids: readonly number[]) => void;
}

/**
 * Cards share this table. The chat shows the owner's own to-dos, so a mission's
 * automatic card stays off the list, and a snoozed card hides until its time.
 */
const LISTED = "auto = 0 AND (snooze_until IS NULL OR snooze_until <= @now)";

const toTodo = (row: TodoRow): Todo => ({ id: row.id, text: row.text, today: row.today === 1, done: row.done === 1, createdAt: row.created_at });

/**
 * A voice/text to-do list. "Today" items live on one chat message pinned for 24 h and edited as items change;
 * 4 h before it unpins, the owner gets a reminder with whatever is still open.
 */
export function createTodoService(deps: TodoDeps): TodoService {
  const db = deps.db;
  const insertRow = db.prepare<[string, number, string, string]>(
    // `source` is always written: an upgraded database keeps the column default of its first release.
    "INSERT INTO todos (text, today, done, created_at, updated_at, state, source) VALUES (?, ?, 0, ?, ?, 'open', 'manager')",
  );
  const insert = { run: (text: string, today: number, at: string) => insertRow.run(text, today, at, at) };
  const byId = db.prepare<[number], TodoRow>('SELECT id, text, today, done, created_at FROM todos WHERE id = ?');
  const openStmt = db.prepare<{ now: string }, TodoRow>(
    `SELECT id, text, today, done, created_at FROM todos WHERE done = 0 AND ${LISTED} ORDER BY today DESC, id`,
  );
  const todayStmt = db.prepare<{ since: string; now: string }, TodoRow>(
    `SELECT id, text, today, done, created_at FROM todos WHERE today = 1 AND (done = 0 OR done_at >= @since) AND ${LISTED} ORDER BY id`,
  );
  // `state` follows `done` (board/), so the board and this list agree on what is done.
  const markDoneRow = db.prepare<[string, string, number]>("UPDATE todos SET done = 1, done_at = ?, state = 'done', updated_at = ? WHERE id = ?");
  const markDone = { run: (at: string, id: number) => markDoneRow.run(at, at, id) };
  const delRow = db.prepare<[number]>('DELETE FROM todos WHERE id = ?');
  const delLog = db.prepare<[number]>('DELETE FROM todo_events WHERE todo_id = ?');
  const del = { run: (id: number) => db.transaction(() => { delLog.run(id); delRow.run(id); })() };
  const todayIds = db.prepare<[], { id: number }>('SELECT id FROM todos WHERE today = 1 ORDER BY id');
  const clearTodayRows = db.prepare<[string]>('UPDATE todos SET today = 0, updated_at = ? WHERE today = 1');
  const clearToday = (): number[] => db.transaction(() => {
    const ids = todayIds.all().map((row) => row.id);
    clearTodayRows.run(now().toISOString());
    return ids;
  })();
  const liveBoard = db.prepare<[], BoardRow>('SELECT * FROM todo_boards WHERE closed = 0 ORDER BY id DESC LIMIT 1');
  const newBoard = db.prepare<[string]>('INSERT INTO todo_boards (pinned_at, reminded, closed) VALUES (?, 0, 0)');
  const setBoardMsg = db.prepare<[string, string, number]>('UPDATE todo_boards SET chat_msg_id = ?, sent_at = ? WHERE id = ?');
  const setReminded = db.prepare<[number]>('UPDATE todo_boards SET reminded = 1 WHERE id = ?');
  const closeBoard = db.prepare<[number]>('UPDATE todo_boards SET closed = 1 WHERE id = ?');
  let timer: ReturnType<typeof setInterval> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const now = (): Date => deps.clock.now();
  const openRows = { all: (): TodoRow[] => openStmt.all({ now: now().toISOString() }) };
  const todayRows = { all: (since: string): TodoRow[] => todayStmt.all({ since, now: now().toISOString() }) };

  function boardText(board: BoardRow): string {
    const items = todayRows.all(board.pinned_at).map((row) => (row.done === 1 ? `✅ ~${row.text}~` : `☐ ${row.id}. ${row.text}`));
    const day = PINNED_DAY.format(new Date(board.pinned_at));
    return [`📝 *Today · ${day}*`, ...(items.length > 0 ? items : ['Nothing left 🎉']), `_Updated ${clock12(now())}_`].join('\n');
  }

  /** Edit the pinned board while the chat allows it, otherwise replace it (new pin, old one unpinned and deleted). */
  async function pushBoard(board: BoardRow): Promise<void> {
    const text = boardText(board);
    const fresh = board.chat_msg_id !== null && board.sent_at !== null && now().getTime() - Date.parse(board.sent_at) < EDIT_WINDOW_MS;
    if (fresh && board.chat_msg_id !== null && deps.outbound.edit !== undefined && (await deps.outbound.edit(board.chat_msg_id, text))) return;
    const msgId = await deps.outbound.send(text, null);
    if (msgId === null) return;
    setBoardMsg.run(msgId, now().toISOString(), board.id);
    deps.outbound.pin?.(msgId, true, BOARD_PIN_SECONDS);
    if (board.chat_msg_id !== null) {
      deps.outbound.pin?.(board.chat_msg_id, false);
      deps.outbound.revoke?.(board.chat_msg_id);
    }
  }

  function refreshBoard(): Promise<void> {
    chain = chain.then(async () => {
      let board = liveBoard.get();
      if (board === undefined) {
        newBoard.run(now().toISOString());
        board = liveBoard.get();
      }
      if (board !== undefined) await pushBoard(board);
    }).catch((err: unknown) => deps.log.warn({ err }, 'todos: board update failed'));
    return chain;
  }

  async function tick(): Promise<void> {
    const board = liveBoard.get();
    if (board === undefined) return;
    const age = now().getTime() - Date.parse(board.pinned_at);
    if (board.reminded === 0 && age >= BOARD_LIFE_MS - REMINDER_BEFORE_MS) {
      setReminded.run(board.id);
      const open = todayRows.all(board.pinned_at).filter((row) => row.done === 0);
      if (open.length > 0) {
        const lines = open.map((row) => `☐ ${row.id}. ${row.text}`);
        await deps.outbound.send([`⏰ *4 hours left* on today's list:`, ...lines].join('\n'), null);
      }
    }
    if (age >= BOARD_LIFE_MS) {
      closeBoard.run(board.id);
      const cleared = clearToday();
      if (board.chat_msg_id !== null) deps.outbound.pin?.(board.chat_msg_id, false);
      if (cleared.length > 0) deps.onTodayCleared?.(cleared);
    }
  }

  return {
    async add(text, today) {
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean === '' || clean.length > TEXT_MAX) throw new ValidationError(`A to-do needs 1-${TEXT_MAX} characters`);
      const result = insert.run(clean, today ? 1 : 0, now().toISOString());
      const todo = byId.get(Number(result.lastInsertRowid));
      if (todo === undefined) throw new Error('to-do was not saved');
      if (today) await refreshBoard();
      return toTodo(todo);
    },
    list: () => openRows.all().map(toTodo),
    async done(id) {
      const row = byId.get(id);
      if (row === undefined) throw new NotFoundError(`No to-do #${id}`);
      markDone.run(now().toISOString(), id);
      if (row.today === 1 && liveBoard.get() !== undefined) await refreshBoard();
      return { ...toTodo(row), done: true };
    },
    async remove(id) {
      const row = byId.get(id);
      if (row === undefined) throw new NotFoundError(`No to-do #${id}`);
      del.run(id);
      if (row.today === 1 && liveBoard.get() !== undefined) await refreshBoard();
    },
    async refreshToday(create) {
      if (create || liveBoard.get() !== undefined) await refreshBoard();
    },
    render() {
      const rows = openRows.all();
      if (rows.length === 0) return 'Your to-do list is empty.';
      return ['📝 *To-do*', ...rows.map((row) => `☐ ${row.id}. ${row.text}${row.today === 1 ? ' _(today)_' : ''}`)].join('\n');
    },
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        tick().catch((err: unknown) => deps.log.warn({ err }, 'todos: tick failed'));
      }, TODO_TICK_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
