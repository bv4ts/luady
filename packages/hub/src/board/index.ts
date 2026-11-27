import { LIMITS, type BoardItemDTO } from '@luady/shared';
import type {
  BoardFilter, BoardService, Clock, Db, EventBus, JiraService, LuadyService, Logger, NotesService, OutboundChannel, ProjectsService,
  SessionService,
} from '../core/contracts.js';
import { NotFoundError } from '../core/errors.js';
import { createBoardAutomation, type BoardMissions } from './automation.js';
import { delegate } from './delegate.js';
import { createBoardReminders } from './reminders.js';
import { boardItemsParagraph } from './reports.js';
import { renderLane } from './render.js';
import { createBoardCore, type TodayList } from './service.js';
import { createCardStore, toCardDto, type CardRow } from './store.js';

export { STOPPED_TEXT, NOT_PICKED_TEXT, QUEUED_TIMEOUT_MS } from './automation.js';
export type { BoardMissions } from './automation.js';

/** Everything the board needs (wired in app.ts). */
export interface BoardDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  sessions: Pick<SessionService, 'get' | 'findByRef'>;
  missions: BoardMissions;
  /** Delegation events for Luady, and whether he can take them now. */
  luady: Pick<LuadyService, 'postEvent' | 'postOwnerRequest' | 'status' | 'signedOut'>;
  projects: Pick<ProjectsService, 'list'>;
  /** The pinned "today" list on the chat (todos/service.ts) on the same `todos` table. */
  todos: TodayList;
  /** Tickets sent to work become cards (answers jira_not_connected without a connection). */
  jira: Pick<JiraService, 'issue'>;
  /** Notes sent to work become cards. */
  notes: Pick<NotesService, 'get'>;
  /**
   * "Back on your board" and "Due now" notices, routed like every hub notice (website first, the chat after
   * 10 minutes or when the website is closed). Optional so existing tests need no change.
   */
  reminders?: OutboundChannel;
}

const DAY_MS = 24 * 60 * 60_000;

/** The owner's board on the `todos` table: cards, their log, Run and Give to…, and the hub's own bookkeeping. */
export function createBoardService(deps: BoardDeps): BoardService & { tick(): Promise<void>; checkReminders(): Promise<void> } {
  const store = createCardStore(deps.db);
  const dto = (row: CardRow): BoardItemDTO => toCardDto(row, deps.log);
  const core = createBoardCore({ store, bus: deps.bus, clock: deps.clock, log: deps.log, today: deps.todos });
  const automation = createBoardAutomation({ ...deps, core, store });
  const reminders = createBoardReminders({ db: deps.db, core, clock: deps.clock, log: deps.log, reminders: deps.reminders });
  const doneSince = (): string => new Date(deps.clock.now().getTime() - LIMITS.boardDoneDays * DAY_MS).toISOString();
  const sessionName = (id: string): string | null => {
    const session = deps.sessions.get(id);
    return session === undefined ? null : `${session.host}/${session.displayName}`;
  };

  function find(filter: BoardFilter): BoardItemDTO[] {
    switch (filter) {
      case 'open':
        return store.inState(['open']).map(dto);
      case 'running':
        return store.inState(['queued', 'running']).map(dto);
      case 'review':
        return store.inState(['review']).map(dto);
      case 'done':
        return store.doneSince(doneSince()).map(dto);
      case 'all':
        return store.board(doneSince()).map(dto);
    }
  }

  async function link(sessionId: string, ids: readonly number[]): Promise<void> {
    const unique = [...new Set(ids)];
    for (const id of unique) core.row(id);
    // The mission's automatic card is replaced by these cards, so it is removed below.
    const stand = store.ofSession(sessionId, ['running']).filter((card) => card.auto === 1 && !unique.includes(card.id));
    await core.changeMany(unique.map((id) => ({ id, patch: { state: 'running', sessionId, note: `Linked to ${sessionName(sessionId) ?? sessionId}.` } })), 'hub');
    if (stand.length > 0) await core.remove(stand.map((card) => card.id));
  }

  return {
    list: () => store.board(doneSince()).map(dto),
    find,
    get: (id) => core.dto(id),
    detail(id) {
      const item = core.dto(id);
      if (item === null) return null;
      return { item, events: store.events(id), mission: item.sessionId === null ? null : deps.missions.view(item.sessionId) };
    },
    add: (input, by) => core.add(input, by),
    update: (id, patch, by) => core.change(id, patch, by),
    async remove(id) {
      await core.remove([id]);
    },
    delegate: (body, opts) => delegate(body, { ...deps, core, store }, opts),
    briefFor(ids) {
      for (const id of ids) if (store.get(id) === undefined) throw new NotFoundError(`No card #${id}`);
      return boardItemsParagraph([...new Set(ids)]);
    },
    link,
    render: (filter) => renderLane(filter, find(filter), sessionName, deps.clock.now()),
    missions: () => deps.missions.views(),
    start() {
      const fixed = store.reconcile();
      if (fixed > 0) deps.log.info({ fixed }, 'board: cards changed by an older release brought in step');
      automation.start();
      reminders.start();
    },
    stop() {
      automation.stop();
      reminders.stop();
    },
    tick: () => automation.tick(),
    checkReminders: () => reminders.check(),
  };
}
