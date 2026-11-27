import { localParts, ownerZone, wallTimeToUtc, type NoticeRef, type Settings } from '@luady/shared';
import type { Clock, EventBus, Logger, OutboundLink, SettingsService } from '../core/contracts.js';
import { inQuietHours } from '../core/time.js';
import { fallbackWaitsForMorning, settlesOnAnswer } from './policy.js';
import { formatDigest, planBacklog } from './digest.js';
import { toNoticeDto, type NoticeRow, type NoticesRepo } from './repo.js';
import type { ChatSender } from './router.js';
import { createThrottle } from './throttle.js';

export type RefState = 'open' | 'closed' | 'unknown';

/** A send the adapter refuses is tried again on the next passes, at most this many times, then given up. */
export const FALLBACK_RETRIES = 3;

export interface FallbackDeps {
  repo: NoticesRepo;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  chat: ChatSender;
  settings: Pick<SettingsService, 'get'>;
  gapMs: number;
  /**
   * Is the question or confirmation a notice points to still waiting? `unknown` = not yet known (its server has not
   * reported in since the hub started, for at most two minutes: ref-state.ts): the notice waits for the next pass.
   */
  refState?: (ref: NoticeRef) => RefState;
  /** The owner's "Updates: chat" is on: they asked for the chat now, so quiet hours hold nothing back. */
  switchOn?: () => boolean;
}

export interface FallbackSender {
  /** Queues every due notice once; the throttle spaces the sends. */
  tick(): void;
  /** Drops queued sends that have not started; their notices stay due and go out after the next start. */
  stop(): void;
}

export function linkOf(ref: NoticeRef | null): OutboundLink | null {
  return ref === null ? null : { kind: ref.kind, refId: ref.id };
}

/**
 * The first instant after `now` at which quiet hours are over: the next owner-time wall clock `quiet.end` (today's, or
 * tomorrow's when today's has passed). DST-safe: the wall time is placed in the owner's zone on its own
 * day, so a 23- or 25-hour night ends at the right hour; a wall time in a spring-forward gap becomes the next valid minute.
 */
export function quietEndsAt(now: Date, quiet: Settings['quiet_hours']): Date {
  const [hour = 0, minute = 0] = quiet.end.split(':').map(Number);
  const tz = ownerZone();
  const today = localParts(tz, now.getTime());
  for (let offset = 0; offset <= 2; offset += 1) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const at = wallTimeToUtc(tz, { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute });
    if (at > now.getTime()) return new Date(at);
  }
  return new Date(now.getTime() + 24 * 60 * 60_000);
}

/**
 * Sends notices whose ten minutes ran out. A notice is claimed only right before its own send, so a restart (or a
 * stop) never loses a queued one and two senders on one database never both send it. While the link is down nothing
 * is handed to the channel: its in-memory queue would be lost on a restart and flushed as a burst on reconnect.
 * A backlog (more than three due at once) leaves as at most three red questions and one digest (digest.ts).
 */
export function createFallbackSender(deps: FallbackDeps): FallbackSender {
  const throttle = createThrottle(deps.gapMs);
  let queued: ReadonlySet<string> = new Set();
  /** Refusals per notice in this process (a restart allows a few more tries; none is ever repeated once sent). */
  let refusals: ReadonlyMap<string, number> = new Map();
  const nowIso = (): string => deps.clock.now().toISOString();

  /** Quiet hours hold everything but a red question until the morning. True when it was moved. */
  function postponed(id: string, kind: Parameters<typeof fallbackWaitsForMorning>[0]): boolean {
    if (deps.switchOn?.() === true) return false;
    const now = deps.clock.now();
    const quiet = deps.settings.get().quiet_hours;
    if (!fallbackWaitsForMorning(kind) || !inQuietHours(now, quiet)) return false;
    deps.repo.setDue(id, quietEndsAt(now, quiet).toISOString());
    const row = deps.repo.get(id);
    if (row !== undefined) deps.bus.emit('notice.updated', toNoticeDto(row));
    return true;
  }

  async function sendChecked(text: string, link: ReturnType<typeof linkOf>): Promise<{ msgId: string | null; refused: boolean }> {
    if (deps.chat.sendChecked !== undefined) return deps.chat.sendChecked(text, link, null);
    return { msgId: await deps.chat.send(text, link, null), refused: false };
  }

  /** Undo the claims and keep the notices due; after FALLBACK_RETRIES retries give up and tell the website. */
  function refused(rows: readonly NoticeRow[]): void {
    for (const row of rows) {
      deps.repo.unclaim(row.id);
      const count = (refusals.get(row.id) ?? 0) + 1;
      refusals = new Map([...refusals, [row.id, count]]);
      if (count <= FALLBACK_RETRIES) continue;
      deps.repo.setDue(row.id, null);
      const failed = deps.repo.get(row.id);
      if (failed !== undefined) deps.bus.emit('notice.updated', toNoticeDto(failed));
      deps.log.error({ notice: row.id, kind: row.kind, tries: count }, 'notices: the chat refused the fallback, giving up');
    }
  }

  /** A question or confirmation answered meanwhile (also at the terminal while the hub was down) is settled, not sent. */
  function stillOpen(row: NoticeRow): boolean {
    if (row.ref === null || deps.refState === undefined || (row.ref.kind !== 'question' && row.ref.kind !== 'action')) return true;
    const state = deps.refState(row.ref);
    if (state === 'closed' && deps.repo.settle(row.id, 'answer', nowIso())) {
      const settled = deps.repo.get(row.id);
      if (settled !== undefined) deps.bus.emit('notice.updated', toNoticeDto(settled));
    }
    return state === 'open';
  }

  async function deliver(id: string): Promise<void> {
    const row = deps.repo.get(id);
    if (row === undefined || row.settledAt !== null || row.chatSentAt !== null) return;
    const via = deps.chat.channelId();
    if (postponed(id, row.kind) || !stillOpen(row) || !deps.chat.isUp() || via === null) return;
    if (!deps.repo.claimSend(id, nowIso())) return;
    const { msgId, refused: refusedNow } = await sendChecked(row.text, linkOf(row.ref));
    if (refusedNow) {
      refused([row]);
      return;
    }
    deps.repo.setMessage(id, msgId);
    if (!settlesOnAnswer(row.kind)) deps.repo.settle(id, via, nowIso());
    const notice = toNoticeDto(deps.repo.get(id) ?? row);
    deps.bus.emit('notice.updated', notice);
    deps.bus.emit('notice.delivered', { notice, msgId });
    deps.log.info({ notice: id, kind: row.kind, queued: msgId === null }, 'notices: fallback sent to the chat');
  }

  /** Every notice of a backlog in one message; questions in it stay open until answered. Claimed just before the send. */
  async function deliverDigest(ids: readonly string[]): Promise<void> {
    const via = deps.chat.channelId();
    if (!deps.chat.isUp() || via === null) return;
    const open = ids.map((id) => deps.repo.get(id))
      .filter((row): row is NoticeRow => row !== undefined && row.settledAt === null && row.chatSentAt === null && stillOpen(row));
    const now = nowIso();
    const claimed = open.filter((row) => deps.repo.claimSend(row.id, now));
    if (claimed.length === 0) return;
    const { msgId, refused: refusedNow } = await sendChecked(formatDigest(claimed, deps.clock.now()), null);
    if (refusedNow) {
      refused(claimed);
      return;
    }
    for (const row of claimed) {
      deps.repo.setMessage(row.id, msgId);
      if (!settlesOnAnswer(row.kind)) deps.repo.settle(row.id, via, nowIso());
      const notice = toNoticeDto(deps.repo.get(row.id) ?? row);
      deps.bus.emit('notice.updated', notice);
      // One message for many notices: nothing to pin, but a red question's escalation counts from now.
      deps.bus.emit('notice.delivered', { notice, msgId: null });
    }
    deps.log.info({ notices: claimed.length, queued: msgId === null }, 'notices: backlog sent to the chat as one digest');
  }

  function enqueue(ids: readonly string[], work: () => Promise<void>): void {
    queued = new Set([...queued, ...ids]);
    throttle.run(async () => {
      try {
        await work();
      } catch (err) {
        deps.log.error({ err, notices: ids }, 'notices: fallback send failed');
      } finally {
        queued = new Set([...queued].filter((queuedId) => !ids.includes(queuedId)));
      }
    });
  }

  return {
    tick() {
      if (!deps.chat.isUp()) return;
      const due = deps.repo.due(nowIso()).filter((row) => !queued.has(row.id) && !postponed(row.id, row.kind) && stillOpen(row));
      const plan = planBacklog(due);
      for (const row of plan.alone) enqueue([row.id], () => deliver(row.id));
      if (plan.digest.length > 0) enqueue(plan.digest.map((row) => row.id), () => deliverDigest(plan.digest.map((row) => row.id)));
    },
    stop() {
      throttle.stop();
      queued = new Set();
    },
  };
}
