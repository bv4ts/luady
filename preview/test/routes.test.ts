import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { previewOrigins } from '../config.ts';
import { createPreviewFleet } from '../fake-fleet.ts';
import { createLoginTokens } from '../login-token.ts';
import { installOriginShim } from '../origin-shim.ts';
import { registerPreviewRoutes } from '../routes.ts';

const hubRequire = createRequire(new URL('../../packages/hub/package.json', import.meta.url));
const Fastify = hubRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = hubRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const ORIGINS = previewOrigins(7420);
const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

function send(port: number, headers: IncomingHttpHeaders): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, headers });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('installOriginShim', () => {
  async function shimmed(): Promise<number> {
    const server = createServer((req, res) => res.end(String(req.headers.origin)));
    server.on('upgrade', (req, socket) => {
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: test\r\nx-origin: ${req.headers.origin}\r\n\r\n`);
    });
    installOriginShim(server, ORIGINS);
    return listen(server);
  }

  it('turns the browser origin into the public origin before the handler runs', async () => {
    const port = await shimmed();
    expect((await send(port, { origin: ORIGINS.http })).body).toBe(ORIGINS.https);
    expect((await send(port, { origin: 'http://elsewhere.invalid' })).body).toBe('http://elsewhere.invalid');
  });

  it('does the same for WebSocket upgrades', async () => {
    const port = await shimmed();
    const upgrade = { connection: 'Upgrade', upgrade: 'test' };
    expect((await send(port, { ...upgrade, origin: ORIGINS.http })).headers['x-origin']).toBe(ORIGINS.https);
    expect((await send(port, { ...upgrade, origin: 'http://elsewhere.invalid' })).headers['x-origin']).toBe('http://elsewhere.invalid');
  });
});

describe('registerPreviewRoutes', () => {
  async function build(): Promise<{ app: FastifyInstance }> {
    const app = Fastify();
    await app.register(fastifyCookie, { secret: 'a'.repeat(64), hook: 'onRequest' });
    const run = async (scenario: string, args: readonly string[]): Promise<string> => {
      if (args[0] === 'bad') throw new Error('unknown session "bad". Known: cedar/one');
      return `${scenario} ran`;
    };
    registerPreviewRoutes(app, {
      fleet: createPreviewFleet({ clock: () => new Date() }), run, scenarios: ['work'], login: createLoginTokens(), pageKey: () => undefined,
    });
    await app.ready();
    closers.push(async () => {
      await app.close();
    });
    return { app };
  }

  it('runs a known scenario and refuses an unknown or failing one with 400', async () => {
    const { app } = await build();
    const ok = await app.inject({ method: 'POST', url: '/__preview/run', payload: { scenario: 'work', args: ['cedar/one'] } });
    expect(ok.json()).toEqual({ ok: true, result: 'work ran' });
    const unknown = await app.inject({ method: 'POST', url: '/__preview/run', payload: { scenario: 'nope' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ ok: false, error: expect.stringContaining('unknown scenario') });
    const failing = await app.inject({ method: 'POST', url: '/__preview/run', payload: { scenario: 'work', args: ['bad'] } });
    expect(failing.statusCode).toBe(400);
    expect(failing.json()).toMatchObject({ ok: false, error: expect.stringContaining('Known:') });
    const malformed = await app.inject({ method: 'POST', url: '/__preview/run', payload: { scenario: 'work', args: [1] } });
    expect(malformed.statusCode).toBe(400);
  });

  it('shows the panes per host and the scenario names', async () => {
    const { app } = await build();
    const state = (await app.inject({ method: 'GET', url: '/__preview/state' })).json();
    expect(Object.keys(state.hosts)).toEqual(['cedar', 'birch', 'ash', 'local', 'hq']);
    expect(state.scenarios).toEqual(['work']);
  });
});
