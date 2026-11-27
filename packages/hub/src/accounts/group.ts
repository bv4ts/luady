import { isSelfHost, type AccountDTO, type AccountHostDTO, type AccountLimitsDTO, type HostId, type RateWindowDTO } from '@luady/shared';
import type { LoginStatus } from '../claude-login/status.js';
import { liveWindow, type HostLimits } from './limits.js';

/** `claude:<orgId>` | `claude:<lower-cased email>` | `claude:host:<host>` (signed out, or a kit that reports neither). */
export function accountIdOf(status: Pick<LoginStatus, 'host' | 'orgId' | 'email'>): string {
  if (status.orgId !== null && status.orgId !== '') return `claude:${status.orgId}`;
  if (status.email !== null && status.email !== '') return `claude:${status.email.toLowerCase()}`;
  return `claude:host:${status.host}`;
}

export interface GroupInput {
  readonly statuses: readonly LoginStatus[];
  readonly limits: readonly HostLimits[];
  /** Hosts whose sign-in link still waits for its code. */
  readonly pending: readonly HostId[];
  /** The host can be signed out from here (Luady's own, or a server on kit 2). */
  readonly kitOk: (host: HostId) => boolean;
  readonly now: Date;
}

export const UNKNOWN_LIMITS: AccountLimitsDTO = { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null };

/** Luady's own host first, then by name. */
const hostOrder = (a: HostId, b: HostId): number => (isSelfHost(a) ? -1 : isSelfHost(b) ? 1 : a.localeCompare(b));
const newest = <T>(items: readonly T[], when: (item: T) => string | null): T | undefined =>
  items.reduce<T | undefined>((best, item) => {
    const at = when(item);
    if (at === null) return best;
    const bestAt = best === undefined ? null : when(best);
    return bestAt === null || at > bestAt ? item : best;
  }, undefined);

/** The newest reading of one window among the account's hosts; null when none, or its reset has passed. */
function newestWindow(limits: readonly HostLimits[], pick: 'fiveHour' | 'sevenDay', now: Date): RateWindowDTO | null {
  const atKey = pick === 'fiveHour' ? 'fiveHourAt' : 'sevenDayAt';
  const host = newest(limits.filter((entry) => entry[pick] !== null), (entry) => entry[atKey]);
  return liveWindow(host?.[pick] ?? null, now);
}

/** Hosts of one account share its limits: merged window by window, the newest reading of each wins. */
export function mergeLimits(limits: readonly HostLimits[], now: Date): AccountLimitsDTO {
  const reported = limits.some((entry) => entry.reported === 'yes') ? 'yes' : limits.some((entry) => entry.reported === 'no') ? 'no' : null;
  if (reported === null) return UNKNOWN_LIMITS;
  const counted = limits.filter((entry) => entry.reported === reported);
  return {
    reported,
    fiveHour: reported === 'yes' ? newestWindow(counted, 'fiveHour', now) : null,
    sevenDay: reported === 'yes' ? newestWindow(counted, 'sevenDay', now) : null,
    updatedAt: newest(counted, (entry) => entry.updatedAt)?.updatedAt ?? null,
  };
}

function hostRow(status: LoginStatus, input: GroupInput): AccountHostDTO {
  return {
    host: status.host, loggedIn: status.loggedIn, expiresAt: status.expiresAt, checkedAt: status.checkedAt,
    loginPending: input.pending.includes(status.host), canLogout: input.kitOk(status.host),
  };
}

function toAccount(id: string, statuses: readonly LoginStatus[], input: GroupInput): AccountDTO {
  const hosts = [...statuses].sort((a, b) => hostOrder(a.host, b.host));
  const last = newest(hosts, (status) => status.checkedAt) ?? hosts[0];
  const names = new Set(hosts.map((status) => status.host));
  return {
    id, provider: 'claude', email: last?.email ?? null, orgName: last?.orgName ?? null, plan: last?.plan ?? null,
    hosts: hosts.map((status) => hostRow(status, input)),
    limits: mergeLimits(input.limits.filter((entry) => names.has(entry.host)), input.now),
    isManager: [...names].some(isSelfHost),
  };
}

const lowestHost = (account: AccountDTO): string => account.hosts.map((h) => h.host).sort()[0] ?? '';

/** Hosts signed in to the same account form one; sorted with Luady's account first, then by the lowest host name. */
export function groupAccounts(input: GroupInput): AccountDTO[] {
  const groups = input.statuses.reduce<ReadonlyMap<string, readonly LoginStatus[]>>((acc, status) => {
    const id = accountIdOf(status);
    return new Map([...acc, [id, [...(acc.get(id) ?? []), status]]]);
  }, new Map());
  return [...groups].map(([id, statuses]) => toAccount(id, statuses, input))
    .sort((a, b) => (a.isManager !== b.isManager ? (a.isManager ? -1 : 1) : lowestHost(a).localeCompare(lowestHost(b))));
}
