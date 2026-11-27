import { afterEach, describe, expect, it, vi } from 'vitest';
import { promptHash, type CtlPane, type HostId, type SpoolEvent } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { CtlClient, StartArgs, TranscriptWindow } from '../../src/core/contracts.js';
import { CtlError, NotFoundError, QuestionPendingError, RefusedError, SessionPausedError, ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createSessionService } from '../../src/sessions/service.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';
import { createFakeFleet, serverDto } from '../fleet/fake-fleet.js';
import {
  notification, permission, permissionResolved, prompt, question, questionResolved, report, sessionEnd, sessionStart, stop, stopFailure,
} from './spool-events.js';

const ID = 'cedar:cc-meadow-hr:0.0';
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function pane(target: string, over: Partial<CtlPane> = {}): CtlPane {
  return {
    target,
    tmux_session: target.split(':')[0] ?? target,
    pane_pid: 4242,
    command: 'claude',
    cwd: '/home/dev/projects/meadow-hr',
    is_claude: true,
    session_id: null,
    transcript_path: null,
    registered: false,
    pending_qid: null,
    ...over,
  };
}

interface PauseHooks {
  isPaused?: (sessionId: string) => boolean;
  pausedBy?: (sessionId: string) => 'owner' | 'manager' | null;
  isHeld?: (sessionId: string) => boolean;
  onReleased?: (listener: (sessionId: string, sent: boolean) => void) => () => void;
  ensureSynced?: (host: HostId) => Promise<void>;
  afterReconcile?: () => void;
  onPanes?: (host: HostId, panes: readonly CtlPane[], requestedAt: string) => void;
}

function setup(over: Partial<CtlClient> = {}, hooks: PauseHooks = {}) {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock('2026-10-09T12:00:00.000Z');
  const ctl = createFakeCtl(over);
  const fleet = createFakeFleet({ cedar: ctl });
  const service = createSessionService({
    db, bus, clock, fleet, memory: createMemoryService({ db, clock }), log: silentLogger(), ...hooks,
  });
  const updated: string[] = [];
  const ended: Array<{ unexpected: boolean; reason: string }> = [];
  const removed: string[] = [];
  bus.on('session.updated', (session) => updated.push(session.id));
  bus.on('session.ended', (event) => ended.push({ unexpected: event.unexpected, reason: event.reason }));
  bus.on('session.removed', (event) => removed.push(event.id));
  const ingest = (event: SpoolEvent, host: HostId = 'cedar'): void => bus.emit('spool.event', { host, event, replay: false });
  service.start();
  cleanups.push(() => service.stop());
  return { db, bus, clock, ctl, fleet, service, updated, ended, removed, ingest };
}

describe('createSessionService', () => {
  it('applies spool events once started and stops listening after stop()', () => {
    const { service, ingest } = setup();
    ingest(sessionStart('startup'));
    expect(service.list()).toEqual([expect.objectContaining({ id: ID, state: 'idle', claudeSessionId: 'claude-a', displayName: 'meadow-hr' })]);
    expect(service.get(ID)?.registered).toBe(true);
    service.stop();
    ingest(prompt('ignored after stop'));
    expect(service.get(ID)?.state).toBe('idle');
  });

  it('start() is idempotent', () => {
    const { service, ingest, updated } = setup();
    service.start();
    ingest(sessionStart('startup'));
    expect(updated).toEqual([ID]);
  });

  it('list hides the brain unless asked', () => {
    const { service, ingest } = setup();
    ingest(sessionStart('startup', { tmux: 'manager:0.0' }), 'hq');
    expect(service.list()).toEqual([]);
    expect(service.list({ includeSystem: true })).toEqual([expect.objectContaining({ id: 'hq:manager:0.0', origin: 'system' })]);
  });

  it('findByRef accepts ids, display names and host/name, refusing ambiguity', () => {
    const { service, ingest } = setup();
    ingest(sessionStart('startup'));
    ingest(sessionStart('startup', { tmux: 'cc-orchard:0.0', session_id: 'claude-b' }));
    ingest(sessionStart('startup', { tmux: 'cc-orchard:0.0', session_id: 'claude-c' }), 'birch');
    ingest(sessionStart('startup', { tmux: 'manager:0.0' }), 'hq');
    expect(service.findByRef(ID)?.id).toBe(ID);
    expect(service.findByRef('meadow-hr')?.id).toBe(ID);
    expect(service.findByRef(' Meadow-HR ')?.id).toBe(ID);
    expect(service.findByRef('orchard')).toBeUndefined();
    expect(service.findByRef('birch/orchard')?.id).toBe('birch:cc-orchard:0.0');
    expect(service.findByRef('manager')).toBeUndefined();
    expect(service.findByRef('nope')).toBeUndefined();
    ingest(sessionEnd('prompt_input_exit', { tmux: 'cc-orchard:0.0', session_id: 'claude-c' }), 'birch');
    expect(service.findByRef('orchard')?.id).toBe('cedar:cc-orchard:0.0');
  });

  it('send refuses while a question is pending', async () => {
    const { service, ingest, ctl } = setup();
    ingest(sessionStart('startup'));
    ingest(question('QQQQ2345', [{ question: 'Which DB?', options: [{ label: 'Postgres' }] }]));
    const failure = await service.send(ID, 'hello', 'test-channel').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(QuestionPendingError);
    expect(failure).toMatchObject({ qid: 'QQQQ2345' });
    expect(ctl.calls.some((call) => call.method === 'send')).toBe(false);
  });

  it('send refuses a paused session before anything is recorded or typed, saying who paused it', async () => {
    const { service, ingest, ctl, db } = setup({}, { isPaused: (id) => id === ID, pausedBy: () => 'owner' });
    ingest(sessionStart('startup'));
    const failure = await service.send(ID, 'hello', 'web').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SessionPausedError);
    expect(failure).toMatchObject({
      code: 'session_paused',
      message: 'cedar · meadow-hr was paused by the owner. Ask the owner before going on: only the owner can resume it.',
    });
    const byLuady = setup({}, { isPaused: (id) => id === ID, pausedBy: () => 'manager' });
    byLuady.ingest(sessionStart('startup'));
    await expect(byLuady.service.send(ID, 'hello', 'event')).rejects.toThrow('cedar · meadow-hr was paused by Luady. Resume it first.');
    expect(ctl.calls.some((call) => call.method === 'send')).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM injections').get()).toEqual({ n: 0 });
  });

  it('a turn held by a pause hit is reported when the pause is released without typing', () => {
    let held = true;
    let release: (sessionId: string, sent: boolean) => void = () => undefined;
    const finished: string[] = [];
    const { ingest, bus } = setup({}, {
      isHeld: () => held,
      onReleased: (listener) => {
        release = listener;
        return () => undefined;
      },
    });
    bus.on('turn.finished', (event) => finished.push(event.lastMessage));
    ingest(sessionStart('startup'));
    ingest(prompt('go'));
    ingest(stop('Stopped before the pause.'));
    expect(finished).toEqual([]);
    held = false;
    release(ID, false);
    expect(finished).toEqual(['Stopped before the pause.']);
  });

  it('send waits for the pause flags of its server (after a restart) before it checks and types', async () => {
    let paused = false;
    const order: string[] = [];
    const { service, ingest, ctl } = setup({}, {
      isPaused: () => paused,
      ensureSynced: async (host) => {
        order.push(`synced ${host}`);
        paused = true;
      },
    });
    ingest(sessionStart('startup'));
    await expect(service.send(ID, 'hello', 'web')).rejects.toBeInstanceOf(SessionPausedError);
    expect(order).toEqual(['synced cedar']);
    expect(ctl.calls.some((call) => call.method === 'send')).toBe(false);
  });

  it('send refuses while the pause flags of its server cannot be read', async () => {
    const { service, ingest, ctl } = setup({}, {
      ensureSynced: async () => {
        throw new CtlError('failed', 'cedar is not connected', -1);
      },
    });
    ingest(sessionStart('startup'));
    await expect(service.send(ID, 'hello', 'web')).rejects.toMatchObject({ code: 'failed' });
    expect(ctl.calls.some((call) => call.method === 'send')).toBe(false);
  });

  it('send records the injection and types through luady-ctl', async () => {
    const { service, ingest, ctl, db } = setup();
    ingest(sessionStart('startup'));
    await service.send(ID, 'run the tests', 'test-channel');
    expect(ctl.calls).toContainEqual({ method: 'send', args: ['cc-meadow-hr:0.0', 'run the tests'] });
    expect(db.prepare('SELECT session_id, text_sha256, channel FROM injections').all()).toEqual([
      { session_id: ID, text_sha256: promptHash('run the tests'), channel: 'test-channel' },
    ]);
    await expect(service.send('cedar:cc-nope:0.0', 'x', 'web')).rejects.toBeInstanceOf(NotFoundError);
    ingest(sessionEnd('prompt_input_exit'));
    await expect(service.send(ID, 'x', 'web')).rejects.toBeInstanceOf(RefusedError);
  });

  describe('after a question goes back to the terminal', () => {
    const DIALOG = 'cedar · meadow-hr has a question waiting in its terminal. Answer it there first: a message sent now would be typed into that dialog.';
    const sends = (ctl: ReturnType<typeof setup>['ctl']): number => ctl.calls.filter((call) => call.method === 'send').length;

    const asked = (): SpoolEvent => question('QQQQ2345', [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }]);
    it.each([
      ['an "Answer in terminal" release of a permission', () => permission('PPPP2345', 'Bash', 'cat [redacted]'), () => permissionResolved('PPPP2345', 'released')],
      ['a question that timed out', asked, () => questionResolved('QQQQ2345', 'timeout')],
      ['an allow the kit refused (error)', () => permission('PPPP2345', 'Bash', 'ls'), () => permissionResolved('PPPP2345', 'error')],
    ])('send and the dialog check refuse after %s, until the session shows the dialog is gone', async (_name, open, handBack) => {
      const { service, ingest, ctl } = setup();
      ingest(sessionStart('startup'));
      ingest(prompt('deploy it'));
      ingest(open());
      ingest(handBack());
      expect(service.dialogInTerminal?.(ID)).toBe(true);
      await expect(service.send(ID, 'go on', 'web')).rejects.toThrow(new RefusedError(DIALOG));
      ingest(notification('permission_prompt', 'Claude needs your permission to use Bash'));
      await expect(service.send(ID, 'go on', 'event')).rejects.toThrow(DIALOG);
      expect(sends(ctl)).toBe(0);
      ingest(stop('done'));
      expect(service.dialogInTerminal?.(ID)).toBe(false);
      await service.send(ID, 'go on', 'web');
      expect(sends(ctl)).toBe(1);
    });

    it.each([
      ['a new prompt', () => prompt('typed in the terminal')],
      ['a failure', () => stopFailure('rate_limit')],
      ['a new permission request', () => permission('RRRR2345', 'Bash', 'ls')],
      ['a report', () => report('ready')],
      ['a new Claude session', () => sessionStart('clear')],
    ])('%s shows the dialog is gone', (_name, next) => {
      const { service, ingest } = setup();
      ingest(sessionStart('startup'));
      ingest(questionResolved('QQQQ2345', 'released'));
      expect(service.dialogInTerminal?.(ID)).toBe(true);
      ingest(next());
      expect(service.dialogInTerminal?.(ID)).toBe(false);
    });

    it('an answer given remotely leaves nothing open, and another session is not affected', async () => {
      const { service, ingest } = setup();
      ingest(sessionStart('startup'));
      ingest(permissionResolved('PPPP2345', 'allowed'));
      ingest(questionResolved('QQQQ2345', 'answered'));
      expect(service.dialogInTerminal?.(ID)).toBe(false);
      ingest(questionResolved('QQQQ2345', 'released', { tmux: 'cc-other:0.0' }));
      expect(service.dialogInTerminal?.(ID)).toBe(false);
      expect(service.dialogInTerminal?.('cedar:cc-other:0.0')).toBe(true);
    });
  });

  it('start launches cc-<name> under the projects root', async () => {
    const starts: StartArgs[] = [];
    const { service, db } = setup({
      start: async (args) => {
        starts.push(args);
        return { ok: true, target: `cc-${args.name}:0.0` };
      },
    });
    const dto = await service.start({ server: 'cedar', cwd: '/home/dev/projects/orchard', prompt: 'run the tests', origin: 'manager' });
    expect(starts).toEqual([{ name: 'orchard', cwd: '/home/dev/projects/orchard', prompt: 'run the tests' }]);
    expect(dto).toMatchObject({ id: 'cedar:cc-orchard:0.0', state: 'starting', origin: 'manager', displayName: 'orchard', registered: false });
    expect(db.prepare('SELECT channel FROM injections WHERE session_id = ?').get('cedar:cc-orchard:0.0')).toEqual({ channel: 'event' });
    for (const cwd of ['/etc', '/home/dev/projects', '/home/dev/projects/../secret', '/home/dev/projectsX/a']) {
      await expect(service.start({ server: 'cedar', cwd, origin: 'owner' })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(starts).toHaveLength(1);
  });

  it('start keeps the row SessionStart created while luady-ctl was starting', async () => {
    let onStart: (name: string) => void = () => undefined;
    const env = setup({
      start: async (args) => {
        onStart(args.name);
        return { ok: true, target: `cc-${args.name}:0.0` };
      },
    });
    onStart = (name) => env.ingest(sessionStart('startup', { tmux: `cc-${name}:0.0`, session_id: 'claude-new' }));
    const dto = await env.service.start({ server: 'cedar', cwd: '/home/dev/projects/orchard', origin: 'manager' });
    expect(dto).toMatchObject({ state: 'idle', claudeSessionId: 'claude-new', origin: 'manager', registered: true });
  });

  it('interrupt, restart and stop drive luady-ctl', async () => {
    const { service, ingest, ctl, clock, ended } = setup();
    ingest(sessionStart('startup'));
    await service.interrupt(ID);
    expect(ctl.calls).toContainEqual({ method: 'keys', args: ['cc-meadow-hr:0.0', 'Escape'] });
    clock.advance(60_000);
    await service.restart(ID);
    expect(ctl.calls).toContainEqual({ method: 'restart', args: ['cc-meadow-hr:0.0'] });
    expect(service.get(ID)?.state).toBe('starting');
    await service.stop(ID, false);
    expect(ctl.calls).toContainEqual({ method: 'stop', args: ['cc-meadow-hr:0.0', false] });
    expect(service.get(ID)?.state).toBe('ended');
    expect(ended).toEqual([{ unexpected: false, reason: 'stopped' }]);
  });

  it('restart reopens an ended session (server rebooted) in its own conversation, or respawns when tmux still has it', async () => {
    const { service, ingest, ctl, clock } = setup();
    ingest(sessionStart('startup'));
    await service.stop(ID, false);
    clock.advance(60_000);
    await service.restart(ID);
    expect(ctl.calls).toContainEqual({
      method: 'start', args: [{ name: 'meadow-hr', cwd: '/home/dev/projects/meadow-hr', resume: 'claude-a' }],
    });
    expect(ctl.calls.some((c) => c.method === 'restart')).toBe(false);
    expect(service.get(ID)?.state).toBe('starting');

    const kept = setup({ start: async () => { throw new CtlError('refused', 'tmux session cc-meadow-hr already exists', 1); } });
    kept.ingest(sessionStart('startup'));
    await kept.service.stop(ID, false);
    await kept.service.restart(ID);
    expect(kept.ctl.calls).toContainEqual({ method: 'restart', args: ['cc-meadow-hr:0.0'] });
  });

  it('remove trashes the transcript and deletes the row', async () => {
    const { service, ingest, ctl, removed } = setup();
    ingest(sessionStart('startup'));
    await service.remove(ID);
    expect(ctl.calls).toContainEqual({ method: 'remove', args: ['claude-a'] });
    expect(service.get(ID)).toBeUndefined();
    expect(removed).toEqual([ID]);
    ingest(prompt('hello', { tmux: 'cc-x:0.0' }));
    await expect(service.remove('cedar:cc-x:0.0')).rejects.toBeInstanceOf(RefusedError);
  });

  it('reconciliation adds unknown Claude panes and ends vanished ones', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { service, ingest, fleet, ended } = setup({
      sessions: async () => ({
        sessions: [pane('cc-new:0.0', { session_id: 'claude-n' }), pane('cc-shell:0.0', { is_claude: false, command: 'bash' })],
      }),
    });
    fleet.setServers([serverDto('cedar', 'online')]);
    ingest(sessionStart('startup', { tmux: 'cc-old:0.0', ts: '2026-10-09T11:50:00.000Z' }));
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(service.get('cedar:cc-new:0.0')).toMatchObject({ state: 'idle', registered: false, claudeSessionId: 'claude-n', origin: 'owner' });
    expect(service.get('cedar:cc-shell:0.0')).toBeUndefined();
    expect(service.get('cedar:cc-old:0.0')).toMatchObject({ state: 'ended', unexpectedEnd: true });
    expect(ended).toEqual([{ unexpected: true, reason: 'pane_gone' }]);
  });

  it('reconciliation hands every sessions() reply to onPanes with its host', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const rows = [pane('cc-a:0.0', { paused: true }), pane('cc-b:0.0', { paused: false })];
    const seen: Array<{ host: HostId; panes: readonly CtlPane[]; requestedAt: string }> = [];
    const { fleet } = setup({ sessions: async () => ({ sessions: rows }) }, {
      onPanes: (host, panes, requestedAt) => seen.push({ host, panes, requestedAt }),
    });
    fleet.setServers([serverDto('cedar', 'online')]);
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(seen).toEqual([
      { host: 'cedar', panes: rows, requestedAt: '2026-10-09T12:00:00.000Z' },
      { host: 'hq', panes: [], requestedAt: '2026-10-09T12:00:00.000Z' },
    ]);
  });

  it('reconciliation runs afterReconcile once per pass, after every host', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const order: string[] = [];
    const { fleet } = setup({ sessions: async () => ({ sessions: [] }) }, {
      onPanes: (host) => order.push(`panes ${host}`),
      afterReconcile: () => order.push('after'),
    });
    fleet.setServers([serverDto('cedar', 'online')]);
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(order).toEqual(['panes cedar', 'panes hq', 'after']);
  });

  it('reconciliation skips offline servers and survives failures', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let calls = 0;
    const { fleet } = setup({
      sessions: async () => {
        calls += 1;
        return { sessions: [] };
      },
    });
    fleet.setServers([serverDto('cedar', 'offline')]);
    fleet.setClient('hq', createFakeCtl({ sessions: async () => { throw new Error('luady-ctl missing'); } }));
    await vi.advanceTimersByTimeAsync(15_000);
    await settle();
    expect(calls).toBe(0);
  });

  it('transcript and condensed read through luady-ctl', async () => {
    const chunk = `${JSON.stringify({ type: 'user', uuid: 'u-1', timestamp: '2026-10-09T12:00:00.000Z', message: { role: 'user', content: 'hello there' } })}\n`;
    const windows: TranscriptWindow[] = [];
    const { service, ingest } = setup({
      transcript: async (_sessionId, window) => {
        windows.push(window);
        return { path: '/t.jsonl', size: chunk.length, from: 0, to: chunk.length, data: chunk };
      },
    });
    ingest(sessionStart('startup'));
    await expect(service.transcript(ID, null, 10)).resolves.toEqual({
      items: [{ uuid: 'u-1', role: 'user', text: 'hello there', ts: '2026-10-09T12:00:00.000Z', toolName: null }],
      nextCursor: null,
    });
    await expect(service.condensed(ID, 5)).resolves.toBe('[user] hello there');
    expect(windows).toHaveLength(2);
    ingest(prompt('x', { tmux: 'cc-x:0.0' }));
    await expect(service.transcript('cedar:cc-x:0.0', null, 10)).resolves.toEqual({ items: [], nextCursor: null });
    await expect(service.transcript('cedar:cc-nope:0.0', null, 10)).rejects.toBeInstanceOf(NotFoundError);
  });
});
