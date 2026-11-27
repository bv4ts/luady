import type { CtlAuthStatus, HostId } from '@luady/shared';
import type { Logger, OutboundChannel } from '../core/contracts.js';
import { identityOf, sameAccount, type AccountIdentity, type LoginState } from './state.js';
import { hostLabel } from './text.js';

const accountName = (identity: AccountIdentity, unknown: string): string =>
  `${identity.orgName ?? identity.email ?? unknown}${identity.plan === null ? '' : ` (${identity.plan})`}`;

/** The send-now chat message when a host turns up signed in to another account. */
export function movedText(host: HostId, identity: AccountIdentity): string {
  return `🔐 ${hostLabel(host)} is now signed in to ${accountName(identity, 'another account')}. If that was not you, sign it out.`;
}

/** The audit line of a finished sign-in: the host (the manager's name for its own) and the account, never the code. */
export function signedInSummary(host: HostId, status: CtlAuthStatus): string {
  return `${hostLabel(host)} signed in to ${accountName(identityOf(status), 'an unknown account')}`;
}

export interface IdentityWatchDeps {
  state: LoginState;
  log: Logger;
  /** Send-now: the owner hears of a move at once, night or day. */
  outbound: Pick<OutboundChannel, 'send'>;
}

export interface IdentityWatch {
  /** Every signed-in reading of a host; true (after the message went out) when it is now on another account. */
  observe(host: HostId, status: CtlAuthStatus): Promise<boolean>;
}

/** Remembers each host's account (across restarts) and tells the owner once when it changes. */
export function createIdentityWatch(deps: IdentityWatchDeps): IdentityWatch {
  return {
    async observe(host, status) {
      if (!status.logged_in) return false;
      const next = identityOf(status);
      const before = deps.state.identity(host);
      deps.state.setIdentity(host, next);
      if (before === null || sameAccount(before, next)) return false;
      deps.log.warn({ host, orgName: next.orgName, plan: next.plan }, 'claude-login: host moved to another account');
      try {
        await deps.outbound.send(movedText(host, next), null);
      } catch (err) {
        deps.log.error({ host, err: err instanceof Error ? err.message : String(err) }, 'claude-login: move message not sent');
      }
      return true;
    },
  };
}
