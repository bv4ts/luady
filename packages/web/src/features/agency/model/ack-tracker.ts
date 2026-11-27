/** A notice counts as seen after this long on screen in a visible, focused tab. */
export const ACK_AFTER_MS = 3_000;

export interface AckTracker {
  /** The notice is on screen. Showing it again keeps its running clock. */
  shown(id: string, nowMs: number): void;
  /** It left the screen: its clock stops and is forgotten. */
  hidden(id: string): void;
  /** The tab is visible AND focused, or not. Losing it resets every clock. */
  attention(active: boolean, nowMs: number): void;
  /** Ids that have had 3 continuous seconds of attention on screen; each id is returned once, ever. */
  due(nowMs: number): readonly string[];
  /** Handled another way (the owner clicked it): never due. */
  done(id: string): void;
  /** Anything on screen that may still become due. */
  watching(): boolean;
}

/** Pure bookkeeping for "seen" acknowledgements; the caller feeds it the clock. */
export function createAckTracker(): AckTracker {
  /** id → when its current stretch of attention began; null while the tab has none. */
  let clocks: ReadonlyMap<string, number | null> = new Map();
  let finished: ReadonlySet<string> = new Set();
  let active = false;

  const restart = (at: number | null): void => {
    clocks = new Map([...clocks.keys()].map((id) => [id, at] as const));
  };

  return {
    shown: (id, nowMs) => {
      if (finished.has(id) || clocks.has(id)) return;
      clocks = new Map([...clocks, [id, active ? nowMs : null]]);
    },
    hidden: (id) => {
      if (clocks.has(id)) clocks = new Map([...clocks].filter(([key]) => key !== id));
    },
    attention: (next, nowMs) => {
      if (next === active) return;
      active = next;
      restart(next ? nowMs : null);
    },
    due: (nowMs) => {
      const ready = [...clocks].filter(([, since]) => since !== null && nowMs - since >= ACK_AFTER_MS).map(([id]) => id);
      if (ready.length === 0) return [];
      finished = new Set([...finished, ...ready]);
      clocks = new Map([...clocks].filter(([id]) => !ready.includes(id)));
      return ready;
    },
    done: (id) => {
      finished = new Set([...finished, id]);
      clocks = new Map([...clocks].filter(([key]) => key !== id));
    },
    watching: () => clocks.size > 0,
  };
}
