import { isSelfHost, type AccountDTO, type PresenceDTO } from '@luady/shared';
import { formatClock } from '../hud/Clock.js';
import { liveWindow } from './limits.js';
import { CHAT_FALLBACK } from './notice-text.js';
import { managerName } from '@luady/shared';

/** Amber from 85% of the 5-hour window, red from 95%. */
export const ENERGY_AMBER_PCT = 85;
export const ENERGY_RED_PCT = 95;

export interface Energy {
  readonly accountId: string;
  readonly label: string;
  readonly usedPct: number;
  readonly tone: 'ok' | 'amber' | 'red';
  readonly resetsAt: string;
}

interface Candidate { readonly account: AccountDTO; readonly usedPct: number; readonly resetsAt: string }

const toneOf = (pct: number): Energy['tone'] => (pct >= ENERGY_RED_PCT ? 'red' : pct >= ENERGY_AMBER_PCT ? 'amber' : 'ok');

/** The Claude accounts with a reported 5-hour window that is still running. */
function candidates(accounts: readonly AccountDTO[], nowMs: number): readonly Candidate[] {
  return accounts.flatMap((account) => {
    if (account.provider !== 'claude' || account.limits.reported !== 'yes') return [];
    const window = liveWindow(account.limits.fiveHour, nowMs);
    return window === null ? [] : [{ account, usedPct: window.usedPct, resetsAt: window.resetsAt }];
  });
}

/** The account's first host other than the manager's own; the manager's name when it is the only one (never its id). */
const firstHost = (account: AccountDTO): string =>
  account.hosts.find((h) => !isSelfHost(h.host))?.host ?? managerName();

/**
 * The bar to show: the focused room's own account, else the fullest account. Null when nothing reports a live
 * 5-hour window (a missing window is never shown as 0%).
 */
export function pickEnergy(accounts: readonly AccountDTO[], focusedHost: string | null, nowMs: number = Date.now()): Energy | null {
  const list = candidates(accounts, nowMs);
  const focused = focusedHost === null ? undefined : list.find((c) => c.account.hosts.some((h) => h.host === focusedHost));
  const chosen = focused ?? list.toSorted((a, b) => b.usedPct - a.usedPct)[0];
  if (chosen === undefined) return null;
  return {
    accountId: chosen.account.id,
    label: focused === undefined || focusedHost === null ? firstHost(chosen.account) : focusedHost,
    usedPct: Math.round(chosen.usedPct),
    tone: toneOf(chosen.usedPct),
    resetsAt: chosen.resetsAt,
  };
}

/**
 * 'Updates: here' | 'Updates: <chat>' | 'Updates: <chat> until 4:10 PM' (owner time); '' before the hub says. `chat`: the
 * chat channel's name ("your chat channel" when the hub has not named one).
 */
export function pillText(presence: PresenceDTO | null, now: Date, chat: string = CHAT_FALLBACK): string {
  if (presence === null) return '';
  if (presence.mode === 'here') return 'Updates: here';
  const until = presence.forcedUntil === null ? Number.NaN : Date.parse(presence.forcedUntil);
  return Number.isFinite(until) && until > now.getTime() ? `Updates: ${chat} until ${formatClock(until)}` : `Updates: ${chat}`;
}
