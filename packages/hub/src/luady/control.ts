import type { EventBus, Logger, SettingsService } from '../core/contracts.js';
import type { Bootstrap, BootstrapReport } from './bootstrap.js';

/**
 * The manager switch:
 * - `off`: `manager_enabled` is false (a new install). No bootstrap, no supervisor, no call to the self host;
 * - `starting`: switched on, the bootstrap is running;
 * - `on`: the bootstrap is done and the supervisor runs;
 * - `failed`: the bootstrap stopped at a step; the status route says which, and the next switch-on or start retries.
 */
export type ManagerState = 'off' | 'starting' | 'on' | 'failed';

export interface ManagerControl {
  state(): ManagerState;
  /** True only in `on`: the self host may be reached and the manager may be messaged. */
  ready(): boolean;
  /** The bootstrap's steps, or each step reported as "manager off" while the switch is off. */
  bootstrap(): BootstrapReport;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves once the current switch (on or off) has settled; for tests and the status route. */
  settled(): Promise<void>;
}

/** What the switch turns on and off: the manager service's supervisor (luady/service.ts). */
export interface ManagerRuntime {
  activate(): Promise<void>;
  /** Ends the manager's session; false when it could not be ended. */
  deactivate(): Promise<boolean>;
}

export interface ManagerControlDeps {
  readonly settings: SettingsService;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly bootstrap: Bootstrap;
  /** Late-bound: the manager service is built after the control. */
  readonly runtime: () => ManagerRuntime;
  /** Told whenever the state changes (the manager status event). */
  readonly onChange?: (state: ManagerState) => void;
  /** Whether the manager's own tmux folder exists: a session from an earlier run may be left there. */
  readonly leftover?: () => boolean;
}

/** "manager off" for every step: the bootstrap's checks are not failures while the switch is off. */
export function offReport(report: BootstrapReport): BootstrapReport {
  return { ...report, state: 'idle', steps: report.steps.map((step) => ({ id: step.id, state: 'skipped', detail: 'manager off' })) };
}

export function createManagerControl(deps: ManagerControlDeps): ManagerControl {
  let state: ManagerState = 'off';
  let chain: Promise<void> = Promise.resolve();
  let started = false;
  /** True while a switch-off ends the session: nothing reaches the manager meanwhile, and the state is not off yet. */
  let stopping = false;
  let off: (() => void) | null = null;
  const enabled = (): boolean => deps.settings.get().manager_enabled;

  function set(next: ManagerState): void {
    if (next === state) return;
    state = next;
    deps.log.info({ state }, 'manager: switch');
    deps.onChange?.(next);
  }

  async function turnOn(): Promise<void> {
    if (!started || !enabled() || state === 'on') return;
    set('starting');
    const report = await deps.bootstrap.run();
    // Switched off while the bootstrap ran: stay off. The hub stopping meanwhile: leave things as they are.
    if (!started) return;
    if (!enabled()) {
      await turnOff();
      return;
    }
    if (report.state !== 'done') {
      // A manager left running from before this start must not go on while the switch says it failed.
      set('failed');
      await end();
      return;
    }
    set('on');
    await deps.runtime().activate();
  }

  /**
   * Off from any state: the supervisor stops and the manager's own tmux session ends, also one left running from before
   * this start (switched off while it was still setting up, or after a failed bootstrap). Never called while the switch
   * was off all along, so a new install never runs tmux.
   */
  async function turnOff(): Promise<void> {
    if (state === 'off') return;
    set((await end()) ? 'off' : 'failed');
  }

  /** Ends the manager's session; a session that would not end leaves the switch failed, never a false off. */
  async function end(): Promise<boolean> {
    stopping = true;
    try {
      const ended = await deps.runtime().deactivate();
      if (!ended) set('failed');
      return ended;
    } finally {
      stopping = false;
    }
  }

  /** Every switch runs after the one before it, so on/off/on never overlap. */
  function queue(task: () => Promise<void>): Promise<void> {
    chain = chain.then(task).catch((err: unknown) => {
      deps.log.error({ err }, 'manager: switch failed');
      set('failed');
    });
    return chain;
  }

  function follow(): void {
    queue(async () => {
      if (enabled() && state !== 'on' && state !== 'starting') await turnOn();
      else if (!enabled() && state !== 'off') await turnOff();
    }).catch(() => undefined);
  }

  return {
    state: () => state,
    ready: () => state === 'on' && !stopping,
    bootstrap: () => (state === 'off' ? offReport(deps.bootstrap.report()) : deps.bootstrap.report()),
    async start() {
      if (started) return;
      started = true;
      // Switching starts or stops the manager at once (well within 30 s).
      off = deps.bus.on('settings.updated', () => follow());
      // Switched off, with a tmux folder from an earlier run: a session left there is ended (a new install has none,
      // so it runs no tmux).
      if (!enabled() && deps.leftover?.() === true) queue(async () => void (await end())).catch(() => undefined);
      // The hub does not wait for the bootstrap (a kit install can take a minute): the manager comes up on its own.
      follow();
    },
    /**
     * The hub stops: the switch stops following the settings and waits for a switch in progress. The manager's own tmux
     * session is left running (the supervisor finds it alive at the next start); only switching the
     * manager off ends it.
     */
    async stop() {
      if (!started) return;
      started = false;
      off?.();
      off = null;
      await chain;
    },
    settled: () => chain,
  };
}
