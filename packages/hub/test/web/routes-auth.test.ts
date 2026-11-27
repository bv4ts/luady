import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...actual, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() };
});

import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { DEFAULT_SETTINGS } from '@luady/shared';
import { AuthError, PinInvalidError } from '../../src/core/errors.js';
import { createPasskeyStore } from '../../src/web/auth/passkeys.js';
import { call, cookieFrom, harnessFactory, OWNER_EMAIL, type Harness, type LoggedIn } from './helpers.js';
import {
  authenticationResponse,
  CRED_ID,
  OTHER_CRED_ID,
  registrationResponse,
  verifiedAuthentication,
  verifiedRegistration,
} from './webauthn-fixtures.js';

const harness = harnessFactory();
const verifyReg = vi.mocked(verifyRegistrationResponse);
const verifyAuth = vi.mocked(verifyAuthenticationResponse);
const SETUP_CODE = 'SETUP-CODE-1';
const PIN = '123456';

beforeEach(() => {
  verifyReg.mockReset();
  verifyAuth.mockReset();
});

function enroll(h: Harness): void {
  createPasskeyStore({ db: h.deps.db, clock: h.deps.clock }).insert({
    credId: CRED_ID,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 1,
    transports: ['internal'],
    label: 'Phone',
  });
}

function challengeOf(body: unknown): string {
  return (body as { challenge: string }).challenge;
}

describe('GET /api/me', () => {
  it('is 401 without an app session', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/me');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: 'Login required' } });
  });

  it('returns the owner, the auth mode, passkey count, PIN state and CSRF token', async () => {
    const h = await harness();
    enroll(h);
    const session = h.login();
    const res = await call(h, 'GET', '/api/me', undefined, { session });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ owner: OWNER_EMAIL, authMode: 'local', passkeys: 1, pinSet: true, csrf: session.csrf });
  });
});

describe('first passkey enrollment', () => {
  it('checks the setup code at options and verify (the first PIN set consumes it) and starts a session', async () => {
    const h = await harness();
    vi.mocked(h.deps.pin.isSet).mockReturnValue(false);
    const options = await call(h, 'POST', '/api/auth/passkey/register/options', { setupCode: SETUP_CODE });
    expect(options.statusCode).toBe(200);
    expect(h.deps.setupCodes.check).toHaveBeenCalledWith(SETUP_CODE, 'owner_setup');
    verifyReg.mockResolvedValue(verifiedRegistration());
    const verify = await call(h, 'POST', '/api/auth/passkey/register/verify', {
      response: registrationResponse(challengeOf(options.json())),
      label: 'Phone',
    });
    expect(verify.statusCode).toBe(200);
    // The claim signs the browser in, so the answer carries the new session's page key.
    expect(verify.json()).toEqual({ ok: true, pageKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(h.deps.setupCodes.check).toHaveBeenLastCalledWith(SETUP_CODE, 'owner_setup');
    expect(h.deps.setupCodes.consume).not.toHaveBeenCalled();
    const fresh: LoggedIn = { sid: '', csrf: '', cookie: cookieFrom(verify) };
    const me = await call(h, 'GET', '/api/me', undefined, { session: fresh });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ passkeys: 1, pinSet: false });
  });

  it('refuses options without a setup code (401)', async () => {
    const h = await harness();
    vi.mocked(h.deps.pin.isSet).mockReturnValue(false);
    const res = await call(h, 'POST', '/api/auth/passkey/register/options', {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: 'A setup code is required to enroll the first passkey' } });
  });

  it('rejects an invalid setup code (401)', async () => {
    const h = await harness();
    vi.mocked(h.deps.pin.isSet).mockReturnValue(false);
    vi.mocked(h.deps.setupCodes.check).mockImplementation(() => {
      throw new AuthError('Setup code is invalid or expired');
    });
    const res = await call(h, 'POST', '/api/auth/passkey/register/options', { setupCode: 'WRONG-CODE' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: 'Setup code is invalid or expired' } });
  });

  it('requires the public Origin even without a session (403)', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/auth/passkey/register/options', { setupCode: SETUP_CODE }, { origin: null });
    expect(res.statusCode).toBe(403);
    expect(h.deps.setupCodes.check).not.toHaveBeenCalled();
  });
});

describe('adding a passkey', () => {
  it('needs an app session (401)', async () => {
    const h = await harness();
    enroll(h);
    const res = await call(h, 'POST', '/api/auth/passkey/register/options', { pin: PIN });
    expect(res.statusCode).toBe(401);
    expect(h.deps.pin.verify).not.toHaveBeenCalled();
  });

  it('needs the PIN: missing is 428, wrong is 403', async () => {
    const h = await harness();
    enroll(h);
    const session = h.login();
    const missing = await call(h, 'POST', '/api/auth/passkey/register/options', {}, { session });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toEqual({ error: { code: 'pin_required', message: 'PIN required to add another passkey' } });
    vi.mocked(h.deps.pin.verify).mockRejectedValueOnce(new PinInvalidError(2));
    const wrong = await call(h, 'POST', '/api/auth/passkey/register/options', { pin: '000000' }, { session });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: { code: 'pin_invalid', message: 'Wrong PIN', remaining: 2 } });
  });

  it('with a session and the PIN enrolls the passkey and keeps the current session', async () => {
    const h = await harness();
    enroll(h);
    const session = h.login();
    const options = await call(h, 'POST', '/api/auth/passkey/register/options', { pin: PIN }, { session });
    expect(options.statusCode).toBe(200);
    expect(h.deps.pin.verify).toHaveBeenCalledWith(PIN, 'web');
    verifyReg.mockResolvedValue(verifiedRegistration(OTHER_CRED_ID));
    const verify = await call(
      h,
      'POST',
      '/api/auth/passkey/register/verify',
      { response: registrationResponse(challengeOf(options.json()), OTHER_CRED_ID), label: 'Laptop' },
      { session },
    );
    expect(verify.statusCode).toBe(200);
    expect(verify.headers['set-cookie']).toBeUndefined();
    const me = await call(h, 'GET', '/api/me', undefined, { session });
    expect(me.json()).toMatchObject({ passkeys: 2, csrf: session.csrf });
  });
});

describe('passkey sign-in', () => {
  it('rotates the session and returns the new CSRF token', async () => {
    const h = await harness();
    enroll(h);
    const old = h.login();
    const options = await call(h, 'POST', '/api/auth/passkey/login/options', {}, { session: old });
    expect(options.statusCode).toBe(200);
    verifyAuth.mockResolvedValue(verifiedAuthentication(CRED_ID, 9));
    const res = await call(
      h,
      'POST',
      '/api/auth/passkey/login/verify',
      { response: authenticationResponse(challengeOf(options.json())) },
      { session: old },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; csrf: string };
    expect(body.ok).toBe(true);
    expect(body.csrf).not.toBe(old.csrf);
    expect((await call(h, 'GET', '/api/me', undefined, { session: old })).statusCode).toBe(401);
    const fresh: LoggedIn = { sid: '', csrf: body.csrf, cookie: cookieFrom(res) };
    expect((await call(h, 'GET', '/api/me', undefined, { session: fresh })).json()).toMatchObject({ csrf: body.csrf });
  });

  it('answers 409 when no passkey is enrolled', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/auth/passkey/login/options', {});
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'refused', message: 'No passkey is enrolled yet' } });
  });

  it('a failed assertion is 401 and sets no cookie', async () => {
    const h = await harness();
    enroll(h);
    const options = await call(h, 'POST', '/api/auth/passkey/login/options', {});
    verifyAuth.mockResolvedValue({ ...verifiedAuthentication(), verified: false });
    const res = await call(h, 'POST', '/api/auth/passkey/login/verify', {
      response: authenticationResponse(challengeOf(options.json())),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('logout and PIN', () => {
  it('logout destroys the session and clears the cookie', async () => {
    const h = await harness();
    const session = h.login();
    const res = await call(h, 'POST', '/api/auth/logout', {}, { session });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(String(res.headers['set-cookie'])).toMatch(/^hub_sid=;/);
    expect((await call(h, 'GET', '/api/me', undefined, { session })).statusCode).toBe(401);
  });

  it('the first PIN needs a signed-in session as well as the setup code', async () => {
    const h = await harness();
    vi.mocked(h.deps.pin.isSet).mockReturnValue(false);
    const anonymous = await call(h, 'POST', '/api/auth/pin', { newPin: PIN, setupCode: SETUP_CODE });
    expect(anonymous.statusCode).toBe(401);
    expect(h.deps.pin.set).not.toHaveBeenCalled();
    const res = await call(h, 'POST', '/api/auth/pin', { newPin: PIN, setupCode: SETUP_CODE }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.deps.pin.set).toHaveBeenCalledWith(PIN, { currentPin: undefined, setupCode: SETUP_CODE });
  });

  it("the claim stores the browser's time zone, only when none is set; a bad zone never stops the PIN", async () => {
    const h = await harness();
    vi.mocked(h.deps.pin.isSet).mockReturnValue(false);
    const session = h.login();
    const claim = (timeZone: string) => call(h, 'POST', '/api/auth/pin', { newPin: PIN, setupCode: SETUP_CODE, timeZone }, { session });
    expect((await claim('America/Chicago')).statusCode).toBe(200);
    expect(h.deps.settings.update).toHaveBeenCalledTimes(1);
    expect(h.deps.settings.update).toHaveBeenCalledWith({ owner_tz: 'America/Chicago' });
    expect((await claim('Mars/Olympus')).statusCode).toBe(200);
    expect(h.deps.pin.set).toHaveBeenCalledTimes(2);
    expect(h.deps.settings.update).toHaveBeenCalledTimes(1);
    vi.mocked(h.deps.settings.get).mockReturnValue({ ...DEFAULT_SETTINGS, owner_tz: 'Australia/Sydney' });
    expect((await claim('America/Chicago')).statusCode).toBe(200);
    expect(h.deps.settings.update).toHaveBeenCalledTimes(1);
  });

  it('a PIN change never touches the time zone', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/auth/pin', { newPin: '654321', currentPin: PIN, timeZone: 'America/Chicago' }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.settings.update).not.toHaveBeenCalled();
  });

  it('changing the PIN requires an app session', async () => {
    const h = await harness();
    const anonymous = await call(h, 'POST', '/api/auth/pin', { newPin: '654321', currentPin: PIN });
    expect(anonymous.statusCode).toBe(401);
    expect(h.deps.pin.set).not.toHaveBeenCalled();
    const res = await call(h, 'POST', '/api/auth/pin', { newPin: '654321', currentPin: PIN }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.pin.set).toHaveBeenCalledWith('654321', { currentPin: PIN, setupCode: undefined });
  });

  it('rejects a malformed PIN with 400', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/auth/pin', { newPin: '12' }, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
  });
});

describe('passkey management', () => {
  function enrollSecond(h: Harness): void {
    createPasskeyStore({ db: h.deps.db, clock: h.deps.clock }).insert({
      credId: OTHER_CRED_ID,
      publicKey: new Uint8Array([4, 5, 6]),
      counter: 9,
      transports: ['usb'],
      label: 'YubiKey',
    });
  }

  function deleteUrl(id: string): string {
    return `/api/auth/passkeys/${id}/delete`;
  }

  it('lists passkeys without public keys or counters', async () => {
    const h = await harness();
    enroll(h);
    h.clock.advance(1000);
    enrollSecond(h);
    const res = await call(h, 'GET', '/api/auth/passkeys', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { id: CRED_ID, label: 'Phone', createdAt: '2026-10-09T12:00:00.000Z', lastUsedAt: null },
        { id: OTHER_CRED_ID, label: 'YubiKey', createdAt: '2026-10-09T12:00:01.000Z', lastUsedAt: null },
      ],
    });
    expect(res.body).not.toMatch(/publicKey|public_key|counter/);
  });

  it('listing passkeys requires an app session (401)', async () => {
    const h = await harness();
    enroll(h);
    const res = await call(h, 'GET', '/api/auth/passkeys');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: 'Login required' } });
  });

  it('deletes a passkey after the PIN and revokes every other app session', async () => {
    const h = await harness();
    enroll(h);
    enrollSecond(h);
    const mine = h.login();
    const other = h.login();
    const res = await call(h, 'POST', deleteUrl(CRED_ID), { pin: PIN }, { session: mine });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.deps.pin.verify).toHaveBeenCalledWith(PIN, 'web');
    const list = await call(h, 'GET', '/api/auth/passkeys', undefined, { session: mine });
    expect((list.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([OTHER_CRED_ID]);
    expect((await call(h, 'GET', '/api/me', undefined, { session: other })).statusCode).toBe(401);
    expect((await call(h, 'GET', '/api/me', undefined, { session: mine })).statusCode).toBe(200);
  });

  it('deleting requires an app session (401)', async () => {
    const h = await harness();
    enroll(h);
    enrollSecond(h);
    const res = await call(h, 'POST', deleteUrl(CRED_ID), { pin: PIN });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: 'Login required' } });
    expect(h.deps.pin.verify).not.toHaveBeenCalled();
  });

  it('deleting requires the CSRF token (403)', async () => {
    const h = await harness();
    enroll(h);
    enrollSecond(h);
    const res = await call(h, 'POST', deleteUrl(CRED_ID), { pin: PIN }, { session: h.login(), csrf: null });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'forbidden', message: 'CSRF token missing or invalid' } });
    expect(h.deps.pin.verify).not.toHaveBeenCalled();
  });

  it('deleting requires a valid PIN: missing is 400, wrong is 403 with remaining', async () => {
    const h = await harness();
    enroll(h);
    enrollSecond(h);
    const session = h.login();
    const missing = await call(h, 'POST', deleteUrl(CRED_ID), {}, { session });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'validation' } });
    vi.mocked(h.deps.pin.verify).mockRejectedValueOnce(new PinInvalidError(2));
    const wrong = await call(h, 'POST', deleteUrl(CRED_ID), { pin: '000000' }, { session });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: { code: 'pin_invalid', message: 'Wrong PIN', remaining: 2 } });
    const list = await call(h, 'GET', '/api/auth/passkeys', undefined, { session });
    expect((list.json() as { items: unknown[] }).items).toHaveLength(2);
  });

  it('refuses to delete the last passkey (409)', async () => {
    const h = await harness();
    enroll(h);
    const session = h.login();
    const res = await call(h, 'POST', deleteUrl(CRED_ID), { pin: PIN }, { session });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'refused', message: 'The last passkey cannot be deleted; add another one first' },
    });
    expect((await call(h, 'GET', '/api/me', undefined, { session })).json()).toMatchObject({ passkeys: 1 });
  });

  it('answers 404 for an unknown passkey and 400 for a malformed id', async () => {
    const h = await harness();
    enroll(h);
    enrollSecond(h);
    const session = h.login();
    const unknownId = 'bm8tc3VjaC1' + 'rZXk';
    const unknown = await call(h, 'POST', deleteUrl(unknownId), { pin: PIN }, { session });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: { code: 'not_found', message: `Unknown passkey: ${unknownId}` } });
    const malformed = await call(h, 'POST', deleteUrl('bad%21id'), { pin: PIN }, { session });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ error: { code: 'validation' } });
  });

  it('both passkey routes share the /api/auth/* rate limit', async () => {
    const h = await harness();
    enroll(h);
    enrollSecond(h);
    const session = h.login();
    for (let i = 0; i < 10; i += 1) {
      expect((await call(h, 'GET', '/api/auth/passkeys', undefined, { session })).statusCode).toBe(200);
    }
    const limited = await call(h, 'POST', deleteUrl(CRED_ID), { pin: PIN }, { session });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });
});
