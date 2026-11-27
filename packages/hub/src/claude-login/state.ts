import { z } from 'zod';
import type { CtlAuthStatus, HostId } from '@luady/shared';
import type { Db } from '../core/contracts.js';

/**
 * What the sign-in service must remember across restarts, kept as rows of the `settings` table under keys the settings
 * service does not know (it ignores them, and so does a rolled-back release).
 */
/** The settings-key prefix of each host's last-seen account: `login.identity.<host id>`. */
export const IDENTITY_KEY_PREFIX = 'login.identity.';
const IDENTITY_KEY = (host: HostId): string => `${IDENTITY_KEY_PREFIX}${host}`;
export const BRAIN_OUT_KEY = 'login.brain_signed_out';

/** The account a host was last seen signed in to. */
export interface AccountIdentity {
  readonly orgId: string | null;
  readonly email: string | null;
  readonly orgName: string | null;
  readonly plan: string | null;
}

const IdentitySchema = z.object({
  orgId: z.string().nullable(), email: z.string().nullable(), orgName: z.string().nullable(), plan: z.string().nullable(),
});

export interface LoginState {
  identity(host: HostId): AccountIdentity | null;
  setIdentity(host: HostId, identity: AccountIdentity): void;
  /** Luady's own sign-in was out when last seen: what is meant for the brain stays queued, also over a restart. */
  brainSignedOut(): boolean;
  setBrainSignedOut(out: boolean): void;
}

export function identityOf(status: CtlAuthStatus): AccountIdentity {
  return { orgId: status.org_id ?? null, email: status.email, orgName: status.org_name ?? null, plan: status.plan ?? null };
}

/**
 * Two readings are the same account when their organisations match; a kit that reports no organisation (kit 1, or
 * before an upgrade) is compared by e-mail; with neither on one side nothing can be told, so it is not a move.
 */
export function sameAccount(a: AccountIdentity, b: AccountIdentity): boolean {
  if (a.orgId !== null && b.orgId !== null) return a.orgId === b.orgId;
  if (a.email !== null && b.email !== null) return a.email.toLowerCase() === b.email.toLowerCase();
  return true;
}

function parseIdentity(json: string | undefined): AccountIdentity | null {
  if (json === undefined) return null;
  try {
    const parsed = IdentitySchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createLoginState(db: Db): LoginState {
  const read = db.prepare<[string], { value_json: string }>('SELECT value_json FROM settings WHERE key = ?');
  const write = db.prepare<[string, string]>(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  );
  return {
    identity: (host) => parseIdentity(read.get(IDENTITY_KEY(host))?.value_json),
    setIdentity(host, identity) {
      write.run(IDENTITY_KEY(host), JSON.stringify(identity));
    },
    brainSignedOut: () => read.get(BRAIN_OUT_KEY)?.value_json === 'true',
    setBrainSignedOut(out) {
      write.run(BRAIN_OUT_KEY, out ? 'true' : 'false');
    },
  };
}
