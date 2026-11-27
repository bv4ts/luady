import { describe, expect, it, vi } from 'vitest';
import type { CtlExec } from '@luady/shared';
import { EXEC_OUTPUT_MAX, EXEC_TIMEOUT_SEC, execFolder, executeAction, formatExecResult } from '../../src/actions/execute.js';
import { parseActionParams } from '../../src/actions/params.js';
import type { ActionKind, CtlClient, SessionService } from '../../src/core/contracts.js';
import { CtlError, RefusedError, ValidationError } from '../../src/core/errors.js';
import { createTicketStore } from '../../src/security/tickets.js';
import { createFakeClock, createFakeCtl } from '../../test/helpers/fakes.js';
import { SID, createFleetStub, createPausesStub, createSessionsStub, createChannelStub } from './stubs.js';

function setup(ctlOver: Partial<CtlClient> = {}) {
  const fleet = createFleetStub(createFakeCtl(ctlOver));
  const sessions = createSessionsStub();
  const channel = createChannelStub();
  const tickets = createTicketStore(createFakeClock());
  const pauses = createPausesStub();
  return { fleet, sessions, channel, tickets, pauses, deps: { fleet, sessions, channel, tickets, pauses } };
}

const AS_LUADY = { actor: 'manager' as const, channel: 'event' as const };
const AS_OWNER = { actor: 'owner' as const, channel: 'web' as const };

const SESSION_CALLS: Array<{ kind: ActionKind; params: Record<string, unknown>; method: keyof SessionService; args: unknown[]; result: string }> = [
  { kind: 'session.send', params: { sessionId: SID, text: 'continue' }, method: 'send', args: [SID, 'continue', 'event'], result: 'sent' },
  { kind: 'session.interrupt', params: { sessionId: SID }, method: 'interrupt', args: [SID], result: 'interrupted' },
  { kind: 'session.stop', params: { sessionId: SID }, method: 'stop', args: [SID, false], result: 'stopped' },
  { kind: 'session.stop', params: { sessionId: SID, force: true }, method: 'stop', args: [SID, true], result: 'stopped (forced)' },
  { kind: 'session.restart', params: { sessionId: SID }, method: 'restart', args: [SID], result: 'restarted' },
  { kind: 'session.delete', params: { sessionId: SID }, method: 'remove', args: [SID], result: 'deleted; transcript moved to trash (restorable for 7 days)' },
];

describe('executeAction', () => {
  it.for(SESSION_CALLS)('$kind calls SessionService.$method', async ({ kind, params, method, args, result }) => {
    const t = setup();
    await expect(executeAction(parseActionParams(kind, params), AS_LUADY, t.deps)).resolves.toBe(result);
    expect(t.sessions[method]).toHaveBeenCalledWith(...args);
  });

  it('pauses and resumes through the pause service, saying who asked', async () => {
    const t = setup();
    await expect(executeAction(parseActionParams('session.pause', { sessionId: SID }), AS_LUADY, t.deps)).resolves.toBe('paused');
    expect(t.pauses.pause).toHaveBeenCalledWith(SID, 'manager');
    await expect(executeAction(parseActionParams('session.resume', { sessionId: SID }), AS_LUADY, t.deps)).resolves.toBe('resumed');
    expect(t.pauses.resume).toHaveBeenCalledWith(SID, 'manager');
    await executeAction(parseActionParams('session.resume', { sessionId: SID }), AS_OWNER, t.deps);
    expect(t.pauses.resume).toHaveBeenLastCalledWith(SID, 'owner');
    vi.mocked(t.pauses.resume).mockResolvedValueOnce({ wasHit: false, sent: false });
    await expect(executeAction(parseActionParams('session.resume', { sessionId: SID }), AS_LUADY, t.deps))
      .resolves.toBe('pause lifted; the agent was still working');
    vi.mocked(t.pauses.resume).mockResolvedValueOnce({ wasHit: true, sent: false });
    await expect(executeAction(parseActionParams('session.resume', { sessionId: SID }), AS_LUADY, t.deps))
      .resolves.toBe('pause lifted; the agent was idle');
    expect(t.sessions.send).not.toHaveBeenCalled();
  });

  it('starts a session with the actor as origin', async () => {
    const t = setup();
    const action = parseActionParams('session.start', { server: 'cedar', cwd: '/home/dev/projects/mission', prompt: 'go', name: 'mission' });
    await expect(executeAction(action, AS_LUADY, t.deps)).resolves.toBe('started cedar:cc-mission:0.0 (mission)');
    expect(t.sessions.start).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'cedar', cwd: '/home/dev/projects/mission', prompt: 'go', name: 'mission', origin: 'manager' }),
    );
  });

  it('runs exec with a 120 s timeout and formats the result', async () => {
    const exec = vi.fn(async (): Promise<CtlExec> => ({ exit: 0, stdout: 'Filesystem  Size\n', stderr: '', truncated: false, timed_out: false }));
    const t = setup({ exec });
    const action = parseActionParams('server.exec', { server: 'birch', command: 'df -h' });
    await expect(executeAction(action, AS_LUADY, t.deps)).resolves.toBe('exit 0\nstdout:\nFilesystem  Size\n');
    expect(t.fleet.client).toHaveBeenCalledWith('birch');
    expect(exec).toHaveBeenCalledWith('df -h', '/home/dev', EXEC_TIMEOUT_SEC);
  });

  it('writes files, updates Claude Code and unlinks the chat channel', async () => {
    const fileWrite = vi.fn(async () => ({ ok: true as const, bytes: 5 }));
    const updateClaude = vi.fn(async () => ({ before: '2.1.295', after: '2.1.300', output: '' }));
    const t = setup({ fileWrite, updateClaude });
    const write = parseActionParams('server.file_write', { server: 'ash', path: '/home/dev/projects/x/a.txt', content: 'hello' });
    await expect(executeAction(write, AS_LUADY, t.deps)).resolves.toBe('wrote 5 bytes to ash:/home/dev/projects/x/a.txt');
    expect(fileWrite).toHaveBeenCalledWith('/home/dev/projects/x/a.txt', 'hello');
    const update = parseActionParams('server.claude_update', { server: 'ash' });
    await expect(executeAction(update, AS_LUADY, t.deps)).resolves.toBe('Claude Code on ash: 2.1.295 → 2.1.300');
    await expect(executeAction(parseActionParams('channel.unlink', {}), AS_LUADY, t.deps)).resolves.toBe('chat channel unlinked');
    expect(t.channel.unlink).toHaveBeenCalledTimes(1);
  });

  it('opens a terminal by issuing a single-use ticket bound to the website session that asked', async () => {
    const t = setup();
    const action = parseActionParams('terminal.open', { server: 'cedar', target: 'cc-meadow-hr:0.0' });
    const ticket = await executeAction(action, { actor: 'owner', channel: 'web', sid: 'sid-asking' }, t.deps);
    expect(ticket).toMatch(/^[a-f0-9]{64}$/);
    expect(t.tickets.consume(ticket, 'sid-other')).toBeNull();
    const again = await executeAction(action, { actor: 'owner', channel: 'web', sid: 'sid-asking' }, t.deps);
    expect(t.tickets.consume(again, 'sid-asking')).toEqual({ server: 'cedar', target: 'cc-meadow-hr:0.0' });
  });

  it('issues no terminal ticket without a website session to bind it to', async () => {
    const t = setup();
    const action = parseActionParams('terminal.open', { server: 'cedar' });
    await expect(executeAction(action, { actor: 'owner', channel: 'web' }, t.deps)).rejects.toBeInstanceOf(RefusedError);
    await expect(executeAction(action, AS_LUADY, t.deps)).rejects.toBeInstanceOf(RefusedError);
  });

  it('propagates execution errors', async () => {
    const fileWrite = vi.fn(async () => {
      throw new CtlError('refused', 'path is protected', 3);
    });
    const t = setup({ fileWrite });
    const write = parseActionParams('server.file_write', { server: 'cedar', path: '/home/dev/projects/x/a.txt', content: 'x' });
    await expect(executeAction(write, AS_LUADY, t.deps)).rejects.toBeInstanceOf(CtlError);
  });
});

describe('executeAction: accounts', () => {
  const accounts = () => ({ login: vi.fn(async () => 'sign-in started'), logout: vi.fn(async () => 'signed out') });

  it('account.logout for the self host calls the login service sign-out through the accounts dependency', async () => {
    const t = setup();
    const deps = { ...t.deps, accounts: accounts() };
    await expect(executeAction(parseActionParams('account.logout', { target: 'hq' }), AS_OWNER, deps)).resolves.toBe('signed out');
    expect(deps.accounts.logout).toHaveBeenCalledWith('hq');
    await expect(executeAction(parseActionParams('account.login', { target: 'cedar' }), AS_OWNER, deps)).resolves.toBe('sign-in started');
    expect(deps.accounts.login).toHaveBeenCalledWith('cedar', 'web');
  });

  it('refuses when the hub has no accounts dependency', async () => {
    const t = setup();
    await expect(executeAction(parseActionParams('account.logout', { target: 'cedar' }), AS_OWNER, t.deps)).rejects.toThrow('Sign-in is not available');
  });
});

describe('formatExecResult', () => {
  it('clips each stream to 4000 characters and lists the flags', () => {
    const text = formatExecResult({ exit: 124, stdout: 'a'.repeat(5000), stderr: 'oops', truncated: true, timed_out: true });
    expect(text.startsWith('exit 124 (timed out, output truncated by server)\nstdout:\n')).toBe(true);
    expect(text).toContain(`${'a'.repeat(EXEC_OUTPUT_MAX)}\n… (1000 more chars)\nstderr:\noops`);
    expect(text).not.toContain('a'.repeat(EXEC_OUTPUT_MAX + 1));
  });

  it('omits empty streams', () => {
    expect(formatExecResult({ exit: 1, stdout: '', stderr: '', truncated: false, timed_out: false })).toBe('exit 1');
  });
});

describe('execFolder: where a command without a folder runs (no fixed path)', () => {
  const fleetWith = (info: { homeDir: string | null; projectsRoot: string | null } | null) =>
    ({ hostInfo: () => (info === null ? null : { id: 'mars', kind: 'ssh' as const, terminal: true, ...info }) });

  it('is the host\'s own home, else its projects folder, and refuses when neither is known', () => {
    expect(execFolder(fleetWith({ homeDir: '/home/mars', projectsRoot: '/srv/work' }), 'mars')).toBe('/home/mars');
    expect(execFolder(fleetWith({ homeDir: null, projectsRoot: '/srv/work' }), 'mars')).toBe('/srv/work');
    expect(() => execFolder(fleetWith({ homeDir: null, projectsRoot: null }), 'mars')).toThrow(/No folder is known on mars/);
    expect(() => execFolder(fleetWith(null), 'mars')).toThrow(ValidationError);
  });
});
