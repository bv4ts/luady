import { describe, expect, it } from 'vitest';
import { AuthError } from '../../src/core/errors.js';
import { sha256Hex } from '../../src/core/ids.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSetupCodeService, revokeUnusedCodes, SETUP_CODE_TTL_MS, SETUP_CODE_TTLS } from '../../src/security/setup-codes.js';
import { createFakeClock } from '../../test/helpers/fakes.js';

function setup() {
  const db = openMemoryDb();
  const clock = createFakeClock();
  return { db, clock, codes: createSetupCodeService({ db, clock }) };
}

describe('createSetupCodeService', () => {
  it('issues a 12-character base32 code and stores only its sha256', () => {
    const { db, codes } = setup();
    const code = codes.issue('owner_setup');
    expect(code).toMatch(/^[A-Z2-7]{12}$/);
    const rows = db.prepare('SELECT * FROM setup_codes').all();
    expect(rows).toEqual([
      { code_sha256: sha256Hex(code), purpose: 'owner_setup', expires_at: '2026-10-09T12:30:00.000Z', used_at: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('issues a different code each time', () => {
    const { codes } = setup();
    const issued = new Set(Array.from({ length: 20 }, () => codes.issue('owner_setup')));
    expect(issued.size).toBe(20);
  });

  it('consumes a valid code exactly once', () => {
    const { db, codes } = setup();
    const code = codes.issue('owner_setup');
    expect(() => codes.consume(code, 'owner_setup')).not.toThrow();
    expect(db.prepare('SELECT used_at FROM setup_codes').get()).toEqual({ used_at: '2026-10-09T12:00:00.000Z' });
    expect(() => codes.consume(code, 'owner_setup')).toThrow(AuthError);
    expect(() => codes.check(code, 'owner_setup')).toThrow('Setup code was already used');
  });

  it('check validates without marking the code used', () => {
    const { codes } = setup();
    const code = codes.issue('owner_setup');
    codes.check(code, 'owner_setup');
    codes.check(code, 'owner_setup');
    expect(() => codes.consume(code, 'owner_setup')).not.toThrow();
  });

  it('accepts lower case, spaces and dashes typed by the owner', () => {
    const { codes } = setup();
    const code = codes.issue('owner_setup');
    const typed = ` ${code.slice(0, 4).toLowerCase()}-${code.slice(4, 8)} ${code.slice(8).toLowerCase()} `;
    expect(() => codes.consume(typed, 'owner_setup')).not.toThrow();
  });

  it('expires 30 minutes after issue', () => {
    const { clock, codes } = setup();
    const code = codes.issue('owner_setup');
    clock.advance(SETUP_CODE_TTL_MS - 1);
    expect(() => codes.check(code, 'owner_setup')).not.toThrow();
    clock.advance(1);
    expect(() => codes.consume(code, 'owner_setup')).toThrow('Setup code expired');
  });

  it.for([
    { name: 'an empty string', code: '' },
    { name: 'a short code', code: 'ABCDEF' },
    { name: 'a non-base32 digit', code: 'ABCDEFGHIJK1' },
    { name: 'a too-long code', code: 'ABCDEFGHIJKL-MNOP' },
  ])('rejects $name', ({ code }) => {
    const { codes } = setup();
    codes.issue('owner_setup');
    expect(() => codes.consume(code, 'owner_setup')).toThrow(AuthError);
  });

  it('rejects a well-formed code that was never issued', () => {
    const { codes } = setup();
    const code = codes.issue('owner_setup');
    const other = code.startsWith('A') ? 'BBBBBBBBBBBB' : 'AAAAAAAAAAAA';
    expect(() => codes.consume(other, 'owner_setup')).toThrow('Invalid setup code');
  });
});

describe('login tokens (purpose owner_login)', () => {
  it('issues a 43-character base64url token that lives 5 minutes, and stores only its sha256', () => {
    const { db, codes } = setup();
    const token = codes.issue('owner_login');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = db.prepare('SELECT * FROM setup_codes').all();
    expect(rows).toEqual([
      { code_sha256: sha256Hex(token), purpose: 'owner_login', expires_at: '2026-10-09T12:05:00.000Z', used_at: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(SETUP_CODE_TTLS.owner_login).toBe(5 * 60_000);
  });

  it('is single use and expires after 5 minutes, with messages about a login link', () => {
    const { clock, codes } = setup();
    const once = codes.issue('owner_login');
    codes.consume(once, 'owner_login');
    expect(() => codes.consume(once, 'owner_login')).toThrow('This login link was already used');
    const late = codes.issue('owner_login');
    clock.advance(5 * 60_000);
    expect(() => codes.check(late, 'owner_login')).toThrow('This login link expired');
  });

  it('is case-sensitive: a token is never normalised like a typed code', () => {
    const { codes } = setup();
    const token = codes.issue('owner_login');
    // 43 random base64url characters always hold a letter; swap the case of the first one.
    const flipped = token.replace(/[A-Za-z]/, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
    expect(flipped).not.toBe(token);
    expect(() => codes.check(flipped, 'owner_login')).toThrow('This login link is not valid');
    expect(() => codes.check(` ${token} `, 'owner_login')).toThrow('This login link is not valid');
  });

  it('a token is never a setup code, and a setup code is never a token', () => {
    const { codes } = setup();
    const token = codes.issue('owner_login');
    const code = codes.issue('owner_setup');
    expect(() => codes.check(token, 'owner_setup')).toThrow(AuthError);
    expect(() => codes.check(code, 'owner_login')).toThrow('This login link is not valid');
  });

  it('revokeUnused ends every code and token not yet used, and keeps the used ones as a record', () => {
    const { db, codes } = setup();
    const used = codes.issue('owner_setup');
    codes.consume(used, 'owner_setup');
    const open = codes.issue('owner_setup');
    const token = codes.issue('owner_login');
    expect(revokeUnusedCodes(db)).toBe(2);
    expect(() => codes.check(open, 'owner_setup')).toThrow(AuthError);
    expect(() => codes.check(token, 'owner_login')).toThrow(AuthError);
    expect(db.prepare('SELECT COUNT(*) AS n FROM setup_codes').get()).toEqual({ n: 1 });
  });
});
