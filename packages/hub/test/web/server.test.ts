import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WEB_OPTIONS } from '../../src/web/context.js';
import { CONTENT_SECURITY_POLICY } from '../../src/web/security-headers.js';
import { buildWebServer, createWebServer } from '../../src/web/server.js';
import { APP_JS, call, harnessFactory, INDEX_HTML, PUBLIC_ORIGIN } from './helpers.js';

const harness = harnessFactory();

describe('static SPA', () => {
  it('serves index.html at / and assets by path', async () => {
    const h = await harness();
    const index = await call(h, 'GET', '/');
    expect(index.statusCode).toBe(200);
    expect(index.body).toBe(INDEX_HTML);
    const asset = await call(h, 'GET', '/assets/app.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe(APP_JS);
    expect(String(asset.headers['content-type'])).toContain('javascript');
  });

  it('falls back to index.html for client-side routes', async () => {
    const h = await harness();
    for (const url of ['/sessions/abc', '/settings', '/manager?tab=memory']) {
      const res = await call(h, 'GET', url);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(INDEX_HTML);
    }
  });

  it('answers unknown /api paths with JSON: 401 without a session, 404 with one', async () => {
    const h = await harness();
    expect((await call(h, 'GET', '/api/nope')).statusCode).toBe(401);
    const res = await call(h, 'GET', '/api/nope', undefined, { session: h.login() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('never falls back to index.html under /ws', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/ws/nope', undefined, { session: h.login(), origin: PUBLIC_ORIGIN });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<title>Luady</title>');
  });

  it('caches hashed /assets/* files for a year as immutable', async () => {
    const h = await harness();
    writeFileSync(join(h.dirs.webDir, 'assets', 'index-B4x9Qe1z.js'), 'export {};');
    writeFileSync(join(h.dirs.webDir, 'assets', 'index-C2kd81Lm.css'), 'body{}');
    for (const url of ['/assets/app.js', '/assets/index-B4x9Qe1z.js', '/assets/index-C2kd81Lm.css']) {
      const res = await call(h, 'GET', url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    }
  });

  it('never marks index.html, client routes or other root files immutable', async () => {
    const h = await harness();
    writeFileSync(join(h.dirs.webDir, 'manifest.webmanifest'), '{}');
    mkdirSync(join(h.dirs.webDir, 'not-assets'), { recursive: true });
    writeFileSync(join(h.dirs.webDir, 'not-assets', 'x.js'), 'export {};');
    for (const url of ['/', '/index.html', '/inbox', '/sessions/abc', '/manifest.webmanifest', '/not-assets/x.js']) {
      const res = await call(h, 'GET', url);
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['cache-control'] ?? '')).not.toContain('immutable');
    }
    const api = await call(h, 'GET', '/api/me');
    expect(api.headers['cache-control']).toBe('no-store');
  });

  it('requires the Access JWT for static files and accepts the CF_Authorization cookie', async () => {
    const h = await harness();
    const denied = await call(h, 'GET', '/', undefined, { token: null });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: { code: 'forbidden', message: 'Cloudflare Access token missing or invalid' } });
    const viaCookie = await call(h, 'GET', '/', undefined, { token: null, headers: { cookie: `CF_Authorization=${h.token}` } });
    expect(viaCookie.statusCode).toBe(200);
  });
});

describe('composition', () => {
  it('sets the security headers on static, API and error responses', async () => {
    const h = await harness();
    for (const url of ['/', '/api/me', '/api/nope']) {
      const res = await call(h, 'GET', url);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000');
    }
  });

  it('createWebServer returns a working instance that is not listening', async () => {
    const h = await harness();
    const app = await createWebServer(h.deps);
    try {
      expect(app.server.listening).toBe(false);
      const res = await app.inject({ method: 'GET', url: '/', headers: { 'cf-access-jwt-assertion': h.token } });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('refuses a short session secret or a non-https public origin', async () => {
    const h = await harness();
    await expect(
      buildWebServer({ ...h.deps, config: { ...h.deps.config, sessionSecret: 'short' } }, DEFAULT_WEB_OPTIONS),
    ).rejects.toThrow(/sessionSecret/);
    await expect(
      buildWebServer({ ...h.deps, config: { ...h.deps.config, publicOrigin: 'http://luady.test.example' } }, DEFAULT_WEB_OPTIONS),
    ).rejects.toThrow(/publicOrigin/);
  });
});
