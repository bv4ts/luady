import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { isLoopbackAddress, isRemote, remoteReason, wantsHsts } from '../../src/config/remote.js';
import type { HubConfig } from '../../src/core/contracts.js';
import { loginLinkRefusal } from '../../src/web/auth/login-link.js';
import { sessionCookieOptions } from '../../src/web/auth/sessions.js';
import { registerSecurityHeaders } from '../../src/web/security-headers.js';
import { assertWebConfig } from '../../src/web/server.js';
import { harnessFactory } from './helpers.js';

const harness = harnessFactory();
const cfg = (over: Partial<HubConfig>): HubConfig => ({ publicOrigin: 'http://localhost:7410', bindHost: '127.0.0.1', ...over }) as HubConfig;

describe('"remote", defined once', () => {
  it('is false only for a loopback bind behind http(s)://localhost', () => {
    expect(isRemote(cfg({}))).toBe(false);
    expect(isRemote(cfg({ publicOrigin: 'https://localhost:7410' }))).toBe(false);
    expect(isRemote(cfg({ bindHost: '::1' }))).toBe(false);
    expect(isRemote(cfg({ bindHost: undefined }))).toBe(false);
  });

  it('bindHost 127.0.0.1 with publicOrigin https://hub.example counts as remote: a local tunnel is still remote', () => {
    expect(isRemote(cfg({ publicOrigin: 'https://hub.example' }))).toBe(true);
    expect(remoteReason(cfg({ publicOrigin: 'https://hub.example' }))).toMatch(/publicOrigin host is not localhost/);
  });

  it('a non-loopback bind is remote, whatever the origin; an IP origin is remote too', () => {
    expect(remoteReason(cfg({ bindHost: '0.0.0.0' }))).toMatch(/bindHost 0\.0\.0\.0/);
    expect(isRemote(cfg({ bindHost: '192.0.2.10' }))).toBe(true);
    expect(isRemote(cfg({ publicOrigin: 'http://127.0.0.1:7410' }))).toBe(true);
  });

  it('an allowedHosts entry whose host is not localhost makes it remote too', () => {
    expect(isRemote(cfg({ allowedHosts: ['localhost:7410'] }))).toBe(false);
    expect(isRemote(cfg({ allowedHosts: ['localhost:7410', 'LOCALHOST'] }))).toBe(false);
    expect(remoteReason(cfg({ allowedHosts: ['localhost:7410', 'hub.example'] }))).toMatch(/allowedHosts entry is not localhost/);
    expect(isRemote(cfg({ allowedHosts: ['127.0.0.1:7410'] }))).toBe(true);
    expect(isRemote(cfg({ allowedHosts: ['[::1]:7410'] }))).toBe(true);
    expect(isRemote(cfg({ allowedHosts: ['198.51.100.7'] }))).toBe(true);
  });

  it('knows the loopback addresses', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(address), address).toBe(true);
    for (const address of ['0.0.0.0', '192.0.2.1', '::', '::ffff:192.0.2.1', 'localhost', '']) expect(isLoopbackAddress(address), address).toBe(false);
  });
});

describe('the login link refusal', () => {
  async function refusalFor(config: HubConfig, headers: Record<string, string> = {}, remoteAddress = '127.0.0.1') {
    const app = Fastify();
    app.get('/x', async (request) => ({ refusal: loginLinkRefusal(config, request) }));
    const res = await app.inject({ url: '/x', headers, remoteAddress });
    await app.close();
    return (res.json() as { refusal: string | null }).refusal;
  }

  it('is refused on a remote install, even from loopback', async () => {
    expect(await refusalFor(cfg({ publicOrigin: 'https://hub.example' }))).toBe('remote');
  });

  it('is refused when any forwarding header is present', async () => {
    for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
      expect(await refusalFor(cfg({}), { [header]: '203.0.113.7' }), header).toBe('forwarded');
    }
  });

  it('is refused from a non-loopback peer, and allowed from loopback on a local install', async () => {
    expect(await refusalFor(cfg({}), {}, '192.0.2.50')).toBe('not-loopback');
    expect(await refusalFor(cfg({}))).toBeNull();
  });
});

describe('the web server on http://localhost', () => {
  const secret = 'e'.repeat(64);
  it('accepts http://localhost:<port> and any bare https origin, nothing else', () => {
    const base = { sessionSecret: secret } as HubConfig;
    expect(() => assertWebConfig({ ...base, publicOrigin: 'http://localhost:7410', rpId: 'localhost' })).not.toThrow();
    expect(() => assertWebConfig({ ...base, publicOrigin: 'https://hub.example', rpId: 'hub.example' })).not.toThrow();
    expect(() => assertWebConfig({ ...base, publicOrigin: 'http://127.0.0.1:7410', rpId: '127.0.0.1' })).toThrow(/http:\/\/localhost/);
    expect(() => assertWebConfig({ ...base, publicOrigin: 'http://hub.example', rpId: 'hub.example' })).toThrow(/http:\/\/localhost/);
  });

  it('sends HSTS only for an https origin whose host is not localhost', async () => {
    expect(wantsHsts('https://hub.example')).toBe(true);
    expect(wantsHsts('https://localhost:7410')).toBe(false);
    expect(wantsHsts('http://localhost:7410')).toBe(false);
    const app = Fastify();
    registerSecurityHeaders(app, { hsts: false });
    app.get('/page', async () => 'ok');
    const res = await app.inject('/page');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    await app.close();
  });

  it('a hub on http://localhost answers without HSTS and keeps the cookie Secure', async () => {
    const h = await harness();
    const local = await harness({ config: { ...h.deps.config, publicOrigin: 'http://localhost:7410', rpId: 'localhost' } });
    const page = await local.app.inject({ url: '/' });
    expect(page.headers['strict-transport-security']).toBeUndefined();
    const https = await h.app.inject({ url: '/' });
    expect(https.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(sessionCookieOptions()).toMatchObject({ secure: true, httpOnly: true, sameSite: 'strict' });
  });
});
