import type { IncomingMessage, Server } from 'node:http';

/**
 * The hub accepts only its https public origin and compares the `Origin` header with it on every mutating request
 * and WebSocket upgrade. The browser opens plain http on localhost, so its exact http origin is mapped to the https
 * one before Fastify sees the request. Nothing else is rewritten.
 */
export function installOriginShim(server: Server, origins: { http: string; https: string }): void {
  const rewrite = (request: IncomingMessage): void => {
    if (request.headers.origin === origins.http) request.headers.origin = origins.https;
  };
  server.prependListener('request', rewrite);
  server.prependListener('upgrade', rewrite);
}
