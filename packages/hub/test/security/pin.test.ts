import { beforeAll, describe, expect, it } from 'vitest';
import type { Channel } from '@luady/shared';
import type { Db, Logger, PinService } from '../../src/core/contracts.js';
import { AuthError, PinInvalidError, PinLockedError, PinNotSetError, ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createPinService, type PinFailureInfo } from '../../src/security/pin.js';
import { hashPin } from '../../src/security/pin-hash.js';
import { createSetupCodeService } from '../../src/security/setup-codes.js';
import { createFakeClock, silentLogger } from '../../test/helpers/fakes.js';
import { createCaptureLogger } from './capture-logger.js';

const PIN = '482915';
const NEW_PIN = '7654321';
const WRONG = '000000';
const MINUTE = 60_000;
let pinHash = '';

beforeAll(async () => {
  pinHash = await hashPin(PIN);
});

interface SetupOptions {
  withPin?: boolean;
  log?: Logger;
  onFailure?: (info: PinFailureInfo) => void;
}

function setup(options: SetupOptions = {}) {
  const db = openMemoryDb();
  const clock = createFakeClock();
  const setupCodes = createSetupCodeService({ db, clock });
  const failures: PinFailureInfo[] = [];
  if (options.withPin !== false) db.prepare('UPDATE pin_state SET hash = ? WHERE id = 1').run(pinHash);
  const record = (info: PinFailureInfo): void => {
    failures.push(info);
  };
  const pin = createPinService({ db, clock, setupCodes, log: options.log ?? silentLogger(), onFailure: options.onFailure ?? record });
  return { db, clock, setupCodes, failures, pin };
}

function counters(db: Db): unknown {
  return db.prepare('SELECT failed_count, lockouts, locked_until FROM pin_state WHERE id = 1').get();
}

function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
}

async function failTimes(pin: PinService, times: number, via: Channel = 'web'): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await expect(pin.verify(WRONG, via)).rejects.toBeInstanceOf(PinInvalidError);
  }
}

describe('createPinService.verify', { timeout: 30_000 }, () => {
  it('throws PinNotSetError while no PIN is set', async () => {
    const { pin } = setup({ withPin: false });
    expect(pin.isSet()).toBe(false);
    await expect(pin.verify(PIN, 'web')).rejects.toBeInstanceOf(PinNotSetError);
  });

  it('accepts the right PIN', async () => {
    const { pin, failures } = setup();
    expect(pin.isSet()).toBe(true);
    await expect(pin.verify(PIN, 'test-channel')).resolves.toBeUndefined();
    expect(failures).toEqual([]);
  });

  it('counts wrong PINs down and locks for 15 minutes on the third', async () => {
    const { db, pin, failures } = setup();
    const errors = [
      await rejection(pin.verify(WRONG, 'web')),
      await rejection(pin.verify(WRONG, 'web')),
      await rejection(pin.verify(WRONG, 'web')),
    ];
    expect(errors.every((err) => err instanceof PinInvalidError)).toBe(true);
    expect(errors.map((err) => (err as PinInvalidError).remaining)).toEqual([2, 1, 0]);
    expect(counters(db)).toEqual({ failed_count: 0, lockouts: 1, locked_until: '2026-10-09T12:15:00.000Z' });
    expect(failures).toEqual([
      { via: 'web', remaining: 2, lockedUntil: null },
      { via: 'web', remaining: 1, lockedUntil: null },
      { via: 'web', remaining: 0, lockedUntil: '2026-10-09T12:15:00.000Z' },
    ]);
  });

  it('rejects every attempt while locked without counting it', async () => {
    const { db, clock, pin, failures } = setup();
    await failTimes(pin, 3);
    const locked = await rejection(pin.verify(PIN, 'web'));
    expect(locked).toBeInstanceOf(PinLockedError);
    expect((locked as PinLockedError).until).toBe('2026-10-09T12:15:00.000Z');
    await expect(pin.verify(WRONG, 'test-channel')).rejects.toBeInstanceOf(PinLockedError);
    expect(counters(db)).toEqual({ failed_count: 0, lockouts: 1, locked_until: '2026-10-09T12:15:00.000Z' });
    expect(failures).toHaveLength(3);
    clock.advance(15 * MINUTE);
    await expect(pin.verify(PIN, 'web')).resolves.toBeUndefined();
    expect(counters(db)).toEqual({ failed_count: 0, lockouts: 0, locked_until: null });
  });

  it('doubles the lockout each time and resets it after a success', async () => {
    const { db, clock, pin } = setup();
    await failTimes(pin, 3);
    expect(counters(db)).toMatchObject({ lockouts: 1, locked_until: '2026-10-09T12:15:00.000Z' });
    clock.advance(15 * MINUTE);
    await failTimes(pin, 3);
    expect(counters(db)).toMatchObject({ lockouts: 2, locked_until: '2026-10-09T12:45:00.000Z' });
    clock.advance(30 * MINUTE);
    await failTimes(pin, 3);
    expect(counters(db)).toMatchObject({ lockouts: 3, locked_until: '2026-10-09T13:45:00.000Z' });
    clock.advance(60 * MINUTE);
    await pin.verify(PIN, 'web');
    await failTimes(pin, 3);
    expect(counters(db)).toMatchObject({ lockouts: 1, locked_until: '2026-10-09T14:00:00.000Z' });
  });

  it('shares one failure counter across channels', async () => {
    const { pin, failures } = setup();
    await failTimes(pin, 1, 'test-channel');
    await failTimes(pin, 1, 'web');
    await failTimes(pin, 1, 'phone');
    await expect(pin.verify(PIN, 'web')).rejects.toBeInstanceOf(PinLockedError);
    expect(failures.map((info) => [info.via, info.remaining])).toEqual([
      ['test-channel', 2],
      ['web', 1],
      ['phone', 0],
    ]);
  });

  it('serializes concurrent attempts so parallel guesses cannot skip the lockout', async () => {
    const { pin } = setup();
    const results = await Promise.allSettled([
      pin.verify(WRONG, 'web'),
      pin.verify(WRONG, 'test-channel'),
      pin.verify(WRONG, 'web'),
      pin.verify(WRONG, 'test-channel'),
      pin.verify(PIN, 'web'),
    ]);
    const names = results.map((result) => (result.status === 'fulfilled' ? 'ok' : (result.reason as Error).name));
    expect(names).toEqual(['PinInvalidError', 'PinInvalidError', 'PinInvalidError', 'PinLockedError', 'PinLockedError']);
    const remaining = results.slice(0, 3).map((result) => ((result as PromiseRejectedResult).reason as PinInvalidError).remaining);
    expect(remaining).toEqual([2, 1, 0]);
  });

  it('counts a malformed PIN as a failure', async () => {
    const { pin } = setup();
    const err = await rejection(pin.verify('12ab', 'web'));
    expect(err).toBeInstanceOf(PinInvalidError);
    expect((err as PinInvalidError).remaining).toBe(2);
  });

  it('still throws PinInvalidError when the failure notifier throws or rejects', async () => {
    const throwing = setup({
      onFailure: () => {
        throw new Error('notifier down');
      },
    });
    await expect(throwing.pin.verify(WRONG, 'web')).rejects.toBeInstanceOf(PinInvalidError);
    const rejecting = setup({
      onFailure: async () => {
        throw new Error('notifier down');
      },
    });
    await expect(rejecting.pin.verify(WRONG, 'web')).rejects.toBeInstanceOf(PinInvalidError);
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('createPinService.set', { timeout: 30_000 }, () => {
  it('needs a valid setup code for the first PIN and consumes it', async () => {
    const { pin, setupCodes } = setup({ withPin: false });
    const code = setupCodes.issue('owner_setup');
    await expect(pin.set(PIN, {})).rejects.toBeInstanceOf(AuthError);
    await expect(pin.set(PIN, { setupCode: 'AAAAAAAAAAAA' })).rejects.toBeInstanceOf(AuthError);
    await expect(pin.set(PIN, { setupCode: code })).resolves.toBeUndefined();
    expect(pin.isSet()).toBe(true);
    await expect(pin.verify(PIN, 'web')).resolves.toBeUndefined();
    expect(() => setupCodes.check(code, 'owner_setup')).toThrow(AuthError);
  });

  it('rejects a malformed new PIN without using up the setup code', async () => {
    const { pin, setupCodes } = setup({ withPin: false });
    const code = setupCodes.issue('owner_setup');
    await expect(pin.set('12ab', { setupCode: code })).rejects.toBeInstanceOf(ValidationError);
    await expect(pin.set('12345', { setupCode: code })).rejects.toBeInstanceOf(ValidationError);
    expect(() => setupCodes.check(code, 'owner_setup')).not.toThrow();
    expect(pin.isSet()).toBe(false);
  });

  it('changes the PIN only with the current PIN and counts wrong ones', async () => {
    const { db, pin } = setup();
    await expect(pin.set(NEW_PIN, {})).rejects.toBeInstanceOf(AuthError);
    await expect(pin.set(NEW_PIN, { currentPin: WRONG })).rejects.toBeInstanceOf(PinInvalidError);
    expect(counters(db)).toMatchObject({ failed_count: 1 });
    await expect(pin.set(NEW_PIN, { currentPin: PIN })).resolves.toBeUndefined();
    await expect(pin.verify(NEW_PIN, 'web')).resolves.toBeUndefined();
    await expect(pin.verify(PIN, 'web')).rejects.toBeInstanceOf(PinInvalidError);
  });

  it('never lets a setup code replace an existing PIN', async () => {
    const { pin, setupCodes } = setup();
    const code = setupCodes.issue('owner_setup');
    await expect(pin.set(NEW_PIN, { setupCode: code })).rejects.toBeInstanceOf(AuthError);
    expect(() => setupCodes.check(code, 'owner_setup')).not.toThrow();
    await expect(pin.verify(PIN, 'web')).resolves.toBeUndefined();
  });

  it('refuses a PIN change while locked', async () => {
    const { pin } = setup();
    await failTimes(pin, 3);
    await expect(pin.set(NEW_PIN, { currentPin: PIN })).rejects.toBeInstanceOf(PinLockedError);
  });

  it('stores only an argon2id hash', async () => {
    const { db, pin, setupCodes } = setup({ withPin: false });
    await pin.set(PIN, { setupCode: setupCodes.issue('owner_setup') });
    const row = db.prepare('SELECT hash FROM pin_state WHERE id = 1').get() as { hash: string };
    expect(row.hash.startsWith('$argon2id$')).toBe(true);
    expect(row.hash).not.toContain(PIN);
  });

  it('never writes a PIN to the logs', async () => {
    const { log, lines } = createCaptureLogger();
    const { clock, pin, setupCodes } = setup({ withPin: false, log });
    await pin.set(PIN, { setupCode: setupCodes.issue('owner_setup') });
    await failTimes(pin, 3, 'test-channel');
    await expect(pin.verify(PIN, 'web')).rejects.toBeInstanceOf(PinLockedError);
    clock.advance(15 * MINUTE);
    await pin.set(NEW_PIN, { currentPin: PIN });
    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    expect(all).not.toContain(PIN);
    expect(all).not.toContain(NEW_PIN);
  });
});
