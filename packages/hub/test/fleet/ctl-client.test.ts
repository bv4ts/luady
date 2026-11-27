import { describe, expect, it } from 'vitest';
import type { CtlClient, CtlKey } from '../../src/core/contracts.js';
import { CtlError, ValidationError } from '../../src/core/errors.js';
import { shQuote } from '../../src/core/ids.js';
import { buildCommandLine } from '../../src/fleet/command-line.js';
import { AUTH_LOGOUT_TIMEOUT_MS, KB_PUT_TIMEOUT_MS, PROJECTS_TIMEOUT_MS, createCtlClient } from '../../src/fleet/ctl-client.js';
import type { ExecResult } from '../../src/fleet/executor.js';
import { createFakeExecutor, okJson } from './fake-executor.js';

const CANNED: Record<string, unknown> = {
  version: { kit: '1.0.0', claude: '2.1.295', tmux: '3.4', python: '3.12.3' },
  sysinfo: { load1: 0.5, load5: 0.4, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 5_700_000, uptime_s: 3600 },
  sessions: { sessions: [] },
  pending: { pending: [] },
  answer: { ok: true },
  permission: { ok: true },
  send: { ok: true },
  keys: { ok: true },
  start: { ok: true, target: 'cc-health:0.0' },
  stop: { ok: true, forced: true },
  restart: { ok: true },
  delete: { ok: true, trashed: '/home/dev/.luady/trash/20261009-sid-1.jsonl' },
  transcript: { path: '/home/dev/.claude/projects/x/sid-1.jsonl', size: 8, from: 0, to: 8, data: '{"a":1}\n' },
  capture: { text: 'pane text' },
  'update-claude': { before: '2.1.295', after: '2.1.296', output: 'Updated' },
  projects: { projects: [] },
  exec: { exit: 0, stdout: 'ok', stderr: '', truncated: false, timed_out: false },
  'file-read': { path: '/home/dev/a.txt', size: 2, content: 'hi', truncated: false },
  'file-write': { ok: true, bytes: 3 },
  config: { remote_answering: true, hook_wait_seconds: 7200, host_alias: 'cedar' },
  pause: { ok: true, paused: true },
  resume: { ok: true, was_hit: true, sent: false },
  'auth-logout': { ok: true, message: 'Signed out', logged_in: false, email: null, expires_at: null },
  skills: { skills: [{ name: 'cc-prompt', description: 'Write a brief.', source: 'user', path: '/home/dev/.claude/skills/cc-prompt/SKILL.md' }] },
  'kb-put': { written: 2, removed: 1 },
  'git-status': { projects: [{ path: '/home/dev/projects/x', name: 'x', branch: 'main', dirty: false, ahead: 0, behind: 0, lastCommitAt: null }] },
};

function cannedExecutor() {
  return createFakeExecutor((args) => okJson(CANNED[args[0] ?? '']));
}

function clientReturning(result: ExecResult): CtlClient {
  return createCtlClient(createFakeExecutor(() => result));
}

interface VerbCase {
  name: string;
  run: (client: CtlClient) => Promise<unknown>;
  args: string[];
  stdin?: string;
}

const PROJECT_DIR = '/home/dev/projects/meadow-hr';

const VERB_CASES: VerbCase[] = [
  { name: 'version', run: (c) => c.version(), args: ['version'] },
  { name: 'sysinfo', run: (c) => c.sysinfo(), args: ['sysinfo'] },
  { name: 'sessions', run: (c) => c.sessions(), args: ['sessions'] },
  { name: 'pending', run: (c) => c.pending(), args: ['pending'] },
  {
    name: 'answer',
    run: (c) => c.answer('QQQQ2345', { answers: { 'Which DB?': 'Postgres' } }),
    args: ['answer', '--qid', 'QQQQ2345'],
    stdin: '{"answers":{"Which DB?":"Postgres"}}',
  },
  { name: 'release', run: (c) => c.answer('QQQQ2345', { release: true }), args: ['answer', '--qid', 'QQQQ2345'], stdin: '{"release":true}' },
  {
    name: 'permission',
    run: (c) => c.permission('QQQQ2345', { behavior: 'deny', message: 'not now' }),
    args: ['permission', '--qid', 'QQQQ2345'],
    stdin: '{"behavior":"deny","message":"not now"}',
  },
  { name: 'keys', run: (c) => c.keys('cc-x:0.0', 'Escape'), args: ['keys', '--target', 'cc-x:0.0', '--key', 'Escape'] },
  {
    name: 'start',
    run: (c) => c.start({ name: 'health', cwd: PROJECT_DIR, model: 'opus', resume: 'sid-1', prompt: 'add /health' }),
    args: ['start', '--name', 'health', '--cwd', PROJECT_DIR, '--model', 'opus', '--resume', 'sid-1'],
    stdin: 'add /health',
  },
  {
    name: 'start without prompt',
    run: (c) => c.start({ name: 'health', cwd: PROJECT_DIR }),
    args: ['start', '--name', 'health', '--cwd', PROJECT_DIR],
    stdin: '',
  },
  { name: 'stop', run: (c) => c.stop('cc-x:0.0', true), args: ['stop', '--target', 'cc-x:0.0', '--force'] },
  { name: 'restart', run: (c) => c.restart('cc-x:0.0'), args: ['restart', '--target', 'cc-x:0.0'] },
  { name: 'remove', run: (c) => c.remove('sid-1'), args: ['delete', '--session', 'sid-1'] },
  { name: 'transcript tail', run: (c) => c.transcript('sid-1', { tail: 4096 }), args: ['transcript', '--session', 'sid-1', '--tail', '4096'] },
  {
    name: 'transcript before',
    run: (c) => c.transcript('sid-1', { before: 9000, max: 4096 }),
    args: ['transcript', '--session', 'sid-1', '--before', '9000', '--max', '4096'],
  },
  {
    name: 'transcript from',
    run: (c) => c.transcript('sid-1', { from: 10, max: 100 }),
    args: ['transcript', '--session', 'sid-1', '--from', '10', '--max', '100'],
  },
  { name: 'capture', run: (c) => c.capture('cc-x:0.0', 50), args: ['capture', '--target', 'cc-x:0.0', '--lines', '50'] },
  { name: 'update-claude', run: (c) => c.updateClaude(), args: ['update-claude'] },
  { name: 'projects', run: (c) => c.projects(), args: ['projects'] },
  {
    name: 'exec',
    run: (c) => c.exec('git status', PROJECT_DIR, 30),
    args: ['exec', '--cwd', PROJECT_DIR, '--timeout', '30'],
    stdin: 'git status',
  },
  { name: 'file-read', run: (c) => c.fileRead('/home/dev/a.txt', 100), args: ['file-read', '--path', '/home/dev/a.txt', '--max', '100'] },
  { name: 'file-write', run: (c) => c.fileWrite('/home/dev/a.txt', 'hi\n'), args: ['file-write', '--path', '/home/dev/a.txt'], stdin: 'hi\n' },
  { name: 'config get', run: (c) => c.getConfig(), args: ['config', '--get'] },
  { name: 'config set', run: (c) => c.setConfig('hook_wait_seconds', '7200'), args: ['config', '--set', 'hook_wait_seconds=7200'] },
  { name: 'pause', run: (c) => c.pause('cc-x:0.0'), args: ['pause', '--target', 'cc-x:0.0'] },
  { name: 'resume', run: (c) => c.resume('cc-x:0.0'), args: ['resume', '--target', 'cc-x:0.0'] },
  { name: 'auth-logout', run: (c) => c.authLogout(), args: ['auth-logout'] },
  { name: 'skills', run: (c) => c.skills(), args: ['skills'] },
  {
    name: 'kb-put',
    run: (c) => c.kbPut([{ path: 'INDEX.md', content: '# Index' }], true),
    args: ['kb-put'],
    stdin: '{"files":[{"path":"INDEX.md","content":"# Index"}],"prune":true}',
  },
  { name: 'git-status', run: (c) => c.gitStatus(), args: ['git-status'] },
];

describe('createCtlClient', () => {
  it.each(VERB_CASES)('$name builds the expected argv and stdin', async ({ run, args, stdin }) => {
    const executor = cannedExecutor();
    await run(createCtlClient(executor));
    expect(executor.execs).toHaveLength(1);
    expect(executor.execs[0]?.args).toEqual(args);
    expect(executor.execs[0]?.opts.stdin).toBe(stdin);
  });

  it('send passes text on stdin only', async () => {
    const executor = cannedExecutor();
    const text = 'مرحبا يا Claude 👋🏽\nsecond line with "double" and \'single\' quotes\n$(rm -rf ~) `whoami` ${HOME} \\n done';
    await createCtlClient(executor).send('cc-meadow-hr:0.0', text);
    const call = executor.execs[0];
    expect(call?.args).toEqual(['send', '--target', 'cc-meadow-hr:0.0']);
    expect(Buffer.from(call?.opts.stdin ?? '', 'utf8').equals(Buffer.from(text, 'utf8'))).toBe(true);
    const line = buildCommandLine('~/.luady/bin/luady-ctl', call?.args ?? []);
    expect(line).toBe(`~/.luady/bin/luady-ctl ${['send', '--target', 'cc-meadow-hr:0.0'].map((arg) => shQuote(arg)).join(' ')}`);
    for (const fragment of ['مرحبا', '👋', '$(', '`', 'whoami', '${HOME}', '\n', 'double']) {
      expect(line).not.toContain(fragment);
    }
  });

  it('pause and resume parse the kit replies and check the target', async () => {
    const client = createCtlClient(cannedExecutor());
    await expect(client.pause('cc-x:0.0')).resolves.toEqual({ ok: true, paused: true });
    await expect(client.resume('cc-x:0.0')).resolves.toEqual({ ok: true, was_hit: true, sent: false });
    await expect(client.pause('cc-x; rm -rf ~')).rejects.toBeInstanceOf(ValidationError);
  });

  it('auth-logout waits 45 seconds and returns the sign-in state afterwards', async () => {
    const executor = cannedExecutor();
    const result = await createCtlClient(executor).authLogout();
    expect(result).toEqual({ ok: true, message: 'Signed out', logged_in: false, email: null, expires_at: null });
    expect(executor.execs[0]?.opts.timeoutMs).toBe(AUTH_LOGOUT_TIMEOUT_MS);
    expect(AUTH_LOGOUT_TIMEOUT_MS).toBe(45_000);
  });

  it('auth-logout on a kit 1 server is a usage error', async () => {
    const client = clientReturning({ code: 2, stdout: '{"error":{"code":"usage","message":"unknown verb auth-logout"}}', stderr: '', truncated: false });
    const failure = await client.authLogout().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CtlError);
    expect(failure).toMatchObject({ code: 'usage', exitCode: 2 });
  });

  it('kit 2.1 verbs parse their replies, with longer timeouts for kb-put and git-status', async () => {
    const executor = cannedExecutor();
    const client = createCtlClient(executor);
    await expect(client.skills()).resolves.toEqual(CANNED['skills']);
    await expect(client.kbPut([{ path: 'global/rules.md', content: 'Be kind' }], false)).resolves.toEqual({ written: 2, removed: 1 });
    await expect(client.gitStatus()).resolves.toEqual(CANNED['git-status']);
    expect(executor.execs.map((call) => call.opts.timeoutMs)).toEqual([60_000, KB_PUT_TIMEOUT_MS, PROJECTS_TIMEOUT_MS]);
  });

  it('kb-put refuses paths outside ~/luady-kb/, other files and payloads over 2 MB before running anything', async () => {
    const executor = cannedExecutor();
    const client = createCtlClient(executor);
    const big = 'x'.repeat(1024 * 1024);
    const attempts: Array<() => Promise<unknown>> = [
      () => client.kbPut([{ path: '../.bashrc.md', content: '' }], false),
      () => client.kbPut([{ path: '/home/dev/luady-kb/x.md', content: '' }], false),
      () => client.kbPut([{ path: 'notes.txt', content: '' }], false),
      () => client.kbPut([{ path: 'a.md', content: big }, { path: 'b.md', content: big }], false),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ValidationError);
    }
    expect(executor.execs).toEqual([]);
  });

  it('kit 2.1 verbs on an older kit are usage errors', async () => {
    const client = clientReturning({ code: 2, stdout: '{"error":{"code":"usage","message":"unknown verb skills"}}', stderr: '', truncated: false });
    await expect(client.skills()).rejects.toMatchObject({ code: 'usage', exitCode: 2 });
  });

  it('returns parsed results', async () => {
    const client = createCtlClient(cannedExecutor());
    await expect(client.version()).resolves.toEqual(CANNED['version']);
    await expect(client.capture('cc-x:0.0', 10)).resolves.toBe('pane text');
    await expect(client.start({ name: 'health', cwd: PROJECT_DIR })).resolves.toEqual({ ok: true, target: 'cc-health:0.0' });
  });

  it('maps an error reply to CtlError with its code and exit status', async () => {
    const client = clientReturning({
      code: 3,
      stdout: '{"error":{"code":"refused","message":"a question is pending for cc-x:0.0"}}',
      stderr: '',
      truncated: false,
    });
    const failure = await client.send('cc-x:0.0', 'hi').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CtlError);
    expect(failure).toMatchObject({ code: 'refused', message: 'a question is pending for cc-x:0.0', exitCode: 3 });
  });

  it('maps other failures to CtlError failed with the exit status', async () => {
    const missing = clientReturning({ code: 127, stdout: '', stderr: 'bash: /home/dev/.luady/bin/luady-ctl: No such file or directory', truncated: false });
    await expect(missing.version()).rejects.toMatchObject({ code: 'failed', exitCode: 127, message: expect.stringContaining('No such file') });
    const killed = clientReturning({ code: null, stdout: '', stderr: '', truncated: false });
    await expect(killed.version()).rejects.toMatchObject({ code: 'failed', exitCode: -1 });
  });

  it('rejects malformed and truncated output', async () => {
    await expect(clientReturning({ code: 0, stdout: 'not json', stderr: '', truncated: false }).version()).rejects.toMatchObject({ code: 'failed' });
    await expect(clientReturning(okJson({ kit: 1 })).version()).rejects.toThrow(/unexpected output/);
    await expect(clientReturning({ ...okJson({ ok: true }), truncated: true }).restart('cc-x:0.0')).rejects.toThrow(/size cap/);
  });

  it('validates arguments before running anything', async () => {
    const executor = cannedExecutor();
    const client = createCtlClient(executor);
    const attempts: Array<() => Promise<unknown>> = [
      () => client.send('x; rm -rf /', 'hi'),
      () => client.answer('bad-qid', { release: true }),
      () => client.answer('QQQQ2345', { answers: { q: 5 } } as never),
      () => client.fileRead('relative/path', 10),
      () => client.capture('cc-x:0.0', 0),
      () => client.keys('cc-x:0.0', 'C-z' as CtlKey),
      () => client.transcript('sid-1', {}),
      () => client.transcript('sid 1', { tail: 10 }),
      () => client.start({ name: 'bad name', cwd: '/home/dev/projects/x' }),
      () => client.setConfig('remote_answering', 'true; reboot'),
      () => client.exec('ls', '/home/dev', 601),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ValidationError);
    }
    expect(executor.execs).toEqual([]);
  });

  it('rejects empty, oversized or NUL free text', async () => {
    const client = createCtlClient(cannedExecutor());
    await expect(client.send('cc-x:0.0', '   ')).rejects.toBeInstanceOf(ValidationError);
    await expect(client.send('cc-x:0.0', 'x'.repeat(20_001))).rejects.toBeInstanceOf(ValidationError);
    await expect(client.send('cc-x:0.0', 'a\0b')).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses control characters in text the kit types, but keeps line breaks and tabs', async () => {
    const executor = cannedExecutor();
    const client = createCtlClient(executor);
    for (const char of ['\u0003', '\u0004', '\u0008', '\u000b', '\u000c', '\u001b', '\u001f', '\u007f']) {
      await expect(client.send('cc-x:0.0', `hello${char}${char}\nrm -rf ~/projects`)).rejects.toThrow(/control characters/);
      await expect(client.start({ name: 'health', cwd: PROJECT_DIR, prompt: `go${char}` })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(executor.execs).toEqual([]);
    await client.send('cc-x:0.0', 'one\ntwo\r\nthree\r\tfour');
    expect(executor.execs.map((call) => call.opts.stdin)).toEqual(['one\ntwo\r\nthree\r\tfour']);
  });

  it('gives long-running verbs longer timeouts', async () => {
    const executor = cannedExecutor();
    const client = createCtlClient(executor);
    await client.version();
    await client.projects();
    await client.updateClaude();
    await client.exec('sleep 1', '/home/dev', 600);
    expect(executor.execs.map((call) => call.opts.timeoutMs)).toEqual([60_000, 120_000, 360_000, 630_000]);
  });
});
