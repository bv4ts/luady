import { PIN_RE, type Channel } from '@luady/shared';
import type { Clock, Db, Logger, PinService, SetupCodeService } from '../core/contracts.js';
import { AuthError, PinInvalidError, PinLockedError, PinNotSetError, ValidationError } from '../core/errors.js';
import { createMutex } from './mutex.js';
import { hashPin, verifyPinHash } from './pin-hash.js';
import { voidOtherSetupCodes } from './setup-codes.js';

export interface PinFailureInfo {
  via: Channel;
  remaining: number;
  lockedUntil: string | null;
}

export interface PinDeps {
  db: Db;
  clock: Clock;
  setupCodes: SetupCodeService;
  log: Logger;
  onFailure?: (info: PinFailureInfo) => void;
  /** After the PIN was set or changed (the setup state moves on from its PIN step). Never told the PIN. */
  onChange?: () => void;
}

/** Consecutive wrong PINs that trigger a lockout. */
export const PIN_MAX_FAILURES = 3;
/** First lockout length; every further lockout doubles it (15, 30, 60 min, …). */
export const PIN_LOCK_BASE_MS = 15 * 60_000;
/** Keeps the date valid; ~30 years, unreachable in practice. */
const PIN_LOCK_MAX_DOUBLINGS = 20;
/** PIN changes only arrive through POST /api/auth/pin. */
const PIN_CHANGE_CHANNEL: Channel = 'web';

interface PinRow {
  hash: string | null;
  failed_count: number;
  locked_until: string | null;
  lockouts: number;
}

interface PinStore {
  read(): PinRow;
  writeCounters(failed: number, lockouts: number, lockedUntil: string | null): void;
  writeHash(digest: string): void;
}

interface PinContext {
  readonly deps: PinDeps;
  readonly store: PinStore;
}

function createPinStore(db: Db): PinStore {
  const select = db.prepare<[], PinRow>('SELECT hash, failed_count, locked_until, lockouts FROM pin_state WHERE id = 1');
  const counters = db.prepare<[number, number, string | null]>(
    'UPDATE pin_state SET failed_count = ?, lockouts = ?, locked_until = ? WHERE id = 1',
  );
  const hash = db.prepare<[string]>(
    'UPDATE pin_state SET hash = ?, failed_count = 0, lockouts = 0, locked_until = NULL WHERE id = 1',
  );
  return {
    read() {
      const row = select.get();
      if (row === undefined) throw new Error('pin_state row is missing; run migrations');
      return row;
    },
    writeCounters(failed, lockouts, lockedUntil) {
      counters.run(failed, lockouts, lockedUntil);
    },
    writeHash(digest) {
      hash.run(digest);
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lockedUntilFor(nowMs: number, lockouts: number): string {
  const doublings = Math.min(lockouts - 1, PIN_LOCK_MAX_DOUBLINGS);
  return new Date(nowMs + PIN_LOCK_BASE_MS * 2 ** doublings).toISOString();
}

/** The notifier (a chat notice) must never mask the PIN error. */
function notifyFailure(ctx: PinContext, info: PinFailureInfo): void {
  if (ctx.deps.onFailure === undefined) return;
  try {
    const outcome: unknown = ctx.deps.onFailure({ ...info });
    if (outcome instanceof Promise) {
      outcome.catch((err: unknown) => ctx.deps.log.error({ err: errorText(err) }, 'PIN failure notifier rejected'));
    }
  } catch (err) {
    ctx.deps.log.error({ err: errorText(err) }, 'PIN failure notifier threw');
  }
}

/** A listener's failure never undoes or masks a PIN change that is already stored. */
function notifyChange(ctx: PinContext): void {
  try {
    ctx.deps.onChange?.();
  } catch (err) {
    ctx.deps.log.error({ err: errorText(err) }, 'PIN change listener threw');
  }
}

function recordFailure(ctx: PinContext, state: PinRow, nowMs: number, via: Channel): PinInvalidError {
  const failed = state.failed_count + 1;
  const locks = failed >= PIN_MAX_FAILURES;
  const lockouts = locks ? state.lockouts + 1 : state.lockouts;
  const lockedUntil = locks ? lockedUntilFor(nowMs, lockouts) : null;
  ctx.store.writeCounters(locks ? 0 : failed, lockouts, lockedUntil);
  const info: PinFailureInfo = { via, remaining: locks ? 0 : PIN_MAX_FAILURES - failed, lockedUntil };
  ctx.deps.log.warn({ ...info }, 'PIN verification failed');
  notifyFailure(ctx, info);
  return new PinInvalidError(info.remaining);
}

async function verifyLocked(ctx: PinContext, pin: string, via: Channel): Promise<void> {
  const state = ctx.store.read();
  if (state.hash === null) throw new PinNotSetError();
  const nowMs = ctx.deps.clock.now().getTime();
  if (state.locked_until !== null && nowMs < Date.parse(state.locked_until)) throw new PinLockedError(state.locked_until);
  const valid = PIN_RE.test(pin) && (await verifyPinHash(state.hash, pin));
  if (!valid) throw recordFailure(ctx, state, nowMs, via);
  ctx.store.writeCounters(0, 0, null);
}

async function changePin(ctx: PinContext, newPin: string, currentPin: string | undefined): Promise<void> {
  if (currentPin === undefined) throw new AuthError('The current PIN is required to change the PIN');
  await verifyLocked(ctx, currentPin, PIN_CHANGE_CHANNEL);
  ctx.store.writeHash(await hashPin(newPin));
  ctx.deps.log.info('PIN changed');
  notifyChange(ctx);
}

async function firstSet(ctx: PinContext, newPin: string, setupCode: string | undefined): Promise<void> {
  if (setupCode === undefined) throw new AuthError('A setup code is required to set the first PIN');
  ctx.deps.setupCodes.check(setupCode, 'owner_setup');
  const digest = await hashPin(newPin);
  // The claim: the code is used up, the PIN stored, and every other unused setup code voided, all at once.
  ctx.deps.db.transaction(() => {
    ctx.deps.setupCodes.consume(setupCode, 'owner_setup');
    ctx.store.writeHash(digest);
    voidOtherSetupCodes(ctx.deps.db);
  })();
  ctx.deps.log.info('PIN set for the first time');
  notifyChange(ctx);
}

async function setLocked(ctx: PinContext, newPin: string, auth: { currentPin?: string; setupCode?: string }): Promise<void> {
  if (!PIN_RE.test(newPin)) throw new ValidationError('The PIN must be 6 to 12 digits');
  if (ctx.store.read().hash !== null) return changePin(ctx, newPin, auth.currentPin);
  return firstSet(ctx, newPin, auth.setupCode);
}

/**
 * Clears the PIN and its failure counters and lockout (`luady pin reset`, through setup/pin-reset.ts). Runs over the
 * database, so the CLI can call it with or without the hub running; the hub's PIN service reads the row at every use.
 * The next PIN is a first PIN again, and so needs a new setup code.
 */
export function clearPinState(db: Db): void {
  const result = db.prepare('UPDATE pin_state SET hash = NULL, failed_count = 0, lockouts = 0, locked_until = NULL WHERE id = 1').run();
  if (result.changes !== 1) throw new Error('pin_state row is missing; run migrations');
}

export function createPinService(deps: PinDeps): PinService {
  const ctx: PinContext = { deps, store: createPinStore(deps.db) };
  const mutex = createMutex();
  return {
    isSet: () => ctx.store.read().hash !== null,
    set: (newPin, auth) => mutex.run(() => setLocked(ctx, newPin, auth)),
    verify: (pin, via) => mutex.run(() => verifyLocked(ctx, pin, via)),
  };
}
