import { randomUUID } from 'node:crypto';
import { SELF_HOST_ID, type CtlAuthStatus, type HostId } from '@luady/shared';
import type { CtlClient } from '../packages/hub/dist/core/contracts.js';
import { CtlError } from '../packages/hub/dist/core/errors.js';

export type AuthVerb = 'authStatus' | 'authLogin' | 'authCode' | 'authLogout';

/** The code the preview's fake sign-in accepts for the host's own account; anything else but the next is "Invalid code". */
export const PREVIEW_SIGN_IN_CODE = 'preview-code-1234';
/** Signs the host in to another organisation, so the hub's "now signed in to …" message can be seen. */
export const PREVIEW_OTHER_ACCOUNT_CODE = 'preview-code-5678';
/**
 * The hub shows only links on the provider's own hosts, so the preview's link is a subdomain of claude.ai that has no
 * sign-in page; its state is random, so it can never complete a real sign-in.
 */
export const PREVIEW_SIGN_IN_URL = 'https://luady-preview.claude.ai/oauth/authorize';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NOT_FOUND_EXIT = 4;

interface Profile { readonly email: string; readonly org_id: string; readonly org_name: string; readonly plan: string; readonly validMs: number }

const LUADY_ACCOUNT: Profile = { email: 'luady@preview.invalid', org_id: 'org_luady', org_name: 'Luady', plan: 'max', validMs: 25 * DAY_MS };

/** cedar on a personal Max plan, birch and ash on two Team plans (ash's sign-in ends in 30 hours), local and the self host sharing Luady's. */
export const PREVIEW_ACCOUNTS: Readonly<Record<HostId, Profile>> = {
  cedar: { email: 'owner@preview.invalid', org_id: 'org_max', org_name: 'Personal', plan: 'max', validMs: 20 * DAY_MS },
  birch: { email: 'team-a@preview.invalid', org_id: 'org_team_a', org_name: 'Team A', plan: 'team', validMs: 40 * DAY_MS },
  ash: { email: 'team-b@preview.invalid', org_id: 'org_team_b', org_name: 'Team B', plan: 'team', validMs: 30 * HOUR_MS },
  local: LUADY_ACCOUNT,
  [SELF_HOST_ID]: LUADY_ACCOUNT,
};

const OTHER_ACCOUNT: Profile = { email: 'other@preview.invalid', org_id: 'org_other', org_name: 'Other Org', plan: 'pro', validMs: 10 * DAY_MS };
/** A server the owner adds in the demo signs in to the owner's own plan; until then it is signed out. */
const NEW_SERVER_ACCOUNT: Profile = { email: 'owner@preview.invalid', org_id: 'org_max', org_name: 'Personal', plan: 'max', validMs: 20 * DAY_MS };

const SIGNED_OUT: CtlAuthStatus = { logged_in: false, email: null, expires_at: null, org_id: null, org_name: null, plan: null };

export interface FakeAuth extends Pick<CtlClient, AuthVerb> {
  /** Signed out at the terminal: the hub only learns it at its next check. */
  signOut(): void;
}

/** One host's Claude account, like `claude auth`: the seeded hosts have theirs; one added in the demo gets the owner's. */
function profileOf(host: HostId): Profile {
  return PREVIEW_ACCOUNTS[host] ?? NEW_SERVER_ACCOUNT;
}

/** Signed in when the preview starts; a host added while it runs starts signed out, as a new server does. */
export function createFakeAuth(host: HostId, clock: () => Date): FakeAuth {
  let profile = profileOf(host);
  const until = (): string => new Date(clock().getTime() + profile.validMs).toISOString();
  let expiresAt: string | null = PREVIEW_ACCOUNTS[host] === undefined ? null : until();
  let waiting = false;
  const status = (): CtlAuthStatus => (expiresAt === null ? { ...SIGNED_OUT } : {
    logged_in: true, email: profile.email, expires_at: expiresAt, org_id: profile.org_id, org_name: profile.org_name, plan: profile.plan,
  });

  return {
    authStatus: async () => status(),
    authLogin: async () => {
      waiting = true;
      return { url: `${PREVIEW_SIGN_IN_URL}?code=true&state=${randomUUID()}` };
    },
    authCode: async (code) => {
      if (!waiting) throw new CtlError('not_found', 'no sign-in is waiting', NOT_FOUND_EXIT);
      if (code !== PREVIEW_SIGN_IN_CODE && code !== PREVIEW_OTHER_ACCOUNT_CODE) return { ok: false, message: 'Invalid code', ...status() };
      waiting = false;
      profile = code === PREVIEW_OTHER_ACCOUNT_CODE ? OTHER_ACCOUNT : profileOf(host);
      expiresAt = until();
      return { ok: true, message: 'Login successful', ...status() };
    },
    authLogout: async () => {
      waiting = false;
      expiresAt = null;
      return { ok: true, message: 'Successfully logged out', ...status() };
    },
    signOut() {
      expiresAt = null;
    },
  };
}
