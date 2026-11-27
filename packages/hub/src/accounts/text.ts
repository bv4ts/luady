import type { AccountDTO, AccountHostDTO, RateWindowDTO } from '@luady/shared';
import { hostLabel, whenText } from '../claude-login/text.js';
import { WARN_AHEAD_MS } from '../claude-login/alerts.js';
import { clock12 } from '../core/time.js';

export const NO_ACCOUNTS_TEXT = 'No Claude account has been checked yet.';

const planLabel = (plan: string | null): string =>
  plan === null || plan === '' ? 'Claude' : `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;

/** "5h 62% (resets 3:20 PM)"; a missing window is unknown, never zero. */
function windowText(name: string, window: RateWindowDTO | null, resets: (at: Date) => string): string {
  if (window === null) return `${name} unknown`;
  return `${name} ${Math.round(window.usedPct)}% (resets ${resets(new Date(window.resetsAt))})`;
}

function limitsPart(account: AccountDTO, now: Date): string[] {
  if (account.limits.reported === 'no') return ['this plan does not report limits'];
  if (account.limits.reported === 'unknown') return ['no reading yet'];
  return [
    windowText('5h', account.limits.fiveHour, clock12),
    windowText('week', account.limits.sevenDay, (at) => whenText(at, now)),
  ];
}

function signInPart(host: AccountHostDTO, now: Date): string | null {
  if (host.loggedIn === false) return `${hostLabel(host.host)} is signed out`;
  if (host.loggedIn !== true || host.expiresAt === null) return null;
  const left = Date.parse(host.expiresAt) - now.getTime();
  if (!Number.isFinite(left) || left > WARN_AHEAD_MS) return null;
  return `${hostLabel(host.host)}'s sign-in ends ${whenText(new Date(host.expiresAt), now)}`;
}

/** One line per Claude account, for Luady's `account_limits` tool. Times are owner time. */
export function limitsText(accounts: readonly AccountDTO[], now: Date): string {
  const claude = accounts.filter((account) => account.provider === 'claude');
  if (claude.length === 0) return NO_ACCOUNTS_TEXT;
  return claude.map((account) => {
    const hosts = account.hosts.map((host) => hostLabel(host.host)).join(', ');
    const signIns = account.hosts.map((host) => signInPart(host, now)).filter((part): part is string => part !== null);
    return [`${planLabel(account.plan)} (${hosts})`, ...limitsPart(account, now), ...signIns].join(' · ');
  }).join('\n');
}
