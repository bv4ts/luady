import { describe, expect, it } from 'vitest';
import type { ActionKind } from '../../src/core/contracts.js';
import { ValidationError } from '../../src/core/errors.js';
import { ACTION_KINDS, DEFAULT_EXEC_CWD, parseActionParams } from '../../src/actions/params.js';

const SID = 'cedar:cc-meadow-hr:0.0';

const ACCEPTED: Array<{ name: string; kind: ActionKind; params: Record<string, unknown> }> = [
  { name: 'a start', kind: 'session.start', params: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', prompt: 'run tests', name: 'tests' } },
  { name: 'a send with a reason', kind: 'session.send', params: { sessionId: SID, text: 'hello', reason: 'owner asked' } },
  { name: 'a file write', kind: 'server.file_write', params: { server: 'ash', path: '/home/dev/projects/x/a.txt', content: '' } },
  { name: 'a terminal with a target', kind: 'terminal.open', params: { server: 'cedar', target: 'cc-meadow-hr:0.0' } },
  { name: 'a chat logout', kind: 'channel.unlink', params: {} },
];

const REJECTED: Array<{ name: string; kind: string; params: Record<string, unknown> }> = [
  { name: 'an unknown key', kind: 'session.interrupt', params: { sessionId: SID, pin: '123456' } },
  { name: 'the brain session', kind: 'session.stop', params: { sessionId: 'hq:manager:0.0' } },
  { name: 'a malformed session id', kind: 'session.send', params: { sessionId: 'meadow-hr', text: 'hi' } },
  { name: 'a cwd escaping the projects root', kind: 'session.start', params: { server: 'cedar', cwd: '/home/dev/projects/../.ssh' } },
  // The host's own projects folder (a look-alike such as /home/dev/projectsX) is the session service's check.
  { name: 'a climb out of the projects folder', kind: 'session.start', params: { server: 'cedar', cwd: '/home/dev/projects/../etc' } },
  { name: 'the VPS as a server', kind: 'server.exec', params: { server: 'hq', command: 'ls' } },
  { name: 'a relative exec cwd', kind: 'server.exec', params: { server: 'cedar', command: 'ls', cwd: 'projects' } },
  { name: 'an overlong command', kind: 'server.exec', params: { server: 'cedar', command: 'x'.repeat(4001) } },
  { name: 'a protected file write', kind: 'server.file_write', params: { server: 'cedar', path: '/home/dev/.ssh/authorized_keys', content: 'k' } },
  { name: 'a relative file write', kind: 'server.file_write', params: { server: 'cedar', path: 'notes.txt', content: 'k' } },
  { name: 'a bad terminal target', kind: 'terminal.open', params: { server: 'cedar', target: 'cc-x; rm' } },
  { name: 'an unknown kind', kind: 'server.reboot', params: {} },
];

describe('parseActionParams', () => {
  it('knows exactly the action kinds, with pause, resume, sign-in, sign-out, an answer, and the records', () => {
    expect([...ACTION_KINDS].sort()).toEqual([
      'account.login', 'account.logout', 'account.signed_in', 'channel.unlink',
      'host.add', 'host.edit', 'host.kit', 'host.local', 'host.pin', 'host.remove', 'kb.write', 'question.answer',
      'server.claude_update', 'server.exec', 'server.file_write',
      'session.delete', 'session.interrupt', 'session.pause', 'session.restart', 'session.resume', 'session.send', 'session.start',
      'session.stop', 'terminal.open',
    ]);
  });

  it('applies defaults', () => {
    expect(parseActionParams('server.exec', { server: 'birch', command: 'df -h' })).toEqual({
      kind: 'server.exec',
      params: { server: 'birch', command: 'df -h', cwd: DEFAULT_EXEC_CWD },
    });
    expect(parseActionParams('session.stop', { sessionId: SID })).toEqual({
      kind: 'session.stop',
      params: { sessionId: SID, force: false },
    });
  });

  it.for(ACCEPTED)('accepts $name', ({ kind, params }) => {
    expect(parseActionParams(kind, params).params).toMatchObject(params);
  });

  it.for(REJECTED)('rejects $name', ({ kind, params }) => {
    expect(() => parseActionParams(kind as ActionKind, params)).toThrow(ValidationError);
  });
});
