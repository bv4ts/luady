import { posix } from 'node:path';
import { SELF_HOST_ID } from '@luady/shared';
import type { HubConfig, Logger } from '../core/contracts.js';
import { installRoot, managerHomeOf, managerTmuxDir, selfCtlPath } from '../config/defaults.js';
import { ensureDir } from '../config/files.js';
import { managerEnv } from '../fleet/local-env.js';
import { installLocalKit, installedKitAlias, installedKitVersion, releaseKitVersion, type LocalKitOptions } from '../fleet/local-kit.js';
import { seedBrain } from './brain-seed.js';
import { acceptFolderTrust, renderManagerFiles, writeHubToken } from './render.js';

/** The bootstrap's steps, in order: each idempotent, logged and reported through the status route. */
export const BOOTSTRAP_STEPS = ['folders', 'brain', 'render', 'token', 'kit', 'trust'] as const;
export type BootstrapStep = (typeof BOOTSTRAP_STEPS)[number];
export type StepState = 'pending' | 'done' | 'skipped' | 'failed';

export interface StepReport {
  readonly id: BootstrapStep;
  readonly state: StepState;
  /** What the step did or why it failed, in plain words; never a secret. */
  readonly detail: string | null;
}

export interface SelfKitReport {
  /** The self host's luady-ctl: derived, never configured. */
  readonly path: string;
  readonly version: string | null;
  readonly alias: string | null;
}

export interface BootstrapReport {
  readonly state: 'idle' | 'running' | 'done' | 'failed';
  readonly steps: readonly StepReport[];
  readonly kit: SelfKitReport;
  readonly finishedAt: string | null;
}

export interface BootstrapDeps {
  readonly config: HubConfig;
  readonly log: Logger;
  readonly now: () => Date;
  /** The kit installer; `installLocalKit` in the hub (tests and the preview pass their own, or null to skip the step). */
  readonly installKit: ((options: LocalKitOptions) => Promise<{ version: string }>) | null;
  /** The install root (brain templates, the kit, the MCP entry). */
  readonly root?: string;
}

export interface Bootstrap {
  /** Runs every step in order; stops at the first failure. Safe to run again: a done step changes nothing. */
  run(): Promise<BootstrapReport>;
  report(): BootstrapReport;
  /**
   * Before every launch (the daily rotation and every relaunch included): the rendered files and the token file are
   * written again from the release, so nothing changed in them since survives into a new manager.
   */
  prepareLaunch(): Promise<void>;
}

const pendingSteps = (): StepReport[] => BOOTSTRAP_STEPS.map((id) => ({ id, state: 'pending', detail: null }));

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * The manager bootstrap: its folders, its brain, its rendered config, its token file, its own kit
 * under its home (with the self host's alias and no settings merge, re-run only when the kit version changes) and the
 * pre-accepted folder trust. Its tmux server needs only `<managerHome>/tmux`: the runner and the self host's executor
 * carry HOME and TMUX_TMPDIR (fleet/local-env.ts).
 */
export function createBootstrap(deps: BootstrapDeps): Bootstrap {
  const root = deps.root ?? installRoot();
  const managerHome = managerHomeOf(deps.config);
  const log = deps.log.child({ mod: 'manager-bootstrap' });
  let current: BootstrapReport = { state: 'idle', steps: pendingSteps(), kit: { path: selfCtlPath(managerHome), version: null, alias: null }, finishedAt: null };
  let running: Promise<BootstrapReport> | null = null;

  async function kitStep(): Promise<{ state: StepState; detail: string }> {
    const wanted = await releaseKitVersion(root);
    const [version, alias] = await Promise.all([installedKitVersion(managerHome), installedKitAlias(managerHome)]);
    if (wanted !== null && version === wanted && alias === SELF_HOST_ID) return { state: 'done', detail: `kit ${version} already installed` };
    if (deps.installKit === null) return { state: 'skipped', detail: 'no kit installer here (a test or the preview)' };
    const summary = await deps.installKit({
      projectsRoot: deps.config.brainDir, claudeBin: deps.config.claudePath, home: managerHome, alias: SELF_HOST_ID, skipSettings: true,
      env: managerEnv(managerHome), root,
    });
    return { state: 'done', detail: `kit ${summary.version} installed` };
  }

  const steps: Readonly<Record<BootstrapStep, () => Promise<{ state: StepState; detail: string }>>> = {
    folders: async () => {
      for (const dir of [managerHome, deps.config.brainDir, managerTmuxDir(managerHome)]) ensureDir(dir);
      return { state: 'done', detail: 'folders ready (0700)' };
    },
    brain: async () => {
      const seeded = seedBrain(posix.join(root, 'brain'), deps.config.brainDir);
      for (const { path, backup } of seeded.backedUp) log.warn({ path, backup }, 'manager: a changed release file was kept aside before the new copy');
      return { state: 'done', detail: `${seeded.created.length} created, ${seeded.replaced.length} replaced, ${seeded.backedUp.length} kept as .bak` };
    },
    render: async () => {
      const changed = renderManagerFiles(deps.config, { root });
      return { state: 'done', detail: changed.length === 0 ? 'up to date' : `wrote ${changed.join(', ')}` };
    },
    token: async () => ({ state: 'done', detail: writeHubToken(deps.config) ? 'written' : 'up to date' }),
    kit: kitStep,
    trust: async () => ({ state: 'done', detail: acceptFolderTrust(managerHome, deps.config.brainDir) ? 'folder trust accepted' : 'up to date' }),
  };

  async function kitReport(): Promise<SelfKitReport> {
    const [version, alias] = await Promise.all([installedKitVersion(managerHome), installedKitAlias(managerHome)]);
    return { path: selfCtlPath(managerHome), version, alias };
  }

  async function runAll(): Promise<BootstrapReport> {
    const reports: StepReport[] = [];
    current = { ...current, state: 'running', steps: pendingSteps(), finishedAt: null };
    for (const id of BOOTSTRAP_STEPS) {
      try {
        const outcome = await steps[id]();
        reports.push({ id, ...outcome });
        log.info({ step: id, state: outcome.state, detail: outcome.detail }, 'manager bootstrap step');
      } catch (err) {
        reports.push({ id, state: 'failed', detail: message(err) });
        log.error({ step: id, err: message(err) }, 'manager bootstrap step failed');
        break;
      }
      current = { ...current, steps: [...reports, ...pendingSteps().slice(reports.length)] };
    }
    const failed = reports.some((step) => step.state === 'failed');
    const final = [...reports, ...pendingSteps().slice(reports.length)];
    current = { state: failed ? 'failed' : 'done', steps: final, kit: await kitReport(), finishedAt: deps.now().toISOString() };
    return current;
  }

  return {
    run() {
      running ??= runAll().finally(() => {
        running = null;
      });
      return running;
    },
    report: () => current,
    async prepareLaunch() {
      const changed = renderManagerFiles(deps.config, { root });
      if (changed.length > 0) log.warn({ files: changed }, 'manager: rendered files differed before the launch and were written again');
      writeHubToken(deps.config);
    },
  };
}

/** The hub's kit installer for the bootstrap: `installLocalKit`, its lines logged at debug level. */
export function hubKitInstaller(log: Logger): (options: LocalKitOptions) => Promise<{ version: string }> {
  return (options) => installLocalKit(options, (line) => log.debug({ line }, 'manager kit install'));
}

/**
 * The bootstrap of a hub whose manager runs on a fake tmux (tests and the preview): there is no real Claude Code to
 * prepare for, so no file is written and nothing is spawned. Every step reports why it was skipped.
 */
export function skippedBootstrap(config: HubConfig, reason: string, now: () => Date): Bootstrap {
  const report: BootstrapReport = {
    state: 'done',
    steps: BOOTSTRAP_STEPS.map((id) => ({ id, state: 'skipped', detail: reason })),
    kit: { path: selfCtlPath(managerHomeOf(config)), version: null, alias: null },
    finishedAt: null,
  };
  return {
    run: async () => ({ ...report, finishedAt: now().toISOString() }),
    report: () => report,
    prepareLaunch: async () => undefined,
  };
}
