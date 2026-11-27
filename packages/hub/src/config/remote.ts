import { isIP } from 'node:net';
import type { HubConfig } from '../core/contracts.js';
import { bindHostOf } from './defaults.js';

/** The host name a plain-http, non-remote install must use (an IP address is not a valid passkey RP ID). */
export const LOCAL_ORIGIN_HOST = 'localhost';

/** True for an IPv4 or IPv6 loopback address (127.0.0.0/8, ::1, and the IPv4-mapped ::ffff:127.x.y.z). */
export function isLoopbackAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  const mapped = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
  if (isIP(mapped) === 4) return mapped.split('.')[0] === '127';
  return value === '::1' || value === '0:0:0:0:0:0:0:1';
}

/** What the remote rule reads; `bindHost` and `allowedHosts` may be absent (then their defaults apply). */
export type RemoteInputs = Pick<HubConfig, 'publicOrigin'> & Partial<Pick<HubConfig, 'bindHost' | 'allowedHosts'>>;

/** The host name of an `allowedHosts` entry (`host`, `host:port`, `[v6]:port`), lower case; null when unreadable. */
function allowedHostName(entry: string): string | null {
  try {
    return new URL(`http://${entry.trim()}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Why the install counts as remote, or null when it is local. */
export function remoteReason(config: RemoteInputs): string | null {
  const bind = bindHostOf(config);
  if (!isLoopbackAddress(bind)) return `bindHost ${bind} is not a loopback address`;
  const host = new URL(config.publicOrigin).hostname;
  if (host !== LOCAL_ORIGIN_HOST) return 'the publicOrigin host is not localhost';
  // An extra allowed Host is a name the website answers to from elsewhere (a tunnel, a proxy): that is remote too.
  if ((config.allowedHosts ?? []).some((entry) => allowedHostName(entry) !== LOCAL_ORIGIN_HOST)) return 'an allowedHosts entry is not localhost';
  return null;
}

/**
 * "Remote", defined once: `bindHost` is not loopback, OR the `publicOrigin` host is not `localhost`, OR an
 * `allowedHosts` entry names a host other than `localhost`.
 */
export function isRemote(config: RemoteInputs): boolean {
  return remoteReason(config) !== null;
}

/** HSTS only for an https origin whose host is not localhost: HSTS on https://localhost would pin every local port. */
export function wantsHsts(publicOrigin: string): boolean {
  const url = new URL(publicOrigin);
  return url.protocol === 'https:' && url.hostname !== LOCAL_ORIGIN_HOST;
}
