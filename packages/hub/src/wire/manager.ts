import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { managerHomeOf, managerTmuxDir } from '../config/defaults.js';
import { runGraphify } from '../daily/graphify.js';
import { createDailyJobs } from '../daily/jobs.js';
import { isoNow } from '../core/time.js';
import { managerEnv } from '../fleet/local-env.js';
import { createBootstrap, hubKitInstaller, skippedBootstrap } from '../luady/bootstrap.js';
import { createManagerControl, type ManagerControl } from '../luady/control.js';
import { DEFAULT_GATHER } from '../luady/gather.js';
import { createLuadyService, type ManagedLuadyService } from '../luady/service.js';
import { createScheduler } from '../scheduler/service.js';
import type { WireContext, Wired } from './context.js';

/**
 * The manager service as the context carries it: the service with its `managerState()`, plus the switch (also under its
 * own context key, `managerControl`, which the fleet and the status route read).
 */
export type ProvidedManager = ManagedLuadyService & { managerReady(): boolean; managerControl: ManagerControl };

/**
 * Manager: the manager switch and its bootstrap, the manager service, the scheduler and the
 * daily jobs (their updaters and the brief's data read from the context at call time). While `manager_enabled` is off
 * nothing of the manager runs: no bootstrap, no supervisor, no scheduled task, no digest, brief or rotation, and the
 * fleet never reaches the self host.
 */
export function wireManager(ctx: WireContext): Wired {
  const { config, overrides } = ctx;
  const db = ctx.get('db');
  const bus = ctx.get('bus');
  const clock = ctx.get('clock');
  const log = ctx.get('log');
  const settings = ctx.get('settings');
  const missions = ctx.get('missions');
  const claudeLogin = ctx.get('claudeLogin');
  const now = (): Date => clock.now();
  // A manager on a fake tmux (tests, the preview) has no real Claude Code to prepare: no file, no spawn.
  const bootstrap = overrides.tmux !== undefined
    ? skippedBootstrap(config, 'the manager runs on a fake tmux here', now)
    : createBootstrap({ config, log, now, installKit: overrides.fleet === undefined ? hubKitInstaller(log) : null });
  const control = ctx.provide('managerControl', createManagerControl({
    settings, bus, log, bootstrap,
    runtime: () => service,
    onChange: () => bus.emit('manager.status', service.status()),
    leftover: () => existsSync(managerTmuxDir(managerHomeOf(config))),
  }));
  const service = createLuadyService({
    config, db, bus, clock, log, fleet: ctx.get('fleet'), settings, outbound: ctx.get('ownerChannel'), notices: ctx.get('notices'),
    memory: ctx.get('memory'), tmux: overrides.tmux,
    tmuxEnv: managerEnv(managerHomeOf(config)),
    active: () => control.ready(),
    beforeLaunch: () => bootstrap.prepareLaunch(),
    isManaged: (sessionId) => missions.isManaged(sessionId),
    // While the manager's own sign-in is out, everything meant for it waits in its queue (claude-login/service.ts).
    signedOut: () => claudeLogin.brainSignedOut() === true,
    phone: ctx.later('phone'),
    gather: DEFAULT_GATHER,
  });
  const provided: ProvidedManager = { ...service, managerReady: () => control.ready(), managerControl: control };
  const luady = ctx.provide('luady', provided);
  const scheduler = ctx.provide('scheduler', createScheduler({
    db, clock, log, luady, onChange: () => bus.emit('schedules.changed', { at: isoNow(clock) }), active: () => control.ready(),
  }));
  const daily = ctx.provide('daily', createDailyJobs({
    db, clock, log, settings, luady, brainDir: config.brainDir, managerReady: () => control.ready(),
    claudeUpdate: (day, at) => ctx.get('claudeUpdater').run(day, at),
    updateTools: async () => ctx.get('updateTools')(),
    briefData: async () => {
      const google = ctx.get('google');
      const imap = ctx.get('imap');
      const parts = [
        google === null ? null : await google.briefData().catch(() => 'Google data unavailable this morning.'),
        imap === null ? null : `## ${imap.label} mailbox (new, not newsletters)\n${(await imap.briefLines().catch(() => ['- unavailable'])).join('\n') || '- none'}`,
        `## To-do\n${ctx.get('todos').render()}`,
        `## Open missions\n${missions.list().join('\n') || '- none'}`,
      ];
      return parts.filter((part): part is string => part !== null).join('\n\n');
    },
    graphify: () => runGraphify({
      fleet: ctx.get('fleet'), projects: ctx.get('projects'), sessions: ctx.get('sessions'), brainDir: config.brainDir,
      log: log.child({ mod: 'graphify' }),
    }),
  }));
  return {
    name: 'manager',
    services: { luady, scheduler },
    web: { luady, scheduler, manager: control },
    tools: {
      scheduler,
      inboxDir: posix.join(config.brainDir, 'inbox'),
      workspaceDir: posix.join(config.brainDir, 'workspace'),
    },
    async start(phase) {
      if (phase !== 'services') return;
      await ctx.start('manager', async () => {
        await luady.start();
        await control.start();
      });
      await ctx.start('scheduler', () => scheduler.start());
      await ctx.start('daily', () => daily.start());
    },
    async stop(phase) {
      if (phase !== 'services') return;
      await ctx.stop('daily', () => daily.stop());
      await ctx.stop('scheduler', () => scheduler.stop());
      await ctx.stop('manager', async () => {
        await control.stop();
        await luady.stop();
      });
    },
  };
}
