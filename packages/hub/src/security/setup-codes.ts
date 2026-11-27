import { randomBytes } from 'node:crypto';
import type { Clock, Db, SetupCodeService } from '../core/contracts.js';
import { AuthError } from '../core/errors.js';
import { sha256Hex } from '../core/ids.js';

export interface SetupCodeDeps {
  db: Db;
  clock: Clock;
}

type SetupPurpose = Parameters<SetupCodeService['issue']>[0];

interface SetupCodeRow {
  purpose: string;
  expires_at: string;
  used_at: string | null;
}

const SETUP_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SETUP_CODE_LENGTH = 12;
const SETUP_CODE_RE = /^[A-Z2-7]{12}$/;
/** A login token: 32 random bytes, base64url. It travels in a link, never typed, so it is never normalised. */
const LOGIN_TOKEN_BYTES = 32;
const LOGIN_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Setup codes are valid for 30 minutes. */
export const SETUP_CODE_TTL_MS = 30 * 60_000;
/** Each purpose's lifetime: a login link lives 5 minutes. */
export const SETUP_CODE_TTLS: Readonly<Record<SetupPurpose, number>> = { owner_setup: SETUP_CODE_TTL_MS, owner_login: 5 * 60_000 };

/** What a refusal says, per purpose: the owner types a setup code, and opens a login link. */
const MESSAGES: Readonly<Record<SetupPurpose, { invalid: string; used: string; expired: string }>> = {
  owner_setup: { invalid: 'Invalid setup code', used: 'Setup code was already used', expired: 'Setup code expired' },
  owner_login: { invalid: 'This login link is not valid', used: 'This login link was already used', expired: 'This login link expired' },
};

/** 12 base32 characters; 256 is a multiple of 32, so `byte & 31` has no bias. */
function generateCode(): string {
  return Array.from(randomBytes(SETUP_CODE_LENGTH), (byte) => SETUP_CODE_ALPHABET.charAt(byte & 31)).join('');
}

function generate(purpose: SetupPurpose): string {
  return purpose === 'owner_login' ? randomBytes(LOGIN_TOKEN_BYTES).toString('base64url') : generateCode();
}

/** The owner may type a setup code in lower case or with spaces and dashes; a login token is taken exactly as sent. */
function normalize(code: string, purpose: SetupPurpose): string {
  return purpose === 'owner_login' ? code : code.trim().toUpperCase().replace(/[\s-]/g, '');
}

function wellFormed(code: string, purpose: SetupPurpose): boolean {
  return (purpose === 'owner_login' ? LOGIN_TOKEN_RE : SETUP_CODE_RE).test(code);
}

/**
 * Voids every unused setup code except the one with this digest: the write that claims the install calls it in its
 * own transaction, so no other printed code outlives the claim. Returns how many were voided.
 */
export function voidOtherSetupCodes(db: Db, keepDigest: string | null = null): number {
  return db.prepare("DELETE FROM setup_codes WHERE purpose = 'owner_setup' AND used_at IS NULL AND code_sha256 IS NOT ?").run(keepDigest).changes;
}

/** The claim, in one transaction with the code still valid and every other unused setup code voided. */
export interface SetupCodeClaim {
  claimWith<T>(code: string, write: () => T): T;
}

/**
 * Ends every code and login token not used yet (a PIN reset: the next PIN needs a new code). Used rows stay as a
 * record. Returns how many were ended.
 */
export function revokeUnusedCodes(db: Db): number {
  return db.prepare('DELETE FROM setup_codes WHERE used_at IS NULL').run().changes;
}

/**
 * Setup codes and login tokens. Only a code's sha256 is stored, and a code is found by that digest: the comparison never
 * runs over the secret itself, so its timing says nothing about it. Codes are never logged or returned by a route.
 * Only one code of each purpose is ever live: issuing a new one voids the earlier unused ones.
 */
export function createSetupCodeService(deps: SetupCodeDeps): SetupCodeService & SetupCodeClaim {
  const insert = deps.db.prepare<[string, string, string]>(
    'INSERT INTO setup_codes (code_sha256, purpose, expires_at) VALUES (?, ?, ?)',
  );
  const purgeExpired = deps.db.prepare<[string]>('DELETE FROM setup_codes WHERE expires_at <= ?');
  const voidUnused = deps.db.prepare<[string]>('DELETE FROM setup_codes WHERE purpose = ? AND used_at IS NULL');
  const select = deps.db.prepare<[string], SetupCodeRow>(
    'SELECT purpose, expires_at, used_at FROM setup_codes WHERE code_sha256 = ?',
  );
  const markUsed = deps.db.prepare<[string, string]>(
    'UPDATE setup_codes SET used_at = ? WHERE code_sha256 = ? AND used_at IS NULL',
  );

  /** Returns the stored digest of a valid, unused, unexpired code; throws AuthError otherwise. */
  function validate(code: string, purpose: SetupPurpose): string {
    const text = MESSAGES[purpose];
    const normalized = normalize(code, purpose);
    if (!wellFormed(normalized, purpose)) throw new AuthError(text.invalid);
    const digest = sha256Hex(normalized);
    const row = select.get(digest);
    if (row === undefined || row.purpose !== purpose) throw new AuthError(text.invalid);
    if (row.used_at !== null) throw new AuthError(text.used);
    if (Date.parse(row.expires_at) <= deps.clock.now().getTime()) throw new AuthError(text.expired);
    return digest;
  }

  return {
    issue(purpose) {
      const now = deps.clock.now();
      const code = generate(purpose);
      deps.db.transaction(() => {
        purgeExpired.run(now.toISOString());
        voidUnused.run(purpose);
        insert.run(sha256Hex(code), purpose, new Date(now.getTime() + SETUP_CODE_TTLS[purpose]).toISOString());
      })();
      return code;
    },
    consume(code, purpose) {
      const digest = validate(code, purpose);
      const result = markUsed.run(deps.clock.now().toISOString(), digest);
      if (result.changes !== 1) throw new AuthError(MESSAGES[purpose].used);
    },
    check(code, purpose) {
      validate(code, purpose);
    },
    claimWith(code, write) {
      return deps.db.transaction(() => {
        const digest = validate(code, 'owner_setup');
        const result = write();
        voidOtherSetupCodes(deps.db, digest);
        return result;
      })();
    },
  };
}
