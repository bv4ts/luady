import { LIMITS, type NoticeDTO, type NoticeFile, type NoticeKind, type NoticeRef, type PresenceDTO } from '@luady/shared';
import type { Clock, Db, EventBus, Logger, OutboundChannel, SettingsService } from '../core/contracts.js';
import { newId } from '../core/ids.js';
import { createFallbackSender, linkOf, type RefState } from './fallback.js';
import { routeFor, settlesOnAnswer, type NoticeSource, type Route } from './policy.js';
import type { PresenceService } from './presence.js';
import type { NoticeState } from './state.js';
import { createNoticesRepo, toNoticeDto, type NoticeRow, type SettledVia } from './repo.js';
import { CHAT_FLUSH_GAP_MS } from './throttle.js';

export const NOTICE_TICK_MS = 5_000;
const LIST_DEFAULT = 50;
const ELLIPSIS = '…';

export interface PostInput {
  readonly kind: NoticeKind;
  readonly source: NoticeSource;
  readonly text: string;
  readonly ref: NoticeRef | null;
  readonly quotedId?: string | null;
  /** Time-critical: the chat at once and the website as well, never held (policy.ts). */
  readonly urgent?: boolean;
}

/** `msgId`: the chat's id when the text was sent now; null when it waits on the website (or the channel queued it). */
export interface PostResult { readonly notice: NoticeDTO | null; readonly msgId: string | null }

export interface NoticeRouter {
  post(input: PostInput): Promise<PostResult>;
  /**
   * What could not go to the chat (no channel is up): kept on the website, with a later chat fallback when a channel is
   * declared. A file kept in the outbox rides along. Returns the notice id.
   */
  keep(input: { readonly kind: NoticeKind; readonly text: string; readonly ref: NoticeRef | null; readonly fileId?: string }): string;
  wouldSendNow(kind: NoticeKind, source: NoticeSource): boolean;
  /** True once a website client said hello since the hub started (the old website never does). */
  capable(): boolean;
  ack(ids: readonly string[]): void;
  /**
   * The owner sent a message on the website: every open chat reply is seen now, and the replies to come wait on the
   * website (with the fallback) only when that tab's session said hello; an old tab's replies stay in the chat.
   */
  webMessage(fromHelloTab: boolean): void;
  settleByRef(kind: NoticeRef['kind'], id: string, via: 'web' | 'answer'): void;
  /** The owner got this on the chat another way (/q): its open notices count as sent, so no fallback repeats it. */
  sentElsewhere(kind: NoticeRef['kind'], id: string, msgId: string | null): void;
  /** Open notices first; default 50. */
  list(limit?: number): NoticeDTO[];
  /** One fallback pass; exposed for tests. */
  tick(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface NoticeRouterDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** The raw chat channel (the owner channel facade). */
  chat: ChatSender;
  /** The files the outbox keeps for notices: `NoticeDTO.file`. */
  files?: { byNotice(noticeId: string): NoticeFile | null; byId(fileId: string): NoticeFile | null };
  presence: Pick<PresenceService, 'state' | 'forced' | 'capable'>;
  state: Pick<NoticeState, 'webTabHello' | 'setWebTabHello'>;
  settings: Pick<SettingsService, 'get'>;
  /** Checked before a fallback sends a question or confirmation (fallback.ts). */
  refState?: (ref: NoticeRef) => RefState;
}

/** The raw chat channel as the router needs it: sends, and which channel took them (`settledVia` keeps its id). */
export type ChatSender = Pick<OutboundChannel, 'send' | 'isUp' | 'sendChecked'> & {
  /** The id of the channel that is up, or null. */
  channelId(): string | null;
  /** A primary channel is declared, so what waits on the website may still reach the chat later. */
  declared(): boolean;
};

const HELD_NO_FALLBACK: Route = { chatNow: false, fallbackMs: null, store: true };
const SEND_NOW: Route = { chatNow: true, fallbackMs: null, store: true };

/** Cut by UTF-16 length (the wire schema's unit) without splitting a surrogate pair. */
export function storedText(text: string): string {
  if (text.length <= LIMITS.noticeTextMax) return text;
  const cut = text.slice(0, LIMITS.noticeTextMax - ELLIPSIS.length);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}${ELLIPSIS}`;
}

const answerable = (ref: NoticeRef | null): ref is NoticeRef => ref !== null && (ref.kind === 'question' || ref.kind === 'action');

function newRow(input: PostInput, now: string, over: Partial<NoticeRow>): NoticeRow {
  return {
    id: newId(), kind: input.kind, text: storedText(input.text), ref: input.ref, createdAt: now, chatDueAt: null,
    chatSentAt: null, chatMsgId: null, settledAt: null, settledVia: null, ...over,
  };
}

export function createNoticeRouter(deps: NoticeRouterDeps): NoticeRouter {
  const repo = createNoticesRepo(deps.db);
  const fallback = createFallbackSender({
    ...deps, repo, gapMs: CHAT_FLUSH_GAP_MS,
    // While the owner's switch is on (one hour), what is pending goes now, quiet hours included; /away does not count.
    switchOn: () => deps.presence.state().forcedUntil !== null,
  });
  const nowIso = (): string => deps.clock.now().toISOString();
  let unsubscribers: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let forced = false;

  /**
   * The routing table, plus one guard: a fallback is armed only where a client can mark the notice seen. Before any
   * client said hello, and for an answer to a website tab whose session never said hello (an old bundle), a manager
   * reply stays in the website chat and anything else goes to the chat at once.
   */
  function routeOf(kind: NoticeKind, source: NoticeSource, ref: NoticeRef | null, urgent = false): Route {
    const route = routeFor({ kind, source, mode: deps.presence.state().mode, forced: deps.presence.forced(), urgent });
    if (route.fallbackMs === null) return route;
    const seeable = deps.presence.capable() && (source !== 'web' || deps.state.webTabHello());
    if (seeable) return route;
    return ref?.kind === 'manager' ? HELD_NO_FALLBACK : SEND_NOW;
  }

  /** The DTO, with the outbox file it carries. */
  function dto(row: NoticeRow): NoticeDTO {
    const notice = toNoticeDto(row);
    const file = deps.files?.byNotice(row.id) ?? null;
    return file === null ? notice : { ...notice, file };
  }

  function stored(row: NoticeRow, file?: NoticeFile): NoticeDTO {
    repo.insert(row);
    const notice = file === undefined ? dto(row) : { ...toNoticeDto(row), file };
    deps.bus.emit('notice.created', notice);
    return notice;
  }

  /**
   * While no chat channel is up, what would have gone there waits on the website. When a channel is declared it may
   * still reach the chat later: at once when it comes back, or after the usual ten minutes while the owner is here.
   */
  function whileNoChat(): number | null {
    if (!deps.chat.declared()) return null;
    return deps.presence.state().mode === 'here' ? LIMITS.noticeFallbackMs : 0;
  }

  function holdOnWebsite(input: PostInput, fallbackMs: number | null, file?: NoticeFile): PostResult {
    const now = deps.clock.now();
    const chatDueAt = fallbackMs === null ? null : new Date(now.getTime() + fallbackMs).toISOString();
    return { notice: stored(newRow(input, now.toISOString(), { chatDueAt }), file), msgId: null };
  }

  async function sendChecked(input: PostInput): Promise<{ msgId: string | null; refused: boolean }> {
    const link = linkOf(input.ref);
    if (deps.chat.sendChecked !== undefined) return deps.chat.sendChecked(input.text, link, input.quotedId ?? null);
    return { msgId: await deps.chat.send(input.text, link, input.quotedId ?? null), refused: false };
  }

  async function sendNow(input: PostInput, store: boolean): Promise<PostResult> {
    const via = deps.chat.channelId();
    const { msgId, refused } = via === null ? { msgId: null, refused: true } : await sendChecked(input);
    // The channel went away or refused it: the website keeps it, and the fallback tries the chat again.
    if (refused || via === null) return holdOnWebsite(input, whileNoChat());
    if (!store) return { notice: null, msgId };
    const now = nowIso();
    const open = settlesOnAnswer(input.kind);
    try {
      const row = newRow(input, now, { chatSentAt: now, chatMsgId: msgId, settledAt: open ? null : now, settledVia: open ? null : via });
      return { notice: stored(row), msgId };
    } catch (err) {
      deps.log.error({ err, kind: input.kind }, 'notices: sent to the chat but not stored');
      return { notice: null, msgId };
    }
  }

  async function post(input: PostInput): Promise<PostResult> {
    if (answerable(input.ref)) {
      const open = repo.openByRef(input.ref.kind, input.ref.id)[0];
      if (open !== undefined) return { notice: dto(open), msgId: null };
    }
    const route = routeOf(input.kind, input.source, input.ref, input.urgent === true);
    if (route.chatNow && deps.chat.isUp()) return sendNow(input, route.store);
    if (route.chatNow) return holdOnWebsite(input, whileNoChat());
    try {
      return holdOnWebsite(input, route.fallbackMs);
    } catch (err) {
      // Better a chat message now than a notice nobody will ever see.
      deps.log.error({ err, kind: input.kind }, 'notices: could not store a notice, sending it to the chat now');
      return sendNow(input, false);
    }
  }

  function fileOf(fileId: string): { file?: NoticeFile } {
    const file = deps.files?.byId(fileId) ?? null;
    return file === null ? {} : { file };
  }

  function keep(input: { readonly kind: NoticeKind; readonly text: string; readonly ref: NoticeRef | null; readonly file?: NoticeFile }): string {
    const post = { kind: input.kind, source: 'hub' as const, text: input.text, ref: input.ref };
    const result = holdOnWebsite(post, whileNoChat(), input.file);
    return result.notice?.id ?? '';
  }

  function settle(id: string, via: SettledVia): void {
    if (!repo.settle(id, via, nowIso())) return;
    const row = repo.get(id);
    if (row !== undefined) deps.bus.emit('notice.updated', dto(row));
  }

  function settleByRef(kind: NoticeRef['kind'], id: string, via: 'web' | 'answer'): void {
    for (const row of repo.openByRef(kind, id)) settle(row.id, via);
  }

  function safeTick(): void {
    try {
      fallback.tick();
    } catch (err) {
      deps.log.error({ err }, 'notices: fallback pass failed');
    }
  }

  /** "Updates: chat" pressed, or /away switched on (the chat while someone is online): pending ones go now. */
  function onPresence(state: PresenceDTO): void {
    const now = state.forcedUntil !== null || (state.mode === 'chat' && state.online);
    const became = !forced && now;
    forced = now;
    if (!became) return;
    const moved = repo.bringForward(nowIso());
    deps.log.info({ moved }, 'notices: updates forced to the chat, pending fallbacks brought forward');
    safeTick();
  }

  function subscribe(): Array<() => void> {
    return [
      deps.bus.on('question.updated', (question) => {
        if (question.state !== 'pending') settleByRef('question', question.qid, 'answer');
      }),
      deps.bus.on('action.updated', (action) => {
        if (action.status !== 'pending_confirmation') settleByRef('action', action.id, 'answer');
      }),
      deps.bus.on('presence.updated', onPresence),
    ];
  }

  return {
    post,
    keep: (input) => keep({ kind: input.kind, text: input.text, ref: input.ref,
      ...(input.fileId === undefined ? {} : fileOf(input.fileId)) }),
    wouldSendNow: (kind, source) => routeOf(kind, source, null).chatNow && deps.chat.isUp(),
    capable: () => deps.presence.capable(),
    ack(ids) {
      for (const id of new Set(ids)) {
        const row = repo.get(id);
        if (row !== undefined && row.settledAt === null && !settlesOnAnswer(row.kind)) settle(id, 'web');
      }
    },
    webMessage(fromHelloTab) {
      for (const row of repo.openOfKind('reply')) settle(row.id, 'web');
      deps.state.setWebTabHello(fromHelloTab);
    },
    settleByRef,
    sentElsewhere(kind, id, msgId) {
      for (const row of repo.openByRef(kind, id)) {
        if (row.chatSentAt !== null || !repo.claimSend(row.id, nowIso())) continue;
        repo.setMessage(row.id, msgId);
        const sent = repo.get(row.id);
        if (sent !== undefined) deps.bus.emit('notice.updated', dto(sent));
      }
    },
    list: (limit = LIST_DEFAULT) => repo.recent(limit).map(dto),
    tick: async () => fallback.tick(),
    start() {
      if (timer !== null) return;
      unsubscribers = subscribe();
      timer = setInterval(safeTick, NOTICE_TICK_MS);
      safeTick();
    },
    stop() {
      for (const off of unsubscribers) off();
      unsubscribers = [];
      if (timer !== null) clearInterval(timer);
      timer = null;
      fallback.stop();
    },
  };
}
