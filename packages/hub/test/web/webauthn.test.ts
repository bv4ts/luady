import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...actual, verifyRegistrationResponse: vi.fn(), verifyAuthenticationResponse: vi.fn() };
});

import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { PinService, SetupCodeService } from '../../src/core/contracts.js';
import { AuthError, PinInvalidError, RefusedError, ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { CHALLENGE_TTL_MS, createChallengeStore } from '../../src/web/auth/challenges.js';
import { createPasskeyStore, type PasskeyStore } from '../../src/web/auth/passkeys.js';
import {
  challengeFromClientData,
  createWebAuthnService,
  RP_NAME,
  type WebAuthnService,
} from '../../src/web/auth/webauthn.js';
import { PinRequiredError } from '../../src/web/errors.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { OWNER_EMAIL, PUBLIC_ORIGIN, RP_ID } from './fixtures.js';
import {
  authenticationResponse,
  CRED_ID,
  OTHER_CRED_ID,
  registrationResponse,
  verifiedAuthentication,
  verifiedRegistration,
} from './webauthn-fixtures.js';

const verifyReg = vi.mocked(verifyRegistrationResponse);
const verifyAuth = vi.mocked(verifyAuthenticationResponse);
const SETUP_CODE = 'SETUP-CODE-1';
type FakeClock = ReturnType<typeof createFakeClock>;

interface Rig {
  service: WebAuthnService;
  passkeys: PasskeyStore;
  setupCodes: SetupCodeService;
  pin: PinService;
  clock: FakeClock;
}

function rig(): Rig {
  const db = openMemoryDb();
  const clock = createFakeClock();
  const passkeys = createPasskeyStore({ db, clock });
  const setupCodes: SetupCodeService = { issue: vi.fn(() => SETUP_CODE), check: vi.fn(), consume: vi.fn() };
  const pin: PinService = { isSet: vi.fn(() => true), set: vi.fn(async () => undefined), verify: vi.fn(async () => undefined) };
  const service = createWebAuthnService({
    config: { rpId: RP_ID, publicOrigin: PUBLIC_ORIGIN, ownerEmail: OWNER_EMAIL },
    passkeys,
    challenges: createChallengeStore({ db, clock }),
    setupCodes,
    pin,
    clock,
    log: silentLogger(),
  });
  return { service, passkeys, setupCodes, pin, clock };
}

function enroll(passkeys: PasskeyStore): void {
  passkeys.insert({ credId: CRED_ID, publicKey: new Uint8Array([9, 9, 9]), counter: 3, transports: ['usb'], label: 'Key' });
}

beforeEach(() => {
  verifyReg.mockReset();
  verifyAuth.mockReset();
});

describe('first passkey (setup code)', () => {
  it('options check the setup code and use the owner RP settings', async () => {
    const r = rig();
    const options = await r.service.registrationOptions({ setupCode: SETUP_CODE, hasSession: false });
    expect(r.setupCodes.check).toHaveBeenCalledWith(SETUP_CODE, 'owner_setup');
    expect(r.setupCodes.consume).not.toHaveBeenCalled();
    expect(options.rp).toEqual({ name: RP_NAME, id: RP_ID });
    expect(options.user.name).toBe(OWNER_EMAIL);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'preferred', userVerification: 'required' });
    expect(options.attestation).toBe('none');
    expect(options.excludeCredentials).toEqual([]);
  });

  it('options without a setup code are refused', async () => {
    await expect(rig().service.registrationOptions({ hasSession: false })).rejects.toBeInstanceOf(AuthError);
  });

  it('an invalid setup code is refused by check', async () => {
    const r = rig();
    vi.mocked(r.setupCodes.check).mockImplementation(() => {
      throw new AuthError('Setup code is invalid or expired');
    });
    await expect(r.service.registrationOptions({ setupCode: 'WRONG-CODE', hasSession: false })).rejects.toThrow(
      'Setup code is invalid or expired',
    );
  });

  it('verify re-checks the setup code without consuming it and stores the passkey', async () => {
    const r = rig();
    const options = await r.service.registrationOptions({ setupCode: SETUP_CODE, hasSession: false });
    verifyReg.mockResolvedValue(verifiedRegistration());
    const record = await r.service.verifyRegistration({
      response: registrationResponse(options.challenge),
      label: 'Phone',
      hasSession: false,
    });
    expect(verifyReg).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: options.challenge,
        expectedOrigin: PUBLIC_ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
      }),
    );
    expect(r.setupCodes.check).toHaveBeenLastCalledWith(SETUP_CODE, 'owner_setup');
    expect(r.setupCodes.consume).not.toHaveBeenCalled();
    expect(record).toMatchObject({ credId: CRED_ID, counter: 0, transports: ['internal'], label: 'Phone' });
    expect(r.passkeys.count()).toBe(1);
  });

  it('a failed verification stores nothing and keeps the setup code', async () => {
    const r = rig();
    const options = await r.service.registrationOptions({ setupCode: SETUP_CODE, hasSession: false });
    verifyReg.mockResolvedValue({ verified: false });
    await expect(
      r.service.verifyRegistration({ response: registrationResponse(options.challenge), hasSession: false }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(r.setupCodes.consume).not.toHaveBeenCalled();
    expect(r.passkeys.count()).toBe(0);
  });

  it('verify refuses the setup path once a passkey already exists', async () => {
    const r = rig();
    const options = await r.service.registrationOptions({ setupCode: SETUP_CODE, hasSession: false });
    enroll(r.passkeys);
    verifyReg.mockResolvedValue(verifiedRegistration(OTHER_CRED_ID));
    await expect(
      r.service.verifyRegistration({ response: registrationResponse(options.challenge, OTHER_CRED_ID), hasSession: false }),
    ).rejects.toThrow('A passkey is already enrolled; sign in to add another');
    expect(r.passkeys.count()).toBe(1);
  });

  it('verify refuses when the setup code is no longer valid', async () => {
    const r = rig();
    const options = await r.service.registrationOptions({ setupCode: SETUP_CODE, hasSession: false });
    vi.mocked(r.setupCodes.check).mockImplementation(() => {
      throw new AuthError('Setup code is invalid or expired');
    });
    verifyReg.mockResolvedValue(verifiedRegistration());
    await expect(
      r.service.verifyRegistration({ response: registrationResponse(options.challenge), hasSession: false }),
    ).rejects.toThrow('Setup code is invalid or expired');
    expect(r.passkeys.count()).toBe(0);
    expect(r.setupCodes.consume).not.toHaveBeenCalled();
  });
});

describe('additional passkeys', () => {
  it('options need a session', async () => {
    const r = rig();
    enroll(r.passkeys);
    await expect(r.service.registrationOptions({ pin: '123456', hasSession: false })).rejects.toBeInstanceOf(AuthError);
    expect(r.pin.verify).not.toHaveBeenCalled();
  });

  it('options need the PIN and verify it; enrolled credentials are excluded', async () => {
    const r = rig();
    enroll(r.passkeys);
    await expect(r.service.registrationOptions({ hasSession: true })).rejects.toBeInstanceOf(PinRequiredError);
    vi.mocked(r.pin.verify).mockRejectedValueOnce(new PinInvalidError(2));
    await expect(r.service.registrationOptions({ pin: '000000', hasSession: true })).rejects.toBeInstanceOf(PinInvalidError);
    const options = await r.service.registrationOptions({ pin: '123456', hasSession: true });
    expect(r.pin.verify).toHaveBeenLastCalledWith('123456', 'web');
    expect(r.setupCodes.check).not.toHaveBeenCalled();
    expect(options.excludeCredentials).toEqual([{ id: CRED_ID, transports: ['usb'], type: 'public-key' }]);
  });

  it('verify needs a session', async () => {
    const r = rig();
    enroll(r.passkeys);
    const options = await r.service.registrationOptions({ pin: '123456', hasSession: true });
    verifyReg.mockResolvedValue(verifiedRegistration(OTHER_CRED_ID));
    await expect(
      r.service.verifyRegistration({ response: registrationResponse(options.challenge, OTHER_CRED_ID), hasSession: false }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(verifyReg).not.toHaveBeenCalled();
  });
});

describe('challenges', () => {
  it('are single use', async () => {
    const r = rig();
    const options = await r.service.registrationOptions({ setupCode: SETUP_CODE, hasSession: false });
    verifyReg.mockResolvedValue(verifiedRegistration());
    await r.service.verifyRegistration({ response: registrationResponse(options.challenge), hasSession: false });
    await expect(
      r.service.verifyRegistration({ response: registrationResponse(options.challenge, OTHER_CRED_ID), hasSession: true }),
    ).rejects.toThrow('Registration challenge is unknown or expired');
  });

  it('expire after 5 minutes', async () => {
    const r = rig();
    const options = await r.service.registrationOptions({ setupCode: SETUP_CODE, hasSession: false });
    r.clock.advance(CHALLENGE_TTL_MS);
    await expect(
      r.service.verifyRegistration({ response: registrationResponse(options.challenge), hasSession: false }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(verifyReg).not.toHaveBeenCalled();
  });

  it('a malformed response is a ValidationError and unreadable client data an AuthError', async () => {
    const r = rig();
    await expect(r.service.verifyRegistration({ response: { id: 'x' }, hasSession: false })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(() => challengeFromClientData(Buffer.from('not json').toString('base64url'))).toThrow(AuthError);
  });

  it('a login challenge cannot complete a registration', async () => {
    const r = rig();
    enroll(r.passkeys);
    const options = await r.service.authenticationOptions();
    await expect(
      r.service.verifyRegistration({ response: registrationResponse(options.challenge, OTHER_CRED_ID), hasSession: true }),
    ).rejects.toThrow('Registration challenge is unknown or expired');
  });
});

describe('sign-in', () => {
  it('options list enrolled credentials with user verification required', async () => {
    const r = rig();
    enroll(r.passkeys);
    const options = await r.service.authenticationOptions();
    expect(options.rpId).toBe(RP_ID);
    expect(options.userVerification).toBe('required');
    expect(options.allowCredentials).toEqual([{ id: CRED_ID, transports: ['usb'], type: 'public-key' }]);
  });

  it('options are refused when no passkey is enrolled', async () => {
    await expect(rig().service.authenticationOptions()).rejects.toBeInstanceOf(RefusedError);
  });

  it('verify updates the counter and last_used_at', async () => {
    const r = rig();
    enroll(r.passkeys);
    const options = await r.service.authenticationOptions();
    verifyAuth.mockResolvedValue(verifiedAuthentication(CRED_ID, 7));
    r.clock.advance(1000);
    await r.service.verifyAuthentication(authenticationResponse(options.challenge));
    expect(verifyAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: options.challenge,
        expectedOrigin: PUBLIC_ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        credential: { id: CRED_ID, publicKey: new Uint8Array([9, 9, 9]), counter: 3, transports: ['usb'] },
      }),
    );
    expect(r.passkeys.get(CRED_ID)).toMatchObject({ counter: 7, lastUsedAt: '2026-10-09T12:00:01.000Z' });
  });

  it('verify rejects an unknown credential', async () => {
    const r = rig();
    enroll(r.passkeys);
    const options = await r.service.authenticationOptions();
    await expect(r.service.verifyAuthentication(authenticationResponse(options.challenge, OTHER_CRED_ID))).rejects.toThrow(
      'Unknown passkey',
    );
    expect(verifyAuth).not.toHaveBeenCalled();
  });

  it('a library exception becomes AuthError', async () => {
    const r = rig();
    enroll(r.passkeys);
    const options = await r.service.authenticationOptions();
    verifyAuth.mockRejectedValue(new Error('Unexpected authentication response origin'));
    await expect(r.service.verifyAuthentication(authenticationResponse(options.challenge))).rejects.toThrow(
      'Passkey sign-in could not be verified',
    );
    expect(r.passkeys.get(CRED_ID)?.counter).toBe(3);
  });
});
