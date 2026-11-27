import { makeSessionId, type HostId, type TranscriptItemDTO } from '@luady/shared';
import type { EventBus, Logger, SessionService } from '../core/contracts.js';

export interface TranscriptWatcherOptions {
  debounceMs: number;
  pollMs: number;
  pageSize: number;
  maxRemembered: number;
}

export const DEFAULT_REMEMBERED_UUIDS = 500;

export const DEFAULT_WATCHER_OPTIONS: TranscriptWatcherOptions = {
  debounceMs: 500,
  pollMs: 10_000,
  pageSize: 50,
  maxRemembered: DEFAULT_REMEMBERED_UUIDS,
};

export interface TranscriptWatcherDeps {
  bus: EventBus;
  sessions: SessionService;
  log: Logger;
  /** Receives only items whose uuid was never delivered for that session. */
  deliver: (sessionId: string, items: TranscriptItemDTO[]) => void;
}

export interface TranscriptWatcher {
  /** Ref-counted. The first subscriber takes a silent baseline of the newest page and starts the fallback poll. */
  subscribe(sessionId: string): void;
  unsubscribe(sessionId: string): void;
  /** Items appended by another producer (bus 'transcript.appended'); they go through the same uuid diff. */
  ingest(sessionId: string, items: readonly TranscriptItemDTO[]): void;
  watched(): string[];
  close(): void;
}

interface WatchState {
  readonly gen: number;
  readonly refs: number;
  readonly sent: ReadonlySet<string>;
  readonly baselined: boolean;
  readonly inFlight: boolean;
  readonly again: boolean;
  readonly debounce: ReturnType<typeof setTimeout> | null;
  readonly poll: ReturnType<typeof setInterval>;
}

/** Bounded memory of delivered uuids, keeping the most recent `max`. */
export function remember(previous: ReadonlySet<string>, uuids: readonly string[], max: number): ReadonlySet<string> {
  const merged = [...previous, ...uuids.filter((uuid) => !previous.has(uuid))];
  return new Set(merged.slice(-max));
}

class Watcher implements TranscriptWatcher {
  private states: ReadonlyMap<string, WatchState> = new Map();
  private nextGen = 0;
  private closed = false;
  private readonly deps: TranscriptWatcherDeps;
  private readonly opts: TranscriptWatcherOptions;
  private readonly offs: ReadonlyArray<() => void>;

  constructor(deps: TranscriptWatcherDeps, opts: TranscriptWatcherOptions) {
    this.deps = deps;
    this.opts = opts;
    this.offs = [
      deps.bus.on('spool.event', ({ host, event }) => this.onSpool(host, event.tmux, event.session_id)),
      deps.bus.on('session.updated', (session) => this.trigger(session.id)),
    ];
  }

  subscribe(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state !== undefined) {
      this.patch(sessionId, { refs: state.refs + 1 });
      return;
    }
    this.nextGen += 1;
    const poll = setInterval(() => void this.refresh(sessionId), this.opts.pollMs);
    this.put(sessionId, {
      gen: this.nextGen,
      refs: 1,
      sent: new Set<string>(),
      baselined: false,
      inFlight: false,
      again: false,
      debounce: null,
      poll,
    });
    void this.refresh(sessionId);
  }

  unsubscribe(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state === undefined) return;
    if (state.refs > 1) {
      this.patch(sessionId, { refs: state.refs - 1 });
      return;
    }
    this.stop(sessionId, state);
  }

  ingest(sessionId: string, items: readonly TranscriptItemDTO[]): void {
    const state = this.states.get(sessionId);
    if (state === undefined) return;
    const fresh = items.filter((item) => !state.sent.has(item.uuid));
    if (fresh.length === 0) return;
    this.patch(sessionId, { sent: remember(state.sent, fresh.map((item) => item.uuid), this.opts.maxRemembered) });
    this.deps.deliver(sessionId, fresh);
  }

  watched(): string[] {
    return [...this.states.keys()];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.offs) off();
    for (const [sessionId, state] of [...this.states]) this.stop(sessionId, state);
  }

  private onSpool(host: HostId, tmux: string | null, claudeSessionId: string | null): void {
    const direct = tmux === null ? null : makeSessionId(host, tmux);
    for (const sessionId of [...this.states.keys()]) {
      const byClaudeId =
        claudeSessionId !== null && this.deps.sessions.get(sessionId)?.claudeSessionId === claudeSessionId;
      if (sessionId === direct || byClaudeId) this.trigger(sessionId);
    }
  }

  private trigger(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (state === undefined || state.debounce !== null) return;
    const debounce = setTimeout(() => {
      this.patch(sessionId, { debounce: null });
      void this.refresh(sessionId);
    }, this.opts.debounceMs);
    this.patch(sessionId, { debounce });
  }

  private async refresh(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (state === undefined) return;
    if (state.inFlight) {
      this.patch(sessionId, { again: true });
      return;
    }
    this.patch(sessionId, { inFlight: true, again: false });
    const items = await this.fetchPage(sessionId);
    this.finish(sessionId, state.gen, items);
  }

  private async fetchPage(sessionId: string): Promise<readonly TranscriptItemDTO[] | null> {
    try {
      return (await this.deps.sessions.transcript(sessionId, null, this.opts.pageSize)).items;
    } catch (err) {
      this.deps.log.warn({ err, sessionId }, 'transcript refresh failed');
      return null;
    }
  }

  private finish(sessionId: string, gen: number, items: readonly TranscriptItemDTO[] | null): void {
    const state = this.states.get(sessionId);
    if (state === undefined || state.gen !== gen) return;
    const fresh = items === null ? [] : items.filter((item) => !state.sent.has(item.uuid));
    const sent = items === null ? state.sent : remember(state.sent, items.map((item) => item.uuid), this.opts.maxRemembered);
    this.patch(sessionId, { inFlight: false, again: false, baselined: true, sent });
    if (state.baselined && fresh.length > 0) this.deps.deliver(sessionId, fresh);
    if (state.again) this.trigger(sessionId);
  }

  private stop(sessionId: string, state: WatchState): void {
    clearInterval(state.poll);
    if (state.debounce !== null) clearTimeout(state.debounce);
    this.states = new Map([...this.states].filter(([key]) => key !== sessionId));
  }

  private put(sessionId: string, state: WatchState): void {
    this.states = new Map<string, WatchState>([...this.states, [sessionId, state]]);
  }

  private patch(sessionId: string, change: Partial<WatchState>): void {
    const current = this.states.get(sessionId);
    if (current !== undefined) this.put(sessionId, { ...current, ...change });
  }
}

export function createTranscriptWatcher(
  deps: TranscriptWatcherDeps,
  opts: TranscriptWatcherOptions = DEFAULT_WATCHER_OPTIONS,
): TranscriptWatcher {
  return new Watcher(deps, opts);
}
