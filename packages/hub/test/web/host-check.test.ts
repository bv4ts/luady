import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { HubConfig } from '../../src/core/contracts.js';
import { createHostCheck } from '../../src/web/host-check.js';
import { harnessFactory } from './helpers.js';
import { listen, wsHeaders } from './ws-helpers.js';

const harness = harnessFactory();

const base = { publicOrigin: 'http://localhost:7410' } as HubConfig;

async function hostOf(check: ReturnType<typeof createHostCheck>, host: string | undefined): Promise<boolean> {
  const app = Fastify();
  app.get('/', async (request) => ({ ok: check(request) }));
  const res = await app.inject({ url: '/', headers: host === undefined ? {} : { host } });
  await app.close();
  return (res.json() as { ok: boolean }).ok;
}

describe('createHostCheck', () => {
  it('accepts exactly the host:port of publicOrigin by default, never the loopback address it listens on', async () => {
    const check = createHostCheck(base, ['localhost:7410']);
    expect(await hostOf(check, 'localhost:7410')).toBe(true);
    expect(await hostOf(check, 'LOCALHOST:7410')).toBe(true);
    expect(await hostOf(check, '127.0.0.1:7410')).toBe(false);
    expect(await hostOf(check, 'localhost:7411')).toBe(false);
    expect(await hostOf(check, 'localhost')).toBe(false);
    expect(await hostOf(check, 'evil.example')).toBe(false);
  });

  it('reads the allowed hosts from the config when none are passed, and a bare host also matches its default port', async () => {
    const https = { publicOrigin: 'https://hub.example', allowedHosts: ['hub.example'] } as HubConfig;
    const check = createHostCheck(https);
    expect(await hostOf(check, 'hub.example')).toBe(true);
    expect(await hostOf(check, 'hub.example:443')).toBe(true);
    expect(await hostOf(check, 'hub.example:80')).toBe(false);
    expect(await hostOf(check, 'other.example')).toBe(false);
  });

  it('for the voice server: the voiceOrigin host as well', async () => {
    const voice = { publicOrigin: 'https://hub.example', voiceOrigin: 'https://voice.example.com' } as HubConfig;
    const check = createHostCheck(voice);
    expect(await hostOf(check, 'voice.example.com')).toBe(true);
    expect(await hostOf(check, 'hub.example')).toBe(true);
    expect(await hostOf(check, 'elsewhere.example.com')).toBe(false);
  });
});

describe('the web server answers 421 for another Host', () => {
  const check = createHostCheck({ publicOrigin: 'https://luady.test.example' } as HubConfig, ['luady.test.example']);

  it('refuses a request for another host with 421 "Open <publicOrigin>", before the auth chain', async () => {
    const h = await harness({ hostCheck: check });
    const session = h.login();
    for (const host of ['127.0.0.1:7410', 'localhost', 'evil.example']) {
      const res = await h.app.inject({ url: '/api/overview', headers: { host, cookie: session.cookie, 'cf-access-jwt-assertion': h.token } });
      expect(res.statusCode).toBe(421);
      expect(res.body).toBe('Open https://luady.test.example');
      expect(res.headers['content-security-policy']).toBeDefined();
    }
    const page = await h.app.inject({ url: '/', headers: { host: '127.0.0.1:7410' } });
    expect(page.statusCode).toBe(421);
    const ok = await h.app.inject({ url: '/api/overview', headers: { host: 'luady.test.example', cookie: session.cookie, 'cf-access-jwt-assertion': h.token } });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses a WebSocket upgrade for another host with 421', async () => {
    const h = await harness({ hostCheck: check });
    const url = `${await listen(h)}/ws`;
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { ...wsHeaders(h, h.login()) } });
      ws.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      ws.once('open', () => reject(new Error('the upgrade went through')));
      ws.once('error', () => undefined);
    });
    expect(status).toBe(421);
  });
});
