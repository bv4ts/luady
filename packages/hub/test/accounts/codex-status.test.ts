import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_STATUS_TTL_MS, CODEX_STATUS_WAIT_MS, withCachedStatus } from '../../src/accounts/codex-status.js';
import type { CodexLogin } from '../../src/media/codex-login.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import { createFakeClock } from '../helpers/fakes.js';

type State = 'in' | 'out' | 'unknown';

/** A Codex login whose `status` answers when the test says so. */
function fakeCodex() {
  const pending: Array<{ resolve: (state: State) => void; reject: (err: Error) => void }> = [];
  let listeners: Array<(ok: boolean) => void> = [];
  const inner: CodexLogin = {
    begin: vi.fn(async () => 'text'),
    beginData: vi.fn(async () => ({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z', expiresAt: 'x' })),
    status: vi.fn(() => new Promise<State>((resolve, reject) => pending.push({ resolve, reject }))),
    logout: vi.fn(async () => true),
    onResult: (listener) => {
      listeners = [...listeners, listener];
      return () => undefined;
    },
  };
  return {
    inner, pending,
    answer: async (state: State) => {
      pending.shift()?.resolve(state);
      await vi.advanceTimersByTimeAsync(0);
    },
    finish: (ok: boolean) => listeners.forEach((listener) => listener(ok)),
  };
}

function setup() {
  const clock = createFakeClock('2026-11-14T10:00:00.000Z');
  const fake = fakeCodex();
  const capture = createCaptureLogger();
  const codex = withCachedStatus(fake.inner, { clock, log: capture.log });
  return { clock, fake, codex, lines: capture.lines };
}

/** Resolves when `promise` settles, moving the fake timers `ms` forward first. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Codex sign-in status cache', () => {
  it('keeps a result for 60 seconds: one check for every read in that time, and reads in flight share it', async () => {
    const t = setup();
    const first = t.codex.status();
    const second = t.codex.status();
    await t.fake.answer('in');
    expect(await first).toBe('in');
    expect(await second).toBe('in');
    t.clock.advance(CODEX_STATUS_TTL_MS - 1);
    expect(await t.codex.status()).toBe('in');
    expect(t.fake.inner.status).toHaveBeenCalledTimes(1);
  });

  it('an older result is answered at once while a check runs in the background', async () => {
    const t = setup();
    const first = t.codex.status();
    await t.fake.answer('in');
    await first;
    t.clock.advance(CODEX_STATUS_TTL_MS);
    expect(await t.codex.status()).toBe('in');
    expect(t.fake.inner.status).toHaveBeenCalledTimes(2);
    await t.fake.answer('out');
    expect(await t.codex.status()).toBe('out');
    expect(t.fake.inner.status).toHaveBeenCalledTimes(2);
  });

  it('a slow first check answers "unknown" after 1 second, and its result is kept when it comes', async () => {
    const t = setup();
    const read = t.codex.status();
    await vi.advanceTimersByTimeAsync(CODEX_STATUS_WAIT_MS - 1);
    let settled = false;
    void read.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(await within(read, 1)).toBe('unknown');
    await t.fake.answer('in');
    expect(await t.codex.status()).toBe('in');
    expect(t.fake.inner.status).toHaveBeenCalledTimes(1);
  });

  it('a failing check answers the last known state, logs it, and the next read tries again', async () => {
    const t = setup();
    const first = t.codex.status();
    await t.fake.answer('in');
    await first;
    t.clock.advance(CODEX_STATUS_TTL_MS);
    expect(await t.codex.status()).toBe('in');
    t.fake.pending.shift()?.reject(new Error('spawn codex ENOENT'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await t.codex.status()).toBe('in');
    expect(t.fake.inner.status).toHaveBeenCalledTimes(3);
    expect(t.lines.some((line) => line.includes('codex status check failed'))).toBe(true);
  });

  it('a failing first check answers "unknown"', async () => {
    const t = setup();
    const read = t.codex.status();
    t.fake.pending.shift()?.reject(new Error('boom'));
    expect(await within(read, 0)).toBe('unknown');
  });

  it('a sign-out drops the result at once: the next read checks again', async () => {
    const t = setup();
    const first = t.codex.status();
    await t.fake.answer('in');
    await first;
    expect(await t.codex.logout()).toBe(true);
    const after = t.codex.status();
    expect(t.fake.inner.status).toHaveBeenCalledTimes(2);
    await t.fake.answer('out');
    expect(await after).toBe('out');
  });

  it('a finished sign-in drops the result at once, and a check that started before it is not kept', async () => {
    const t = setup();
    const first = t.codex.status();
    await t.fake.answer('out');
    await first;
    t.clock.advance(CODEX_STATUS_TTL_MS);
    expect(await t.codex.status()).toBe('out');
    t.fake.finish(true);
    await t.fake.answer('out');
    const after = t.codex.status();
    expect(t.fake.inner.status).toHaveBeenCalledTimes(3);
    await t.fake.answer('in');
    expect(await after).toBe('in');
  });

  it('passes the sign-in itself through unchanged', async () => {
    const t = setup();
    await t.codex.beginData();
    await t.codex.begin();
    expect(t.fake.inner.beginData).toHaveBeenCalledTimes(1);
    expect(t.fake.inner.begin).toHaveBeenCalledTimes(1);
  });
});
