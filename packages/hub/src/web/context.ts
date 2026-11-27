import type { FastifyInstance } from 'fastify';
import type { PasskeyStore } from './auth/passkeys.js';
import type { SessionStore } from './auth/sessions.js';
import type { WebAuthnService } from './auth/webauthn.js';
import type { WebDeps } from './server.js';

/** Timings that tests shorten; production always uses DEFAULT_WEB_OPTIONS. */
export interface WebServerOptions {
  /** How often an open /ws connection re-checks its app session (without extending it). */
  wsSessionCheckMs: number;
  transcriptDebounceMs: number;
  transcriptPollMs: number;
  transcriptPageSize: number;
  terminalIdleMs: number;
  /** How long a socket has to send its `auth` first message, once the page-key rule is on. */
  wsAuthTimeoutMs: number;
}

export const DEFAULT_WEB_OPTIONS: WebServerOptions = {
  wsSessionCheckMs: 30_000,
  transcriptDebounceMs: 500,
  transcriptPollMs: 10_000,
  transcriptPageSize: 50,
  terminalIdleMs: 15 * 60_000,
  wsAuthTimeoutMs: 5_000,
};

export interface WebContext {
  deps: WebDeps;
  store: SessionStore;
  passkeys: PasskeyStore;
  webauthn: WebAuthnService;
  options: WebServerOptions;
}

/** A route module registers its routes (and any onClose hook) synchronously. */
export type RouteModule = (app: FastifyInstance, ctx: WebContext) => void;
