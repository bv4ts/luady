import { describe, expect, it } from 'vitest';
import type { Db, HubConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSetupCodeService } from '../../src/security/setup-codes.js';
import { claimBanner, groupCode, loginCommand, pinResetCommand, setupCodeCommand } from '../../src/setup/index.js';
import { createFakeClock } from '../helpers/fakes.js';

type Config = Pick<HubConfig, 'bindHost' | 'publicOrigin' | 'allowedHosts' | 'authMode'>;
const LOCAL: Config = { publicOrigin: 'http://localhost:7410', bindHost: '127.0.0.1', authMode: 'local' };
const REMOTE: Config = { publicOrigin: 'https://hub.example.com', bindHost: '127.0.0.1', authMode: 'local' };
const OPTIONS = { timeZone: 'UTC' } as const;

function addPasskey(db: Db): void {
  db.prepare(`INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at)
    VALUES ('cred-1', ?, 0, '[]', 'Laptop', '2026-11-21T08:00:00.000Z')`).run(Buffer.from([1, 2, 3]));
}

/** The grouped code a banner printed, as the hub stores it (dashes dropped). */
function codeIn(lines: readonly string[]): string {
  const line = lines.find((text) => text.startsWith('Setup code: ')) ?? '';
  return line.slice('Setup code: '.length).replace(/-/g, '');
}

describe('claimBanner', () => {
  it('on an unclaimed install: the URL, a new 30-minute code, when it expires, and the login-link way', () => {
    const db = openMemoryDb();
    const clock = createFakeClock();
    const banner = claimBanner(db, LOCAL, { clock, ...OPTIONS });
    expect(banner.claimed).toBe(false);
    expect(banner.lines[0]).toBe('Luady is running: open http://localhost:7410 in your browser.');
    expect(banner.lines).toContain('It works once and expires in 30 minutes (at 12:30).');
    expect(banner.lines).toContain('No passkey on this device? Run npm run luady -- login instead.');
    const code = codeIn(banner.lines);
    expect(code).toMatch(/^[A-Z2-7]{12}$/);
    expect(() => createSetupCodeService({ db, clock }).check(code, 'owner_setup')).not.toThrow();
  });

  it('works over the database alone: before the hub listens, and again after (each call a new code that voids the last)', () => {
    const db = openMemoryDb();
    const clock = createFakeClock();
    const first = codeIn(claimBanner(db, LOCAL, { clock, ...OPTIONS }).lines);
    const second = codeIn(claimBanner(db, LOCAL, { clock, ...OPTIONS }).lines);
    expect(first).not.toBe(second);
    expect(db.prepare("SELECT COUNT(*) AS n FROM setup_codes WHERE purpose = 'owner_setup'").get()).toEqual({ n: 1 });
    expect(() => createSetupCodeService({ db, clock }).check(first, 'owner_setup')).toThrow();
  });

  it('on a remote install it says a passkey is required and never offers the login link', () => {
    const banner = claimBanner(openMemoryDb(), REMOTE, { clock: createFakeClock(), ...OPTIONS });
    expect(banner.lines.join('\n')).not.toMatch(/luady -- login/);
    expect(banner.lines).toContain('This hub can be reached from other machines, so claim it with a passkey (login links are off).');
  });

  it('on a claimed install it issues nothing', () => {
    const db = openMemoryDb();
    addPasskey(db);
    db.prepare("UPDATE pin_state SET hash = 'set' WHERE id = 1").run();
    const banner = claimBanner(db, LOCAL, { clock: createFakeClock(), ...OPTIONS });
    expect(banner).toEqual({ claimed: true, lines: ['Luady is running: open http://localhost:7410 in your browser.'] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM setup_codes').get()).toEqual({ n: 0 });
  });

  it('on a claimed install without a PIN (after a reset) it says how to get a code, without issuing one', () => {
    const db = openMemoryDb();
    addPasskey(db);
    const banner = claimBanner(db, LOCAL, { clock: createFakeClock(), ...OPTIONS });
    expect(banner.lines[1]).toMatch(/run npm run luady -- setup-code/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM setup_codes').get()).toEqual({ n: 0 });
  });

  it('groups a code by four for reading; the hub ignores the dashes', () => {
    expect(groupCode('ABCDEFGHJKLM')).toBe('ABCD-EFGH-JKLM');
  });
});

describe('the terminal commands', () => {
  it('setup-code prints a new grouped code and its expiry', () => {
    const db = openMemoryDb();
    const result = setupCodeCommand(db, { clock: createFakeClock(), ...OPTIONS });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toMatch(/^Setup code: [A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(result.lines[1]).toBe('It works once and expires in 30 minutes (at 12:30).');
  });

  it('login prints the link, its 5 minutes, and a setup code while no PIN is set', () => {
    const db = openMemoryDb();
    const result = loginCommand(db, LOCAL, { clock: createFakeClock(), ...OPTIONS });
    expect(result.exitCode).toBe(0);
    expect(result.lines[1]).toMatch(/^ {2}http:\/\/localhost:7410\/setup\/login#[A-Za-z0-9_-]{43}$/);
    expect(result.lines[2]).toMatch(/expires in 5 minutes \(at 12:05\)/);
    expect(codeIn(result.lines)).toMatch(/^[A-Z2-7]{12}$/);
  });

  it('login prints no setup code once a PIN is set', () => {
    const db = openMemoryDb();
    addPasskey(db);
    db.prepare("UPDATE pin_state SET hash = 'set' WHERE id = 1").run();
    db.prepare("UPDATE setup_state SET step = 'done' WHERE id = 1").run();
    const result = loginCommand(db, LOCAL, { clock: createFakeClock(), ...OPTIONS });
    expect(result.lines.join('\n')).not.toMatch(/Setup code/);
  });

  it('login is refused on a remote install, with exit code 1 and nothing written', () => {
    const db = openMemoryDb();
    const result = loginCommand(db, REMOTE, { clock: createFakeClock(), ...OPTIONS });
    expect(result).toEqual({ exitCode: 1, lines: ['Login links are off: this hub can be reached from other machines. Sign in with a passkey.'] });
    expect(db.prepare('SELECT COUNT(*) AS n FROM setup_codes').get()).toEqual({ n: 0 });
  });

  it('pin reset says what happened and what to do next', () => {
    const db = openMemoryDb();
    db.prepare("INSERT INTO auth_sessions (sid, csrf, created_at, last_seen_at) VALUES ('a', 'b', 'c', 'd')").run();
    expect(pinResetCommand(db).lines).toEqual([
      'The PIN is cleared and 1 browser was signed out; open pages and web terminals close within a minute. Passkeys are kept.',
      'To choose a new PIN: sign in with your passkey first, then run npm run luady -- setup-code and enter that code on the page.',
      'No passkey on this device? Run npm run luady -- login instead: it prints a sign-in link and the setup code to use after it.',
    ]);
  });
});
