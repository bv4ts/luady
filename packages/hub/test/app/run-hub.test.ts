import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHub } from '../../src/main.js';
import { silentLogger } from '../helpers/fakes.js';

const { join } = posix;

let blocker: Server | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((resolve) => (blocker === null ? resolve() : blocker.close(() => resolve())));
  blocker = null;
});

/** A port another program already holds on 127.0.0.1. */
function takenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      blocker = server;
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

/** A home with config.json at the default path and a built website folder. */
function home(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'luady-runhub-'));
  const web = join(dir, 'web');
  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Hub</title>');
  mkdirSync(join(dir, '.config', 'luady'), { recursive: true });
  writeFileSync(join(dir, '.config', 'luady', 'config.json'), JSON.stringify({ webDir: web, ...config }));
  return dir;
}

describe('runHub when the start fails after the services started', () => {
  it('stops every service before it closes the database: the caller gets the one error, and no timer is left running', async () => {
    // The timers are faked: every service loop (sessions, sweeps, sign-in checks…) registers here and must be cleared.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const dir = home({ webPort: await takenPort() });
    await expect(runHub({ env: {}, home: dir, log: silentLogger(), listen: true })).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    // Were one left, its next run would read the closed database and crash the process instead.
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  });
});
