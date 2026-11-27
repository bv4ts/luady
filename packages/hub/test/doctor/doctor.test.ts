import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import type { Db } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { renderJson, renderText, runDoctor, type CheckResult } from '../../src/doctor/index.js';
import { codexSignInCheck, refusalSentence } from '../../src/doctor/checks-install.js';
import { FULL_HINT, FULL_NOTE, SAFE_NOTE } from '../../src/doctor/report.js';
import { CONFIG, MANAGER_ON, PRIVATE_MARKERS, SECRET_MARKERS, fakeProbe, input, setUpDb, status, type FakeProbe } from './fake-probe.js';

const MANAGER_CTL = '/home/someone/.local/share/luady/data/manager-home/.luady/bin/luady-ctl';

async function checks(probe: FakeProbe, over: Parameters<typeof input>[1] = {}, db: Db | null = setUpDb()): Promise<Map<string, CheckResult>> {
  const report = await runDoctor(input(probe, over, db));
  return new Map(report.checks.map((check) => [check.id, check]));
}

const stateOf = async (probe: FakeProbe, id: string, over: Parameters<typeof input>[1] = {}, db: Db | null = setUpDb()): Promise<CheckResult> => {
  const found = (await checks(probe, over, db)).get(id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

describe('doctor: each check passes, warns or fails with a fix', () => {
  it('a healthy Linux install with the hub running and the manager off passes everything', async () => {
    const report = await runDoctor(input(fakeProbe(), {}, setUpDb()));
    expect(report.checks.filter((check) => check.state !== 'PASS').map((check) => `${check.id}: ${check.summary}`)).toEqual([]);
    expect(report.exitCode).toBe(0);
    for (const check of report.checks) expect(check.fix).toBeNull();
  });

  it('Node.js: an old version fails', async () => {
    const probe = fakeProbe();
    probe.node = '20.11.0';
    expect(await stateOf(probe, 'node')).toMatchObject({ state: 'FAIL', fix: expect.stringContaining('22.12') });
  });

  it('platform: Windows warns that the hub runs on Linux or WSL2 and points at the demo', async () => {
    const probe = fakeProbe();
    probe.os = 'win32';
    expect(await stateOf(probe, 'platform')).toMatchObject({ state: 'WARN', fix: expect.stringContaining('npm run demo') });
  });

  it('tools: tmux missing and an old Python warn, Claude Code missing warns', async () => {
    const probe = fakeProbe();
    probe.runs.delete('tmux -V');
    probe.runs.set('python3 --version', { code: 0, stdout: 'Python 3.8.10', stderr: '' });
    probe.files.delete('/home/someone/.local/bin/claude');
    const found = await checks(probe);
    expect(found.get('tmux')).toMatchObject({ state: 'WARN', fix: expect.stringContaining('tmux') });
    expect(found.get('python')).toMatchObject({ state: 'WARN', summary: 'Python 3.8 is too old' });
    expect(found.get('claude')).toMatchObject({ state: 'WARN', fix: expect.stringContaining('claudePath') });
  });

  it('web build: missing fails with `npm run build`', async () => {
    const probe = fakeProbe();
    probe.files.delete('/home/someone/luady/packages/web/dist/index.html');
    expect(await stateOf(probe, 'web-build')).toMatchObject({ state: 'FAIL', fix: expect.stringContaining('npm run build') });
  });

  it('config: an error fails with a fixed sentence; its line, path and key are only in the detail', async () => {
    const probe = fakeProbe();
    const found = await stateOf(probe, 'config', { config: null, configError: 'invalid config /home/someone/.config/luady/config.json: webPort: expected number' });
    expect(found.state).toBe('FAIL');
    expect(found.summary).toBe('config.json cannot be used: a field of config.json is missing, unknown or of the wrong kind');
    expect(found.detail).toContain('/home/someone/.config/luady/config.json');
    expect(found.detail).toContain('webPort');
  });

  it('database: missing fails; an old schema fails; up to date passes', async () => {
    const probe = fakeProbe();
    expect(await stateOf(probe, 'database', {}, null)).toMatchObject({ state: 'FAIL' });
    const db = setUpDb();
    expect(await stateOf(probe, 'database', {}, db)).toMatchObject({ state: 'PASS' });
    db.prepare('DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)').run();
    expect(await stateOf(probe, 'database', {}, db)).toMatchObject({ state: 'FAIL', fix: expect.stringContaining('Start the hub') });
  });

  it('owner_tz: a claimed install (its PIN set) without a time zone FAILs; one halfway through its claim passes', async () => {
    const db = setUpDb();
    db.prepare("DELETE FROM settings WHERE key = 'owner_tz'").run();
    db.prepare('UPDATE pin_state SET hash = NULL WHERE id = 1').run();
    expect(await stateOf(fakeProbe(), 'owner-tz', {}, db)).toMatchObject({ state: 'PASS' });
    // The passkey comes before the first PIN, which brings the zone: no fault yet.
    db.prepare("INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at) VALUES ('c1', x'00', 0, '[]', 'key', '2026-11-21T00:00:00Z')").run();
    expect(await stateOf(fakeProbe(), 'owner-tz', {}, db)).toMatchObject({ state: 'PASS' });
    db.prepare("UPDATE pin_state SET hash = 'argon2-hash' WHERE id = 1").run();
    expect(await stateOf(fakeProbe(), 'owner-tz', {}, db)).toMatchObject({ state: 'FAIL', fix: expect.stringContaining('time zone') });
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('owner_tz', '\"UTC\"')").run();
    expect(await stateOf(fakeProbe(), 'owner-tz', {}, db)).toMatchObject({ state: 'PASS' });
  });

  it('codex-sign-in: a ChatGPT sign-in only where an older release kept it warns to sign in again; none or a new one says nothing', () => {
    const probe = fakeProbe();
    expect(codexSignInCheck(input(probe), '/home/someone')).toBeNull();
    probe.files.set('/home/someone/.codex/auth.json', { isFile: true, isDir: false, mode: 0o600, executable: false });
    expect(codexSignInCheck(input(probe), '/home/someone')).toMatchObject({
      state: 'WARN', summary: expect.stringMatching(/Connect ChatGPT \(pictures\) again/),
      fix: expect.stringMatching(/Accounts and limits.*sign the old one out .*or delete its auth\.json/),
      // Only `doctor --full` prints the detail: which old file is still there.
      detail: '/home/someone/.codex/auth.json',
    });
    probe.files.set(`${CONFIG.dataDir}/codex/auth.json`, { isFile: true, isDir: false, mode: 0o600, executable: false });
    expect(codexSignInCheck(input(probe), '/home/someone')).toBeNull();
  });

  it('setup: a first run waiting at claim or a later step warns with the way on; a finished one passes', async () => {
    const fresh = openMemoryDb();
    expect(await stateOf(fakeProbe(), 'setup', {}, fresh)).toMatchObject({
      state: 'WARN', summary: 'The first run waits at its claim step', fix: expect.stringContaining('npm run luady -- setup-code'),
    });
    fresh.prepare("UPDATE pin_state SET hash = 'set' WHERE id = 1").run();
    fresh.prepare("UPDATE setup_state SET step = 'connect' WHERE id = 1").run();
    expect(await stateOf(fakeProbe(), 'setup', {}, fresh)).toMatchObject({ state: 'WARN', summary: 'The first run waits at its connect step' });
    expect(await stateOf(fakeProbe(), 'setup', {}, setUpDb())).toMatchObject({ state: 'PASS' });
  });

  it('refusals: a remote install without a passkey and sealed rows of another secret fail; none passes', async () => {
    const db = setUpDb();
    expect(await stateOf(fakeProbe(), 'refusals', {}, db)).toMatchObject({ state: 'PASS' });
    const remote = { ...CONFIG, publicOrigin: 'https://hub.example.com', rpId: 'hub.example.com' };
    db.prepare("INSERT OR REPLACE INTO wispr_auth (id, refresh_enc) VALUES (1, 'v1.not-sealed-with-this-secret')").run();
    const found = await stateOf(fakeProbe(), 'refusals', { config: remote }, db);
    expect(found.state).toBe('FAIL');
    expect(found.summary).toMatch(/passkey/i);
    expect(found.summary).toMatch(/secret/i);
    for (const marker of SECRET_MARKERS) expect(found.summary).not.toContain(marker);
  });

  it('fleet key: missing warns, open to others fails', async () => {
    const probe = fakeProbe();
    const key = '/home/someone/.local/share/luady/data/fleet_ed25519';
    probe.files.delete(key);
    expect(await stateOf(probe, 'fleet-key')).toMatchObject({ state: 'WARN' });
    probe.files.set(key, { isFile: true, isDir: false, mode: 0o644, executable: false });
    expect(await stateOf(probe, 'fleet-key')).toMatchObject({ state: 'FAIL', fix: expect.stringContaining('chmod 600') });
  });

  it('port: held by another program fails when the hub does not answer', async () => {
    const probe = fakeProbe();
    probe.hub = null;
    probe.free = false;
    const found = await checks(probe);
    expect(found.get('port')).toMatchObject({ state: 'FAIL' });
    expect(found.get('hub')).toMatchObject({ state: 'WARN', fix: expect.stringContaining('npm start') });
    expect([...found.keys()].filter((id) => id.startsWith('manager') || id === 'hosts')).toEqual([]);
  });

  it('hosts: counts only; a refused key fails, an offline host or one without the kit warns, a config collision fails', async () => {
    const probe = fakeProbe();
    probe.hub = status({
      hosts: [
        { id: 'cedar', kind: 'ssh', link: 'offline', kitVersion: '2.1.0', kitAlias: 'cedar', claudeVersion: null, lastError: 'auth' },
        { id: 'computer', kind: 'local', link: 'online', kitVersion: null, kitAlias: null, claudeVersion: null, lastError: null },
      ],
      configSync: { collisions: ['birch'], removed: [] },
    });
    const found = await checks(probe);
    expect(found.get('hosts')).toMatchObject({ state: 'FAIL', summary: '2 host(s): 1 online, 1 not online, 1 without the kit; 1 refused the hub (key or host key)' });
    expect(found.get('hosts-config')).toMatchObject({ state: 'FAIL' });
    probe.hub = status({ hosts: [{ id: 'computer', kind: 'local', link: 'online', kitVersion: null, kitAlias: null, claudeVersion: null, lastError: null }] });
    expect(await stateOf(probe, 'hosts')).toMatchObject({ state: 'WARN' });
  });

  it('add-ons: one not connected warns', async () => {
    const probe = fakeProbe();
    probe.hub = status({ addons: [{ id: 'chat', kind: 'channel', state: 'down', connected: false }] });
    expect(await stateOf(probe, 'add-ons')).toMatchObject({ state: 'WARN', summary: '1 of 1 add-on(s) not connected' });
  });
});

describe('doctor: the manager', () => {
  it('switched off: one line "manager off", never a FAIL, even without its kit', async () => {
    const probe = fakeProbe();
    probe.files.clear();
    const found = await checks(probe);
    const manager = [...found.values()].filter((check) => check.group === 'manager');
    expect(manager.map((check) => `${check.state} ${check.summary}`)).toEqual([expect.stringMatching(/^PASS manager off/)]);
  });

  it('switched on and set up: its own luady-ctl answers with the manager\'s HOME, alias hq, signed in, its tmux server', async () => {
    const probe = fakeProbe();
    probe.hub = status({ manager: MANAGER_ON });
    const found = await checks(probe);
    for (const id of ['manager-setup', 'manager-run', 'manager-ctl', 'manager-signin', 'manager-alias', 'manager-tmux']) {
      expect(found.get(id)?.state, id).toBe('PASS');
    }
  });

  it('a missing self-host luady-ctl FAILs', async () => {
    const probe = fakeProbe();
    probe.hub = status({ manager: MANAGER_ON });
    probe.files.delete(MANAGER_CTL);
    expect(await stateOf(probe, 'manager-ctl')).toMatchObject({ state: 'FAIL', fix: expect.stringContaining('off and on') });
  });

  it('a self-host kit with the wrong alias FAILs', async () => {
    const probe = fakeProbe();
    probe.hub = status({ manager: MANAGER_ON });
    probe.texts.set('/home/someone/.local/share/luady/data/manager-home/.luady/state/config.json', JSON.stringify({ host_alias: 'cedar' }));
    expect(await stateOf(probe, 'manager-alias')).toMatchObject({ state: 'FAIL', summary: 'The manager\'s kit answers to another name' });
  });

  it('a luady-ctl that does not answer version FAILs; signed out warns', async () => {
    const probe = fakeProbe();
    probe.hub = status({ manager: MANAGER_ON });
    probe.runs.set(`${MANAGER_CTL} version`, { code: 2, stdout: '', stderr: 'broken' });
    probe.runs.set(`${MANAGER_CTL} auth-status`, { code: 0, stdout: JSON.stringify({ logged_in: false }), stderr: '' });
    const found = await checks(probe);
    expect(found.get('manager-ctl')).toMatchObject({ state: 'FAIL' });
    expect(found.get('manager-signin')).toMatchObject({ state: 'WARN' });
  });

  it('a failed setup step FAILs with its name', async () => {
    const probe = fakeProbe();
    probe.hub = status({
      manager: { ...MANAGER_ON, switch: 'failed', state: 'off', bootstrap: { ...MANAGER_ON.bootstrap, state: 'failed', steps: [{ id: 'kit', state: 'failed', detail: 'python3 not found' }] } },
    });
    expect(await stateOf(probe, 'manager-setup')).toMatchObject({ state: 'FAIL', summary: 'The manager\'s setup stopped at: kit' });
  });
});

describe('doctor: what it prints', () => {
  async function broken(): Promise<FakeProbe> {
    const probe = fakeProbe();
    probe.hub = status({
      manager: MANAGER_ON,
      hosts: [{ id: 'cedar', kind: 'ssh', link: 'offline', kitVersion: null, kitAlias: null, claudeVersion: null, lastError: 'auth' }],
      configSync: { collisions: ['birch'], removed: [] },
      addons: [{ id: 'chat', kind: 'channel', state: 'down', connected: false }],
    });
    probe.files.delete('/home/someone/.local/bin/claude');
    return probe;
  }

  it('by default: states and counts, no name, address, e-mail, phone, path or secret; and how to get the rest', async () => {
    const report = await runDoctor(input(await broken(), {}, setUpDb()));
    const text = renderText(report, { full: false }).join('\n');
    expect(text).toContain(SAFE_NOTE);
    expect(text).toContain(FULL_HINT);
    for (const marker of [...SECRET_MARKERS, ...PRIVATE_MARKERS, 'cedar', 'birch', '192.0.2.13']) expect(text, marker).not.toContain(marker);
    expect(text).toMatch(/\d+ pass, \d+ warn, \d+ fail$/m);
    const json = renderJson(report, { full: false });
    for (const marker of [...SECRET_MARKERS, ...PRIVATE_MARKERS, 'cedar', 'birch']) expect(json, marker).not.toContain(marker);
    expect(JSON.parse(json)).toMatchObject({ full: false, exitCode: 1 });
  });

  it('--full: the particulars too, with the warning to remove private parts; never a secret', async () => {
    const report = await runDoctor(input(await broken(), {}, setUpDb()));
    const text = renderText(report, { full: true }).join('\n');
    expect(text).toContain(FULL_NOTE);
    expect(text).toContain('cedar (ssh): link offline');
    expect(text).toContain('/home/someone/.local/bin/claude');
    for (const marker of SECRET_MARKERS) expect(text, marker).not.toContain(marker);
    expect(JSON.parse(renderJson(report, { full: true })).checks.some((check: { detail?: string }) => check.detail?.includes('birch') === true)).toBe(true);
  });

  it('the exit code is 0 only without a FAIL', async () => {
    expect((await runDoctor(input(fakeProbe(), {}, setUpDb()))).exitCode).toBe(0);
    const probe = fakeProbe();
    probe.free = false;
    probe.hub = null;
    expect((await runDoctor(input(probe, {}, setUpDb()))).exitCode).toBe(1);
    const warnOnly = fakeProbe();
    warnOnly.runs.delete('tmux -V');
    expect((await runDoctor(input(warnOnly, {}, setUpDb()))).exitCode).toBe(0);
  });

  it('gives each kind of refusal one fixed sentence', () => {
    expect(refusalSentence('cannot read config file C:\\Users\\some one\\x.json: ENOENT')).toBe('config.json or secrets.env cannot be read');
    expect(refusalSentence('SQLITE_CANTOPEN: unable to open database file', 'the file cannot be opened')).toBe('the file cannot be opened');
    expect(refusalSentence('Refusing to start: /srv/x belongs to another Unix user.')).toBe('a file or folder the hub reads belongs to another user');
  });
});

describe('doctor: a refused config never shows the address, server name or key it names', () => {
  /** The message loadConfig gives for this config.json, as doctor's loader catches it. */
  function refusalOf(config: unknown): string {
    const home = mkdtempSync(join(tmpdir(), 'luady-doctor-'));
    try {
      mkdirSync(join(home, '.config', 'luady'), { recursive: true });
      writeFileSync(join(home, '.config', 'luady', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
      loadConfig({}, { home });
      throw new Error('the config was accepted');
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it.each([
    ['a remote bindHost', { bindHost: '203.0.113.7' }, '203.0.113.7', 'the install counts as remote, and "allowRemote" is not set'],
    ['two servers with one name', { servers: [{ name: 'orchard-box' }, { name: 'orchard-box' }] }, 'orchard-box',
      'two servers in config.json share a name, or one uses a reserved name'],
    ['an unknown key', { unknownKeyName: true }, 'unknownKeyName', 'a field of config.json is missing, unknown or of the wrong kind'],
    ['broken JSON', '{"webPort": ', 'config.json', 'config.json is not valid JSON'],
  ])('%s', async (_name, config, named, sentence) => {
    const message = refusalOf(config);
    expect(message).toContain(named);
    const found = await stateOf(fakeProbe(), 'config', { config: null, configError: message });
    expect(found.summary).toBe(`config.json cannot be used: ${sentence}`);
    if (named !== 'config.json') expect(found.summary).not.toContain(named);
    expect(found.detail).toContain(message);
    const text = renderText(await runDoctor(input(fakeProbe(), { config: null, configError: message }, null)), { full: false }).join('\n');
    if (named !== 'config.json') expect(text).not.toContain(named);
  });
});
