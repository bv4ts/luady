import { describe, expect, it, vi } from 'vitest';
import type { CtlPane, ServerDTO, SessionDTO } from '@luady/shared';
import { createPauseService } from '../../src/activity/pause.js';
import { CtlError, KitTooOldError, NotFoundError, RefusedError } from '../../src/core/errors.js';
import { createBus } from '../../src/core/bus.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';
import { createFakeFleet, serverDto } from '../fleet/fake-fleet.js';

const CEDAR = 'cedar:cc-meadow-hr:0.0';
const CEDAR_OTHER = 'cedar:cc-api:0.0';
const BIRCH = 'birch:cc-orchard:0.0';
const BRAIN = 'hq:manager:0.0';

function session(id: string, over: Partial<SessionDTO> = {}): SessionDTO {
  const [host, ...rest] = id.split(':');
  const target = rest.join(':');
  return {
    id, host: host as SessionDTO['host'], target, claudeSessionId: 'claude-1', cwd: '/home/dev/projects/x', project: 'x',
    displayName: target.replace(/^cc-/, '').replace(/:0\.0$/, ''), state: 'working', origin: 'owner', registered: true,
    lastEventAt: null, turnStartedAt: null, pendingQid: null, unexpectedEnd: false, ...over,
  };
}

function pane(target: string, paused?: boolean): CtlPane {
  return {
    target, tmux_session: target.split(':')[0] ?? target, pane_pid: 1, command: 'claude', cwd: '/home/dev/projects/x',
    is_claude: true, session_id: null, transcript_path: null, registered: true, pending_qid: null,
    ...(paused === undefined ? {} : { paused }),
  };
}

function kit(version: string | null, name: ServerDTO['name'] = 'cedar'): ServerDTO {
  return { ...serverDto(name), kitVersion: version };
}

function setup(options: { servers?: ServerDTO[]; sessions?: SessionDTO[]; ctl?: ReturnType<typeof createFakeCtl>; dialogs?: string[] } = {}) {
  const clock = createFakeClock('2026-10-09T12:00:00.000Z');
  const bus = createBus();
  const ctl = options.ctl ?? createFakeCtl();
  const birchCtl = createFakeCtl();
  const fleet = createFakeFleet({ cedar: ctl, birch: birchCtl, hq: createFakeCtl() });
  fleet.setServers(options.servers ?? [kit('2.0.0'), kit('2.0.0', 'birch')]);
  const all = options.sessions ?? [session(CEDAR), session(CEDAR_OTHER), session(BIRCH), session(BRAIN, { host: 'hq', origin: 'system' })];
  const sessions = {
    get: vi.fn((id: string) => all.find((item) => item.id === id)),
    dialogInTerminal: vi.fn((id: string) => (options.dialogs ?? []).includes(id)),
  };
  const pauses = createPauseService({ fleet, sessions: () => sessions, log: silentLogger(), clock, bus });
  const changes: string[] = [];
  pauses.onChange((id) => changes.push(id));
  return { ctl, birchCtl, fleet, pauses, changes, clock, bus };
}

const verbs = (ctl: ReturnType<typeof createFakeCtl>): string[] => ctl.calls.map((call) => call.method);

describe('pause', () => {
  it('pauses a session on a kit-2 server through its tmux target and tells the listeners once', async () => {
    const t = setup();
    await t.pauses.pause(CEDAR);
    expect(t.ctl.calls).toEqual([{ method: 'pause', args: ['cc-meadow-hr:0.0'] }]);
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
    expect(t.pauses.list()).toEqual([CEDAR]);
    expect(t.changes).toEqual([CEDAR]);
    await t.pauses.pause(CEDAR);
    expect(t.changes).toEqual([CEDAR]);
  });

  it.each([['1.0.0'], [null]])('refuses a server whose kit is %s with kit_too_old and runs no verb', async (version) => {
    const t = setup({ servers: [kit(version)] });
    const failure = await t.pauses.pause(CEDAR).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(KitTooOldError);
    expect(failure).toMatchObject({
      code: 'kit_too_old',
      message: "cedar's kit is older than 2.0.0 and cannot pause. Update the kit on cedar first.",
    });
    expect(t.ctl.calls).toEqual([]);
    expect(t.pauses.isPaused(CEDAR)).toBe(false);
  });

  it('maps a usage error from the verb (a kit-1 server not known yet) to kit_too_old', async () => {
    const ctl = createFakeCtl({ pause: async () => { throw new CtlError('usage', 'invalid choice: pause', 2); } });
    const t = setup({ ctl });
    await expect(t.pauses.pause(CEDAR)).rejects.toBeInstanceOf(KitTooOldError);
    expect(t.pauses.isPaused(CEDAR)).toBe(false);
    expect(t.changes).toEqual([]);
  });

  it('passes other kit errors through unchanged', async () => {
    const ctl = createFakeCtl({ pause: async () => { throw new CtlError('not_found', 'no pane cc-meadow-hr:0.0', 4); } });
    const t = setup({ ctl });
    await expect(t.pauses.pause(CEDAR)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses the brain session, an ended session and an unknown one', async () => {
    const t = setup({ sessions: [session(CEDAR, { state: 'ended' }), session(BRAIN, { host: 'hq', origin: 'system' })] });
    await expect(t.pauses.pause(BRAIN)).rejects.toThrow(new RefusedError('hq · manager cannot be paused'));
    await expect(t.pauses.pause(CEDAR)).rejects.toThrow(new RefusedError('cedar · meadow-hr cannot be paused'));
    await expect(t.pauses.pause('cedar:cc-nope:0.0')).rejects.toBeInstanceOf(NotFoundError);
    expect(t.ctl.calls).toEqual([]);
  });
});

describe('resume', () => {
  it('is refused while the session has a question waiting in its terminal: its line would land in that dialog', async () => {
    const t = setup({ dialogs: [CEDAR] });
    await t.pauses.pause(CEDAR);
    await expect(t.pauses.resume(CEDAR)).rejects.toThrow(new RefusedError(
      'cedar · meadow-hr has a question waiting in its terminal. Answer it there first: a message sent now would be typed into that dialog.',
    ));
    expect(verbs(t.ctl)).toEqual(['pause']);
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
  });

  it('clears the flag and returns what the kit reports', async () => {
    const t = setup();
    await t.pauses.pause(CEDAR);
    await expect(t.pauses.resume(CEDAR)).resolves.toEqual({ wasHit: true, sent: true });
    expect(verbs(t.ctl)).toEqual(['pause', 'resume']);
    expect(t.ctl.calls[1]?.args).toEqual(['cc-meadow-hr:0.0']);
    expect(t.pauses.isPaused(CEDAR)).toBe(false);
    expect(t.changes).toEqual([CEDAR, CEDAR]);
  });

  it('reports sent: false when the kit typed nothing', async () => {
    const ctl = createFakeCtl({ resume: async () => ({ ok: true, was_hit: false, sent: false }) });
    const t = setup({ ctl });
    await t.pauses.pause(CEDAR);
    await expect(t.pauses.resume(CEDAR)).resolves.toEqual({ wasHit: false, sent: false });
  });

  it('maps a usage error to kit_too_old and keeps the flag when the kit fails', async () => {
    const usage = createFakeCtl({ resume: async () => { throw new CtlError('usage', 'invalid choice: resume', 2); } });
    await expect(setup({ ctl: usage }).pauses.resume(CEDAR)).rejects.toBeInstanceOf(KitTooOldError);
    const failing = createFakeCtl({ resume: async () => { throw new CtlError('failed', 'ssh down', 255); } });
    const t = setup({ ctl: failing });
    await t.pauses.pause(CEDAR);
    await expect(t.pauses.resume(CEDAR)).rejects.toMatchObject({ code: 'failed' });
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
  });
});

describe('sync', () => {
  it("makes a host's set follow the kit's flags without touching other hosts", async () => {
    const t = setup();
    await t.pauses.pause(CEDAR);
    await t.pauses.pause(BIRCH);
    t.changes.splice(0);
    t.pauses.sync('cedar', [pane('cc-api:0.0', true), pane('cc-meadow-hr:0.0', false)]);
    expect(t.pauses.isPaused(CEDAR_OTHER)).toBe(true);
    expect(t.pauses.isPaused(CEDAR)).toBe(false);
    expect(t.pauses.isPaused(BIRCH)).toBe(true);
    expect([...t.changes].sort()).toEqual([CEDAR, CEDAR_OTHER].sort());
    t.pauses.sync('cedar', [pane('cc-api:0.0', true), pane('cc-meadow-hr:0.0', false)]);
    expect(t.changes).toHaveLength(2);
  });

  it('changes nothing for kit-1 rows (no paused key)', async () => {
    const t = setup({ servers: [kit('1.0.0'), kit('2.0.0', 'birch')] });
    t.pauses.sync('cedar', [pane('cc-api:0.0'), pane('cc-meadow-hr:0.0')]);
    expect(t.pauses.list()).toEqual([]);
    const k2 = setup();
    await k2.pauses.pause(CEDAR);
    k2.changes.splice(0);
    k2.fleet.setServers([kit('1.0.0'), kit('2.0.0', 'birch')]);
    k2.pauses.sync('cedar', [pane('cc-meadow-hr:0.0')]);
    expect(k2.pauses.isPaused(CEDAR)).toBe(true);
    expect(k2.changes).toEqual([]);
  });

  it('clears the flags of a kit-2 host that has no panes left', async () => {
    const t = setup();
    await t.pauses.pause(CEDAR);
    t.pauses.sync('cedar', []);
    expect(t.pauses.isPaused(CEDAR)).toBe(false);
  });

  it('a listener that throws does not stop the others', async () => {
    const t = setup();
    t.pauses.onChange(() => { throw new Error('boom'); });
    const later: string[] = [];
    const off = t.pauses.onChange((id) => later.push(id));
    await t.pauses.pause(CEDAR);
    expect(later).toEqual([CEDAR]);
    off();
    await t.pauses.resume(CEDAR);
    expect(later).toEqual([CEDAR]);
  });
});

describe('the pause hit and its release', () => {
  it('markHit holds only a session whose flag is set; a resume releases it with what the kit typed', async () => {
    const t = setup();
    const released: Array<[string, boolean]> = [];
    t.pauses.onReleased((id, sent) => released.push([id, sent]));
    t.pauses.markHit(CEDAR);
    expect(t.pauses.isHeld(CEDAR)).toBe(false);
    await t.pauses.pause(CEDAR);
    expect(t.pauses.isHeld(CEDAR)).toBe(false);
    t.pauses.markHit(CEDAR);
    expect(t.pauses.isHeld(CEDAR)).toBe(true);
    await t.pauses.resume(CEDAR);
    expect(released).toEqual([[CEDAR, true]]);
    expect(t.pauses.isHeld(CEDAR)).toBe(false);
    await t.pauses.pause(CEDAR);
    expect(t.pauses.isHeld(CEDAR)).toBe(false);
  });

  it('a resume that typed nothing releases with sent: false', async () => {
    const t = setup({ ctl: createFakeCtl({ resume: async () => ({ ok: true, was_hit: true, sent: false }) }) });
    const released: Array<[string, boolean]> = [];
    t.pauses.onReleased((id, sent) => released.push([id, sent]));
    await t.pauses.pause(CEDAR);
    t.pauses.markHit(CEDAR);
    await t.pauses.resume(CEDAR);
    expect(released).toEqual([[CEDAR, false]]);
  });

  it('a flag the kit no longer reports releases the session with sent: false', async () => {
    const t = setup();
    const released: Array<[string, boolean]> = [];
    t.pauses.onReleased((id, sent) => released.push([id, sent]));
    await t.pauses.pause(CEDAR);
    t.pauses.markHit(CEDAR);
    t.pauses.sync('cedar', [pane('cc-meadow-hr:0.0', false)]);
    expect(released).toEqual([[CEDAR, false]]);
    expect(t.pauses.isHeld(CEDAR)).toBe(false);
  });
});

describe('the pause set after a restart', () => {
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const flaggedGr = () => createFakeCtl({ sessions: async () => ({ sessions: [pane('cc-meadow-hr:0.0', true), pane('cc-api:0.0', false)] }) });

  it('start() reads the flags of every online server, and again when a server comes back online', async () => {
    const ctl = flaggedGr();
    const t = setup({ ctl });
    t.pauses.start();
    await settle();
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
    expect(ctl.calls.filter((call) => call.method === 'sessions')).toHaveLength(1);
    t.bus.emit('server.updated', { ...kit('2.0.0'), status: 'offline' });
    t.bus.emit('server.updated', kit('2.0.0'));
    await settle();
    expect(ctl.calls.filter((call) => call.method === 'sessions')).toHaveLength(2);
    t.pauses.stop();
    t.bus.emit('server.updated', { ...kit('2.0.0'), status: 'offline' });
    t.bus.emit('server.updated', kit('2.0.0'));
    await settle();
    expect(ctl.calls.filter((call) => call.method === 'sessions')).toHaveLength(2);
  });

  it('ensureSynced waits for the first snapshot of a host, then answers at once; the brain host needs none', async () => {
    const ctl = flaggedGr();
    const t = setup({ ctl });
    await t.pauses.ensureSynced('cedar');
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
    await t.pauses.ensureSynced('cedar');
    await t.pauses.ensureSynced('hq');
    expect(ctl.calls.filter((call) => call.method === 'sessions')).toHaveLength(1);
  });

  it('ensureSynced fails when the flags cannot be read, and tries again next time', async () => {
    let fail = true;
    const ctl = createFakeCtl({ sessions: async () => {
      if (fail) throw new CtlError('failed', 'cedar is not connected', -1);
      return { sessions: [pane('cc-meadow-hr:0.0', true)] };
    } });
    const t = setup({ ctl });
    await expect(t.pauses.ensureSynced('cedar')).rejects.toMatchObject({ code: 'failed' });
    fail = false;
    await t.pauses.ensureSynced('cedar');
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
  });

  it('a server that went offline must be read again before its next send', async () => {
    const ctl = flaggedGr();
    const t = setup({ ctl });
    t.pauses.start();
    await t.pauses.ensureSynced('cedar');
    t.bus.emit('server.updated', { ...kit('2.0.0'), status: 'offline' });
    await t.pauses.ensureSynced('cedar');
    expect(ctl.calls.filter((call) => call.method === 'sessions')).toHaveLength(2);
    t.pauses.stop();
  });

  it('a snapshot requested before a local pause or resume does not undo it', async () => {
    const t = setup();
    const before = t.clock.now().toISOString();
    t.clock.advance(1_000);
    await t.pauses.pause(CEDAR);
    t.pauses.sync('cedar', [pane('cc-meadow-hr:0.0', false)], before);
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
    t.clock.advance(1_000);
    const between = t.clock.now().toISOString();
    t.clock.advance(1_000);
    await t.pauses.resume(CEDAR);
    t.pauses.sync('cedar', [pane('cc-meadow-hr:0.0', true), pane('cc-api:0.0', true)], between);
    expect(t.pauses.isPaused(CEDAR)).toBe(false);
    expect(t.pauses.isPaused(CEDAR_OTHER)).toBe(true);
    t.clock.advance(1_000);
    t.pauses.sync('cedar', [pane('cc-meadow-hr:0.0', true)], t.clock.now().toISOString());
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
  });
});

describe('a session that runs again after the hit', () => {
  it('clearHit keeps the flag but ends the hold (the turn goes on); the next real stop marks it again', async () => {
    const t = setup();
    const released: Array<[string, boolean]> = [];
    t.pauses.onReleased((id, sent) => released.push([id, sent]));
    await t.pauses.pause(CEDAR);
    t.pauses.markHit(CEDAR);
    t.pauses.clearHit(CEDAR);
    t.pauses.clearHit(CEDAR);
    expect(released).toEqual([[CEDAR, true]]);
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
    expect(t.pauses.isHeld(CEDAR)).toBe(false);
    t.pauses.markHit(CEDAR);
    expect(t.pauses.isHeld(CEDAR)).toBe(true);
  });
});


describe('who paused', () => {
  it("Luady cannot lift the owner's pause: refused before the kit is asked", async () => {
    const t = setup();
    await t.pauses.pause(CEDAR, 'owner');
    expect(t.pauses.pausedBy(CEDAR)).toBe('owner');
    const failure = await t.pauses.resume(CEDAR, 'manager').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(RefusedError);
    expect((failure as Error).message).toBe('The owner paused this session; only the owner can resume it.');
    expect(verbs(t.ctl)).toEqual(['pause']);
    expect(t.pauses.isPaused(CEDAR)).toBe(true);
  });

  it('Luady resumes his own pause; the owner resumes anything', async () => {
    const t = setup();
    await t.pauses.pause(CEDAR, 'manager');
    expect(t.pauses.pausedBy(CEDAR)).toBe('manager');
    await t.pauses.resume(CEDAR, 'manager');
    expect(t.pauses.isPaused(CEDAR)).toBe(false);
    expect(t.pauses.pausedBy(CEDAR)).toBeNull();
    await t.pauses.pause(CEDAR_OTHER, 'manager');
    await t.pauses.resume(CEDAR_OTHER, 'owner');
    expect(t.pauses.isPaused(CEDAR_OTHER)).toBe(false);
  });

  it("Luady pausing a session the owner paused leaves it the owner's", async () => {
    const t = setup();
    await t.pauses.pause(CEDAR, 'owner');
    await t.pauses.pause(CEDAR, 'manager');
    expect(t.pauses.pausedBy(CEDAR)).toBe('owner');
    await expect(t.pauses.resume(CEDAR, 'manager')).rejects.toBeInstanceOf(RefusedError);
  });

  it("a pause the hub only learned from the kit (after a restart) counts as the owner's", () => {
    const t = setup();
    t.pauses.sync('cedar', [pane('cc-meadow-hr:0.0', true)]);
    expect(t.pauses.pausedBy(CEDAR)).toBe('owner');
    expect(t.pauses.pausedBy(CEDAR_OTHER)).toBeNull();
  });
});
