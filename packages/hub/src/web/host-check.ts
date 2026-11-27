import type { FastifyRequest } from 'fastify';
import type { HubConfig } from '../core/contracts.js';
import { allowedHostsOf } from '../config/defaults.js';

/** Whether a request's Host header names this hub (`allowedHosts`). */
export type HostCheck = (request: FastifyRequest) => boolean;

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };

/** `host` or `host:port`, lower-cased; a host without a port also matches its scheme's default port. */
function accepted(hosts: readonly string[], scheme: string): string[] {
  const port = DEFAULT_PORTS[scheme];
  return hosts
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '')
    .flatMap((host) => (port !== undefined && !/:\d+$/.test(host) ? [host, `${host}:${port}`] : [host]));
}

/**
 * The Host check, against DNS rebinding. It accepts exactly the listed hosts, never an address the
 * owner did not name:
 * - `hosts` given (the web server, wire/core.ts): those, read with publicOrigin's scheme. The default list is the
 *   `host[:port]` of publicOrigin, so `localhost:7410` and never `127.0.0.1:7410`;
 * - no `hosts` (the voice server, wire/domain.ts): the voiceOrigin host, plus the web server's allowed hosts.
 * A request without a Host header is refused.
 */
export function createHostCheck(config: HubConfig, hosts?: readonly string[]): HostCheck {
  const web = accepted(hosts ?? allowedHostsOf(config), new URL(config.publicOrigin).protocol);
  const voice = hosts === undefined && config.voiceOrigin !== undefined
    ? accepted([new URL(config.voiceOrigin).host], new URL(config.voiceOrigin).protocol)
    : [];
  const allowed: ReadonlySet<string> = new Set([...web, ...voice]);
  return (request) => {
    const value = request.headers.host;
    return typeof value === 'string' && allowed.has(value.trim().toLowerCase());
  };
}
