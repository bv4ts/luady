import { createHash } from 'node:crypto';

/** One pass over every host per minute, one tick a second. */
export const SYSINFO_PERIOD_TICKS = 60;
export const SYSINFO_TICK_MS = 1_000;
/** At most this many sysinfo reads in flight at once. */
export const MAX_SYSINFO_IN_FLIGHT = 8;

/** A host's own second within the minute: stable for its id, spread over the 60 s. */
export function phaseOf(id: string, period: number = SYSINFO_PERIOD_TICKS): number {
  return createHash('sha256').update(id).digest().readUInt32BE(0) % period;
}

export interface PhaseOptions {
  /** The hosts read again at every tick (never a captured list). */
  readonly hosts: () => readonly string[];
  /** One host's turn: read sysinfo, or repair a drifted status row. Never rejects (the caller logs). */
  readonly run: (id: string) => Promise<void>;
  readonly period?: number;
  readonly maxInFlight?: number;
  readonly tickMs?: number;
}

export interface PhaseScheduler {
  start(): void;
  stop(): void;
  /** One tick (tests drive it; production runs it every second). */
  tick(): void;
  inFlight(): number;
}

/**
 * Sysinfo phases: each host is due once a minute at its own second, so a hundred servers never answer
 * at the same instant; due hosts beyond eight in flight wait in a queue and go as reads finish. The ticks are counted,
 * not read from a clock, so a test drives them with fake timers or `tick()`.
 */
export function createPhaseScheduler(options: PhaseOptions): PhaseScheduler {
  const period = options.period ?? SYSINFO_PERIOD_TICKS;
  const max = options.maxInFlight ?? MAX_SYSINFO_IN_FLIGHT;
  const queue: string[] = [];
  const running = new Set<string>();
  let tickCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function drain(): void {
    while (running.size < max && queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || running.has(id)) continue;
      running.add(id);
      void options.run(id).catch(() => undefined).finally(() => {
        running.delete(id);
        drain();
      });
    }
  }

  function tick(): void {
    tickCount = (tickCount + 1) % period;
    for (const id of options.hosts()) {
      if (phaseOf(id, period) === tickCount && !running.has(id) && !queue.includes(id)) queue.push(id);
    }
    drain();
  }

  return {
    start() {
      if (timer === null) timer = setInterval(tick, options.tickMs ?? SYSINFO_TICK_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      queue.length = 0;
    },
    tick,
    inFlight: () => running.size,
  };
}
