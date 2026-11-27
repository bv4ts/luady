import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...actual, verifyRegistrationResponse: vi.fn() };
});

import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { Db } from '../../src/core/contracts.js';
import { AuthError } from '../../src/core/errors.js';
import { sha256Hex } from '../../src/core/ids.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createPinService } from '../../src/security/pin.js';
import { createSetupCodeService } from '../../src/security/setup-codes.js';
import { claimBanner, issueLoginLink, loginCommand } from '../../src/setup/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { harnessFactory } from '../web/helpers.js';
import { registrationResponse, verifiedRegistration } from '../web/webauthn-fixtures.js';
import { OWNER_PIN, localHub, sessionCookie, type LocalHub, type SignedIn } from './local-hub.js';

const harness = harnessFactory();
const verifyReg = vi.mocked(verifyRegistrationResponse);
const LOCAL = { publicOrigin: 'http://localhost:7410', bindHost: '127.0.0.1', authMode: 'local' } as const;

beforeEach(() => {
  verifyReg.mockReset();
  verifyReg.mockResolvedValue(verifiedRegistration());
});

function liveCodes(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM setup_codes WHERE purpose = 'owner_setup' AND used_at IS NULL").get() as { n: number }).n;
}

/** A code written straight to the table, as two processes issuing at once could leave it. */
function plantCode(db: Db, code: string): void {
  db.prepare("INSERT INTO setup_codes (code_sha256, purpose, expires_at) VALUES (?, 'owner_setup', '2099-01-01T00:00:00.000Z')").run(sha256Hex(code));
}

const bannerCode = (lines: readonly string[]): string =>
  (lines.find((line) => line.startsWith('Setup code: ')) ?? '').slice('Setup code: '.length).replace(/-/g, '');

async function registerPasskey(hub: LocalHub, body: object, session?: SignedIn) {
  const options = await hub.send('POST', '/api/auth/passkey/register/options', body, session === undefined ? {} : { session });
  if (options.statusCode !== 200) return { options, verify: null };
  const challenge = (options.json() as { challenge: string }).challenge;
  const verify = await hub.send('POST', '/api/auth/passkey/register/verify', { response: registrationResponse(challenge), label: 'Laptop' },
    session === undefined ? {} : { session });
  return { options, verify };
}

function passkeys(hub: LocalHub): number {
  return (hub.db.prepare('SELECT COUNT(*) AS n FROM auth_passkeys').get() as { n: number }).n;
}

describe('only one setup code is ever live', () => {
  it('issuing a code voids the earlier unused one; the same holds for login links', () => {
    const db = openMemoryDb();
    const codes = createSetupCodeService({ db, clock: createFakeClock() });
    const first = codes.issue('owner_setup');
    const second = codes.issue('owner_setup');
    expect(() => codes.check(first, 'owner_setup')).toThrow(AuthError);
    expect(() => codes.check(second, 'owner_setup')).not.toThrow();
    expect(liveCodes(db)).toBe(1);
    const oldLink = codes.issue('owner_login');
    const newLink = codes.issue('owner_login');
    expect(() => codes.check(oldLink, 'owner_login')).toThrow(AuthError);
    expect(() => codes.check(newLink, 'owner_login')).not.toThrow();
    // A new login link leaves the live setup code alone, and the other way round.
    expect(() => codes.check(second, 'owner_setup')).not.toThrow();
  });

  it('the start banner\'s code dies when luady login prints a new one', () => {
    const db = openMemoryDb();
    const clock = createFakeClock();
    const fromStart = bannerCode(claimBanner(db, LOCAL, { clock }).lines);
    const fromLogin = bannerCode(loginCommand(db, LOCAL, { clock }).lines);
    const codes = createSetupCodeService({ db, clock });
    expect(() => codes.check(fromStart, 'owner_setup')).toThrow(AuthError);
    expect(() => codes.check(fromLogin, 'owner_setup')).not.toThrow();
    expect(liveCodes(db)).toBe(1);
  });
});

describe('the claim voids every other unused code, in the same transaction', () => {
  it('the first PIN', async () => {
    const db = openMemoryDb();
    const clock = createFakeClock();
    const codes = createSetupCodeService({ db, clock });
    const pin = createPinService({ db, clock, setupCodes: codes, log: silentLogger() });
    const used = codes.issue('owner_setup');
    plantCode(db, 'STRAYCODEAB2');
    await pin.set(OWNER_PIN, { setupCode: used });
    expect(liveCodes(db)).toBe(0);
    expect(() => codes.check('STRAYCODEAB2', 'owner_setup')).toThrow(AuthError);
  });

  it('the first passkey, which keeps only its own code (the first PIN needs it next)', async () => {
    const hub = await localHub(harness);
    const code = hub.setupCodes.issue('owner_setup');
    plantCode(hub.db, 'STRAYCODEAB2');
    const { verify } = await registerPasskey(hub, { setupCode: code });
    expect(verify?.statusCode).toBe(200);
    expect(passkeys(hub)).toBe(1);
    expect(liveCodes(hub.db)).toBe(1);
    expect(() => hub.setupCodes.check(code, 'owner_setup')).not.toThrow();
    expect(() => hub.setupCodes.check('STRAYCODEAB2', 'owner_setup')).toThrow(AuthError);
  });
});

describe('the stale-code attack', () => {
  it('a code printed at start no longer makes a passkey once the owner claimed with the code luady login printed', async () => {
    const hub = await localHub(harness);
    const fromStart = bannerCode(claimBanner(hub.db, hub.config, { clock: hub.clock }).lines);
    // The owner signs in with a login link (which prints a new code), skips the passkey and sets the PIN with that code.
    const link = issueLoginLink(hub.db, hub.config, hub.clock);
    const login = await hub.send('POST', '/api/setup/login', { token: link.url.slice(link.url.indexOf('#') + 1) });
    const cookie = sessionCookie(login);
    const { pageKey } = login.json() as { pageKey: string };
    const csrf = ((await hub.send('GET', '/api/me', undefined, { headers: { cookie, 'x-hub-key': pageKey } })).json() as { csrf: string }).csrf;
    const owner: SignedIn = { cookie, pageKey, csrf, sid: '' };
    expect((await hub.send('POST', '/api/setup/step', { step: 'passkey', action: 'skip' }, { session: owner })).statusCode).toBe(200);
    expect((await hub.send('POST', '/api/auth/pin', { newPin: OWNER_PIN, setupCode: link.setupCode }, { session: owner })).statusCode).toBe(200);
    // The stranger with the start banner's code, and no session:
    const { options, verify } = await registerPasskey(hub, { setupCode: fromStart });
    expect(options.statusCode).toBe(401);
    expect(verify).toBeNull();
    expect(passkeys(hub)).toBe(0);
  });
});

describe('the first PIN needs a session', () => {
  it('on an install with a passkey, the code alone sets no PIN; the passkey\'s session with the code does', async () => {
    const hub = await localHub(harness, { passkey: true });
    const code = hub.setupCodes.issue('owner_setup');
    const anonymous = await hub.send('POST', '/api/auth/pin', { newPin: OWNER_PIN, setupCode: code });
    expect(anonymous.statusCode).toBe(401);
    expect(hub.db.prepare('SELECT hash FROM pin_state WHERE id = 1').get()).toEqual({ hash: null });
    const signedIn = await hub.send('POST', '/api/auth/pin', { newPin: OWNER_PIN, setupCode: code }, { session: hub.signIn() });
    expect(signedIn.statusCode).toBe(200);
  });

  it('on a fresh install too: no anonymous first PIN, so no install is ever claimed by a code alone', async () => {
    const hub = await localHub(harness);
    const code = hub.setupCodes.issue('owner_setup');
    expect((await hub.send('POST', '/api/auth/pin', { newPin: OWNER_PIN, setupCode: code })).statusCode).toBe(401);
    expect((await hub.send('GET', '/api/setup/state')).json()).toMatchObject({ step: 'claim', claimed: false });
  });
});

describe('a claimed install refuses every code', () => {
  it('a fresh code, alone, makes no passkey on an install with a PIN; a session and the PIN do', async () => {
    const hub = await localHub(harness, { pinSet: true });
    const fresh = hub.setupCodes.issue('owner_setup');
    const anonymous = await registerPasskey(hub, { setupCode: fresh });
    expect(anonymous.options.statusCode).toBe(401);
    expect(anonymous.options.json()).toMatchObject({ error: { message: expect.stringMatching(/Sign in/) } });
    const session = hub.signIn();
    const withoutPin = await registerPasskey(hub, { setupCode: fresh }, session);
    expect(withoutPin.options.statusCode).toBe(428);
    const withPin = await registerPasskey(hub, { pin: OWNER_PIN }, session);
    expect(withPin.verify?.statusCode).toBe(200);
    expect(passkeys(hub)).toBe(1);
  });

  it('a fresh code, alone, makes no second passkey on an install with a passkey (and no PIN yet)', async () => {
    const hub = await localHub(harness, { passkey: true });
    const fresh = hub.setupCodes.issue('owner_setup');
    expect((await registerPasskey(hub, { setupCode: fresh })).options.statusCode).toBe(401);
    // No PIN exists yet, so a session alone may add one.
    expect((await registerPasskey(hub, {}, hub.signIn())).verify?.statusCode).toBe(200);
    expect(passkeys(hub)).toBe(2);
  });

  it('a finished install with neither passkey nor PIN (a link-only owner after a PIN reset) still refuses a code alone', async () => {
    const hub = await localHub(harness);
    hub.db.prepare("UPDATE setup_state SET step = 'done' WHERE id = 1").run();
    const fresh = hub.setupCodes.issue('owner_setup');
    expect((await registerPasskey(hub, { setupCode: fresh })).options.statusCode).toBe(401);
    expect(passkeys(hub)).toBe(0);
  });

  it('options taken with a code before the claim cannot be finished after it', async () => {
    const hub = await localHub(harness);
    const code = hub.setupCodes.issue('owner_setup');
    const early = await hub.send('POST', '/api/auth/passkey/register/options', { setupCode: code });
    expect(early.statusCode).toBe(200);
    hub.db.prepare("UPDATE setup_state SET step = 'done' WHERE id = 1").run();
    const late = await hub.send('POST', '/api/auth/passkey/register/verify', {
      response: registrationResponse((early.json() as { challenge: string }).challenge), label: 'Laptop',
    });
    expect(late.statusCode).toBe(401);
    expect(passkeys(hub)).toBe(0);
  });
});
