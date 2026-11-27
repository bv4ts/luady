import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@luady/shared';
import type { Clock, Db, HubConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createLuadySupervisor } from '../../src/luady/supervisor.js';
import type { TmuxRunner } from '../../src/luady/types.js';
import { LUADY_CRASH_NOTICE } from '../../src/notify/format.js';
import { createFakeOutbound, silentLogger } from '../../test/helpers/fakes.js';

const T0 = '2026-10-09T12:00:00.000Z'; // Fri 16:00 in owner time
const clock: Clock = { now: () => new Date() };
const SESSION_UUID = '0f8e2a4c-1111-4222-8333-944455556666';
const config = {
  brainDir: '/home/luady/brain', claudePath: '/home/luady/.local/bin/claude',
} as unknown as HubConfig;
const EXPECTED_ARGV = [
  'new-session', '-d', '-s', 'manager', '-c', '/home/luady/brain', '--', '/home/luady/.local/bin/claude',
  // Project and local settings in the brain are never read.
  '--restricted', '--setting-sources', 'user', '--settings', '/home/luady/brain/.manager/settings.json', '--mcp-config', '/home/luady/brain/.manager/mcp.json',
  '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disallowedTools', 'AskUserQuestion', '--model', 'opus',
  '--effort', 'high', '--remote-control', 'Luady',
];

function fakeTmux(initial: { alive?: boolean; command?: string; launchCode?: number } = {}) {
  const state = { alive: false, command: 'claude', launchCode: 0, ...initial };
  const calls: string[][] = [];
  const runner: TmuxRunner = {
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'has-session') return { code: state.alive ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: `${state.command}\n`, stderr: '' };
      return { code: args[0] === 'new-session' ? state.launchCode : 0, stdout: '', stderr: '' };
    },
  };
  const launches = (): string[][] => calls.filter((c) => c[0] === 'new-session');
  return { runner, calls, state, launches };
}

function setup(opts: { tmux?: ReturnType<typeof fakeTmux>; settings?: Partial<Settings>; db?: Db } = {}) {
  const db = opts.db ?? openMemoryDb();
  const tmux = opts.tmux ?? fakeTmux();
  const outbound = createFakeOutbound();
  const onStateChange = vi.fn();
  const supervisor = createLuadySupervisor({
    config, db, clock, log: silentLogger(), outbound, tmux: tmux.runner, onStateChange,
    settings: { get: () => ({ ...DEFAULT_SETTINGS, ...opts.settings }), update: vi.fn() },
  });
  return { db, tmux, outbound, onStateChange, supervisor };
}

function luadyState(db: Db) {
  return db.prepare('SELECT claude_session_id, started_at FROM manager_state WHERE id = 1').get();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createLuadySupervisor', () => {
  it('launches the brain with the exact argv when no session exists', async () => {
    const t = setup();
    await t.supervisor.start();
    expect(t.tmux.launches()).toEqual([EXPECTED_ARGV]);
    expect(t.supervisor.state()).toBe('starting');
    expect(t.onStateChange).toHaveBeenCalledWith('starting');
    expect(luadyState(t.db)).toEqual({ claude_session_id: null, started_at: T0 });
    t.supervisor.stop();
  });

  it('adds --resume only when manager_state.started_at is in the current Luady day (04:00 to 04:00 owner time)', async () => {
    const today = openMemoryDb();
    today.prepare('UPDATE manager_state SET claude_session_id = ?, started_at = ? WHERE id = 1').run(SESSION_UUID, '2026-10-09T00:30:00.000Z');
    const resumed = setup({ db: today });
    await resumed.supervisor.start();
    expect(resumed.tmux.launches()).toEqual([[...EXPECTED_ARGV, '--resume', SESSION_UUID]]);
    expect(luadyState(today)).toEqual({ claude_session_id: SESSION_UUID, started_at: '2026-10-09T00:30:00.000Z' });
    resumed.supervisor.stop();

    const yesterday = openMemoryDb();
    yesterday.prepare('UPDATE manager_state SET claude_session_id = ?, started_at = ? WHERE id = 1').run(SESSION_UUID, '2026-10-08T23:59:00.000Z');
    const fresh = setup({ db: yesterday });
    await fresh.supervisor.start();
    expect(fresh.tmux.launches()).toEqual([EXPECTED_ARGV]);
    fresh.supervisor.stop();
  });

  it('adopts an already running brain without launching', async () => {
    const t = setup({ tmux: fakeTmux({ alive: true }) });
    await t.supervisor.start();
    expect(t.supervisor.state()).toBe('running');
    expect(t.tmux.launches()).toEqual([]);
    t.supervisor.stop();
  });

  it('kills a pane that dropped to a shell and relaunches', async () => {
    const t = setup({ tmux: fakeTmux({ alive: true, command: 'bash' }) });
    await t.supervisor.start();
    expect(t.tmux.calls.map((c) => c[0])).toEqual(['has-session', 'display-message', 'kill-session', 'new-session']);
    t.supervisor.stop();
  });

  it('invalid manager_model falls back to opus', async () => {
    const t = setup({ settings: { manager_model: '--dangerously-skip-permissions' } });
    await t.supervisor.start();
    const argv = t.tmux.launches()[0] ?? [];
    expect(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2)).toEqual(['--model', 'opus']);
    expect(argv).not.toContain('--dangerously-skip-permissions');
    t.supervisor.stop();
  });

  it('turns starting into running on markReady or after the 60 s grace', async () => {
    const ready = setup();
    await ready.supervisor.start();
    ready.supervisor.markReady();
    expect(ready.supervisor.state()).toBe('running');
    ready.supervisor.stop();

    const grace = setup();
    await grace.supervisor.start();
    grace.tmux.state.alive = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(grace.supervisor.state()).toBe('starting');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(grace.supervisor.state()).toBe('running');
    grace.supervisor.stop();
  });

  it('notifies once and backs off for 10 minutes after 3 crashes in 10 minutes', async () => {
    const t = setup();
    await t.supervisor.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.tmux.launches()).toHaveLength(3);
    expect(t.outbound.sent.map((s) => s.text)).toEqual([LUADY_CRASH_NOTICE]);
    expect(t.supervisor.state()).toBe('down');
    await vi.advanceTimersByTimeAsync(570_000);
    expect(t.tmux.launches()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.tmux.launches()).toHaveLength(4);
    expect(t.outbound.sent).toHaveLength(1);
    t.supervisor.stop();
  });

  it('counts failed launches as crashes', async () => {
    const t = setup({ tmux: fakeTmux({ launchCode: 1 }) });
    await t.supervisor.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.tmux.launches()).toHaveLength(3);
    expect(t.outbound.sent.map((s) => s.text)).toEqual([LUADY_CRASH_NOTICE]);
    expect(t.supervisor.state()).toBe('down');
    t.supervisor.stop();
  });

  it('stop() halts the health loop', async () => {
    const t = setup({ tmux: fakeTmux({ alive: true }) });
    await t.supervisor.start();
    const before = t.tmux.calls.length;
    t.supervisor.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.tmux.calls).toHaveLength(before);
  });
});
