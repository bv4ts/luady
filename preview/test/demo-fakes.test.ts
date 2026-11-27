import childProcess from 'node:child_process';
import dns from 'node:dns';
import net from 'node:net';
import { HOST_GRANT_HEADER, HOST_KEY_FP_RE, LOCAL_HOST_ID, type HostDTO, type MeDTO } from '@luady/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '../../packages/hub/dist/fleet/servers-repo.js';
import { createDemoHostSeams, demoAddress, demoFingerprint, DEMO_LOCAL_HOME, type DemoHostSeams } from '../demo-fakes.ts';
import { createPreviewFleet } from '../fake-fleet.ts';
import { PREVIEW_PIN } from '../config.ts';
import { startPreview, type Preview } from '../main.ts';
import { signedIn, signInPreview } from './sign-in.ts';

/** Every way out of the process the demo must never take. */
function spyOnTheOutside() {
  return [
    vi.spyOn(net.Socket.prototype, 'connect'), vi.spyOn(childProcess, 'spawn'), vi.spyOn(childProcess, 'execFile'),
    vi.spyOn(childProcess, 'exec'), vi.spyOn(dns, 'lookup'),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
});

const record = (id: string, over: Partial<HostRecord> = {}): HostRecord => ({
  id, kind: 'ssh', host: `${id}.example.invalid`, user: 'dev', port: 22, hostKeyFp: demoFingerprint('192.0.2.9', 22), projectsRoot: '/home/dev/projects',
  homeDir: '/home/dev', claudeBin: null, fromAddr: null, source: 'web', state: 'pinned', ...over,
});

describe('the demo host seams', () => {
  it('resolve only names under .invalid, each to a documentation address', async () => {
    const seams = createDemoHostSeams();
    expect(await seams.lookup('elm.example.invalid')).toEqual([{ address: demoAddress('elm.example.invalid'), family: 4 }]);
    expect(demoAddress('elm.example.invalid')).toMatch(/^192\.0\.2\.\d{1,3}$/);
    expect(demoAddress('ELM.example.invalid.')).toBe(demoAddress('elm.example.invalid'));
    for (const name of ['example.com', 'localhost', 'invalid', '.invalid', '10.0.0.1']) {
      await expect(seams.lookup(name), name).rejects.toMatchObject({ code: 'ENOTFOUND' });
    }
  });

  it('scan a fixed host key per address and port, in the hub\'s fingerprint form', async () => {
    const seams = createDemoHostSeams();
    const a = await seams.scanner.scan({ host: '192.0.2.10', port: 22 });
    expect(a).toEqual({ fingerprint: demoFingerprint('192.0.2.10', 22), keyType: 'ssh-ed25519' });
    expect(a.fingerprint).toMatch(HOST_KEY_FP_RE);
    expect((await seams.scanner.scan({ host: '192.0.2.10', port: 22 })).fingerprint).toBe(a.fingerprint);
    expect((await seams.scanner.scan({ host: '192.0.2.11', port: 22 })).fingerprint).not.toBe(a.fingerprint);
  });

  it('answer preflight like a ready server, and show the kit alias once the kit is installed', async () => {
    const seams = createDemoHostSeams();
    const before = await seams.remote.preflight('elm', { claudeBin: null, projectsRoot: null });
    const lines = new Map(before.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    expect([...lines.keys()]).toEqual(['os', 'home', 'user', 'python', 'tmux', 'tar', 'mktemp', 'claude', 'claude_version', 'projects', 'kit_alias', 'kit_version']);
    expect(lines.get('python')).toBe('3.12');
    expect(lines.get('kit_alias')).toBe('');
    const seen: string[] = [];
    const installed = await seams.remote.kit('elm', ['--host-alias', 'elm', '--projects-root', '/home/dev/projects'], await seams.payload(), (line) => seen.push(line));
    expect(installed).toMatchObject({ code: 0, error: null, summary: { ok: true, action: 'install', host_alias: 'elm' } });
    expect(seen.length).toBeGreaterThan(0);
    expect(await seams.remote.preflight('elm', { claudeBin: null, projectsRoot: null })).toContain('kit_alias="host_alias": "elm"');
    expect((await seams.remote.kit('elm', ['--uninstall'], await seams.payload(), () => undefined)).summary).toMatchObject({ action: 'uninstall' });
    expect(await seams.remote.removeKey('elm', 'AAAA')).toBe('removed');
    expect(await seams.remote.removeKey('elm', 'AAAA')).toBe('absent');
  });

  it('give this computer an in-memory home: folders are made only inside an existing one', async () => {
    const { localKit } = createDemoHostSeams();
    expect(localKit.home()).toBe(DEMO_LOCAL_HOME);
    const projects = `${DEMO_LOCAL_HOME}/projects`;
    expect(localKit.folders.kind(projects)).toBeNull();
    expect(() => localKit.folders.realpath(projects)).toThrow(/ENOENT/);
    localKit.folders.mkdir(projects, 0o700);
    expect(localKit.folders.kind(`${projects}/`)).toBe('dir');
    expect(localKit.folders.realpath(projects)).toBe(projects);
    expect(() => localKit.folders.mkdir('/srv/a/b', 0o700)).toThrow(/ENOENT/);
    expect(await localKit.installedAlias(DEMO_LOCAL_HOME)).toBeNull();
    await localKit.install({ projectsRoot: projects, claudeBin: '/usr/bin/claude' }, () => undefined);
    expect(await localKit.installedAlias(DEMO_LOCAL_HOME)).toBe(LOCAL_HOST_ID);
    expect((await localKit.preflight('/usr/bin/claude')).missing).toEqual([]);
  });

  it('never open a socket, resolve a name or start a process', async () => {
    const spies = spyOnTheOutside();
    const seams = createDemoHostSeams();
    const [address] = await seams.lookup('oak.example.invalid');
    await seams.scanner.scan({ host: address?.address ?? '', port: 22 });
    await seams.remote.preflight('oak', { claudeBin: '/home/dev/.local/bin/claude', projectsRoot: '/home/dev/projects' });
    await seams.remote.kit('oak', ['--host-alias', 'oak'], await seams.payload(), () => undefined);
    await seams.remote.kit('oak', ['--uninstall'], await seams.payload(), () => undefined);
    await seams.remote.removeKey('oak', 'AAAA');
    seams.localKit.folders.mkdir(`${DEMO_LOCAL_HOME}/projects`, 0o700);
    await seams.localKit.preflight('/usr/bin/claude');
    await seams.localKit.install({ projectsRoot: `${DEMO_LOCAL_HOME}/projects`, claudeBin: '/usr/bin/claude' }, () => undefined);
    await seams.localKit.uninstall(() => undefined);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('the preview fleet adds the hosts the owner pins (a dynamic fleet)', () => {
  it('gives a pinned host a fake kit and a link that is online at once, and forgets it when removed', async () => {
    const rows = new Map<string, HostRecord>([['elm', record('elm')], ['draft-one', record('draft-one', { state: 'draft' })]]);
    const fleet = createPreviewFleet({ clock: () => new Date(), records: (id) => rows.get(id) });
    expect(fleet.link('elm')).toBeNull();
    expect(fleet.executor('elm')).toBeUndefined();
    expect(() => fleet.addHost('draft-one')).toThrow(/not a pinned host/);
    expect(() => fleet.addHost('nobody')).toThrow(/not a pinned host/);
    fleet.addHost('elm');
    expect(() => fleet.addHost('elm')).toThrow(/already/);
    expect(fleet.link('elm')).toBe('online');
    expect(fleet.executor('elm')?.status()).toBe('online');
    expect(fleet.hasServer('elm')).toBe(true);
    expect(fleet.hostInfo('elm')).toMatchObject({ kind: 'ssh', projectsRoot: '/home/dev/projects', terminal: true });
    expect(fleet.servers().map((s) => s.name)).toEqual(['cedar', 'birch', 'ash', 'local', 'elm']);
    expect(fleet.servers().at(-1)).toMatchObject({ host: 'elm.example.invalid', status: 'online' });
    expect((await fleet.client('elm').version()).kit).toBe('2.1.0');
    expect((await fleet.client('elm').authStatus()).logged_in).toBe(false);
    await fleet.replaceHost('elm');
    expect(fleet.link('elm')).toBe('online');
    await fleet.removeHost('elm');
    expect(fleet.link('elm')).toBeNull();
    expect(fleet.hasServer('elm')).toBe(false);
    expect(fleet.servers().map((s) => s.name)).toEqual(['cedar', 'birch', 'ash', 'local']);
  });

  it('adds this computer as a local host without a terminal', () => {
    const fleet = createPreviewFleet({ clock: () => new Date(), records: (id) => (id === LOCAL_HOST_ID ? record(id, { kind: 'local', host: 'localhost' }) : undefined) });
    fleet.addHost(LOCAL_HOST_ID);
    expect(fleet.hasLocal(LOCAL_HOST_ID)).toBe(true);
    expect(fleet.hasServer(LOCAL_HOST_ID)).toBe(false);
    expect(fleet.hostInfo(LOCAL_HOST_ID)).toMatchObject({ kind: 'local', terminal: false });
  });

  it('keeps the self host out of the dynamic links', () => {
    const fleet = createPreviewFleet({ clock: () => new Date() });
    for (const id of fleet.hosts()) if (!fleet.hasServer(id) && !fleet.hasLocal(id)) expect(fleet.link(id)).toBeNull();
  });
});

describe('a running preview', () => {
  let preview: Preview;

  beforeAll(async () => {
    preview = await startPreview({ env: {}, port: await freePortNumber() });
  }, 60_000);

  afterAll(async () => {
    await preview?.stop();
  });

  it('hands the hub its fake hosts seams on every run (there is no switch to turn them off)', () => {
    const seams: DemoHostSeams = preview.hostSeams;
    expect(Object.keys(seams).sort()).toEqual(['localKit', 'lookup', 'payload', 'remote', 'scanner']);
  });

  it('lists the demo servers as config rows of the hosts table, linked', async () => {
    const owner = await signInPreview(preview);
    const res = await fetch(`${preview.url}/api/hosts`, { headers: signedIn(owner) });
    const hosts = (await res.json()) as HostDTO[];
    expect(hosts.map((h) => `${h.id}:${h.source}:${h.state}:${h.link}`).sort()).toEqual([
      'ash:config:pinned:online', 'birch:config:pinned:online', 'cedar:config:pinned:online', 'local:config:pinned:online',
    ]);
  });

  it('adds a server and this computer, installs their kits and removes the server, with no socket or process', async () => {
    const owner = await signInPreview(preview);
    const me = (await (await fetch(`${preview.url}/api/me`, { headers: signedIn(owner) })).json()) as MeDTO;
    const call = async <T>(method: string, path: string, body?: unknown, grant?: string): Promise<{ status: number; body: T }> => {
      const res = await fetch(`${preview.url}${path}`, {
        method,
        headers: {
          ...signedIn(owner), 'x-hub-csrf': me.csrf, origin: `http://localhost:${preview.port}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(grant === undefined ? {} : { [HOST_GRANT_HEADER]: grant }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as T };
    };
    const jobDone = async (id: string): Promise<void> => {
      for (let tries = 0; tries < 200; tries += 1) {
        const job = (await call<{ state: string; error: string | null }>('GET', `/api/hosts/${id}/job`)).body;
        if (job.state === 'done') return;
        if (job.state === 'failed') throw new Error(`the kit job failed: ${job.error ?? ''}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the kit job did not finish');
    };
    const outside = spyOnTheOutside();
    const created = await call<{ grant: string }>('POST', '/api/hosts', { id: 'elm', host: 'elm.example.invalid', user: 'dev', port: 22, pin: PREVIEW_PIN });
    expect(created.status).toBe(200);
    const grant = created.body.grant;
    expect((await call<{ line: string }>('GET', '/api/hosts/key')).body.line).toMatch(/ssh-ed25519 \S+ luady-fleet$/);
    const scan = await call<{ fingerprint: string; compare: string }>('POST', '/api/hosts/elm/scan', {}, grant);
    expect(scan.body.compare).toBe('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub');
    expect((await call('POST', '/api/hosts/elm/pin', { fingerprint: scan.body.fingerprint }, grant)).status).toBe(200);
    expect((await call<{ auth: string; missing: string[] }>('POST', '/api/hosts/elm/check', {}, grant)).body).toMatchObject({ auth: 'ok', missing: [] });
    expect((await call('POST', '/api/hosts/elm/kit', { mode: 'install' }, grant)).status).toBe(202);
    await jobDone('elm');
    const local = await call<{ grant: string }>('POST', '/api/hosts/local', { projectsRoot: '~/projects', createFolder: true, pin: PREVIEW_PIN });
    expect(local.status).toBe(200);
    expect((await call<{ auth: string }>('POST', `/api/hosts/${LOCAL_HOST_ID}/check`, {}, local.body.grant)).body.auth).toBe('ok');
    expect((await call('POST', `/api/hosts/${LOCAL_HOST_ID}/kit`, { mode: 'install' }, local.body.grant)).status).toBe(202);
    await jobDone(LOCAL_HOST_ID);
    const listed = (await call<HostDTO[]>('GET', '/api/hosts')).body;
    expect(listed.find((h) => h.id === 'elm')).toMatchObject({ state: 'pinned', link: 'online', kitAlias: 'elm', kitVersion: '2.1.0' });
    expect(listed.find((h) => h.id === LOCAL_HOST_ID)).toMatchObject({ kind: 'local', state: 'pinned', projectsRoot: `${DEMO_LOCAL_HOME}/projects` });
    const removed = await call<{ steps: Record<string, string> }>('POST', '/api/hosts/elm/remove', { uninstallKit: true, removeKey: true, rooms: 'keep', pin: PREVIEW_PIN });
    expect(removed.body.steps).toMatchObject({ kit: 'done', key: 'done', record: 'removed' });
    // A tombstone: gone from the list, and its name is never given out again.
    expect((await call<HostDTO[]>('GET', '/api/hosts')).body.map((h) => h.id)).not.toContain('elm');
    const again = await call<{ error: { code: string } }>('POST', '/api/hosts', { id: 'elm', host: 'elm.example.invalid', user: 'dev', port: 22, pin: PREVIEW_PIN });
    expect(again.status).toBe(409);
    // Only this test's own requests to the preview opened a socket; nothing was started; only `localhost` was looked up.
    const [connect, spawn, execFile, exec, lookup] = outside;
    expect(connect?.mock.calls.filter((args) => !JSON.stringify(args).includes(String(preview.port)))).toEqual([]);
    for (const spy of [spawn, execFile, exec]) expect(spy?.mock.calls).toEqual([]);
    expect(lookup?.mock.calls.filter((args) => args[0] !== 'localhost' && net.isIP(String(args[0])) === 0)).toEqual([]);
  });
});

async function freePortNumber(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}
