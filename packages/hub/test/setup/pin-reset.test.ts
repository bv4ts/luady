import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { AuthError, PinNotSetError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createPinService } from '../../src/security/pin.js';
import { createSetupCodeService } from '../../src/security/setup-codes.js';
import { resetPin } from '../../src/setup/pin-reset.js';
import { createSessionStore } from '../../src/web/auth/sessions.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

const PIN = '482915';
const NEXT_PIN = '7654321';

function addPasskey(db: Db): void {
  db.prepare(`INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at)
    VALUES ('cred-1', ?, 0, '[]', 'Laptop', '2026-11-21T08:00:00.000Z')`).run(Buffer.from([1, 2, 3]));
}

async function claimed() {
  const db = openMemoryDb();
  const clock = createFakeClock();
  const setupCodes = createSetupCodeService({ db, clock });
  const onChange = vi.fn();
  const pin = createPinService({ db, clock, setupCodes, log: silentLogger(), onChange });
  addPasskey(db);
  await pin.set(PIN, { setupCode: setupCodes.issue('owner_setup') });
  const sessions = createSessionStore({ db, clock });
  const signedIn = [sessions.create(), sessions.create()];
  return { db, clock, setupCodes, pin, sessions, signedIn, onChange };
}

describe('resetPin (`luady pin reset`)', () => {
  it('clears the PIN and its lockout, ends every session, and leaves the passkeys alone', async () => {
    const { db, pin, sessions, signedIn } = await claimed();
    db.prepare("UPDATE pin_state SET failed_count = 2, lockouts = 3, locked_until = '2026-10-09T13:00:00.000Z' WHERE id = 1").run();
    expect(resetPin(db)).toEqual({ sessionsEnded: 2, codesEnded: 0 });
    expect(pin.isSet()).toBe(false);
    expect(db.prepare('SELECT hash, failed_count, lockouts, locked_until FROM pin_state WHERE id = 1').get())
      .toEqual({ hash: null, failed_count: 0, lockouts: 0, locked_until: null });
    for (const session of signedIn) expect(sessions.peek(session.sid)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_passkeys').get()).toEqual({ n: 1 });
    await expect(pin.verify(PIN, 'web')).rejects.toBeInstanceOf(PinNotSetError);
  });

  it('a new PIN needs a new setup code: a code issued before the reset no longer works', async () => {
    const { db, setupCodes, pin } = await claimed();
    const before = setupCodes.issue('owner_setup');
    const token = setupCodes.issue('owner_login');
    expect(resetPin(db)).toMatchObject({ codesEnded: 2 });
    await expect(pin.set(NEXT_PIN, { setupCode: before })).rejects.toBeInstanceOf(AuthError);
    await expect(pin.set(NEXT_PIN, {})).rejects.toBeInstanceOf(AuthError);
    expect(() => setupCodes.check(token, 'owner_login')).toThrow(AuthError);
    await pin.set(NEXT_PIN, { setupCode: setupCodes.issue('owner_setup') });
    await expect(pin.verify(NEXT_PIN, 'web')).resolves.toBeUndefined();
  });

  it('is one transaction: on a database without the PIN row nothing is ended', async () => {
    const { db } = await claimed();
    db.prepare('DELETE FROM pin_state').run();
    expect(() => resetPin(db)).toThrow(/pin_state/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 2 });
  });

  it('the PIN service tells the setup state when the PIN changes', async () => {
    const { pin, onChange } = await claimed();
    expect(onChange).toHaveBeenCalledTimes(1);
    await pin.set(NEXT_PIN, { currentPin: PIN });
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
