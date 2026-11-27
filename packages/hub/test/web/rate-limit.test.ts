import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../src/web/errors.js';
import { AUTH_RATE_LIMIT, rateGroup, registerRateLimits, type TrustedProxy } from '../../src/web/rate-limit.js';
import { silentLogger } from '../helpers/fakes.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function app(trustedProxy: TrustedProxy): Promise<FastifyInstance> {
  const server = Fastify();
  apps.push(server);
  registerErrorHandler(server, silentLogger());
  await registerRateLimits(server, { trustedProxy });
  server.get('/api/setup/state', async () => ({ step: 'claim' }));
  server.post('/api/setup/login', async () => ({ ok: true }));
  server.post('/api/auth/passkey/login/options', async () => ({ ok: true }));
  await server.ready();
  return server;
}

const login = (server: FastifyInstance, remoteAddress: string, headers: Record<string, string> = {}) =>
  server.inject({ method: 'POST', url: '/api/auth/passkey/login/options', remoteAddress, headers });

describe('rate limits', () => {
  it('puts /api/auth/* and the login link in the auth bucket, and the setup state in the api bucket', () => {
    expect(rateGroup('/api/setup/login')).toBe('auth');
    expect(rateGroup('/api/auth/passkey/login/options')).toBe('auth');
    expect(rateGroup('/api/setup/state')).toBe('api');
    expect(rateGroup('/api/setup/step')).toBe('api');
  });

  it('30 calls to /api/setup/state pass and do not consume the auth bucket', async () => {
    const server = await app(null);
    for (let i = 0; i < 30; i += 1) expect((await server.inject({ url: '/api/setup/state' })).statusCode).toBe(200);
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) expect((await login(server, '127.0.0.1')).statusCode).toBe(200);
    expect((await login(server, '127.0.0.1')).statusCode).toBe(429);
  });

  it('counts the login link with the passkey routes: 10 a minute per client together', async () => {
    const server = await app(null);
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) expect((await server.inject({ method: 'POST', url: '/api/setup/login' })).statusCode).toBe(200);
    expect((await login(server, '127.0.0.1')).statusCode).toBe(429);
  });

  it('ignores a spoofed CF-Connecting-IP from a non-loopback peer: it cannot pick a fresh bucket', async () => {
    const server = await app('cloudflare');
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) {
      expect((await login(server, '192.0.2.50', { 'cf-connecting-ip': `203.0.113.${i}` })).statusCode).toBe(200);
    }
    expect((await login(server, '192.0.2.50', { 'cf-connecting-ip': '203.0.113.99' })).statusCode).toBe(429);
  });

  it('believes CF-Connecting-IP from the local cloudflared (a loopback peer) with trustedProxy cloudflare only', async () => {
    const trusted = await app('cloudflare');
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) await login(trusted, '127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' });
    expect((await login(trusted, '127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })).statusCode).toBe(429);
    expect((await login(trusted, '127.0.0.1', { 'cf-connecting-ip': '203.0.113.8' })).statusCode).toBe(200);
    const plain = await app(null);
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) await login(plain, '127.0.0.1', { 'cf-connecting-ip': `203.0.113.${i}` });
    expect((await login(plain, '127.0.0.1', { 'cf-connecting-ip': '203.0.113.99' })).statusCode).toBe(429);
  });
});
