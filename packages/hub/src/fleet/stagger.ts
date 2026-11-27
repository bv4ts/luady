import type { LinkStatus } from './executor.js';

/** At most this many SSH handshakes at once. */
export const MAX_HANDSHAKES = 8;
/** A start that had to wait for a slot waits 0-2 s more, so a hundred links never knock at the same instant. */
export const START_JITTER_MS = 2_000;
/** A handshake that neither succeeded nor failed by then frees its slot anyway. */
export const HANDSHAKE_SLOT_MS = 30_000;

/** What the starter needs of an executor. */
export interface Startable {
  start(): void;
  status(): LinkStatus;
  onStatus(listener: (status: LinkStatus) => void): () => void;
}

export interface StaggerOptions {
  readonly max?: number;
  readonly jitterMs?: number;
  readonly slotMs?: number;
  /** A number in [0, 1); Math.random when absent. */
  readonly random?: () => number;
}

export interface StaggeredStarter {
  /** Starts the executor now when a slot is free, else queues it; the key replaces a queued start of the same host. */
  enqueue(key: string, executor: Startable): void;
  /** Drops a queued start (the host was removed) and frees its slot. */
  cancel(key: string): void;
  /** Handshakes running now. */
  inFlight(): number;
  /** Starts waiting for a slot. */
  queued(): number;
  stop(): void;
}

interface Slot {
  readonly off: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * The staggered start: a start takes a handshake slot until its link leaves `connecting` (online or
 * offline) or 30 s pass. Up to eight run at once; a start that had to wait gets a 0-2 s jitter once a slot is free.
 */
export function createStaggeredStarter(options: StaggerOptions = {}): StaggeredStarter {
  const max = options.max ?? MAX_HANDSHAKES;
  const jitterMs = options.jitterMs ?? START_JITTER_MS;
  const slotMs = options.slotMs ?? HANDSHAKE_SLOT_MS;
  const random = options.random ?? Math.random;
  const slots = new Map<string, Slot>();
  const waiting = new Map<string, Startable>();
  const delayed = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  function release(key: string): void {
    const slot = slots.get(key);
    if (slot === undefined) return;
    slot.off();
    clearTimeout(slot.timer);
    slots.delete(key);
    pump();
  }

  function begin(key: string, executor: Startable): void {
    const off = executor.onStatus((status) => {
      if (status !== 'connecting') release(key);
    });
    const timer = setTimeout(() => release(key), slotMs);
    slots.set(key, { off, timer });
    executor.start();
    if (executor.status() !== 'connecting') release(key);
  }

  /** Fills free slots from the queue; each start that waited is jittered (the slot is held during the jitter). */
  function pump(): void {
    while (!stopped && slots.size + delayed.size < max && waiting.size > 0) {
      const [key, executor] = waiting.entries().next().value as [string, Startable];
      waiting.delete(key);
      const timer = setTimeout(() => {
        delayed.delete(key);
        if (!stopped) begin(key, executor);
      }, Math.floor(Math.min(Math.max(random(), 0), 1) * jitterMs));
      delayed.set(key, timer);
    }
  }

  return {
    enqueue(key, executor) {
      if (stopped) return;
      if (slots.size + delayed.size < max && waiting.size === 0) {
        begin(key, executor);
        return;
      }
      waiting.set(key, executor);
    },
    cancel(key) {
      waiting.delete(key);
      const timer = delayed.get(key);
      if (timer !== undefined) clearTimeout(timer);
      delayed.delete(key);
      release(key);
    },
    inFlight: () => slots.size,
    queued: () => waiting.size + delayed.size,
    stop() {
      stopped = true;
      for (const timer of delayed.values()) clearTimeout(timer);
      delayed.clear();
      waiting.clear();
      for (const key of [...slots.keys()]) {
        const slot = slots.get(key);
        slot?.off();
        if (slot !== undefined) clearTimeout(slot.timer);
      }
      slots.clear();
    },
  };
}
