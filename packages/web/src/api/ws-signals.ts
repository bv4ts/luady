import { LIMITS, type WsClientMessage } from '@luady/shared';

/** The hub counts a tab as present for 30 minutes after a `presence.active`; one a minute is plenty. */
export const ACTIVE_EVERY_MS = 60_000;
/** WsClientMessageSchema: a notice id is at most 64 characters (a longer one would close the socket). */
const ACK_ID_MAX = 64;

/** `send` answers whether the frame went out (false while the socket is not open). */
export type SendFrame = (message: WsClientMessage) => boolean;

/** `notice.ack` frames for these ids: unique, valid ids only, at most LIMITS.noticeAckMax per frame. */
export function ackFrames(ids: readonly string[]): readonly WsClientMessage[] {
  const valid = [...new Set(ids.filter((id) => id.length > 0 && id.length <= ACK_ID_MAX))];
  const frames: WsClientMessage[] = [];
  for (let at = 0; at < valid.length; at += LIMITS.noticeAckMax) {
    frames.push({ type: 'notice.ack', ids: valid.slice(at, at + LIMITS.noticeAckMax) });
  }
  return frames;
}

/**
 * What the website tells the hub about the owner: `presence.hello` with the tab's visibility on every
 * (re)connect and visibility change, `presence.active` only for a real touch of a visible tab, at most once a minute.
 * A touch made while the socket is down is owed to the next hello, unless the tab went hidden meanwhile.
 */
export class PresenceSignals {
  private visible: boolean | null = null;
  private owed = false;
  private lastActiveAt: number | null = null;
  private readonly send: SendFrame;
  private readonly now: () => number;

  constructor(send: SendFrame, now: () => number) {
    this.send = send;
    this.now = now;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.owed = false;
    this.send({ type: 'presence.hello', visible });
  }

  touch(): void {
    if (this.visible !== true) return;
    const at = this.now();
    if (this.lastActiveAt !== null && at - this.lastActiveAt < ACTIVE_EVERY_MS) return;
    this.owed = !this.sendActive(at);
  }

  /** A socket just opened: the remembered hello goes first, then a touch owed from while it was down. */
  opened(): void {
    if (this.visible === null) return;
    this.send({ type: 'presence.hello', visible: this.visible });
    if (this.visible && this.owed) this.owed = !this.sendActive(this.now());
  }

  private sendActive(at: number): boolean {
    const sent = this.send({ type: 'presence.active' });
    if (sent) this.lastActiveAt = at;
    return sent;
  }
}

/** Reference counts per session id: the first subscriber sends `subscribe`, the last release sends `unsubscribe`. */
export class SubscriptionCounts {
  private readonly counts = new Map<string, number>();
  private readonly onFirst: (id: string) => void;
  private readonly onLast: (id: string) => void;

  constructor(onFirst: (id: string) => void, onLast: (id: string) => void) {
    this.onFirst = onFirst;
    this.onLast = onLast;
  }

  /** Returns the release function; calling it twice releases once. */
  add(id: string): () => void {
    const count = this.counts.get(id) ?? 0;
    this.counts.set(id, count + 1);
    if (count === 0) this.onFirst(id);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.release(id);
    };
  }

  ids(): readonly string[] {
    return [...this.counts.keys()];
  }

  private release(id: string): void {
    const left = (this.counts.get(id) ?? 1) - 1;
    if (left > 0) {
      this.counts.set(id, left);
      return;
    }
    this.counts.delete(id);
    this.onLast(id);
  }
}
