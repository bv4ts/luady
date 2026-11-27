import { isIP } from 'node:net';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isLoopbackAddress } from '../config/remote.js';
import { RateLimitedError } from './errors.js';

export const AUTH_RATE_LIMIT = 10;
export const API_RATE_LIMIT = 300;
export const RATE_WINDOW_MS = 60_000;
/** The login link: the only route besides /api/auth/* in the auth bucket. */
export const SETUP_LOGIN_ROUTE = '/api/setup/login';
const CF_IP_MAX = 64;

export type RateGroup = 'auth' | 'api' | 'none';
/** `cloudflare`: CF-Connecting-IP is trusted, from a loopback peer only (cloudflared runs on this machine). */
export type TrustedProxy = 'cloudflare' | null;

/**
 * Grouped by the matched route pattern, so percent-encoded URLs cannot dodge the auth bucket. The auth bucket holds
 * /api/auth/* and the login link only; `/api/setup/state`, fetched before every wizard page, is an ordinary API call.
 */
export function rateGroup(routeUrl: string | undefined): RateGroup {
  if (routeUrl === undefined) return 'none';
  if (routeUrl.startsWith('/api/auth/') || routeUrl === SETUP_LOGIN_ROUTE) return 'auth';
  return routeUrl === '/api' || routeUrl.startsWith('/api/') ? 'api' : 'none';
}

/**
 * The client address a bucket is keyed on. trustProxy is off, so it is the TCP peer, except that with
 * `trustedProxy: 'cloudflare'` a CF-Connecting-IP header is believed when, and only when, the peer is loopback: a
 * direct connection can never choose its own bucket. Only an IP address counts: anything else falls back to the
 * peer. Without a trusted proxy the header is ignored.
 */
export function clientIp(request: FastifyRequest, trustedProxy: TrustedProxy = null): string {
  const peer = request.socket.remoteAddress ?? request.ip;
  if (trustedProxy !== 'cloudflare' || !isLoopbackAddress(peer)) return request.ip;
  const header = request.headers['cf-connecting-ip'];
  return typeof header === 'string' && header.length <= CF_IP_MAX && isIP(header) !== 0 ? header : request.ip;
}

function groupOf(request: FastifyRequest): RateGroup {
  return rateGroup(request.routeOptions.url);
}

export interface RateLimitOptions {
  readonly trustedProxy?: TrustedProxy;
}

export async function registerRateLimits(app: FastifyInstance, options: RateLimitOptions = {}): Promise<void> {
  const trustedProxy = options.trustedProxy ?? null;
  await app.register(fastifyRateLimit, {
    global: true,
    timeWindow: RATE_WINDOW_MS,
    max: (request) => (groupOf(request) === 'auth' ? AUTH_RATE_LIMIT : API_RATE_LIMIT),
    keyGenerator: (request) => `${groupOf(request)}|${clientIp(request, trustedProxy)}`,
    allowList: (request) => groupOf(request) === 'none',
    errorResponseBuilder: (_request, context) => new RateLimitedError(context.after),
  });
}
