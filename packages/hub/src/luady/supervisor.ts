import { managerHomeOf } from '../config/defaults.js';
import type { Clock, Db, HubConfig, Logger, OutboundChannel, SettingsService } from '../core/contracts.js';
import { LUADY_CRASH_NOTICE } from '../notify/format.js';
import { LUADY_TARGET, LUADY_TMUX_SESSION, buildStartArgs, readLuadyState, recordLaunch, resumeIdFor, safeModel } from './launch.js';
import type { TmuxRunner } from './types.js';

export type SupervisorState = 'starting' | 'running' | 'down';

export const HEALTH_INTERVAL_MS = 30_000;
export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASH_LIMIT = 3;
export const BACKOFF_MS = 10 * 60_000;
export const STARTING_GRACE_MS = 60_000;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish']);
const STDERR_LOG_MAX = 500;

export interface SupervisorDeps {
  config: HubConfig;
  db: Db;
  clock: Clock;
  log: Logger;
  settings: SettingsService;
  outbound: OutboundChannel;
  tmux: TmuxRunner;
  onStateChange(state: SupervisorState): void;
  /** Runs before every launch (the manager's rendered files written again, luady/bootstrap.ts); a failure stops it. */
  beforeLaunch?: () => Promise<void>;
}

export interface LuadySupervisor {
  start(): Promise<void>;
  stop(): void;
  state(): SupervisorState;
  markReady(): void;
  check(): Promise<void>;
}

type Health = 'alive' | 'shell' | 'missing';

/** The manager's home: loadConfig always sets it; a config built by hand without a data folder has none. */
function managerHomeOrNull(config: Partial<Pick<HubConfig, 'managerHome' | 'dataDir'>>): string | null {
  return config.managerHome === undefined && config.dataDir === undefined ? null : managerHomeOf(config as Pick<HubConfig, 'managerHome' | 'dataDir'>);
}

export function createLuadySupervisor(deps: SupervisorDeps): LuadySupervisor {
  let current: SupervisorState = 'down';
  let timer: NodeJS.Timeout | null = null;
  let started = false;
  let checking = false;
  let launchedAt: number | null = null;
  let crashes: number[] = [];
  let backoffUntil = 0;

  function setState(next: SupervisorState): void {
    if (next === current) return;
    current = next;
    deps.onStateChange(next);
  }

  async function probe(): Promise<Health> {
    // '=' = exact name: tmux would otherwise take any session that merely starts with "manager" as the brain.
    const has = await deps.tmux.run(['has-session', '-t', `=${LUADY_TMUX_SESSION}`]);
    if (has.code !== 0) return 'missing';
    const pane = await deps.tmux.run(['display-message', '-p', '-t', `=${LUADY_TARGET}`, '#{pane_current_command}']);
    return SHELLS.has(pane.stdout.trim()) ? 'shell' : 'alive';
  }

  function onAlive(now: number): void {
    if (current === 'down') setState('running');
    else if (current === 'starting' && launchedAt !== null && now - launchedAt >= STARTING_GRACE_MS) setState('running');
  }

  async function launch(now: number, health: Health): Promise<void> {
    if (health === 'shell') await deps.tmux.run(['kill-session', '-t', `=${LUADY_TMUX_SESSION}`]);
    try {
      await deps.beforeLaunch?.();
    } catch (err) {
      deps.log.error({ err }, 'luady: not launched, its files could not be prepared');
      crashes = [...crashes, now];
      return;
    }
    const resumeId = resumeIdFor(readLuadyState(deps.db), new Date(now));
    const settings = deps.settings.get();
    const model = safeModel(settings.manager_model, deps.log);
    const result = await deps.tmux.run(buildStartArgs({ ...deps.config, managerHome: managerHomeOrNull(deps.config) }, model, settings.manager_effort, resumeId));
    if (result.code !== 0) {
      deps.log.error({ code: result.code, stderr: result.stderr.slice(0, STDERR_LOG_MAX) }, 'luady: launch failed');
      crashes = [...crashes, now];
      return;
    }
    recordLaunch(deps.db, new Date(now).toISOString(), resumeId !== null);
    launchedAt = now;
    setState('starting');
  }

  async function notifyCrashLoop(): Promise<void> {
    deps.log.error('luady: crashed 3 times in 10 minutes, backing off for 10 minutes');
    try {
      await deps.outbound.send(LUADY_CRASH_NOTICE, null);
    } catch (err) {
      deps.log.error({ err }, 'luady: crash notice failed');
    }
  }

  async function onDead(now: number, health: Health): Promise<void> {
    const wasUp = current !== 'down' || launchedAt !== null;
    crashes = crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (wasUp) crashes = [...crashes, now];
    launchedAt = null;
    setState('down');
    if (now < backoffUntil) return;
    if (crashes.length >= CRASH_LIMIT) {
      backoffUntil = now + BACKOFF_MS;
      crashes = [];
      await notifyCrashLoop();
      return;
    }
    await launch(now, health);
  }

  async function check(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const now = deps.clock.now().getTime();
      const health = await probe();
      if (health === 'alive') onAlive(now);
      else await onDead(now, health);
    } catch (err) {
      deps.log.error({ err }, 'luady: health check failed');
    } finally {
      checking = false;
    }
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    await check();
    if (!started) return;
    timer = setInterval(() => void check(), HEALTH_INTERVAL_MS);
  }

  function stop(): void {
    started = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  return { start, stop, state: () => current, markReady: () => setState('running'), check };
}
