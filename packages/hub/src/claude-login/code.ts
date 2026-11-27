import { LoginCodeBodySchema } from '@luady/shared';

/** A sign-in code as the hub accepts it: the shared schema's, trimmed, then 8 to 1,100 characters. */
export const SignInCodeSchema = LoginCodeBodySchema.shape.code;

/** A pasted sign-in code: `<code>#<state>`, both base64url. Distinctive enough to catch without /login. */
export const SIGN_IN_CODE_RE = /^[A-Za-z0-9._~-]{20,512}#[A-Za-z0-9._~-]{20,512}$/;
/** The same shape anywhere in a message ("here is the code: …"), standing on its own. */
const CODE_TOKEN_RE = /(?<![A-Za-z0-9._~-])[A-Za-z0-9._~-]{20,512}#[A-Za-z0-9._~-]{20,512}(?![A-Za-z0-9._~-])/;

/**
 * The sign-in code a chat message carries: the whole message when it is one, or (only while a sign-in waits) a
 * code-shaped token inside it. Such a message goes to the sign-in, never to the brain or the message store.
 */
export function codeInMessage(text: string, signInWaiting: boolean): string | null {
  const trimmed = text.trim();
  if (SIGN_IN_CODE_RE.test(trimmed)) return trimmed;
  if (!signInWaiting) return null;
  return CODE_TOKEN_RE.exec(trimmed)?.[0] ?? null;
}
