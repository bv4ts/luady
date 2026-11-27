import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { ownerLabelOf } from '../../config/defaults.js';
import type { Clock, HubConfig, Logger, PinService, SetupCodeService } from '../../core/contracts.js';
import { AuthError, RefusedError, ValidationError } from '../../core/errors.js';
import { PinRequiredError } from '../errors.js';
import type { SetupCodeClaim } from '../../security/setup-codes.js';
import { CHALLENGE_TTL_MS, type ChallengePurpose, type ChallengeStore } from './challenges.js';
import type { PasskeyRecord, PasskeyStore } from './passkeys.js';

export const RP_NAME = 'Luady';
/** Single owner: a fixed WebAuthn user handle. */
export const OWNER_USER_ID = new Uint8Array(Buffer.from('owner', 'utf8'));

/** The name a new passkey shows: the Access e-mail, or in local mode (no e-mail) the owner label. Never empty. */
export function passkeyUserName(config: Partial<Pick<HubConfig, 'ownerEmail' | 'ownerLabel'>>): string {
  return config.ownerEmail ?? ownerLabelOf(config);
}
const DEFAULT_LABEL = 'Passkey';

export interface WebAuthnDeps {
  config: Pick<HubConfig, 'rpId' | 'publicOrigin'> & Partial<Pick<HubConfig, 'ownerEmail' | 'ownerLabel'>>;
  passkeys: PasskeyStore;
  challenges: ChallengeStore;
  /** The hub's service also claims (claimWith: the first passkey and the voiding of every other code, in one transaction). */
  setupCodes: SetupCodeService & Partial<SetupCodeClaim>;
  pin: PinService;
  clock: Clock;
  log: Logger;
}

export interface RegistrationRequest {
  setupCode?: string;
  pin?: string;
  hasSession: boolean;
  /** Whether the install has an owner (the setup state: a passkey, a PIN, or a finished setup). Absent: a passkey on file. */
  claimed?: boolean;
}

export interface RegistrationVerification {
  response: Record<string, unknown>;
  label?: string;
  hasSession: boolean;
  claimed?: boolean;
}

/**
 * Only an unclaimed install takes a setup code for a passkey: once the install has an owner, a code alone is never
 * enough; adding a passkey needs a session, and the PIN once one exists.
 */
function isClaimed(deps: WebAuthnDeps, request: { claimed?: boolean }): boolean {
  return request.claimed === true || deps.passkeys.count() > 0;
}

export interface WebAuthnService {
  registrationOptions(request: RegistrationRequest): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(request: RegistrationVerification): Promise<PasskeyRecord>;
  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(response: Record<string, unknown>): Promise<PasskeyRecord>;
}

const Base64Url = z.string().min(1).max(65536).regex(/^[A-Za-z0-9_-]+={0,2}$/);
const ClientDataSchema = z.looseObject({ challenge: z.string().min(16).max(512) });
const RegistrationShape = z.looseObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: Base64Url, attestationObject: Base64Url }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});
const AuthenticationShape = z.looseObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: Base64Url, authenticatorData: Base64Url, signature: Base64Url }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

/** Shape check only; SimpleWebAuthn validates every cryptographic field itself. */
function isRegistrationResponse(value: unknown): value is RegistrationResponseJSON {
  return RegistrationShape.safeParse(value).success;
}

function isAuthenticationResponse(value: unknown): value is AuthenticationResponseJSON {
  return AuthenticationShape.safeParse(value).success;
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The challenge the authenticator signed, read from the base64url clientDataJSON. */
export function challengeFromClientData(clientDataJSON: string): string {
  const parsed = ClientDataSchema.safeParse(decodeJson(Buffer.from(clientDataJSON, 'base64url').toString('utf8')));
  if (!parsed.success) throw new AuthError('Malformed passkey client data');
  return parsed.data.challenge;
}

async function guarded<T>(log: Logger, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    log.warn({ err }, `passkey ${what} verification threw`);
    throw new AuthError(`Passkey ${what} could not be verified`);
  }
}

/** Holds a checked setup code between options and verify. Memory only, never persisted; expires with its challenge. */
class PendingSetupCodes {
  private entries: ReadonlyMap<string, { code: string; expiresAt: number }> = new Map();
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  hold(challenge: string, code: string): void {
    const now = this.clock.now().getTime();
    const live = [...this.entries].filter(([, entry]) => entry.expiresAt > now);
    this.entries = new Map<string, { code: string; expiresAt: number }>([
      ...live,
      [challenge, { code, expiresAt: now + CHALLENGE_TTL_MS }],
    ]);
  }

  release(challenge: string): string | null {
    const entry = this.entries.get(challenge);
    this.entries = new Map([...this.entries].filter(([key]) => key !== challenge));
    return entry !== undefined && entry.expiresAt > this.clock.now().getTime() ? entry.code : null;
  }
}

async function authorizeRegistration(deps: WebAuthnDeps, request: RegistrationRequest, first: boolean): Promise<void> {
  if (first) {
    if (request.setupCode === undefined) throw new AuthError('A setup code is required to enroll the first passkey');
    deps.setupCodes.check(request.setupCode, 'owner_setup');
    return;
  }
  if (!request.hasSession) throw new AuthError('Sign in before adding another passkey');
  if (!deps.pin.isSet()) return;
  if (request.pin === undefined) throw new PinRequiredError('PIN required to add another passkey');
  await deps.pin.verify(request.pin, 'web');
}

async function registrationOptions(
  deps: WebAuthnDeps,
  pending: PendingSetupCodes,
  request: RegistrationRequest,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const first = !isClaimed(deps, request);
  await authorizeRegistration(deps, request, first);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: deps.config.rpId,
    userName: passkeyUserName(deps.config),
    userID: OWNER_USER_ID,
    userDisplayName: passkeyUserName(deps.config),
    attestationType: 'none',
    excludeCredentials: deps.passkeys.list().map((passkey) => ({ id: passkey.credId, transports: passkey.transports })),
    // A fresh object on every call: the library writes requireResidentKey into it.
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  const purpose: ChallengePurpose = first ? 'register-setup' : 'register';
  deps.challenges.save(options.challenge, purpose);
  if (first && request.setupCode !== undefined) pending.hold(options.challenge, request.setupCode);
  return options;
}

/** First run: ONE code. Registration only re-checks it here; the first PIN set (pin.set) consumes it. */
function recheckSetupCode(deps: WebAuthnDeps, setupCode: string | null, request: RegistrationVerification): string {
  if (deps.passkeys.count() > 0) throw new AuthError('A passkey is already enrolled; sign in to add another');
  if (isClaimed(deps, request)) throw new AuthError('This install already has an owner; sign in to add a passkey');
  if (setupCode === null) throw new AuthError('The setup code expired; request a new one');
  deps.setupCodes.check(setupCode, 'owner_setup');
  return setupCode;
}

async function verifyRegistration(
  deps: WebAuthnDeps,
  pending: PendingSetupCodes,
  request: RegistrationVerification,
): Promise<PasskeyRecord> {
  const response = request.response;
  if (!isRegistrationResponse(response)) throw new ValidationError('Invalid passkey registration response');
  const challenge = challengeFromClientData(response.response.clientDataJSON);
  const purpose = deps.challenges.take(challenge);
  const setupCode = pending.release(challenge);
  if (purpose !== 'register' && purpose !== 'register-setup') {
    throw new AuthError('Registration challenge is unknown or expired');
  }
  if (purpose === 'register' && !request.hasSession) throw new AuthError('Sign in before adding another passkey');
  const result = await guarded(deps.log, 'registration', () =>
    verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: deps.config.publicOrigin,
      expectedRPID: deps.config.rpId,
      requireUserVerification: true,
    }),
  );
  if (!result.verified) throw new AuthError('Passkey registration could not be verified');
  const claimCode = purpose === 'register-setup' ? recheckSetupCode(deps, setupCode, request) : null;
  const { credential } = result.registrationInfo;
  const insert = (): PasskeyRecord => deps.passkeys.insert({
    credId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
    label: request.label ?? DEFAULT_LABEL,
  });
  // The claim: the first passkey is stored, its code re-checked and every other unused code voided, in one transaction.
  return claimCode !== null && deps.setupCodes.claimWith !== undefined ? deps.setupCodes.claimWith(claimCode, insert) : insert();
}

async function authenticationOptions(deps: WebAuthnDeps): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const passkeys = deps.passkeys.list();
  if (passkeys.length === 0) throw new RefusedError('No passkey is enrolled yet');
  const options = await generateAuthenticationOptions({
    rpID: deps.config.rpId,
    allowCredentials: passkeys.map((passkey) => ({ id: passkey.credId, transports: passkey.transports })),
    userVerification: 'required',
  });
  deps.challenges.save(options.challenge, 'login');
  return options;
}

async function verifyAuthentication(deps: WebAuthnDeps, response: Record<string, unknown>): Promise<PasskeyRecord> {
  if (!isAuthenticationResponse(response)) throw new ValidationError('Invalid passkey sign-in response');
  const challenge = challengeFromClientData(response.response.clientDataJSON);
  if (deps.challenges.take(challenge) !== 'login') throw new AuthError('Login challenge is unknown or expired');
  const passkey = deps.passkeys.get(response.id);
  if (passkey === undefined) throw new AuthError('Unknown passkey');
  const result = await guarded(deps.log, 'sign-in', () =>
    verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: deps.config.publicOrigin,
      expectedRPID: deps.config.rpId,
      credential: { id: passkey.credId, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    }),
  );
  if (!result.verified) throw new AuthError('Passkey sign-in could not be verified');
  deps.passkeys.recordUse(passkey.credId, result.authenticationInfo.newCounter);
  return deps.passkeys.get(passkey.credId) ?? { ...passkey, counter: result.authenticationInfo.newCounter };
}

export function createWebAuthnService(deps: WebAuthnDeps): WebAuthnService {
  const pending = new PendingSetupCodes(deps.clock);
  return {
    registrationOptions: (request) => registrationOptions(deps, pending, request),
    verifyRegistration: (request) => verifyRegistration(deps, pending, request),
    authenticationOptions: () => authenticationOptions(deps),
    verifyAuthentication: (response) => verifyAuthentication(deps, response),
  };
}
