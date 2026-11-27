/**
 * The seven startup refusals. Each one stops the hub with a single plain line that says what is wrong
 * and how to fix it, and never carries a secret value.
 */
export const REFUSALS = [
  'remote-not-allowed',
  'remote-not-https',
  'remote-no-passkey',
  'access-incomplete',
  'host-ids',
  'secrets-mismatch',
  'foreign-owner',
] as const;
export type Refusal = (typeof REFUSALS)[number];

export class StartupRefusal extends Error {
  constructor(public readonly refusal: Refusal, message: string) {
    super(message);
    this.name = 'StartupRefusal';
  }
}

/** The install is remote and `allowRemote` is not set. */
export function remoteNotAllowed(reason: string): StartupRefusal {
  return new StartupRefusal('remote-not-allowed',
    `Refusing to start: this install counts as remote (${reason}). Set "allowRemote": true in config.json only behind https and a passkey, or use http://localhost with an SSH tunnel.`);
}

/** The install is remote and `publicOrigin` is not https. */
export function remoteNotHttps(): StartupRefusal {
  return new StartupRefusal('remote-not-https',
    'Refusing to start: a remote install needs an https publicOrigin; http is accepted only for http://localhost:<port>.');
}

/** The install is remote, in local mode, and has no passkey yet. */
export function remoteNoPasskey(): StartupRefusal {
  return new StartupRefusal('remote-no-passkey',
    'Refusing to start: a remote install needs at least one passkey. Claim the hub on http://localhost (an SSH tunnel works) before making it remote.');
}

/** `cloudflare-access` mode without its three values. */
export function accessIncomplete(missing: readonly string[]): StartupRefusal {
  return new StartupRefusal('access-incomplete',
    `Refusing to start: "authMode": "cloudflare-access" needs ${missing.join(', ')} (config.json: cfTeamDomain, ownerEmail; secrets.env: CF_ACCESS_AUD).`);
}

/** Two hosts share an id, or a host uses a reserved id. */
export function hostIds(detail: string): StartupRefusal {
  return new StartupRefusal('host-ids', `Refusing to start: ${detail} in config.json "servers".`);
}

/** The session secret does not open the sealed rows. */
export function secretsMismatch(): StartupRefusal {
  return new StartupRefusal('secrets-mismatch',
    'Refusing to start: this secrets file does not belong to this database (SESSION_SECRET cannot open its sealed tokens). Point LUADY_SECRETS at the right file.');
}

/** A folder or file the hub owns belongs to another Unix user. */
export function foreignOwner(path: string): StartupRefusal {
  return new StartupRefusal('foreign-owner',
    `Refusing to start: ${path} belongs to another Unix user. Run the hub as the user that owns its folders (one Unix user per machine).`);
}

/** A file the hub reads (config.json, the folder of the secrets) that other users can write (also `foreign-owner`). */
export function writableByOthers(path: string): StartupRefusal {
  return new StartupRefusal('foreign-owner',
    `Refusing to start: ${path} belongs to another Unix user and others can write it. Keep the config and the secrets where only you (or root) can write.`);
}

/** A file the hub reads that belongs to a Unix user other than the hub's or root: that user can change it (also `foreign-owner`). */
export function guardedForeignOwner(path: string): StartupRefusal {
  return new StartupRefusal('foreign-owner',
    `Refusing to start: ${path} belongs to another Unix user, who can change it. Keep the config and the secrets owned by you (or root).`);
}
