import type { CtlAuthStatus, HostId } from '@luady/shared';

/** The last sign-in check of one host; every field null before the first check. */
export interface LoginStatus {
  readonly host: HostId;
  readonly loggedIn: boolean | null;
  readonly email: string | null;
  readonly orgId: string | null;
  readonly orgName: string | null;
  readonly plan: string | null;
  readonly expiresAt: string | null;
  readonly checkedAt: string | null;
}

export function uncheckedStatus(host: HostId): LoginStatus {
  return { host, loggedIn: null, email: null, orgId: null, orgName: null, plan: null, expiresAt: null, checkedAt: null };
}

/** Kit 1 sends no organisation or plan: those stay null. */
export function toLoginStatus(host: HostId, status: CtlAuthStatus, checkedAt: string): LoginStatus {
  return {
    host, loggedIn: status.logged_in, email: status.email, orgId: status.org_id ?? null, orgName: status.org_name ?? null,
    plan: status.plan ?? null, expiresAt: status.expires_at, checkedAt,
  };
}

/** What the accounts view groups and warns by; the check time alone is not a change. */
export function statusChanged(before: LoginStatus | undefined, after: LoginStatus): boolean {
  return before === undefined || before.loggedIn !== after.loggedIn || before.orgId !== after.orgId
    || before.email !== after.email || before.expiresAt !== after.expiresAt;
}
