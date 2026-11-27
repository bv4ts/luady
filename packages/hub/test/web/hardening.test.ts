import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../src/web/errors.js';
import { API_RATE_LIMIT, AUTH_RATE_LIMIT, clientIp, rateGroup, registerRateLimits, type TrustedProxy } from '../../src/web/rate-limit.js';
import { CONTENT_SECURITY_POLICY, registerSecurityHeaders, SECURITY_HEADERS } from '../../src/web/security-headers.js';
import { silentLogger } from '../helpers/fakes.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function headersApp(): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  registerErrorHandler(app, silentLogger());
  registerSecurityHeaders(app);
  app.get('/page', async () => 'ok');
  app.get('/api/thing', async () => ({ ok: true }));
  await app.ready();
  return app;
}

async function limitedApp(trustedProxy: TrustedProxy = null): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  registerErrorHandler(app, silentLogger());
  await registerRateLimits(app, { trustedProxy });
  app.post('/api/auth/passkey/login/options', async () => ({ ok: true }));
  app.get('/api/things', async () => ({ ok: true }));
  app.get('/page', async () => 'ok');
  await app.ready();
  return app;
}

function login(app: FastifyInstance, ip: string, extra: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: '/api/auth/passkey/login/options', headers: { 'cf-connecting-ip': ip, ...extra } });
}

describe('security headers', () => {
  it('uses the exact CSP', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  it('pins HSTS, nosniff, no-referrer, X-Frame-Options, the cross-origin policies and a minimal Permissions-Policy', () => {
    expect(SECURITY_HEADERS).toEqual({
      'content-security-policy': CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'strict-transport-security': 'max-age=31536000',
      'x-frame-options': 'DENY',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
  });

  it('sets every header on pages, API responses and 404s', async () => {
    const app = await headersApp();
    for (const url of ['/page', '/api/thing', '/missing']) {
      const res = await app.inject(url);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        expect(res.headers[name]).toBe(value);
      }
    }
  });

  it('marks API responses Cache-Control: no-store', async () => {
    const app = await headersApp();
    expect((await app.inject('/api/thing')).headers['cache-control']).toBe('no-store');
    expect((await app.inject('/page')).headers['cache-control']).toBeUndefined();
  });

  it('marks percent-encoded API paths no-store too (the router decodes them)', async () => {
    const app = await headersApp();
    const routed = await app.inject('/%61pi/thing');
    expect(routed.statusCode).toBe(200);
    expect(routed.headers['cache-control']).toBe('no-store');
    expect((await app.inject('/%61pi/missing')).headers['cache-control']).toBe('no-store');
    expect((await app.inject('/%41PI/thing')).headers['cache-control']).toBeUndefined();
  });

  it('marks a route registered under /api no-store even when the raw URL differs from the pattern', async () => {
    const app = Fastify({ ignoreDuplicateSlashes: true });
    apps.push(app);
    registerSecurityHeaders(app);
    app.get('/api/thing', async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject('//api/thing');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('exports an immutable header map', () => {
    expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
  });
});

describe('rate limits', () => {
  it('allows 10 auth requests per minute per client, then answers 429 rate_limited', async () => {
    const app = await limitedApp();
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) {
      expect((await login(app, '203.0.113.7')).statusCode).toBe(200);
    }
    const blocked = await login(app, '203.0.113.7');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  // CF-Connecting-IP counts only with trustedProxy 'cloudflare' and a loopback peer (inject's default peer).
  it('keys on CF-Connecting-IP behind the local cloudflared, and ignores X-Forwarded-For', async () => {
    const app = await limitedApp('cloudflare');
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) {
      await login(app, '203.0.113.7', { 'x-forwarded-for': `198.51.100.${i}` });
    }
    expect((await login(app, '203.0.113.7', { 'x-forwarded-for': '198.51.100.99' })).statusCode).toBe(429);
    expect((await login(app, '203.0.113.8')).statusCode).toBe(200);
  });

  it('counts auth and other API requests separately', async () => {
    const app = await limitedApp();
    for (let i = 0; i <= AUTH_RATE_LIMIT; i += 1) await login(app, '203.0.113.7');
    const res = await app.inject({ url: '/api/things', headers: { 'cf-connecting-ip': '203.0.113.7' } });
    expect(res.statusCode).toBe(200);
  });

  it('allows 300 other API requests per minute', async () => {
    const app = await limitedApp();
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    for (let i = 0; i < API_RATE_LIMIT; i += 1) {
      expect((await app.inject({ url: '/api/things', headers })).statusCode).toBe(200);
    }
    expect((await app.inject({ url: '/api/things', headers })).statusCode).toBe(429);
  });

  it('does not limit non-API paths', async () => {
    const app = await limitedApp();
    for (let i = 0; i < API_RATE_LIMIT + 20; i += 1) {
      expect((await app.inject('/page')).statusCode).toBe(200);
    }
  });

  it('counts a percent-encoded auth path in the auth bucket', async () => {
    const app = await limitedApp();
    const encoded = () =>
      app.inject({ method: 'POST', url: '/%61pi/auth/passkey/login/options', headers: { 'cf-connecting-ip': '203.0.113.20' } });
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) expect((await encoded()).statusCode).toBe(200);
    expect((await encoded()).statusCode).toBe(429);
    expect((await login(app, '203.0.113.20')).statusCode).toBe(429);
  });

  it('groups by the matched route pattern', () => {
    expect(rateGroup('/api/auth/passkey/login/options')).toBe('auth');
    expect(rateGroup('/api/auth/passkeys')).toBe('auth');
    expect(rateGroup('/api/auth/passkeys/:id/delete')).toBe('auth');
    expect(rateGroup('/api/sessions/:id/send')).toBe('api');
    expect(rateGroup('/*')).toBe('none');
    expect(rateGroup('/ws')).toBe('none');
    expect(rateGroup(undefined)).toBe('none');
  });
});

describe('clientIp', () => {
  async function ipApp(trustedProxy: TrustedProxy): Promise<FastifyInstance> {
    const app = Fastify();
    apps.push(app);
    app.get('/ip', async (request) => clientIp(request, trustedProxy));
    await app.ready();
    return app;
  }

  async function ipFor(headers: Record<string, string>, remoteAddress = '192.0.2.50', trustedProxy: TrustedProxy = 'cloudflare'): Promise<string> {
    const app = await ipApp(trustedProxy);
    return (await app.inject({ url: '/ip', headers, remoteAddress })).body;
  }

  // CF-Connecting-IP is preferred over the socket address, but only from a loopback peer (cloudflared).
  it('prefers CF-Connecting-IP over the socket address when the peer is the local cloudflared', async () => {
    expect(await ipFor({ 'cf-connecting-ip': '203.0.113.7' }, '127.0.0.1')).toBe('203.0.113.7');
    expect(await ipFor({ 'cf-connecting-ip': '203.0.113.7' }, '::1')).toBe('203.0.113.7');
  });

  it('ignores a spoofed CF-Connecting-IP from a non-loopback peer, and any CF-Connecting-IP without a trusted proxy', async () => {
    expect(await ipFor({ 'cf-connecting-ip': '203.0.113.7' })).toBe('192.0.2.50');
    expect(await ipFor({ 'cf-connecting-ip': '203.0.113.7' }, '127.0.0.1', null)).toBe('127.0.0.1');
  });

  it('falls back to the socket address, ignoring X-Forwarded-For', async () => {
    expect(await ipFor({ 'x-forwarded-for': '198.51.100.1' })).toBe('192.0.2.50');
    expect(await ipFor({ 'x-forwarded-for': '198.51.100.1' }, '127.0.0.1')).toBe('127.0.0.1');
  });

  // The same fallbacks, from the loopback peer that is allowed to send the header: 64 characters that are no IP
  // address fall back too.
  it('falls back to the socket address for an empty or oversized CF-Connecting-IP', async () => {
    expect(await ipFor({ 'cf-connecting-ip': '' }, '127.0.0.1')).toBe('127.0.0.1');
    expect(await ipFor({ 'cf-connecting-ip': 'a'.repeat(65) }, '127.0.0.1')).toBe('127.0.0.1');
    expect(await ipFor({ 'cf-connecting-ip': 'a'.repeat(64) }, '127.0.0.1')).toBe('127.0.0.1');
  });

  it('believes CF-Connecting-IP only when it is an IP address', async () => {
    expect(await ipFor({ 'cf-connecting-ip': '2001:db8::7' }, '127.0.0.1')).toBe('2001:db8::7');
    for (const value of ['not-an-ip', '203.0.113.7, 198.51.100.1', '203.0.113.256', ' 203.0.113.7']) {
      expect(await ipFor({ 'cf-connecting-ip': value }, '127.0.0.1'), value).toBe('127.0.0.1');
    }
  });
});
