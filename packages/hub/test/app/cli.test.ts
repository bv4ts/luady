import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NO_INSTALL, USAGE, runCli, type CliDeps, type CliStore, type StartedHub } from '../../src/cli.js';
import { remoteNotAllowed } from '../../src/config/refusals.js';
import { systemClock } from '../../src/core/clock.js';
import type { Db, HubConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { FULL_HINT } from '../../src/doctor/report.js';
import { createSetupCodeService } from '../../src/security/setup-codes.js';
import { SETUP_CODE_ELSEWHERE } from '../../src/setup/claim.js';
import { fakeProbe, input, PRIVATE_MARKERS, SECRET_MARKERS, type FakeProbe } from '../doctor/fake-probe.js';
import { markSetUp } from '../helpers/claimed.js';
import { loadedDefaults } from '../helpers/loaded-config.js';

const config: HubConfig = {
  ...loadedDefaults('/home/luady/data'),
  servers: [{ name: 'cedar', host: '192.0.2.13', user: 'dev', port: 22, hostKeyFp: 'SHA256:abc' }],
  fleetKeyPath: '/home/luady/.local/share/luady/data/fleet_ed25519', dataDir: '/home/luady/data', brainDir: '/home/luady/brain',
  runDir: '/home/luady/run', webDir: '/home/luady/app/packages/web/dist', webPort: 7410,
  publicOrigin: 'http://localhost:7410', rpId: 'localhost', cfTeamDomain: '',
  cfAccessAud: '', sessionSecret: 'SECRET-SESSION', hubSocketToken: 'SECRET-HUB-TOKEN', claudePath: '/home/luady/.local/bin/claude',
  localCtlPath: '/home/luady/.luady/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl', authMode: 'local', bindHost: '127.0.0.1',
};
const REMOTE: HubConfig = { ...config, publicOrigin: 'https://hub.example.com', rpId: 'hub.example.com' };

const CODE_RE = /^[A-Z2-7]{12}$/;

interface Harness extends CliDeps {
  readonly db: Db;
  readonly lines: string[];
  readonly errors: string[];
  readonly closed: () => number;
  readonly opened: () => number;
  readonly stopped: StartedHub[];
  readonly probe: FakeProbe;
  readonly asked: string[];
}

interface HarnessOptions {
  config?: HubConfig;
  start?: () => Promise<StartedHub>;
  answer?: string;
  /** False: this user has no install (no config, secrets or database). */
  installed?: boolean;
  /** False: standard output is a log or a pipe, not a terminal. */
  terminal?: boolean;
}

function harness(opts: HarnessOptions = {}): Harness {
  const db = openMemoryDb();
  const lines: string[] = [];
  const errors: string[] = [];
  const stopped: StartedHub[] = [];
  const asked: string[] = [];
  const probe = fakeProbe();
  let closes = 0;
  let opened = 0;
  const cfg = opts.config ?? config;
  const store = (): CliStore => ({
    config: cfg, db,
    close: async () => {
      closes += 1;
    },
  });
  return {
    db, lines, errors, stopped, probe, asked, closed: () => closes, opened: () => opened,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    open: async () => {
      opened += 1;
      return store();
    },
    installFound: () => opts.installed ?? true,
    isTerminal: () => opts.terminal ?? true,
    startHub: opts.start ?? (async () => ({ config: cfg, stop: async () => undefined })),
    untilStopped: (hub) => stopped.push(hub),
    doctorInput: async () => ({ ...input(probe, {}, db), close: () => { closes += 1; } }),
    ask: async (question) => {
      asked.push(question);
      return opts.answer ?? '';
    },
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const codeRows = (db: Db, purpose: string): Array<{ code_sha256: string; expires_at: string; used_at: string | null }> =>
  db.prepare('SELECT code_sha256, expires_at, used_at FROM setup_codes WHERE purpose = ?').all(purpose) as Array<{
    code_sha256: string; expires_at: string; used_at: string | null;
  }>;
const addPasskey = (db: Db): void => {
  db.prepare("INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at) VALUES ('c1', x'00', 0, '[]', 'key', '2026-11-21T00:00:00Z')").run();
};

/** The setup code in printed lines (the setup module shows it grouped, ABCD-EFGH-JKLM), as stored: without dashes. */
const printedCode = (lines: readonly string[]): string => (/Setup code: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/.exec(lines.join('\n'))?.[1] ?? '').replace(/-/g, '');
const OPEN_LINE = 'Luady is running: open http://localhost:7410 in your browser.';

describe('luady (runCli)', () => {
  it('prints the usage and returns 2 for no command or an unknown one', async () => {
    for (const args of [[], ['nope'], ['pin'], ['pin', 'set']]) {
      const h = harness();
      await expect(runCli(args, h)).resolves.toBe(2);
      expect(h.lines).toEqual([...USAGE]);
      expect(h.lines.join('\n')).toMatch(/start[\s\S]*setup-code[\s\S]*login[\s\S]*pin reset[\s\S]*doctor/);
    }
  });

  it('setup-code prints one single-use owner code for 30 minutes, stored only as its hash', async () => {
    const h = harness();
    const before = Date.now();
    await expect(runCli(['setup-code'], h)).resolves.toBe(0);
    const code = printedCode(h.lines);
    expect(code).toMatch(CODE_RE);
    const [row] = codeRows(h.db, 'owner_setup');
    expect(row?.code_sha256).toBe(sha256(code));
    expect(Date.parse(row?.expires_at ?? '') - before).toBeGreaterThan(29 * 60_000);
    expect(h.lines.join('\n')).toMatch(/works once and expires in 30 minutes/);
    expect(h.closed()).toBe(1);
  });

  it('setup-code voids the code printed before it: one code is live at a time', async () => {
    const h = harness();
    await runCli(['setup-code'], h);
    const first = h.lines.length;
    await runCli(['setup-code'], h);
    const rows = codeRows(h.db, 'owner_setup');
    expect(rows.filter((row) => row.used_at === null)).toHaveLength(1);
    expect(rows[0]?.code_sha256).toBe(sha256(printedCode(h.lines.slice(first))));
  });

  describe('login', () => {
    it('prints a one-time link on this machine, stores only its hash for 5 minutes, and the setup code while unclaimed', async () => {
      const h = harness();
      const before = Date.now();
      await expect(runCli(['login'], h)).resolves.toBe(0);
      const output = h.lines.join('\n');
      const token = /http:\/\/localhost:7410\/setup\/login#([A-Za-z0-9_-]+)/.exec(output)?.[1] ?? '';
      expect(token.length).toBeGreaterThanOrEqual(20);
      const [row] = codeRows(h.db, 'owner_login');
      expect(row?.code_sha256).toBe(sha256(token));
      expect(row?.used_at).toBeNull();
      const lifetime = Date.parse(row?.expires_at ?? '') - before;
      expect(lifetime).toBeGreaterThan(4 * 60_000);
      expect(lifetime).toBeLessThanOrEqual(5 * 60_000 + 1_000);
      // Unclaimed: the first PIN needs the setup code, so it is printed beside the link.
      expect(codeRows(h.db, 'owner_setup').map((r) => r.code_sha256)).toEqual([sha256(printedCode(h.lines))]);
      expect(JSON.stringify(h.db.prepare('SELECT * FROM setup_codes').all())).not.toContain(token);
      expect(h.errors).toEqual([]);
    });

    it('prints no setup code on a set-up install', async () => {
      const h = harness();
      addPasskey(h.db);
      await markSetUp(h.db);
      await expect(runCli(['login'], h)).resolves.toBe(0);
      expect(h.lines.join('\n')).not.toContain('Setup code');
      expect(codeRows(h.db, 'owner_setup')).toEqual([]);
    });

    it('is refused on a remote install, writing nothing', async () => {
      const h = harness({ config: REMOTE });
      await expect(runCli(['login'], h)).resolves.toBe(1);
      expect(h.lines).toEqual([]);
      expect(h.errors.join('\n')).toMatch(/Login links are off/);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM setup_codes').get()).toEqual({ n: 0 });
      const behindBind = harness({ config: { ...config, bindHost: '0.0.0.0' } });
      await expect(runCli(['login'], behindBind)).resolves.toBe(1);
    });
  });

  describe('start', () => {
    it('starts the hub, prints where it is and a setup code while unclaimed, then keeps it running', async () => {
      const h = harness();
      await expect(runCli(['start'], h)).resolves.toBe(0);
      expect(h.lines[0]).toBe(OPEN_LINE);
      expect(codeRows(h.db, 'owner_setup').map((row) => row.code_sha256)).toEqual([sha256(printedCode(h.lines))]);
      expect(h.lines.join('\n')).toContain('npm run luady -- login');
      expect(h.stopped).toHaveLength(1);
      expect(h.closed()).toBe(1);
    });

    it('prints no code on a set-up install', async () => {
      const h = harness();
      addPasskey(h.db);
      await markSetUp(h.db);
      await expect(runCli(['start'], h)).resolves.toBe(0);
      expect(h.lines).toEqual([OPEN_LINE]);
      expect(codeRows(h.db, 'owner_setup')).toEqual([]);
    });

    it('when its output is not a terminal (a service log), issues and prints no code, only how to get one', async () => {
      const h = harness({ terminal: false });
      await expect(runCli(['start'], h)).resolves.toBe(0);
      expect(h.lines).toEqual([OPEN_LINE, SETUP_CODE_ELSEWHERE, 'No passkey on this device? Run npm run luady -- login instead.']);
      expect(h.lines.join('\n')).toContain('npm run luady -- setup-code');
      expect(h.lines.join('\n')).not.toMatch(/Setup code: /);
      expect(codeRows(h.db, 'owner_setup')).toEqual([]);
      expect(h.stopped).toHaveLength(1);
    });

    it('prints a startup refusal as one line and returns 1', async () => {
      const h = harness({ start: async () => { throw remoteNotAllowed('bindHost 0.0.0.0 is not a loopback address'); } });
      await expect(runCli(['start'], h)).resolves.toBe(1);
      expect(h.errors).toHaveLength(1);
      expect(h.errors[0]).toMatch(/^Refusing to start: /);
      expect(h.lines).toEqual([]);
      expect(h.stopped).toEqual([]);
    });

    it('lets any other start failure through', async () => {
      const h = harness({ start: async () => { throw new Error('EADDRINUSE'); } });
      await expect(runCli(['start'], h)).rejects.toThrow('EADDRINUSE');
    });
  });

  describe('without an install', () => {
    it.each([[['setup-code']], [['login']], [['pin', 'reset']]])('%j refuses with a clear sentence and creates nothing', async (args) => {
      const h = harness({ installed: false, answer: 'yes' });
      await expect(runCli(args, h)).resolves.toBe(1);
      expect(h.errors).toEqual([...NO_INSTALL]);
      expect(h.lines).toEqual([]);
      expect(h.asked).toEqual([]);
      expect(h.opened()).toBe(0);
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM setup_codes').get()).toEqual({ n: 0 });
    });
  });

  describe('pin reset', () => {
    function withPin(h: Harness): void {
      h.db.prepare("UPDATE pin_state SET hash = 'argon2-hash', failed_count = 2, lockouts = 1 WHERE id = 1").run();
      h.db.prepare("INSERT INTO auth_sessions (sid, csrf, created_at, last_seen_at) VALUES ('s1', 'c', '2026-11-21T00:00:00Z', '2026-11-21T00:00:00Z')").run();
      addPasskey(h.db);
    }

    it('needs a typed yes: anything else changes nothing', async () => {
      const h = harness({ answer: 'y' });
      withPin(h);
      await expect(runCli(['pin', 'reset'], h)).resolves.toBe(1);
      expect(h.asked).toEqual(['Type yes to reset the PIN: ']);
      expect(h.lines.at(-1)).toBe('Nothing changed.');
      expect(h.db.prepare('SELECT hash FROM pin_state').get()).toEqual({ hash: 'argon2-hash' });
    });

    it('with yes: the PIN, its lockout, every session and every unused code go; passkeys stay', async () => {
      const h = harness({ answer: 'yes' });
      withPin(h);
      await runCli(['setup-code'], h);
      await expect(runCli(['pin', 'reset'], h)).resolves.toBe(0);
      expect(h.db.prepare('SELECT hash, failed_count, lockouts FROM pin_state').get()).toEqual({ hash: null, failed_count: 0, lockouts: 0 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
      expect(h.db.prepare('SELECT COUNT(*) AS n FROM auth_passkeys').get()).toEqual({ n: 1 });
      expect(codeRows(h.db, 'owner_setup')).toEqual([]);
      expect(h.lines.join('\n')).toMatch(/The PIN is cleared and 1 browser was signed out[\s\S]*run npm run luady -- setup-code/);
    });

    it('the steps it prints work: the code of setup-code, or the one login prints, is the live one', async () => {
      const h = harness({ answer: 'yes' });
      withPin(h);
      await runCli(['pin', 'reset'], h);
      const codes = createSetupCodeService({ db: h.db, clock: systemClock });
      // With a passkey: sign in, then setup-code. Its code is live.
      let from = h.lines.length;
      await runCli(['setup-code'], h);
      const printed = printedCode(h.lines.slice(from));
      expect(() => codes.check(printed, 'owner_setup')).not.toThrow();
      // Without one: login prints a link and a code of its own; that code works, the earlier one no longer does.
      from = h.lines.length;
      await expect(runCli(['login'], h)).resolves.toBe(0);
      const withLink = printedCode(h.lines.slice(from));
      expect(withLink).toMatch(CODE_RE);
      expect(() => codes.check(withLink, 'owner_setup')).not.toThrow();
      expect(() => codes.check(printed, 'owner_setup')).toThrow();
    });
  });

  describe('doctor', () => {
    it('prints the safe report by default and exits 0 without a FAIL', async () => {
      const h = harness();
      await expect(runCli(['doctor'], h)).resolves.toBe(0);
      const text = h.lines.join('\n');
      expect(text).toContain(FULL_HINT);
      for (const marker of [...SECRET_MARKERS, ...PRIVATE_MARKERS]) expect(text, marker).not.toContain(marker);
      expect(h.closed()).toBe(1);
    });

    it('--full adds the particulars; --json prints JSON; a FAIL exits 1; an unknown flag prints the usage', async () => {
      const full = harness();
      full.probe.files.delete('/home/someone/luady/packages/web/dist/index.html');
      await expect(runCli(['doctor', '--full'], full)).resolves.toBe(1);
      expect(full.lines.join('\n')).toContain('/home/someone/luady/packages/web/dist/index.html');
      const json = harness();
      await expect(runCli(['doctor', '--json'], json)).resolves.toBe(0);
      expect(JSON.parse(json.lines.join('\n'))).toMatchObject({ full: false, exitCode: 0 });
      await expect(runCli(['doctor', '--everything'], harness())).resolves.toBe(2);
    });
  });
});
