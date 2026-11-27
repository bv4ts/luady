import type { AccountDTO, RateWindowDTO } from '@luady/shared';

/**
 * A limit window that is reported and still running; null when it is missing, unreadable or already reset.
 * A missing window means "not reported", never 0%.
 */
export function liveWindow(window: RateWindowDTO | null, nowMs: number): RateWindowDTO | null {
  if (window === null || !Number.isFinite(window.usedPct)) return null;
  const resets = Date.parse(window.resetsAt);
  return Number.isFinite(resets) && resets > nowMs ? window : null;
}

/** The Claude account a host is signed in to, if the accounts list has it. */
export function accountOfHost(accounts: readonly AccountDTO[] | undefined, host: string): AccountDTO | null {
  return accounts?.find((account) => account.provider === 'claude' && account.hosts.some((h) => h.host === host)) ?? null;
}

const pct = (value: number): string => `${Math.round(value)}%`;

/** '5h 62% · week 41%' with only the windows that are reported and live; null when there are none. */
export function shortLimits(account: AccountDTO | null, nowMs: number): string | null {
  if (account === null || account.limits.reported !== 'yes') return null;
  const five = liveWindow(account.limits.fiveHour, nowMs);
  const week = liveWindow(account.limits.sevenDay, nowMs);
  const parts = [five === null ? null : `5h ${pct(five.usedPct)}`, week === null ? null : `week ${pct(week.usedPct)}`];
  const text = parts.filter((part): part is string => part !== null).join(' · ');
  return text === '' ? null : text;
}
