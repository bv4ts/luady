import type { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { PUBLIC_ORIGIN, RP_ID } from './fixtures.js';

export const CRED_ID = Buffer.from('credential-one').toString('base64url');
export const OTHER_CRED_ID = Buffer.from('credential-two').toString('base64url');

type RegistrationResult = Awaited<ReturnType<typeof verifyRegistrationResponse>>;
type AuthenticationResult = Awaited<ReturnType<typeof verifyAuthenticationResponse>>;

function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin: PUBLIC_ORIGIN, crossOrigin: false })).toString('base64url');
}

/** Browser-shaped JSON. The cryptographic fields are dummies because verify* is mocked in these tests. */
export function registrationResponse(challenge: string, credId: string = CRED_ID): Record<string, unknown> {
  return {
    id: credId,
    rawId: credId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData('webauthn.create', challenge),
      attestationObject: 'o2NmbXRkbm9uZWdhdHRTdG10oA',
      transports: ['internal'],
    },
  };
}

export function authenticationResponse(challenge: string, credId: string = CRED_ID): Record<string, unknown> {
  return {
    id: credId,
    rawId: credId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: clientData('webauthn.get', challenge),
      authenticatorData: ['SZYN5YgOjGh0', 'NBcPZHZgW4_krrmihjLHm', 'VzzuoMdl2MFAAAAAQ'].join(''),
      signature: 'MEUCIQDZx2tP2b0',
    },
  };
}

export function verifiedRegistration(credId: string = CRED_ID): RegistrationResult {
  return {
    verified: true,
    registrationInfo: {
      fmt: 'none',
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: { id: credId, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
      credentialType: 'public-key',
      attestationObject: new Uint8Array([0]),
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: PUBLIC_ORIGIN,
      rpID: RP_ID,
    },
  };
}

export function verifiedAuthentication(credId: string = CRED_ID, newCounter = 7): AuthenticationResult {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: credId,
      newCounter,
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: PUBLIC_ORIGIN,
      rpID: RP_ID,
    },
  };
}
