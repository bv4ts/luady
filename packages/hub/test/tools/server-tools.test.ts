import { describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, type CtlFileRead, type ProjectDTO } from '@luady/shared';
import { RefusedError, ValidationError } from '../../src/core/errors.js';
import { OWNER_TOOLS } from '../../src/tools/owner-tools.js';
import { SERVER_TOOLS } from '../../src/tools/server-tools.js';
import { createFakeCtl } from '../../test/helpers/fakes.js';
import { createFakeToolContext, makeAction } from './fake-context.js';

const PENDING_TEXT = 'pending_confirmation: action A7 — waiting for owner PIN (expires in 30 min).';

const PROJECT: ProjectDTO = {
  server: 'cedar',
  path: '/home/dev/projects/meadow-hr',
  name: 'meadow-hr',
  remote: 'git@github.com:example-org/meadow-hr.git',
  branch: 'main',
  commits: [{ hash: '0123456789abcdef', date: '2026-10-08T10:00:00Z', subject: 'Fix payroll export' }],
  stack: ['php', 'laravel'],
  updatedAt: '2026-10-09T06:00:00.000Z',
};

describe('server tools', () => {
  it('server_exec returns the result of a read-only command', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction({ id: 'A8', kind: 'server.exec', tier: 0, status: 'done', result: 'exit 0\nstdout:\nok' }));
    await expect(SERVER_TOOLS.server_exec({ server: 'birch', command: 'uptime', reason: 'health check' }, ctx)).resolves.toBe(
      'done: action A8 — exit 0\nstdout:\nok',
    );
    expect(ctx.actions.request).toHaveBeenCalledWith({
      kind: 'server.exec',
      actor: 'manager',
      channel: 'event',
      // No folder named: the action service runs it in the host's own home.
      params: { server: 'birch', command: 'uptime', cwd: undefined, reason: 'health check' },
    });
  });

  it('server_exec reports pending_confirmation for tier-1 commands', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction());
    await expect(SERVER_TOOLS.server_exec({ server: 'birch', command: 'docker compose down', reason: 'free memory' }, ctx)).resolves.toBe(PENDING_TEXT);
  });

  it('server tools reject the self host and other unknown servers', async () => {
    const ctx = createFakeToolContext();
    await expect(SERVER_TOOLS.server_exec({ server: 'hq', command: 'uptime', reason: 'nope' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(SERVER_TOOLS.file_read({ server: 'vps', path: '/etc/hosts' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    expect(ctx.actions.request).not.toHaveBeenCalled();
  });

  it('file_read reads through luady-ctl', async () => {
    const ctx = createFakeToolContext();
    const fileRead = vi.fn(async (): Promise<CtlFileRead> => ({ path: '/home/dev/projects/x/README.md', size: 120000, content: '# X', truncated: true }));
    vi.mocked(ctx.fleet.client).mockReturnValue(createFakeCtl({ fileRead }));
    await expect(SERVER_TOOLS.file_read({ server: 'cedar', path: '/home/dev/projects/x/README.md' }, ctx)).resolves.toBe(
      'cedar:/home/dev/projects/x/README.md (120000 bytes, showing the first 50000 bytes)\n# X',
    );
    expect(ctx.fleet.client).toHaveBeenCalledWith('cedar');
    expect(fileRead).toHaveBeenCalledWith('/home/dev/projects/x/README.md', 50000);
  });

  it('file_read refuses protected and relative paths before reaching the server', async () => {
    const ctx = createFakeToolContext();
    await expect(SERVER_TOOLS.file_read({ server: 'cedar', path: '/home/dev/.claude/.credentials.json' }, ctx)).rejects.toBeInstanceOf(RefusedError);
    await expect(SERVER_TOOLS.file_read({ server: 'cedar', path: 'notes.txt' }, ctx)).rejects.toBeInstanceOf(ValidationError);
    expect(ctx.fleet.client).not.toHaveBeenCalled();
  });

  it("file_read and send_file refuse the hub's own folders on this computer before the kit is asked", async () => {
    const ctx = createFakeToolContext();
    const fleet = {
      ...ctx.fleet,
      hasLocal: (id: string) => id === LOCAL_HOST_ID,
      hasHost: (id: string) => id === LOCAL_HOST_ID || ctx.fleet.hasHost(id),
      hubPathRefusal: (host: string, path: string) => (host === LOCAL_HOST_ID && path.startsWith('/home/me/.local/share/luady/') ? `${path} belongs to the hub itself` : null),
    };
    const local = { ...ctx, fleet };
    const hubFile = '/home/me/.local/share/luady/data/fleet_ed25519';
    await expect(SERVER_TOOLS.file_read({ server: LOCAL_HOST_ID, path: hubFile }, local)).rejects.toThrow(/belongs to the hub itself/);
    await expect(OWNER_TOOLS.send_file({ server: LOCAL_HOST_ID, path: hubFile }, local)).rejects.toBeInstanceOf(RefusedError);
    expect(ctx.fleet.client).not.toHaveBeenCalled();
  });

  it('file_write and claude_update wait for the owner PIN', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction());
    const write = { server: 'ash', path: '/home/dev/projects/x/a.txt', content: 'hi', reason: 'fix typo' };
    await expect(SERVER_TOOLS.file_write(write, ctx)).resolves.toBe(PENDING_TEXT);
    expect(ctx.actions.request).toHaveBeenLastCalledWith({ kind: 'server.file_write', actor: 'manager', channel: 'event', params: write });
    await expect(SERVER_TOOLS.claude_update({ server: 'ash', reason: 'new release' }, ctx)).resolves.toBe(PENDING_TEXT);
    expect(ctx.actions.request).toHaveBeenLastCalledWith({
      kind: 'server.claude_update',
      actor: 'manager',
      channel: 'event',
      params: { server: 'ash', reason: 'new release' },
    });
  });

  it('project_info formats the registry entry', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.projects.list).mockReturnValue([PROJECT]);
    await expect(SERVER_TOOLS.project_info({ server: 'cedar', project: 'Meadow-HR' }, ctx)).resolves.toBe(
      [
        'meadow-hr (cedar:/home/dev/projects/meadow-hr)',
        'remote: git@github.com:example-org/meadow-hr.git',
        'branch: main',
        'stack: php, laravel',
        'updated: 2026-10-09T06:00:00.000Z',
        'recent commits:',
        '  - 0123456 2026-10-08 Fix payroll export',
      ].join('\n'),
    );
    expect(ctx.projects.list).toHaveBeenCalledWith('cedar');
  });

  it('project_info lists the known projects for an unknown name', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.projects.list).mockReturnValue([PROJECT]);
    await expect(SERVER_TOOLS.project_info({ server: 'cedar', project: 'nope' }, ctx)).rejects.toThrow(
      'No project "nope" on cedar. Known projects: meadow-hr',
    );
  });

  it('memory_search formats hits and reports no matches', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.memory.search)
      .mockReturnValueOnce([{ thread: 'session:cedar:cc-meadow-hr:0.0', role: 'assistant', text: 'Payroll export\nfixed.', ts: '2026-10-08T10:00:00.000Z' }])
      .mockReturnValueOnce([]);
    await expect(SERVER_TOOLS.memory_search({ query: 'payroll' }, ctx)).resolves.toBe(
      '- [2026-10-08T10:00:00.000Z] session:cedar:cc-meadow-hr:0.0 · assistant: Payroll export fixed.',
    );
    expect(ctx.memory.search).toHaveBeenCalledWith('payroll', 10);
    await expect(SERVER_TOOLS.memory_search({ query: 'nothing' }, ctx)).resolves.toBe('No memory matches for "nothing".');
  });
});
