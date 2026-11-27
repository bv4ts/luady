import { ChannelSchema, MANAGER_THREAD, type Channel, type NoticeKind, type SpoolEvent, isChatChannel } from '@luady/shared';
import type { Clock, Db, EventBus, Logger, MemoryService } from '../core/contracts.js';
import { MORNING_BRIEF_PREFIX } from '../daily/jobs.js';
import { sourceOfChannel, type NoticeSource } from '../notices/policy.js';
import type { NoticeRouter } from '../notices/router.js';
import { LUADY_SESSION_ID, readLuadyState } from './launch.js';
import type { OwnerRequests } from './owner-requests.js';

export const INJECTION_WINDOW_MS = 15_000;
/**
 * A running turn with no event for this long may be one the owner interrupted in the Claude app, where Claude Code
 * sends no Stop, so it would never end. A prompt that joins such a turn gets no standing from it: only its own (an
 * owner's message, or their Run or Give). Five minutes is longer than the manager's own back-to-back prompts are
 * apart; a long working turn that an Event joins after it only costs a PIN for what the manager does next.
 */
export const STALE_TURN_MS = 5 * 60_000;
/** A scheduled turn that found nothing worth telling the owner ends with exactly this; it is not sent. */
export const NO_UPDATE = 'NO_UPDATE';
const NO_UPDATE_RE = /^\s*\**NO_UPDATE\**\s*\.?\s*$/;
const MORNING_BRIEF_RE = new RegExp(`^\\[Scheduled · [^\\]]+\\] ${MORNING_BRIEF_PREFIX}`);

export function isNoUpdate(text: string): boolean {
  return NO_UPDATE_RE.test(text);
}

/** The daily brief job's prompt as the brain sees it: `[Scheduled · Sat 08:00] Morning brief for …`. */
export function isMorningBrief(promptPreview: string): boolean {
  return MORNING_BRIEF_RE.test(promptPreview);
}

const HASH_LOOKBACK_MS = 60 * 60_000;
const CLOCK_SKEW_MS = 1_000;
/** The owner's own channels: the website, the phone, or the owner's chat app (an add-on channel). */
export const isOwnerChannel = (channel: string | null): boolean =>
  channel !== null && (channel === 'web' || channel === 'phone' || isChatChannel(channel));

export type PromptEvent = Extract<SpoolEvent, { event: 'prompt' }>;
export type StopEvent = Extract<SpoolEvent, { event: 'stop' }>;

export interface ReplyDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  memory: MemoryService;
  /** Where every reply goes: back where the message came from, website first for Luady's own news. */
  notices: Pick<NoticeRouter, 'post' | 'capable'>;
  /** The live phone call, when one is on. */
  phone?: { say?(text: string): boolean };
  /** Prompts the hub injected for the owner's own request on the website (luady/owner-requests.ts). */
  ownerRequests?: Pick<OwnerRequests, 'take'>;
}

export interface ReplyRouter {
  /** `replay`: the event is history read again after a hub restart, not a prompt of this run. */
  onPrompt(event: PromptEvent, replay?: boolean): void;
  onStop(event: StopEvent, replay: boolean): Promise<void>;
  onTurnFailed(): void;
  busy(): boolean;
  /** The running turn's source while busy (typing shows only for chat turns), or null when idle. */
  currentChannel(): Channel | null;
  /** Where the running turn came from, or null when idle or a Remote Control turn. */
  turnSource(): Channel | null;
  /**
   * True while the running turn answers the owner: a message of theirs (the website, the phone, a chat app), or an Event
   * the hub posted for their own request on the website. False when idle, and for every other turn.
   */
  ownerTurn(): boolean;
  /** True while the running turn is the morning brief: whatever Luady sends in it is the morning message. */
  morningTurn(): boolean;
  /** Luady's tools already messaged the owner this turn (notify_user, mission_done). */
  markOwnerTold(): void;
}

/** Owner channels outrank Luady's own reminders, which outrank hub events; a fresh turn always starts over. */
const SOURCE_RANK: Partial<Record<Channel, number>> = { web: 3, phone: 3, scheduled: 2, event: 1 };
/** Any chat channel is the owner's, like the website and the phone. */
const rankOf = (channel: Channel): number => (isChatChannel(channel) ? 3 : SOURCE_RANK[channel] ?? 0);

export function strongerSource(current: Channel | null, next: Channel | null, midTurn: boolean): Channel | null {
  if (!midTurn || current === null) return next;
  if (next === null) return current;
  return rankOf(next) >= rankOf(current) ? next : current;
}

/**
 * `toldMorning`: a tool told the owner while the turn already carried the brief, so that was the morning message.
 * `ownerRequest`: a prompt of this turn was one the hub injected for the owner's own request on the website. Its replies
 * still go as the hub's news (its source stays `event`); only the PIN rule reads it, through ownerTurn().
 */
interface Turn {
  readonly source: Channel | null; readonly morning: boolean; readonly told: boolean; readonly toldMorning: boolean;
  /** The turn counts as the owner's: one of its prompts is the owner's message or carries their website request's mark. */
  readonly standing: boolean;
  /** Opened by a replayed prompt (the hub restarted mid-turn): its reply still goes where it should, but it never counts as the owner's. */
  readonly replayed: boolean;
  /** When its latest prompt came (ms), for STALE_TURN_MS. */
  readonly lastAt: number;
}

const IDLE: Turn = { source: null, morning: false, told: false, toldMorning: false, standing: false, replayed: false, lastAt: 0 };
const isBackground = (source: Channel): boolean => source === 'event' || source === 'scheduled';

export function createReplyRouter(deps: ReplyDeps): ReplyRouter {
  let turn: Turn = IDLE;
  let busyFlag = false;
  const byHash = deps.db.prepare<[string, string, string], { channel: string }>(
    'SELECT channel FROM injections WHERE session_id = ? AND text_sha256 = ? AND created_at >= ? ORDER BY id DESC LIMIT 1',
  );
  const inWindow = deps.db.prepare<[string, string, string], { channel: string }>(
    'SELECT channel FROM injections WHERE session_id = ? AND created_at >= ? AND created_at <= ? ORDER BY id DESC LIMIT 1',
  );
  const recorded = deps.db.prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM messages WHERE thread = 'manager' AND ext_id = ?",
  );
  const iso = (ms: number): string => new Date(ms).toISOString();

  /** When a prompt came (ms): its own time, else the hub's clock. */
  function eventMs(event: PromptEvent): number {
    const parsed = Date.parse(event.ts);
    return Number.isNaN(parsed) ? deps.clock.now().getTime() : parsed;
  }

  /** Channel of the injection that started this turn, or null for a Remote Control turn. */
  function matchedSource(event: PromptEvent): Channel | null {
    const at = eventMs(event);
    const row = byHash.get(LUADY_SESSION_ID, event.data.prompt_sha256, iso(at - HASH_LOOKBACK_MS))
      ?? inWindow.get(LUADY_SESSION_ID, iso(at - INJECTION_WINDOW_MS), iso(at + CLOCK_SKEW_MS));
    const channel = ChannelSchema.safeParse(row?.channel);
    return channel.success ? channel.data : null;
  }

  /** The owner's latest channel (written at injection time); only for the routing used before the new website. */
  function lastInputChannel(): Channel {
    const parsed = ChannelSchema.safeParse(readLuadyState(deps.db).last_input_channel);
    return parsed.success ? parsed.data : 'web';
  }

  /**
   * Where an Event or Scheduled reply goes. Before any new website client has said hello (the old website never
   * does) it follows the owner's latest channel: website only after a website message, the chat
   * otherwise. After that it is the manager's own news: website first while the owner is there, else the chat.
   */
  function backgroundTarget(source: Channel): { readonly channel: Channel; readonly source: NoticeSource } {
    if (deps.notices.capable()) return { channel: source, source: 'hub' };
    const last = lastInputChannel();
    return { channel: last, source: last === 'web' ? 'web' : 'hub' };
  }

  function kindOf(source: Channel, morning: boolean): NoticeKind {
    if (morning) return 'morning';
    return isOwnerChannel(source) ? 'reply' : 'result';
  }

  async function deliver(current: Turn, source: Channel, text: string, messageId: string): Promise<void> {
    const background = isBackground(source) && !current.morning;
    const target = background ? backgroundTarget(source) : { channel: source, source: sourceOfChannel(source) };
    if (target.channel === 'phone' && deps.phone?.say?.(text) === true) return;
    // One message per turn: when a tool already told the owner, the closing summary stays on the website. In a turn
    // that carries the morning brief only a morning message already sent counts: the brief must reach the chat.
    if (current.morning ? current.toldMorning : current.told) return;
    try {
      await deps.notices.post({ kind: kindOf(source, current.morning), source: target.source, text, ref: { kind: 'manager', id: messageId } });
    } catch (err) {
      deps.log.error({ err, messageId }, 'luady: reply delivery failed');
    }
  }

  async function onStop(event: StopEvent, replay: boolean): Promise<void> {
    const current = turn;
    turn = IDLE;
    busyFlag = false;
    const text = event.data.last_assistant_message.trim();
    if (text === '' || (recorded.get(event.id)?.n ?? 0) > 0) return;
    const source = current.source;
    const message = deps.memory.record({ thread: MANAGER_THREAD, role: 'manager', channel: source ?? 'remote_control', text, extId: event.id });
    deps.bus.emit('manager.message', message);
    if (replay || source === null) return;
    if ((isBackground(source) || current.morning) && isNoUpdate(text)) return;
    await deliver(current, source, text, message.id);
  }

  return {
    onPrompt: (event, replay = false) => {
      // Prompts queued during a turn join it. An Event or Scheduled note arriving mid-turn must not steal the
      // reply from the owner, whose message is part of the same turn; the morning brief still marks the turn.
      // A live prompt never joins a turn rebuilt from replayed history: it starts its own, with only its own standing.
      const midTurn = busyFlag && (replay || !turn.replayed);
      const base = midTurn ? turn : IDLE;
      const at = eventMs(event);
      // Joining a turn silent for too long keeps its reply routing, never its standing (STALE_TURN_MS).
      const inherited = midTurn && at - base.lastAt <= STALE_TURN_MS && base.standing;
      const matched = matchedSource(event);
      // Only the exact prompt the hub injected for the owner's website request carries the mark, and only once.
      const ownerRequest = deps.ownerRequests?.take(event.data.prompt_sha256) === true;
      turn = {
        source: strongerSource(base.source, matched, midTurn),
        morning: base.morning || isMorningBrief(event.data.prompt_preview),
        told: base.told,
        toldMorning: base.toldMorning,
        standing: inherited || isOwnerChannel(matched) || ownerRequest,
        replayed: replay || base.replayed,
        lastAt: at,
      };
      busyFlag = true;
    },
    onStop,
    onTurnFailed: () => {
      turn = IDLE;
      busyFlag = false;
    },
    busy: () => busyFlag,
    currentChannel: () => (busyFlag ? turn.source : null),
    turnSource: () => (busyFlag ? turn.source : null),
    ownerTurn: () => busyFlag && !turn.replayed && turn.standing,
    morningTurn: () => busyFlag && turn.morning,
    markOwnerTold: () => {
      if (busyFlag) turn = { ...turn, told: true, toldMorning: turn.toldMorning || turn.morning };
    },
  };
}
