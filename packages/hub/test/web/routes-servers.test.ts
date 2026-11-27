import { describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID } from '@luady/shared';
import { CtlError } from '../../src/core/errors.js';
import { createFakeCtl } from '../helpers/fakes.js';
import { call, fakeFleet, harnessFactory, sampleAction, sampleProject, sampleServer } from './helpers.js';

const harness = harnessFactory();
const PIN = '123456';
const TICKET = 'f'.repeat(64);
const owner = { actor: 'owner', channel: 'web' } as const;

describe('servers and projects', () => {
  it('lists servers', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/servers', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([sampleServer()]);
  });

  it('lists the projects of one server', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/servers/cedar/projects', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([sampleProject()]);
    expect(h.deps.projects.list).toHaveBeenCalledWith('cedar');
  });

  it('rejects a name that is no host id with 400, and a host the fleet does not have (or the manager\'s own) with 404', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/servers/Luady!/projects', undefined, { session })).statusCode).toBe(400);
    expect((await call(h, 'GET', '/api/servers/mars/projects', undefined, { session })).statusCode).toBe(404);
    expect((await call(h, 'GET', '/api/servers/hq/projects', undefined, { session })).statusCode).toBe(404);
    expect((await call(h, 'GET', '/api/servers/hq/file?path=/etc/hosts', undefined, { session })).statusCode).toBe(404);
    expect(h.deps.projects.list).not.toHaveBeenCalled();
  });
});

describe('POST /api/servers/:name/exec', () => {
  it('runs a read-only command as a tier-0 action and never forwards a PIN', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/servers/birch/exec', { command: 'git status', pin: PIN }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.classify).toHaveBeenCalledWith('git status');
    expect(h.deps.actions.request).toHaveBeenCalledWith({
      kind: 'server.exec',
      ...owner,
      // No folder named: the action service runs it in the host's own home.
      params: { server: 'birch', command: 'git status' },
    });
    expect(vi.mocked(h.deps.actions.request).mock.calls[0]?.[0]).not.toHaveProperty('pin');
  });

  it('answers 428 pin_required when the classifier says tier 1 and no PIN was sent', async () => {
    const h = await harness();
    vi.mocked(h.deps.classify).mockReturnValue({ tier: 1, reason: 'not read-only' });
    const res = await call(h, 'POST', '/api/servers/birch/exec', { command: 'rm -rf build' }, { session: h.login() });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toEqual({ error: { code: 'pin_required', message: 'PIN required: not read-only' } });
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });

  it('passes the PIN and cwd for a tier-1 command', async () => {
    const h = await harness();
    vi.mocked(h.deps.classify).mockReturnValue({ tier: 1, reason: 'not read-only' });
    const res = await call(
      h,
      'POST',
      '/api/servers/birch/exec',
      { command: 'npm run build', cwd: '/home/dev/projects/orchard', pin: PIN },
      { session: h.login() },
    );
    expect(res.statusCode).toBe(200);
    expect(h.deps.actions.request).toHaveBeenCalledWith({
      kind: 'server.exec',
      ...owner,
      params: { server: 'birch', command: 'npm run build', cwd: '/home/dev/projects/orchard' },
      pin: PIN,
    });
  });
});

describe('files', () => {
  it('reads a file through the fleet client with the 500000-byte cap', async () => {
    const fileRead = vi.fn(async (path: string, maxBytes: number) => ({
      path,
      size: 5,
      content: 'hello',
      truncated: maxBytes < 5,
    }));
    const fleet = fakeFleet();
    vi.mocked(fleet.client).mockReturnValue(createFakeCtl({ fileRead }));
    const h = await harness({ fleet });
    const path = '/home/dev/projects/harbor/README.md';
    const res = await call(h, 'GET', `/api/servers/ash/file?path=${encodeURIComponent(path)}`, undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(fleet.client).toHaveBeenCalledWith('ash');
    expect(fileRead).toHaveBeenCalledWith(path, 500_000);
    expect(res.json()).toEqual({ path, size: 5, content: 'hello', truncated: false });
  });

  it("refuses the hub's own folders on this computer before the kit is asked", async () => {
    const fileRead = vi.fn(async (path: string) => ({ path, size: 1, content: 'x', truncated: false }));
    const base = fakeFleet();
    const fleet = {
      ...base,
      client: vi.fn(() => createFakeCtl({ fileRead })),
      hasLocal: (id: string) => id === LOCAL_HOST_ID,
      hubPathRefusal: (host: string, path: string) => (host === LOCAL_HOST_ID && path.includes('/.config/luady/') ? `${path} belongs to the hub itself` : null),
    };
    const h = await harness({ fleet });
    const session = h.login();
    const refused = await call(h, 'GET', `/api/servers/${LOCAL_HOST_ID}/file?path=${encodeURIComponent('/home/me/.config/luady/secrets.env')}`, undefined, { session });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.json())).toContain('belongs to the hub itself');
    expect(fileRead).not.toHaveBeenCalled();
    const open = await call(h, 'GET', `/api/servers/${LOCAL_HOST_ID}/file?path=${encodeURIComponent('/home/me/projects/a.md')}`, undefined, { session });
    expect(open.statusCode).toBe(200);
  });

  it('rejects a relative path with 400', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/servers/ash/file?path=projects/x', undefined, { session: h.login() });
    expect(res.statusCode).toBe(400);
  });

  it('maps a refused luady-ctl read to 502', async () => {
    const fleet = fakeFleet();
    vi.mocked(fleet.client).mockReturnValue(
      createFakeCtl({
        fileRead: async () => {
          throw new CtlError('refused', 'path is on the deny list', 3);
        },
      }),
    );
    const h = await harness({ fleet });
    const res = await call(h, 'GET', '/api/servers/cedar/file?path=/home/dev/.ssh/id_rsa', undefined, { session: h.login() });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: 'refused', message: 'path is on the deny list' } });
  });

  it('writes a file as a tier-1 action with the PIN', async () => {
    const h = await harness();
    const body = { path: '/home/dev/projects/meadow-hr/CLAUDE.md', content: '# Rules\n', pin: PIN };
    const res = await call(h, 'PUT', '/api/servers/cedar/file', body, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.actions.request).toHaveBeenCalledWith({
      kind: 'server.file_write',
      ...owner,
      params: { server: 'cedar', path: '/home/dev/projects/meadow-hr/CLAUDE.md', content: '# Rules\n' },
      pin: PIN,
    });
  });

  it('rejects a file write without a PIN with 400', async () => {
    const h = await harness();
    const res = await call(h, 'PUT', '/api/servers/cedar/file', { path: '/home/dev/x.md', content: 'x' }, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });
});

describe('Claude update and terminal tickets', () => {
  it('updates Claude Code as a tier-1 action', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/servers/ash/update-claude', { pin: PIN }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.actions.request).toHaveBeenCalledWith({
      kind: 'server.claude_update',
      ...owner,
      params: { server: 'ash' },
      pin: PIN,
    });
  });

  it('opens a terminal and returns the single-use ticket from the action result, asked for the calling session', async () => {
    const h = await harness();
    vi.mocked(h.deps.actions.request).mockResolvedValueOnce(
      sampleAction({ kind: 'terminal.open', tier: 1, status: 'done', result: TICKET }),
    );
    const session = h.login();
    const res = await call(
      h,
      'POST',
      '/api/terminal/open',
      { server: 'birch', target: 'cc-orchard:0.0', pin: PIN },
      { session },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ticket: TICKET });
    // The ticket is bound to this session when it is issued (the terminal socket of any other session is refused).
    expect(h.deps.actions.request).toHaveBeenCalledWith({
      kind: 'terminal.open',
      ...owner,
      params: { server: 'birch', target: 'cc-orchard:0.0' },
      pin: PIN,
      sid: session.sid,
    });
  });

  it('refuses with 409 when the terminal action yields no ticket', async () => {
    const h = await harness();
    vi.mocked(h.deps.actions.request).mockResolvedValueOnce(
      sampleAction({ kind: 'terminal.open', tier: 1, status: 'failed', result: null, error: 'birch is offline' }),
    );
    const res = await call(h, 'POST', '/api/terminal/open', { server: 'birch', pin: PIN }, { session: h.login() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'refused', message: 'birch is offline' } });
  });

  it('rejects terminal/open without a PIN with 400', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/terminal/open', { server: 'birch' }, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });
});
