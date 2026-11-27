import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkStatus, RemoteExecutor } from '../../src/fleet/executor.js';
import { compileFixed } from '../../src/fleet/fixed-scripts.js';
import { ensureFleetKey } from '../../src/fleet/fleet-key.js';
import { createSshExecutor } from '../../src/fleet/ssh-executor.js';
import { silentLogger } from '../helpers/fakes.js';
import { startSshFixture, type SshFixture } from './ssh-server-fixture.js';

/** Fast back-off: without the stop, a refused key would be retried about ten times in the waits below. */
const FAST = { initialMs: 20, maxMs: 40, offlineAfter: 3 };
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let fixture: SshFixture;
let executor: RemoteExecutor | null = null;

function link(privateKeyPath: string, hostKeyFp: string = fixture.hostKeyFp): RemoteExecutor {
  executor = createSshExecutor({
    name: 'mars', host: '127.0.0.1', port: fixture.port, username: 'dev', hostKeyFp, privateKeyPath,
    ctlPath: '~/.luady/bin/luady-ctl', log: silentLogger(), policy: FAST,
  });
  return executor;
}

/** A key the fixture does not know: the server refuses it (the line was never pasted). */
const strangerKey = (): string => ensureFleetKey(join(mkdtempSync(join(tmpdir(), 'luady-stranger-')), 'fleet_ed25519')).path;

beforeEach(async () => {
  fixture = await startSshFixture();
});

afterEach(async () => {
  await executor?.close();
  executor = null;
  await fixture.close();
});

describe('a refused fleet key stops the retries', () => {
  it('after one auth failure the server sees no further attempts until resume()', async () => {
    const ssh = link(strangerKey());
    const statuses: LinkStatus[] = [];
    ssh.onStatus((status) => statuses.push(status));
    ssh.start();
    await vi.waitFor(() => expect(ssh.lastError?.()).toBe('auth'), { timeout: 5000 });
    const attempts = fixture.authAttempts;
    expect(attempts).toBeGreaterThan(0);
    await settle(400);
    expect(fixture.authAttempts).toBe(attempts);
    expect(ssh.status()).toBe('offline');
    expect(statuses.at(-1)).toBe('offline');

    ssh.resume?.();
    expect(ssh.lastError?.()).toBeNull();
    await vi.waitFor(() => expect(fixture.authAttempts).toBeGreaterThan(attempts), { timeout: 5000 });
    await vi.waitFor(() => expect(ssh.lastError?.()).toBe('auth'), { timeout: 5000 });
    const again = fixture.authAttempts;
    await settle(400);
    expect(fixture.authAttempts).toBe(again);
  });

  it('start() does not restart a stopped link; resume() with the key pasted connects', async () => {
    const ssh = link(strangerKey());
    ssh.start();
    await vi.waitFor(() => expect(ssh.lastError?.()).toBe('auth'), { timeout: 5000 });
    const attempts = fixture.authAttempts;
    ssh.start();
    await settle(200);
    expect(fixture.authAttempts).toBe(attempts);
    await ssh.close();

    const good = link(fixture.clientKeyPath);
    good.start();
    await vi.waitFor(() => expect(good.status()).toBe('online'), { timeout: 5000 });
    expect(good.lastError?.()).toBeNull();
  });

  it('a changed host key reads hostkey, never authenticates, and stops too', async () => {
    const ssh = link(fixture.clientKeyPath, `SHA256:${'Z'.repeat(43)}`);
    ssh.start();
    await vi.waitFor(() => expect(ssh.lastError?.()).toBe('hostkey'), { timeout: 5000 });
    expect(ssh.status()).toBe('offline');
    await settle(300);
    expect(fixture.authAttempts).toBe(0);
  });
});

describe('runFixed', () => {
  it('sends the compiled constant command and the payload bytes on stdin, and streams output', async () => {
    fixture.setExecHandler((call, channel) => {
      channel.stderr.write('progress\n');
      channel.write(`got ${call.stdin.length} bytes`);
      channel.exit(0);
      channel.end();
    });
    const ssh = link(fixture.clientKeyPath);
    ssh.start();
    await vi.waitFor(() => expect(ssh.status()).toBe('online'), { timeout: 5000 });
    const payload = Buffer.from([0x1f, 0x8b, 0, 1, 2, 3, 255]);
    const streamed: string[] = [];
    const result = await ssh.runFixed?.('kit', ['--uninstall'], {
      stdinBytes: payload, onStderr: (chunk) => streamed.push(chunk.toString('utf8')),
    });
    expect(result).toMatchObject({ code: 0, stdout: 'got 7 bytes' });
    expect(streamed.join('')).toBe('progress\n');
    expect(fixture.execs.at(-1)?.command).toBe(compileFixed('kit', ['--uninstall']));
    expect(fixture.execs.at(-1)?.stdin.equals(payload)).toBe(true);
  });

  it('bounds the time a script may take', async () => {
    fixture.setExecHandler(() => undefined);
    const ssh = link(fixture.clientKeyPath);
    ssh.start();
    await vi.waitFor(() => expect(ssh.status()).toBe('online'), { timeout: 5000 });
    await expect(ssh.runFixed?.('preflight', ['', ''], { timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
  });
});
