import { systemClock } from '../core/clock.js';
import type { Clock, Db } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { isRemote } from '../config/remote.js';
import { createSetupCodeService, SETUP_CODE_TTLS } from '../security/setup-codes.js';
import { readFacts, stateOf, type SetupConfig } from './state.js';

/** The page a login link opens; the token rides in the fragment, which the browser never sends to any server. */
export const LOGIN_LINK_PATH = '/setup/login';

export interface LoginLink {
  /** `<publicOrigin>/setup/login#<token>`: single use, 5 minutes. */
  readonly url: string;
  readonly expiresAt: string;
  /** A new setup code when the install has no PIN yet (unclaimed, or after a PIN reset): the first PIN needs one. */
  readonly setupCode: string | null;
}

export const REMOTE_LOGIN_REFUSAL = 'Login links are off: this hub can be reached from other machines. Sign in with a passkey.';

/**
 * Issues a login link for `luady login`: written straight to the database from the CLI process, as
 * `setup-code` does, so it works whether the hub runs or not. Only the token's sha256 is stored (purpose `owner_login`,
 * 5 minutes). Refused on a remote install. The token is returned once, for the terminal; nothing here logs it.
 */
export function issueLoginLink(db: Db, config: SetupConfig, clock: Clock = systemClock): LoginLink {
  if (isRemote(config)) throw new RefusedError(REMOTE_LOGIN_REFUSAL);
  const codes = createSetupCodeService({ db, clock });
  const token = codes.issue('owner_login');
  const state = stateOf(readFacts(db), config);
  const setupCode = state.step === 'claim' || state.step === 'pin' ? codes.issue('owner_setup') : null;
  return {
    url: `${config.publicOrigin}${LOGIN_LINK_PATH}#${token}`,
    expiresAt: new Date(clock.now().getTime() + SETUP_CODE_TTLS.owner_login).toISOString(),
    setupCode,
  };
}
