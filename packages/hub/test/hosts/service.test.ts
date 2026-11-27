import { describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, type HostJobDTO } from '@luady/shared';
import { compileFixed } from '../../src/fleet/fixed-scripts.js';
import { createServersRepo } from '../../src/fleet/servers-repo.js';
import { CEDAR, FP_SCANNED, PIN, SID, hostsRig, settle, type Rig } from './rig.js';

const MARS = { id: 'mars', host: 'mars.example.com', user: 'dev', port: 22, pin: PIN };

async function pinnedMars(rig: Rig): Promise<string> {
  const { grant } = await rig.hosts.create(MARS, SID);
  await rig.hosts.scan('mars');
  await rig.hosts.pinKey('mars', FP_SCANNED);
  return grant;
}

async function onlineMars(rig: Rig): Promise<void> {
  await pinnedMars(rig);
  rig.links.get('mars')?.setStatus('online');
}

async function finished(rig: Rig, host: string): Promise<HostJobDTO> {
  await vi.waitFor(() => expect(rig.hosts.job(host)?.state).not.toBe('running'));
  await settle();
  return rig.hosts.job(host) as HostJobDTO;
}

describe('the add-server flow', () => {
  it('create gives a draft and a grant; scan, pin, check and the kit follow; the room can come next', async () => {
    const rig = hostsRig();
    const created = await rig.hosts.create({ ...MARS, claudeBin: '/opt/claude/bin/claude' }, SID);
    expect(created.host).toMatchObject({ id: 'mars', state: 'draft', fingerprint: null, link: null, source: 'web', kind: 'ssh' });
    expect(() => rig.hosts.authorize('mars', created.grant, SID)).not.toThrow();
    expect(rig.fleet.hasServer('mars')).toBe(false);

    const scan = await rig.hosts.scan('mars');
    expect(scan).toEqual({ fingerprint: FP_SCANNED, keyType: 'ssh-ed25519', compare: 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' });
    expect(rig.scans).toEqual([{ host: '192.0.2.10', port: 22 }]);

    await expect(rig.hosts.pinKey('mars', `SHA256:${'X'.repeat(43)}`)).rejects.toMatchObject({ code: 'fingerprint_changed' });
    const pinned = await rig.hosts.pinKey('mars', FP_SCANNED);
    expect(pinned).toMatchObject({ state: 'pinned', fingerprint: FP_SCANNED });
    expect(rig.fleet.hasServer('mars')).toBe(true);

    rig.links.get('mars')?.setStatus('online');
    const check = await rig.hosts.check('mars');
    expect(check).toMatchObject({ auth: 'ok', missing: [] });
    expect(check.preflight).toMatchObject({ os: 'Linux', python: '3.12', ready: 'yes' });
    expect(rig.remote.calls.at(-1)).toEqual({ script: 'preflight', host: 'mars', args: ['/opt/claude/bin/claude', null] });
    // The check learned the server's home: the empty folders are filled in from it.
    expect(rig.hosts.get('mars')).toMatchObject({ projectsRoot: '/home/dev/projects', homeDir: '/home/dev' });

    const job = rig.hosts.kit('mars', 'install');
    expect(job.state).toBe('running');
    const done = await finished(rig, 'mars');
    expect(done).toMatchObject({ job: job.job, state: 'done', error: null });
    expect(done.summary).toContain('Kit 2.1.0 is on mars');
    const kitCall = rig.remote.calls.find((call) => call.script === 'kit');
    expect(kitCall?.args).toEqual(['--host-alias', 'mars', '--projects-root', '/home/dev/projects', '--claude-bin', '/opt/claude/bin/claude', 'f'.repeat(64)]);
    expect(rig.audits.map((entry) => entry.kind)).toEqual(['host.add', 'host.pin', 'host.kit']);
    expect(rig.audits.every((entry) => entry.actor === 'owner' && entry.channel === 'web' && entry.params.host === 'mars')).toBe(true);
  });

  it('a kit job sends host.job running then done, its lines as host.log, and never the installer JSON', async () => {
    const rig = hostsRig();
    await onlineMars(rig);
    rig.hosts.kit('mars', 'install');
    await finished(rig, 'mars');
    const jobs = rig.events.filter((event) => event.type === 'host.job').map((event) => (event.payload as { state: string }).state);
    expect(jobs).toEqual(['running', 'done']);
    const lines = rig.events.filter((event) => event.type === 'host.log').map((event) => (event.payload as { line: string }).line);
    expect(lines).toContain('copying files');
    expect(lines.some((line) => line.startsWith('{'))).toBe(false);
    expect(lines).toContain('Kit 2.1.0 installed for mars.');
  });

  it('a failed kit job sends host.job failed in plain words, and the latest job stays readable', async () => {
    const rig = hostsRig();
    await onlineMars(rig);
    rig.remote.kitResult = { code: 71, summary: null, error: null };
    rig.hosts.kit('mars', 'install');
    const failed = await finished(rig, 'mars');
    expect(failed).toMatchObject({ state: 'failed', summary: null });
    expect(failed.error).toContain('could not be unpacked');
    const last = rig.events.filter((event) => event.type === 'host.job').at(-1)?.payload;
    expect(last).toMatchObject({ host: 'mars', state: 'failed' });
    rig.remote.kitResult = { code: 1, summary: null, error: 'Python 3.10 or later is needed (found 3.8)\u001b[0m' };
    rig.hosts.kit('mars', 'install');
    expect((await finished(rig, 'mars')).error).toBe('The installer said: Python 3.10 or later is needed (found 3.8)[0m');
  });

  it('one job per host and three overall; a draft or an offline host has no kit job', async () => {
    const rig = hostsRig();
    await rig.hosts.create(MARS, SID);
    expect(() => rig.hosts.kit('mars', 'install')).toThrow(expect.objectContaining({ code: 'host_not_pinned' }));
    await rig.hosts.scan('mars');
    await rig.hosts.pinKey('mars', FP_SCANNED);
    expect(() => rig.hosts.kit('mars', 'install')).toThrow(expect.objectContaining({ code: 'host_offline' }));
    const releases: Array<() => void> = [];
    rig.remote.kit = () => new Promise((resolve) => {
      releases.push(() => resolve({ code: 0, summary: { ok: true, action: 'install', version: '2.1.0' }, error: null }));
    });
    rig.links.get('mars')?.setStatus('online');
    rig.hosts.kit('mars', 'install');
    expect(() => rig.hosts.kit('mars', 'install')).toThrow(expect.objectContaining({ code: 'job_running' }));
    for (const id of ['venus', 'jupiter', 'saturn']) {
      await rig.hosts.create({ ...MARS, id }, SID);
      await rig.hosts.scan(id);
      await rig.hosts.pinKey(id, FP_SCANNED);
      rig.links.get(id)?.setStatus('online');
    }
    rig.hosts.kit('venus', 'install');
    rig.hosts.kit('jupiter', 'install');
    expect(() => rig.hosts.kit('saturn', 'install')).toThrow(expect.objectContaining({ code: 'jobs_busy' }));
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    for (const release of releases) release();
    await finished(rig, 'mars');
    await finished(rig, 'jupiter');
    expect(rig.hosts.kit('saturn', 'install').state).toBe('running');
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases[3]?.();
    await finished(rig, 'saturn');
  });

  it('denied: the key line comes back and the link stays stopped; the next check is the "Try again" that resumes it', async () => {
    const rig = hostsRig();
    await pinnedMars(rig);
    const link = rig.links.get('mars');
    if (link === undefined) throw new Error('no link');
    link.deny();
    link.onResume = () => link.deny();
    const denied = await rig.hosts.check('mars');
    expect(denied).toMatchObject({ auth: 'denied', preflight: null, missing: [] });
    expect(denied.line).toBe(rig.hosts.key().line);
    expect(link.resumes).toBe(1);
    expect(rig.hosts.get('mars')).toMatchObject({ link: 'offline', lastError: 'auth' });
    // Nothing retries on its own meanwhile.
    await settle();
    expect(link.resumes).toBe(1);

    link.onResume = () => link.setStatus('online');
    const ok = await rig.hosts.check('mars');
    expect(ok.auth).toBe('ok');
    expect(link.resumes).toBe(2);
  });

  it('a changed host key and an unreachable server are named', async () => {
    const rig = hostsRig({ checkWaitMs: 30 });
    await pinnedMars(rig);
    const link = rig.links.get('mars');
    if (link === undefined) throw new Error('no link');
    expect((await rig.hosts.check('mars')).auth).toBe('unreachable');
    link.err = 'hostkey';
    link.onResume = () => {
      link.err = 'hostkey';
      link.setStatus('offline');
    };
    expect((await rig.hosts.check('mars')).auth).toBe('hostkey-mismatch');
  });

  it('a pin needs a scan of the last ten minutes', async () => {
    const rig = hostsRig();
    await rig.hosts.create(MARS, SID);
    await expect(rig.hosts.pinKey('mars', FP_SCANNED)).rejects.toMatchObject({ code: 'scan_needed' });
    await rig.hosts.scan('mars');
    rig.clock.advance(10 * 60_000 + 1);
    await expect(rig.hosts.pinKey('mars', FP_SCANNED)).rejects.toMatchObject({ code: 'scan_needed' });
  });
});

describe('this computer', () => {
  it('is created with createFolder: the folder is made at 0700, the row is pinned, the fleet has it', async () => {
    const rig = hostsRig();
    const created = await rig.hosts.createLocal({ projectsRoot: '/home/me/projects', createFolder: true, pin: PIN }, SID);
    expect(created.host).toMatchObject({ id: LOCAL_HOST_ID, kind: 'local', state: 'pinned', host: 'localhost', user: 'me', terminal: false, homeDir: '/home/me' });
    expect(rig.localKit.made).toEqual([['/home/me/projects', 0o700]]);
    expect(rig.fleet.hasLocal(LOCAL_HOST_ID)).toBe(true);
    expect(() => rig.hosts.authorize(LOCAL_HOST_ID, created.grant, SID)).not.toThrow();
    expect(rig.audits.map((entry) => entry.kind)).toEqual(['host.local']);
    await expect(rig.hosts.createLocal({ projectsRoot: '/home/me/projects', pin: PIN }, SID)).rejects.toMatchObject({ code: 'local_exists' });

    expect(await rig.hosts.check(LOCAL_HOST_ID)).toMatchObject({ auth: 'ok', missing: [] });
    rig.hosts.kit(LOCAL_HOST_ID, 'install');
    expect((await finished(rig, LOCAL_HOST_ID)).state).toBe('done');
    expect(rig.localKit.installs).toEqual([{ projectsRoot: '/home/me/projects', claudeBin: '/home/me/.local/bin/claude' }]);
  });

  it('a missing folder without createFolder, or outside the home, is refused and nothing is written', async () => {
    const rig = hostsRig();
    await expect(rig.hosts.createLocal({ projectsRoot: '/home/me/projects', pin: PIN }, SID)).rejects.toMatchObject({ code: 'folder_missing' });
    await expect(rig.hosts.createLocal({ projectsRoot: '/srv/projects', createFolder: true, pin: PIN }, SID)).rejects.toMatchObject({ code: 'folder_outside_home' });
    expect(rig.hosts.list()).toEqual([]);
    expect(rig.localKit.made).toEqual([]);
  });

  it('a hub on Windows refuses this computer plainly (local_unsupported), before the PIN or the folder', async () => {
    const rig = hostsRig();
    rig.localKit.platform = () => 'win32';
    expect(() => rig.hosts.assertLocalSupported()).toThrow(expect.objectContaining({ code: 'local_unsupported' }));
    await expect(rig.hosts.createLocal({ projectsRoot: '/home/me/projects', createFolder: true, pin: PIN }, SID))
      .rejects.toMatchObject({ code: 'local_unsupported' });
    expect(rig.pinChecks).toBe(0);
    expect(rig.localKit.made).toEqual([]);
    rig.localKit.platform = () => 'linux';
    expect(() => rig.hosts.assertLocalSupported()).not.toThrow();
  });

  it('removed, it may be made again (the same machine keeps its history)', async () => {
    const rig = hostsRig({ dirs: ['/home/me', '/home/me/projects'] });
    await rig.hosts.createLocal({ projectsRoot: '/home/me/projects', pin: PIN }, SID);
    const removed = await rig.hosts.remove(LOCAL_HOST_ID, { uninstallKit: true, removeKey: true, rooms: 'keep', pin: PIN });
    expect(removed.steps).toMatchObject({ kit: 'done', key: 'skipped', rooms: 'kept' });
    expect(rig.localKit.uninstalls).toBe(1);
    await rig.hosts.createLocal({ projectsRoot: '/home/me/projects', pin: PIN }, SID);
    expect(rig.hosts.get(LOCAL_HOST_ID)?.state).toBe('pinned');
  });
});

describe('edit, remove, config rows and audit', () => {
  it('an address, user or port change returns the host to draft; a folder change keeps the pin', async () => {
    const rig = hostsRig();
    await pinnedMars(rig);
    const first = rig.links.get('mars');
    const kept = await rig.hosts.update('mars', { projectsRoot: '/srv/work', pin: PIN });
    expect(kept).toMatchObject({ state: 'pinned', fingerprint: FP_SCANNED, projectsRoot: '/srv/work' });
    expect(first?.closed).toBe(true);
    expect(rig.fleet.hostInfo('mars')?.projectsRoot).toBe('/srv/work');
    const moved = await rig.hosts.update('mars', { port: 2222, pin: PIN });
    expect(moved).toMatchObject({ state: 'draft', fingerprint: null, port: 2222, link: null });
    expect(rig.fleet.hasServer('mars')).toBe(false);
    expect(rig.audits.filter((entry) => entry.kind === 'host.edit')).toHaveLength(2);
  });

  it('removes in order: uninstall, key line, link, tombstone, rooms; history is kept and the id never comes back', async () => {
    const rig = hostsRig();
    await onlineMars(rig);
    const link = rig.links.get('mars');
    const order: string[] = [];
    const remote = rig.remote;
    const kit = remote.kit.bind(remote);
    const key = remote.removeKey.bind(remote);
    remote.kit = async (...args) => {
      order.push(`kit ${String(args[1][0])} (link ${link?.closed === true ? 'closed' : 'open'})`);
      return kit(...args);
    };
    remote.removeKey = async (...args) => {
      order.push(`key-remove (link ${link?.closed === true ? 'closed' : 'open'})`);
      return key(...args);
    };
    rig.bus.on('hosts.changed', () => order.push('hosts.changed'));
    const result = await rig.hosts.remove('mars', { uninstallKit: true, removeKey: true, rooms: 'delete', pin: PIN });
    order.push(`rooms ${rig.roomCalls.map(([host, mode]) => `${host}:${mode}`).join()}`);
    expect(order.slice(0, 2)).toEqual(['kit --uninstall (link open)', 'key-remove (link open)']);
    expect(link?.closed).toBe(true);
    expect(result).toEqual({
      host: 'mars', steps: { kit: 'done', key: 'done', link: 'closed', record: 'removed', rooms: 'deleted' }, note: null, keyCommand: null,
    });
    expect(rig.remote.calls.find((call) => call.script === 'key-remove')?.args).toEqual([rig.fleetKey.blob]);
    expect(rig.roomCalls).toEqual([['mars', 'delete']]);
    expect(rig.hosts.get('mars')).toBeUndefined();
    expect(rig.db.prepare("SELECT state FROM servers WHERE name = 'mars'").get()).toEqual({ state: 'removed' });
    expect(rig.hosts.list().map((host) => host.id)).not.toContain('mars');
    await expect(rig.hosts.create(MARS, SID)).rejects.toMatchObject({ code: 'host_exists' });
    expect(rig.audits.at(-1)).toMatchObject({ kind: 'host.remove', params: { host: 'mars' } });
  });

  it('an unreachable server is still removed here, with a note and the command that removes the key line by hand', async () => {
    const rig = hostsRig();
    await pinnedMars(rig);
    const result = await rig.hosts.remove('mars', { uninstallKit: true, removeKey: true, rooms: 'keep', pin: PIN });
    expect(result.steps).toEqual({ kit: 'unreachable', key: 'unreachable', link: 'closed', record: 'removed', rooms: 'kept' });
    expect(result.note).toContain('could not reach mars');
    expect(result.note).toContain('history is kept');
    // The hand-run command is the fixed key-remove command itself (it runs under sh in test/fleet/key-remove-script.test.ts).
    expect(result.keyCommand).toBe(compileFixed('key-remove', [rig.fleetKey.blob]));
    expect(rig.remote.calls.filter((call) => call.script !== 'preflight')).toEqual([]);
    expect(rig.roomCalls).toEqual([['mars', 'keep']]);
  });

  it('one edit or removal per host at a time; a stuck uninstall ends after its time and the removal still completes', async () => {
    const rig = hostsRig({ removeUninstallMs: 50 });
    await onlineMars(rig);
    let uninstalls = 0;
    rig.remote.kit = (_host, args) => {
      uninstalls += args[0] === '--uninstall' ? 1 : 0;
      return new Promise(() => undefined);
    };
    const removing = rig.hosts.remove('mars', { uninstallKit: true, removeKey: true, rooms: 'keep', pin: PIN });
    await vi.waitFor(() => expect(uninstalls).toBe(1));
    await expect(rig.hosts.update('mars', { port: 2222, pin: PIN })).rejects.toMatchObject({ code: 'host_busy' });
    await expect(rig.hosts.remove('mars', { uninstallKit: false, removeKey: false, rooms: 'keep', pin: PIN })).rejects.toMatchObject({ code: 'host_busy' });
    const result = await removing;
    expect(result.steps).toMatchObject({ kit: 'failed', key: 'done', record: 'removed' });
    expect(result.note).toContain('the kit may still be on it');
    expect(rig.hosts.get('mars')).toBeUndefined();
    // The guard is released: the next call is answered on its own merits.
    await expect(rig.hosts.update('mars', { port: 2222, pin: PIN })).rejects.toMatchObject({ code: 'host_removed' });
  });

  it('an edit is refused while a kit job runs on that host', async () => {
    const rig = hostsRig();
    await onlineMars(rig);
    const releases: Array<() => void> = [];
    rig.remote.kit = () => new Promise((resolve) => {
      releases.push(() => resolve({ code: 0, summary: { ok: true, action: 'install', version: '2.1.0' }, error: null }));
    });
    rig.hosts.kit('mars', 'install');
    await expect(rig.hosts.update('mars', { projectsRoot: '/srv/work', pin: PIN })).rejects.toMatchObject({ code: 'job_running' });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]?.();
    await finished(rig, 'mars');
    await expect(rig.hosts.update('mars', { projectsRoot: '/srv/work', pin: PIN })).resolves.toMatchObject({ projectsRoot: '/srv/work' });
  });

  it('a config row: read-only fields (409 host_from_config), but check and the kit work on it', async () => {
    const rig = hostsRig({ servers: [CEDAR] });
    expect(rig.hosts.get('cedar')).toMatchObject({ source: 'config', state: 'pinned' });
    await expect(rig.hosts.update('cedar', { projectsRoot: '/srv/x', pin: PIN })).rejects.toMatchObject({ code: 'host_from_config' });
    await expect(rig.hosts.remove('cedar', { uninstallKit: false, removeKey: false, rooms: 'keep', pin: PIN })).rejects.toMatchObject({ code: 'host_from_config' });
    await rig.hosts.scan('cedar');
    await expect(rig.hosts.pinKey('cedar', FP_SCANNED)).rejects.toMatchObject({ code: 'host_from_config' });
    rig.links.get('cedar')?.setStatus('online');
    expect((await rig.hosts.check('cedar')).auth).toBe('ok');
    rig.hosts.kit('cedar', 'install');
    expect((await finished(rig, 'cedar')).state).toBe('done');
    // The config row itself was never written by the hosts module.
    expect(createServersRepo(rig.db).record('cedar')).toMatchObject({ source: 'config', hostKeyFp: CEDAR.hostKeyFp, projectsRoot: null });
  });

  it('a wrong PIN changes nothing; grants are bound to the session and the host, for ten minutes', async () => {
    const rig = hostsRig();
    await expect(rig.hosts.create({ ...MARS, pin: '000000' }, SID)).rejects.toMatchObject({ code: 'pin_invalid' });
    expect(rig.hosts.list()).toEqual([]);
    expect(rig.audits).toEqual([]);
    const { grant } = await rig.hosts.create(MARS, SID);
    await rig.hosts.create({ ...MARS, id: 'venus' }, SID);
    expect(() => rig.hosts.authorize('venus', grant, SID)).toThrow(expect.objectContaining({ code: 'grant_required' }));
    expect(() => rig.hosts.authorize('mars', grant, 'b'.repeat(64))).toThrow(expect.objectContaining({ code: 'grant_required' }));
    expect(() => rig.hosts.authorize('mars', undefined, SID)).toThrow(expect.objectContaining({ code: 'grant_required' }));
    const fresh = await rig.hosts.grant('mars', PIN, SID);
    rig.clock.advance(10 * 60_000);
    expect(() => rig.hosts.authorize('mars', fresh.grant, SID)).toThrow(expect.objectContaining({ code: 'grant_required' }));
  });
});

describe('scale: a hundred hosts (counted, never timed)', () => {
  it('a hundred drafts and a hundred link reports send one coalesced hosts.changed each, with the full list', async () => {
    const rig = hostsRig();
    rig.hosts.start();
    for (let i = 0; i < 100; i += 1) await rig.hosts.create({ ...MARS, id: `site-${String(i).padStart(3, '0')}` }, SID);
    await vi.waitFor(() => expect(rig.lastList()?.length).toBe(100));
    const afterCreate = rig.events.filter((event) => event.type === 'hosts.changed').length;
    expect(afterCreate).toBe(1);
    for (let i = 0; i < 100; i += 1) rig.bus.emit('server.updated', { name: `site-${i}`, host: 'x', status: 'online', lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null });
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Nothing in the list changed: the coalesced send is dropped as a duplicate.
    expect(rig.events.filter((event) => event.type === 'hosts.changed').length).toBe(afterCreate);
    rig.hosts.stop();
  });
});
