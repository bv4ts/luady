/** At least this long between two fallback sends, so a backlog can never go out as a burst. */
export const CHAT_FLUSH_GAP_MS = 3_000;

export interface Throttle {
  run(task: () => Promise<void>): void;
  /** Tasks waiting to start. */
  size(): number;
  /** Drops what has not started; the throttle stays usable. */
  stop(): void;
}

/** Tasks start in order, at least `gapMs` after the previous one started; a failing task never stops the queue. */
export function createThrottle(gapMs: number): Throttle {
  let queue: ReadonlyArray<() => Promise<void>> = [];
  let cooling: ReturnType<typeof setTimeout> | null = null;

  function pump(): void {
    if (cooling !== null) return;
    const [task, ...rest] = queue;
    if (task === undefined) return;
    queue = rest;
    cooling = setTimeout(() => {
      cooling = null;
      pump();
    }, gapMs);
    try {
      task().catch(() => undefined);
    } catch {
      // A task that throws before its first await is treated like one that rejects.
    }
  }

  return {
    run(task) {
      queue = [...queue, task];
      pump();
    },
    size: () => queue.length,
    stop() {
      queue = [];
      if (cooling !== null) clearTimeout(cooling);
      cooling = null;
    },
  };
}
