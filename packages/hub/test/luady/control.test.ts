import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { HubConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { Bootstrap, BootstrapReport } from '../../src/luady/bootstrap.js';
import { createManagerControl } from '../../src/luady/control.js';
import { createLuadySupervisor } from '../../src/luady/supervisor.js';
import { createFakeOutbound, silentLogger } from '../helpers/fakes.js';

const KIT = { path: '/srv/hub/mh/.luady/bin/luady-ctl', version: null, alias: null };
const report = (state: BootstrapReport['state']): BootstrapReport => ({ state, steps: [], kit: KIT, finishedAt: null });

function rig(enabled: boolean, opts: { ends?: boolean; leftover?: boolean } = {}) {
  const bus = createBus();
  let current: Settings = { ...DEFAULT_SETTINGS, manager_enabled: enabled };
  const settings = {
    get: () => current,
    update: (patch: Partial<Settings>) => {
      current = { ...current, ...patch };
      bus.emit('settings.updated', current);
      return current;
    },
  };
  let finish: (r: BootstrapReport) => void = () => undefined;
  const bootstrap: Bootstrap = {
    run: vi.fn(() => new Promise<BootstrapReport>((resolve) => {
      finish = resolve;
    })),
    report: () => report('idle'),
    prepareLaunch: async () => undefined,
  };
  const runtime = { activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => opts.ends ?? true) };
  const control = createManagerControl({
    settings, bus, log: silentLogger(), bootstrap, runtime: () => runtime, leftover: () => opts.leftover === true,
  });
  return { control, settings, runtime, finish: (r: BootstrapReport) => finish(r) };
}

describe('the manager switch: never a manager running while it says off or failed', () => {
  it('switched off while it was still setting up: the session (one left from before this start) is ended', async () => {
    const { control, settings, runtime, finish } = rig(true);
    await control.start();
    expect(control.state()).toBe('starting');
    settings.update({ manager_enabled: false });
    finish(report('done'));
    await control.settled();
    await control.settled();
    expect(control.state()).toBe('off');
    expect(runtime.activate).not.toHaveBeenCalled();
    expect(runtime.deactivate).toHaveBeenCalled();
  });

  it('a failed bootstrap ends a manager left running, and says failed', async () => {
    const { control, runtime, finish } = rig(true);
    await control.start();
    finish(report('failed'));
    await control.settled();
    expect(control.state()).toBe('failed');
    expect(runtime.activate).not.toHaveBeenCalled();
    expect(runtime.deactivate).toHaveBeenCalledTimes(1);
  });

  it('a switch that was off all along never touches the runtime (a new install runs no tmux)', async () => {
    const { control, runtime } = rig(false);
    await control.start();
    await control.settled();
    expect(control.state()).toBe('off');
    expect(runtime.deactivate).not.toHaveBeenCalled();
    expect(runtime.activate).not.toHaveBeenCalled();
  });

  it('a session that will not end leaves the switch failed, never a false off; nothing reaches it meanwhile', async () => {
    const { control, settings, runtime, finish } = rig(true, { ends: false });
    await control.start();
    finish(report('done'));
    await control.settled();
    expect(control.ready()).toBe(true);
    settings.update({ manager_enabled: false });
    await control.settled();
    expect(runtime.deactivate).toHaveBeenCalledTimes(1);
    expect(control.state()).toBe('failed');
    expect(control.ready()).toBe(false);
  });

  it('switched off at start with a tmux folder from an earlier run: a session left there is ended', async () => {
    const left = rig(false, { leftover: true });
    await left.control.start();
    await left.control.settled();
    expect(left.runtime.deactivate).toHaveBeenCalledTimes(1);
    expect(left.control.state()).toBe('off');
    const stuck = rig(false, { leftover: true, ends: false });
    await stuck.control.start();
    await stuck.control.settled();
    expect(stuck.control.state()).toBe('failed');
  });

  it('the hub stopping leaves a running manager as it is (only switching off ends it)', async () => {
    const { control, runtime, finish } = rig(true);
    await control.start();
    finish(report('done'));
    await control.settled();
    expect(control.state()).toBe('on');
    await control.stop();
    expect(runtime.deactivate).not.toHaveBeenCalled();
  });
});

describe('the supervisor prepares every launch', () => {
  it('does not launch when the files could not be written again before it', async () => {
    const calls: string[][] = [];
    const supervisor = createLuadySupervisor({
      config: { brainDir: '/srv/hub/brain', claudePath: '/srv/hub/bin/claude' } as HubConfig, db: openMemoryDb(), clock: { now: () => new Date() },
      log: silentLogger(), outbound: createFakeOutbound(), onStateChange: vi.fn(),
      settings: { get: () => DEFAULT_SETTINGS, update: vi.fn() },
      tmux: { run: async (args) => (calls.push(args), { code: args[0] === 'has-session' ? 1 : 0, stdout: '', stderr: '' }) },
      beforeLaunch: async () => {
        throw new Error('render failed');
      },
    });
    await supervisor.check();
    expect(calls.map((args) => args[0])).toEqual(['has-session']);
    expect(supervisor.state()).toBe('down');
  });
});
