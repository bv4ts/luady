import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_KEY_HEADER } from '@luady/shared';
import type { App } from '../../src/app.js';
import { FIXTURE_PIN } from '../helpers/claimed.js';
import { TEST_CHAT_ID, openTestChat, testChatDecl } from '../helpers/chat-addon.js';
import { startWiring, wiringConfig, type WiringRun } from '../wire/wiring-harness.js';

/** `GET /api/channels` and `POST /api/channels/:id/action`, the PIN when the panel block says so. */
const PIN = '246810';
const OWNER = '447700900001';
let running: App | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

async function hubWithPanel(): Promise<{ run: WiringRun; frames: Array<Record<string, unknown>>; csrf: string }> {
  const run = await startWiring({}, wiringConfig({ addons: [testChatDecl(OWNER)] }), false);
  running = run.app;
  // The wiring harness hands over a set-up install; this suite's own PIN replaces the fixture's.
  await run.app.services.pin.set(PIN, { currentPin: FIXTURE_PIN });
  const chat = await openTestChat(run.app, run.config.dataDir, {
    capabilities: {
      text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
      replyQuote: false, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
    },
    hello: { panel: { title: 'Link', blocks: [
      { type: 'text', text: '<b>not html</b>' },
      { type: 'button', label: 'Refresh', action: 'refresh' },
      { type: 'button', label: 'Unlink', action: 'unlink', pin: true, danger: true },
      { type: 'input', id: 'code', label: 'Code', action: 'code' },
    ] } },
  });
  const me = await run.app.web.inject({ method: 'GET', url: '/api/me', headers: headers(run) });
  return { run, frames: chat.frames, csrf: me.json<{ csrf: string }>().csrf };
}

function headers(run: WiringRun, csrf?: string): Record<string, string> {
  return {
    host: new URL(run.config.publicOrigin).host, origin: run.config.publicOrigin, 'cf-access-jwt-assertion': 'test-jwt', cookie: run.cookie,
    [PAGE_KEY_HEADER]: run.pageKey, ...(csrf === undefined ? {} : { 'x-hub-csrf': csrf, 'content-type': 'application/json' }),
  };
}

describe('the channel routes', () => {
  it('lists the channel as data, its panel strings untouched', async () => {
    const { run } = await hubWithPanel();
    const res = await run.app.web.inject({ method: 'GET', url: '/api/channels', headers: headers(run) });
    expect(res.json()).toEqual([expect.objectContaining({ state: 'up', panel: expect.objectContaining({ title: 'Link' }) })]);
    expect(res.body).toContain('<b>not html</b>');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });

  it('sends an action on the panel; refuses one that is not; a PIN block needs the right PIN', async () => {
    const { run, frames, csrf } = await hubWithPanel();
    const act = (body: object) => run.app.web.inject({
      method: 'POST', url: `/api/channels/${TEST_CHAT_ID}/action`, headers: headers(run, csrf), payload: body,
    });
    expect((await act({ action: 'refresh' })).statusCode).toBe(200);
    expect((await act({ action: 'code', value: 'ABC-123' })).statusCode).toBe(200);
    expect((await act({ action: 'rm-rf' })).statusCode).toBe(404);
    expect((await act({ action: 'unlink' })).statusCode).toBe(428);
    expect((await act({ action: 'unlink', pin: '000000' })).statusCode).toBe(403);
    expect((await act({ action: 'unlink', pin: PIN })).statusCode).toBe(200);
    await vi.waitFor(() => expect(frames.filter((f) => f.t === 'ui.action')).toHaveLength(3));
    expect(frames.filter((f) => f.t === 'ui.action')).toEqual([
      { t: 'ui.action', action: 'refresh', value: null },
      { t: 'ui.action', action: 'code', value: 'ABC-123' },
      { t: 'ui.action', action: 'unlink', value: null },
    ]);
    const noCsrf = await run.app.web.inject({ method: 'POST', url: `/api/channels/${TEST_CHAT_ID}/action`, headers: { ...headers(run), 'content-type': 'application/json' }, payload: { action: 'refresh' } });
    expect(noCsrf.statusCode).toBe(403);
  });
});
