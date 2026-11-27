import { ChannelSchema, LIMITS, SELF_HOST_ID, promptHash, type Channel, managerName, isChatChannel } from '@luady/shared';
import type { Clock, Db, Fleet, Logger } from '../core/contracts.js';
import { CtlError, ValidationError } from '../core/errors.js';
import { markControlChars } from '../fleet/ctl-args.js';
import { injectionStamp } from '../core/time.js';
import { truncateChars } from '../notify/format.js';
import { bundleMessages } from './bundle.js';
import { LUADY_SESSION_ID, LUADY_TARGET, recordInputChannel } from './launch.js';
import type { OwnerRequests } from './owner-requests.js';

export const FLUSH_GAP_MS = 1_000;
const PREFIX_ALLOWANCE = 64;
/** The owner's own channels: the website, the phone, or the owner's chat app (an add-on channel). */
const isOwnerChannel = (channel: string): boolean => channel === 'web' || channel === 'phone' || isChatChannel(channel);
const LABELS: Partial<Record<Channel, string>> = {
  web: 'Web', phone: 'Phone', event: 'Event', scheduled: 'Scheduled',
};
/** Every chat channel (an add-on's id) reads the same to the manager (brain/CLAUDE.md: `[Chat · …]`). */
export const CHAT_LABEL = 'Chat';

export function injectionLabel(channel: Channel): string {
  const label = isChatChannel(channel) ? CHAT_LABEL : LABELS[channel];
  if (!label) throw new ValidationError(`Channel ${channel} cannot send to ${managerName()}`);
  return label;
}

/**
 * The prompt as the manager gets it. A control character (other than line breaks and tabs) becomes a visible mark: the
 * kit refuses to type one, so a message holding one (mail, a server's text, pasted terminal output) would never go.
 */
export function formatInjection(channel: Channel, at: Date, text: string): string {
  const body = truncateChars(markControlChars(text), LIMITS.sendTextMax - PREFIX_ALLOWANCE);
  return `[${injectionLabel(channel)} · ${injectionStamp(at)}] ${body}`;
}

export interface InboxDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  fleet: Fleet;
  /** Where the prompt of an owner's website request is marked (luady/owner-requests.ts). */
  ownerRequests?: Pick<OwnerRequests, 'mark'>;
}

/** `ownerRequest`: the text is an Event for the owner's own request on the website (the board's Run and Give). */
export interface InjectOptions {
  readonly ownerRequest?: boolean;
}

export interface LuadyInbox {
  inject(text: string, channel: Channel, at: Date, opts?: InjectOptions): Promise<void>;
  enqueue(text: string, channel: Channel, opts?: InjectOptions): void;
  queued(): number;
  flush(): Promise<void>;
  stop(): void;
}

interface QueueRow {
  id: number;
  text: string;
  channel: string;
  created_at: string;
}

/** Consecutive queued owner messages on one channel become one numbered prompt; anything else goes alone. */
export function groupQueued<T extends { channel: string }>(rows: readonly T[]): T[][] {
  const groups: T[][] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    const joins = last !== undefined && last[0]!.channel === row.channel && isOwnerChannel(row.channel);
    if (joins) groups[groups.length - 1] = [...last, row];
    else groups.push([row]);
  }
  return groups;
}

/** The hub's own check of typed text, or the kit's (`usage`): the text itself was refused, so sending it again never helps. */
function refusedForContent(err: unknown): boolean {
  return err instanceof ValidationError || (err instanceof CtlError && err.code === 'usage');
}

export function createLuadyInbox(deps: InboxDeps): LuadyInbox {
  let flushing = false;
  let stopped = false;
  const insertInjection = deps.db.prepare<[string, string, string, string]>(
    'INSERT INTO injections (session_id, text_sha256, channel, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertQueued = deps.db.prepare<[string, string, string]>('INSERT INTO manager_queue (text, channel, created_at) VALUES (?, ?, ?)');
  const countQueued = deps.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM manager_queue');
  const allQueued = deps.db.prepare<[], QueueRow>('SELECT id, text, channel, created_at FROM manager_queue ORDER BY id');
  const deleteQueued = deps.db.prepare<[number]>('DELETE FROM manager_queue WHERE id = ?');
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** Queued rows that are owner requests: in memory only, so after a restart they go as plain Events. */
  let ownerQueued: ReadonlySet<number> = new Set();

  async function inject(text: string, channel: Channel, at: Date, opts: InjectOptions = {}): Promise<void> {
    const formatted = formatInjection(channel, at, text);
    const hash = promptHash(formatted);
    insertInjection.run(LUADY_SESSION_ID, hash, channel, deps.clock.now().toISOString());
    if (isOwnerChannel(channel)) recordInputChannel(deps.db, channel);
    if (opts.ownerRequest === true) deps.ownerRequests?.mark(hash);
    await deps.fleet.client(SELF_HOST_ID).send(LUADY_TARGET, formatted);
  }

  async function flushGroup(rows: readonly QueueRow[]): Promise<void> {
    const first = rows[0]!;
    const channel = ChannelSchema.safeParse(first.channel);
    // An owner request is an Event, and an Event row always goes alone (groupQueued).
    const ownerRequest = rows.length === 1 && ownerQueued.has(first.id);
    if (channel.success) await inject(bundleMessages(rows.map((row) => row.text)), channel.data, new Date(first.created_at), { ownerRequest });
    else deps.log.warn({ id: first.id }, 'luady: dropped a queued message with an unknown channel');
    for (const row of rows) deleteQueued.run(row.id);
    ownerQueued = new Set([...ownerQueued].filter((id) => !rows.some((row) => row.id === id)));
  }

  /**
   * One group, sent. When the hub or the kit refuses its text (its content, not the connection), the group is dropped
   * with a note in the log, so one bad message never holds every later one, the owner's included, for good.
   */
  async function sendOrDrop(rows: readonly QueueRow[]): Promise<void> {
    try {
      await flushGroup(rows);
    } catch (err) {
      if (!refusedForContent(err)) throw err;
      for (const row of rows) deleteQueued.run(row.id);
      ownerQueued = new Set([...ownerQueued].filter((id) => !rows.some((row) => row.id === id)));
      deps.log.warn({ ids: rows.map((row) => row.id), err }, 'luady: dropped a queued message the kit would not type');
    }
  }

  async function flush(): Promise<void> {
    if (flushing) return;
    flushing = true;
    stopped = false;
    try {
      let group = groupQueued(allQueued.all())[0];
      while (group && !stopped) {
        await sendOrDrop(group);
        group = groupQueued(allQueued.all())[0];
        if (group) await pause(FLUSH_GAP_MS);
      }
    } catch (err) {
      deps.log.warn({ err }, 'luady: queue flush stopped, remaining messages stay queued');
    } finally {
      flushing = false;
    }
  }

  return {
    inject,
    enqueue: (text, channel, opts = {}) => {
      const row = insertQueued.run(text, channel, deps.clock.now().toISOString());
      if (opts.ownerRequest === true) ownerQueued = new Set([...ownerQueued, Number(row.lastInsertRowid)]);
    },
    queued: () => countQueued.get()?.n ?? 0,
    flush,
    stop: () => {
      stopped = true;
    },
  };
}
