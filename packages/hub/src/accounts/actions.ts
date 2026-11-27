import { isChatChannel } from '@luady/shared';
import type { AccountActions } from '../actions/execute.js';
import type { ClaudeLoginService } from '../claude-login/service.js';
import { linkText } from '../claude-login/text.js';
import type { Clock, EventBus } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import type { CodexLogin } from '../media/codex-login.js';

export const SIGN_IN_STARTED = 'sign-in started';
export const SIGNED_OUT = 'signed out';
export const CODEX_NOT_SIGNED_OUT = 'ChatGPT did not sign out. Try again.';

export interface AccountActionDeps {
  login: Pick<ClaudeLoginService, 'begin' | 'logout'>;
  codex: Pick<CodexLogin, 'begin' | 'beginData' | 'logout'>;
  bus: Pick<EventBus, 'emit'>;
  clock: Clock;
  /** The owner's chat channel: a sign-in started there gets its link (or device code) there. */
  chat?: (text: string) => Promise<unknown>;
}

/**
 * What the audited `account.login` / `account.logout` actions run. The audit row keeps only these short results: the
 * link goes back to the website through the login service's pending sign-in, never through the action.
 */
export function createAccountActions(deps: AccountActionDeps): AccountActions {
  return {
    async login(target, channel = 'web') {
      const onChat = isChatChannel(channel) && deps.chat !== undefined;
      if (target === 'codex') {
        // From the chat: the device code there, and the result follows there when the sign-in ends (codex-login.ts).
        if (onChat) await deps.chat?.(await deps.codex.begin());
        else await deps.codex.beginData();
        return SIGN_IN_STARTED;
      }
      const start = await deps.login.begin(target);
      if (onChat) await deps.chat?.(linkText(target, start.url));
      return SIGN_IN_STARTED;
    },
    async logout(target) {
      if (target === 'codex') {
        if (!(await deps.codex.logout())) throw new RefusedError(CODEX_NOT_SIGNED_OUT);
        deps.bus.emit('accounts.changed', { at: deps.clock.now().toISOString() });
        return SIGNED_OUT;
      }
      const result = await deps.login.logout(target);
      if (!result.ok) throw new RefusedError(result.message);
      return SIGNED_OUT;
    },
  };
}
