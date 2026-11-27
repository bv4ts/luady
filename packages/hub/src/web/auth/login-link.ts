import type { FastifyRequest } from 'fastify';
import type { HubConfig } from '../../core/contracts.js';
import { isLoopbackAddress, isRemote } from '../../config/remote.js';

/**
 * Any of these on a request means a proxy, a tunnel or a CDN sits in between: the login link is then refused. Every
 * `x-forwarded-*` header counts as well (FORWARDED_PREFIX).
 */
export const FORWARDING_HEADERS = [
  'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'x-client-ip', 'cf-connecting-ip', 'true-client-ip', 'fly-client-ip',
] as const;
export const FORWARDED_PREFIX = 'x-forwarded-';

export type LoginLinkRefusal = 'remote' | 'forwarded' | 'not-loopback';

/** Whether a request carries any header a proxy adds (Node gives header names in lower case). */
export function hasForwardingHeader(headers: FastifyRequest['headers']): boolean {
  return Object.keys(headers).some((name) => name.startsWith(FORWARDED_PREFIX) || (FORWARDING_HEADERS as readonly string[]).includes(name));
}

/**
 * Why a passkey-less sign-in (the login link, the passkey skip) must be refused on this request, or null when it may go
 * on: never on a remote install, never through a proxy (any forwarding header), and only from a loopback TCP peer. The
 * token and the PIN are checked by the caller after this.
 */
export function loginLinkRefusal(config: Pick<HubConfig, 'publicOrigin'> & Partial<Pick<HubConfig, 'bindHost'>>, request: FastifyRequest): LoginLinkRefusal | null {
  if (isRemote(config)) return 'remote';
  if (hasForwardingHeader(request.headers)) return 'forwarded';
  const peer = request.socket.remoteAddress ?? request.ip;
  return isLoopbackAddress(peer) ? null : 'not-loopback';
}
