import { describe, expect, it, vi } from 'vitest';
import type { SetupStateDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, HubConfig } from '../../src/core/contracts.js';
import { RefusedError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSetupState, passkeySkipRefusal, readFacts, setupPending, stateOf } from '../../src/setup/state.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

type SetupConfig = Pick<HubConfig, 'bindHost' | 'publicOrigin' | 'allowedHosts' | 'authMode'>;

const LOCAL: SetupConfig = { publicOrigin: 'http://localhost:7410', bindHost: '127.0.0.1', authMode: 'local' };
const REMOTE: SetupConfig = { publicOrigin: 'https://hub.example.com', bindHost: '127.0.0.1', authMode: 'local' };
const LINKED = { linkSession: true, localRequest: true } as const;
const NOT_LINKED = { linkSession: false, localRequest: true } as const;

function addPasskey(db: Db, id = 'cred-1'): void {
  db.prepare(`INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at)
    VALUES (?, ?, 0, '[]', 'Laptop', '2026-11-21T08:00:00.000Z')`).run(id, Buffer.from([1, 2, 3]));
}

function setPin(db: Db): void {
  // Any non-null hash means "set": the state only reads whether there is one.
  db.prepare('UPDATE pin_state SET hash = ? WHERE id = 1').run(['$argon2id', 'v=19', 'stand-in'].join('$'));
}

function setup(config: SetupConfig = LOCAL) {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock();
  const sent: SetupStateDTO[] = [];
  bus.on('setup.changed', ({ state }) => sent.push(state));
  const service = createSetupState({ db, bus, clock, config, log: silentLogger() });
  return { db, bus, clock, sent, service };
}

describe('the setup state', () => {
  it('a fresh install is at claim and unclaimed', () => {
    const { service } = setup();
    expect(service.state()).toEqual({ step: 'claim', claimed: false, authMode: 'local', remote: false, skipped: [] });
  });

  it('fresh → claim; first passkey → pin; PIN → rooms; then connect, extras and done', () => {
    const { db, service } = setup();
    expect(service.state().step).toBe('claim');
    addPasskey(db);
    expect(service.state()).toMatchObject({ step: 'pin', claimed: true });
    setPin(db);
    expect(service.state()).toMatchObject({ step: 'rooms', claimed: true });
    expect(service.advance('rooms', 'done', NOT_LINKED).step).toBe('connect');
    expect(service.advance('connect', 'skip', NOT_LINKED)).toMatchObject({ step: 'extras', skipped: ['connect'] });
    // The last step stays put until finish: the summary screen is a view of it.
    expect(service.advance('extras', 'done', NOT_LINKED).step).toBe('extras');
    expect(service.finish()).toMatchObject({ step: 'done', claimed: true, skipped: ['connect'] });
    expect(db.prepare('SELECT completed_at FROM setup_state WHERE id = 1').get()).toEqual({ completed_at: '2026-10-09T12:00:00.000Z' });
  });

  it('an existing install (migrated with a passkey) is done, and so is the state the CLI reads', () => {
    const { db, service } = setup();
    db.prepare("UPDATE setup_state SET step = 'done' WHERE id = 1").run();
    addPasskey(db);
    setPin(db);
    expect(service.state()).toEqual({ step: 'done', claimed: true, authMode: 'local', remote: false, skipped: [] });
    expect(stateOf(readFacts(db), LOCAL)).toEqual(service.state());
  });

  it('an install with a PIN but no passkey has an owner: it is claimed and never back at claim', () => {
    const { db, service } = setup();
    setPin(db);
    expect(service.state()).toMatchObject({ step: 'rooms', claimed: true });
  });

  it('after a PIN reset a claimed install asks for the PIN again, then returns to where it was', () => {
    const { db, service } = setup();
    db.prepare("UPDATE setup_state SET step = 'done' WHERE id = 1").run();
    addPasskey(db);
    expect(service.state()).toMatchObject({ step: 'pin', claimed: true });
    setPin(db);
    expect(service.state()).toMatchObject({ step: 'done', claimed: true });
  });

  it('skipping the passkey with a link session moves on to the PIN, but the install is claimed only once the PIN is set', () => {
    const { db, service } = setup();
    expect(service.advance('passkey', 'skip', LINKED)).toEqual({
      step: 'pin', claimed: false, authMode: 'local', remote: false, skipped: ['passkey'],
    });
    setPin(db);
    expect(service.state()).toMatchObject({ step: 'rooms', claimed: true, skipped: ['passkey'] });
  });

  it('a passkey made after the skip clears the skip', () => {
    const { db, service } = setup();
    service.advance('passkey', 'skip', LINKED);
    addPasskey(db);
    expect(service.state()).toMatchObject({ step: 'pin', claimed: true, skipped: [] });
  });

  it('refuses to skip the passkey without a link session', () => {
    const { service } = setup();
    expect(passkeySkipRefusal(NOT_LINKED, LOCAL)).toMatch(/login link/);
    expect(() => service.advance('passkey', 'skip', NOT_LINKED)).toThrow(RefusedError);
    expect(service.state().step).toBe('claim');
  });

  it('refuses to skip the passkey on a remote install, even for a link session', () => {
    const { service } = setup(REMOTE);
    expect(service.state()).toMatchObject({ remote: true });
    expect(passkeySkipRefusal(LINKED, REMOTE)).toMatch(/passkey is required/);
    expect(() => service.advance('passkey', 'skip', LINKED)).toThrow(RefusedError);
    expect(service.state().skipped).toEqual([]);
  });

  it('refuses to skip the passkey for a request that is not local (a proxy, another machine)', () => {
    const { service } = setup();
    expect(() => service.advance('passkey', 'skip', { linkSession: true, localRequest: false })).toThrow(RefusedError);
  });

  it('refuses a passkey skip once a passkey exists, and a passkey "done" without one', () => {
    const { db, service } = setup();
    expect(() => service.advance('passkey', 'done', LINKED)).toThrow(/No passkey/);
    addPasskey(db);
    expect(() => service.advance('passkey', 'skip', LINKED)).toThrow(RefusedError);
    expect(service.advance('passkey', 'done', NOT_LINKED).step).toBe('pin');
  });

  it('refuses the wizard steps before the PIN, and a step ahead of the current one', () => {
    const { db, service } = setup();
    expect(() => service.advance('rooms', 'done', NOT_LINKED)).toThrow(/PIN first/);
    expect(() => service.finish()).toThrow(/PIN first/);
    addPasskey(db);
    setPin(db);
    expect(() => service.advance('extras', 'skip', NOT_LINKED)).toThrow(/rooms step first/);
    expect(service.state().step).toBe('rooms');
  });

  it('an earlier step again changes nothing; a later "done" clears an earlier skip of the same step', () => {
    const { db, service } = setup();
    addPasskey(db);
    setPin(db);
    service.advance('rooms', 'skip', NOT_LINKED);
    expect(service.advance('rooms', 'done', NOT_LINKED)).toMatchObject({ step: 'connect', skipped: [] });
    service.advance('connect', 'done', NOT_LINKED);
    expect(service.advance('rooms', 'skip', NOT_LINKED)).toMatchObject({ step: 'extras', skipped: [] });
  });

  it('finishing early marks the steps never reached as skipped; finishing again changes nothing', () => {
    const { db, service } = setup();
    addPasskey(db);
    setPin(db);
    expect(service.finish()).toMatchObject({ step: 'done', skipped: ['rooms', 'connect', 'extras'] });
    expect(service.finish()).toMatchObject({ step: 'done', skipped: ['rooms', 'connect', 'extras'] });
  });

  it('sends setup.changed on every change, and notify() sends only when something changed', () => {
    const { db, sent, service } = setup();
    service.notify();
    expect(sent).toHaveLength(0);
    addPasskey(db);
    service.notify();
    service.notify();
    expect(sent.map((state) => state.step)).toEqual(['pin']);
    setPin(db);
    service.advance('rooms', 'done', NOT_LINKED);
    service.finish();
    expect(sent.map((state) => state.step)).toEqual(['pin', 'connect', 'done']);
  });

  it('ignores unknown or repeated entries in the stored skip list', () => {
    const { db, service } = setup();
    db.prepare('UPDATE setup_state SET skipped_json = ? WHERE id = 1').run('["rooms","rooms","nonsense",7]');
    addPasskey(db);
    setPin(db);
    expect(service.state().skipped).toEqual(['rooms']);
    db.prepare("UPDATE setup_state SET skipped_json = 'not json' WHERE id = 1").run();
    expect(service.state().skipped).toEqual([]);
  });

  it('prepares its statements once: reading the state (an anonymous route) prepares nothing', () => {
    const { db, service } = setup();
    const prepare = vi.spyOn(db, 'prepare');
    for (let i = 0; i < 5; i += 1) service.state();
    service.notify();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('setup is pending (the hub answers only sign-in and setup) while the step is claim or pin', () => {
    const { db, service } = setup();
    expect(setupPending(service.state())).toBe(true);
    addPasskey(db);
    expect(setupPending(service.state())).toBe(true);
    setPin(db);
    expect(setupPending(service.state())).toBe(false);
    service.finish();
    expect(setupPending(service.state())).toBe(false);
  });

  it('reports the auth mode and the remote rule from the config', () => {
    const access = setup({ ...REMOTE, authMode: 'cloudflare-access' });
    expect(access.service.state()).toMatchObject({ authMode: 'cloudflare-access', remote: true });
  });
});
