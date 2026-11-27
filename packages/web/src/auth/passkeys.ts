import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import type { LuadyApi } from '../api/client.js';
import { signInMessage } from './messages.js';
import { keepPageKey } from './page-key.js';

export async function loginWithPasskey(api: LuadyApi): Promise<void> {
  const optionsJSON = await api.passkeyLoginOptions();
  const assertion = await startAuthentication({ optionsJSON });
  keepPageKey(await api.passkeyLoginVerify({ response: { ...assertion } }));
}

/** First passkey: `{ setupCode }` (first run). Additional passkeys (signed in): `{ pin }`. */
export async function registerPasskey(api: LuadyApi, auth: { setupCode: string } | { pin: string }, label: string): Promise<void> {
  const optionsJSON = await api.passkeyRegisterOptions(auth);
  const attestation = await startRegistration({ optionsJSON });
  keepPageKey(await api.passkeyRegisterVerify({ response: { ...attestation }, label }));
}

export function defaultPasskeyLabel(userAgent: string = navigator.userAgent): string {
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/Android/i.test(userAgent)) return 'Android phone';
  if (/Macintosh/i.test(userAgent)) return 'Mac';
  if (/Windows/i.test(userAgent)) return 'Windows PC';
  return 'This device';
}

export function passkeyErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out.';
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This device already has a Luady passkey.';
    if (err.code === 'ERROR_CEREMONY_ABORTED') return 'The passkey prompt was cancelled.';
    return err.message;
  }
  return signInMessage(err);
}
