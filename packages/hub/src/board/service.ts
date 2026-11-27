import { LIMITS, type BoardItemDTO, type BoardSource, managerName } from '@luady/shared';
import type { BoardActor, BoardAddInput, Clock, EventBus, Logger } from '../core/contracts.js';
import { NotFoundError, ValidationError } from '../core/errors.js';
import { cleanDetails, cleanProject, cleanTitle, logText, planChange, type CardPatch, type LogLine } from './machine.js';
import { effectiveState, toCardDto, type CardRow, type CardStore } from './store.js';

const SOURCE_TEXT: Readonly<Record<BoardSource, string>> = {
  web: 'Added on the website.', chat: 'Added in your chat.', manager: `Added by ${managerName()}.`, meeting: 'Added from a meeting.',
  jira: 'Added from Jira.', note: 'Added from a note.', session: 'Added from a session.',
};

/** The pinned "today" chat list (todos/service.ts) follows every card that is or was on it. */
export interface TodayList {
  refreshToday(create: boolean): Promise<void>;
}

export interface BoardCoreDeps {
  store: CardStore;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  today: TodayList;
}

export interface CardChange {
  readonly id: number;
  readonly patch: CardPatch;
}

/** Card writes in one place: every change is planned (machine.ts), logged, broadcast and mirrored on today's list. */
export interface BoardCore {
  dto(id: number): BoardItemDTO | null;
  row(id: number): CardRow;
  add(input: BoardAddInput, by: BoardActor, opts?: { auto?: boolean }): Promise<BoardItemDTO>;
  /** Changes several cards and broadcasts them as one `board.updated`; unknown ids throw before anything changes. */
  changeMany(changes: readonly CardChange[], by: BoardActor): Promise<BoardItemDTO[]>;
  change(id: number, patch: CardPatch, by: BoardActor): Promise<BoardItemDTO>;
  remove(ids: readonly number[]): Promise<void>;
}

function cleanSourceRef(ref: string | null | undefined): string | null {
  if (ref === undefined || ref === null || ref.trim() === '') return null;
  if (ref.length > LIMITS.boardSourceRefMax) throw new ValidationError(`A source reference is at most ${LIMITS.boardSourceRefMax} characters`);
  return ref.trim();
}

export function createBoardCore(deps: BoardCoreDeps): BoardCore {
  const { store } = deps;
  const nowIso = (): string => deps.clock.now().toISOString();

  function row(id: number): CardRow {
    const found = store.get(id);
    if (found === undefined) throw new NotFoundError(`No card #${id}`);
    return found;
  }

  async function mirrorToday(before: readonly CardRow[], after: readonly CardRow[]): Promise<void> {
    const was = new Set(before.filter((card) => card.today === 1).map((card) => card.id));
    const now = after.filter((card) => card.today === 1);
    const joined = now.some((card) => !was.has(card.id));
    if (was.size === 0 && now.length === 0) return;
    try {
      await deps.today.refreshToday(joined);
    } catch (err) {
      deps.log.warn({ err }, 'board: today list not refreshed');
    }
  }

  function broadcast(rows: readonly CardRow[]): BoardItemDTO[] {
    const items = rows.map((row) => toCardDto(row, deps.log));
    if (items.length > 0) deps.bus.emit('board.updated', { items });
    return items;
  }

  async function add(input: BoardAddInput, by: BoardActor, opts: { auto?: boolean } = {}): Promise<BoardItemDTO> {
    const at = nowIso();
    const linked = input.sessionId !== undefined && input.sessionId !== null;
    const id = store.insert({
      text: cleanTitle(input.title),
      details: cleanDetails(input.details ?? ''),
      project: cleanProject(input.project),
      server: input.server ?? null,
      source: input.source,
      sourceRef: cleanSourceRef(input.sourceRef),
      today: input.today === true,
      priority: input.priority === 1 ? 1 : 0,
      auto: opts.auto === true,
      state: linked ? 'running' : 'open',
      sessionId: linked ? input.sessionId ?? null : null,
      createdAt: at,
    });
    const lines: LogLine[] = [{ kind: 'created', text: by === 'hub' && opts.auto === true ? 'Added for a mission.' : SOURCE_TEXT[input.source] }];
    if (linked) lines.push({ kind: 'started', text: logText('A session works on it.') });
    store.log(id, lines, at);
    const created = row(id);
    const [item] = broadcast([created]);
    await mirrorToday([], [created]);
    if (item === undefined) throw new Error('card was not saved');
    return item;
  }

  async function changeMany(changes: readonly CardChange[], by: BoardActor): Promise<BoardItemDTO[]> {
    const at = nowIso();
    const before = changes.map((change) => row(change.id));
    // Plan every change before writing any, so one refused lane change leaves all cards as they were.
    const plans = changes.map((change, index) => planChange({ ...before[index]!, state: effectiveState(before[index]!) }, change.patch, by, at));
    const changed: CardRow[] = [];
    const beforeChanged: CardRow[] = [];
    changes.forEach((change, index) => {
      const plan = plans[index];
      if (plan === null || plan === undefined) return;
      store.write(change.id, plan.columns);
      store.log(change.id, plan.logs, at);
      changed.push(row(change.id));
      beforeChanged.push(before[index]!);
    });
    const items = broadcast(changed);
    await mirrorToday(beforeChanged, changed);
    return changes.map((change) => items.find((item) => item.id === change.id) ?? toCardDto(row(change.id), deps.log));
  }

  async function remove(ids: readonly number[]): Promise<void> {
    const rows = ids.map(row);
    for (const card of rows) store.remove(card.id);
    if (rows.length > 0) deps.bus.emit('board.removed', { ids: rows.map((card) => card.id) });
    await mirrorToday(rows, []);
  }

  return {
    dto(id) {
      const found = store.get(id);
      return found === undefined ? null : toCardDto(found, deps.log);
    },
    row,
    add,
    changeMany,
    async change(id, patch, by) {
      const [item] = await changeMany([{ id, patch }], by);
      if (item === undefined) throw new NotFoundError(`No card #${id}`);
      return item;
    },
    remove,
  };
}
