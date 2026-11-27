import type { SetupService } from '../core/contracts.js';
import { sha256Hex } from '../core/ids.js';
import { SESSION_ABSOLUTE_MS } from '../web/auth/sessions.js';
import { createSetupState, type SetupStateDeps } from './state.js';

export { claimBanner, groupCode, type ClaimBanner } from './claim.js';
export { loginCommand, pinResetCommand, setupCodeCommand, type CommandResult } from './cli.js';
export { issueLoginLink, LOGIN_LINK_PATH, type LoginLink } from './login-link.js';
export { resetPin, type PinResetResult } from './pin-reset.js';
export { passkeySkipRefusal, readFacts, setupPending, stateOf, type SetupConfig, type StepActor } from './state.js';

/** At most this many login-link sessions are remembered at once; the oldest is forgotten first. */
export const LINK_SESSIONS_MAX = 32;

/**
 * The first-run module: the state machine plus the memory of which sessions came from a login link (the
 * only ones that may skip the passkey). It is `WebDeps.setup` and the wire's `setup`.
 */
export function createSetupModule(deps: SetupStateDeps): SetupService {
  const machine = createSetupState(deps);
  // sha256(page key) → when the memory ends (a session's absolute lifetime; the session store ends it anyway).
  let links: ReadonlyMap<string, number> = new Map();
  const nowMs = (): number => deps.clock.now().getTime();
  return {
    state: machine.state,
    advance: machine.advance,
    finish: machine.finish,
    notify: machine.notify,
    keepLinkSession(pageKey) {
      const now = nowMs();
      const live = [...links].filter(([, until]) => until > now).slice(-(LINK_SESSIONS_MAX - 1));
      links = new Map([...live, [sha256Hex(pageKey), now + SESSION_ABSOLUTE_MS]]);
    },
    isLinkSession(pageKey) {
      if (pageKey === undefined || pageKey === '') return false;
      const until = links.get(sha256Hex(pageKey));
      return until !== undefined && until > nowMs();
    },
  };
}
