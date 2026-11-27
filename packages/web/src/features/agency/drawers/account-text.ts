import {
  isSelfHost, managerName, ownerFormat, type AccountDTO, type AccountHostDTO, type AccountLimitsDTO, type RateWindowDTO,
} from '@luady/shared';
import type { RoomLookup } from '../../rooms/room-lookup.js';
import { formatClock } from '../hud/Clock.js';

const DAY_MS = 86_400_000;
const DAY_KEY = ownerFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
const WEEKDAY = ownerFormat('en-US', { weekday: 'short' });
const MONTH_DAY = ownerFormat('en-US', { month: 'short', day: 'numeric' });

/** A moment in owner time: '3:20 PM' today, 'Sun 9:00 AM' within the next week, 'Dec 1' further away; '' if unreadable. */
export function whenText(iso: string, now: Date): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  if (DAY_KEY.format(at) === DAY_KEY.format(now)) return formatClock(at);
  const ahead = at - now.getTime();
  if (ahead > -DAY_MS && ahead < 6 * DAY_MS) return `${WEEKDAY.format(at)} ${formatClock(at)}`;
  return MONTH_DAY.format(at);
}

/** Who the account is: its e-mail, else its organisation, else 'Not signed in'. */
export function accountTitle(account: AccountDTO): string {
  return account.email ?? account.orgName ?? 'Not signed in';
}

function signInState(host: AccountHostDTO, now: Date): string {
  if (host.loggedIn === true) return host.expiresAt === null ? 'signed in' : `signed in until ${whenText(host.expiresAt, now)}`;
  if (host.loggedIn === false) return 'signed out';
  return host.checkedAt === null ? 'not checked yet' : 'could not be checked';
}

/** The host as the owner knows it: the manager's name for its own host, never the raw id. */
export function hostName(host: string): string {
  return isSelfHost(host) ? managerName() : host;
}

/** The host by its home room's name when it has one (the manager's own host by the manager's name). */
export function hostNameIn(host: string, lookup: Pick<RoomLookup, 'hostLabel'>): string {
  return isSelfHost(host) ? managerName() : lookup.hostLabel(host);
}

/** 'cedar · signed in until Sun 9:00 AM' | 'ash · signed out' | 'birch · not checked yet'; `name` replaces the host id. */
export function hostLine(host: AccountHostDTO, now: Date, name: string = hostName(host.host)): string {
  const waiting = host.loginPending ? ' · sign-in waiting for its code' : '';
  return `${name} · ${signInState(host, now)}${waiting}`;
}

/**
 * One limit window in words: '5-hour limit 62% · resets 3:20 PM'. A missing (or unreadable) window is 'not reported',
 * never 0%; one whose reset time has passed says so until a new reading comes.
 */
export function limitLine(label: string, window: RateWindowDTO | null, now: Date): string | null {
  if (window === null || !Number.isFinite(window.usedPct)) return `${label} not reported`;
  const resets = Date.parse(window.resetsAt);
  if (!Number.isFinite(resets)) return `${label} ${Math.round(window.usedPct)}%`;
  if (resets <= now.getTime()) return `${label} reset at ${whenText(window.resetsAt, now)}, no new reading yet`;
  return `${label} ${Math.round(window.usedPct)}% · resets ${whenText(window.resetsAt, now)}`;
}

/** Why an account shows no limit bars; null when it reports them. */
export function limitsNote(limits: AccountLimitsDTO): string | null {
  if (limits.reported === 'no') return 'This plan does not report limits.';
  if (limits.reported === 'unknown') return 'No reading yet.';
  return null;
}
