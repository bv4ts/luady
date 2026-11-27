import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { shQuote } from '../../src/core/ids.js';
import { buildCommandLine } from '../../src/fleet/command-line.js';
import type { LinkStatus, RemoteExecutor } from '../../src/fleet/executor.js';
import { createSshExecutor } from '../../src/fleet/ssh-executor.js';
import { silentLogger } from '../helpers/fakes.js';
import { startSshFixture, type SshFixture } from './ssh-server-fixture.js';

const CTL = '~/.luady/bin/luady-ctl';
const FAST = { initialMs: 20, maxMs: 40, offlineAfter: 3 };
const NASTY = 'مرحبا 👋\nline two "double" \'single\' $(whoami) `id` \\ end';
const GITHUB_FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';

let fixture: SshFixture;
let executor: RemoteExecutor | null = null;

function connect(hostKeyFp: string = fixture.hostKeyFp): RemoteExecutor {
  executor = createSshExecutor({
    name: 'cedar',
    host: '127.0.0.1',
    port: fixture.port,
    username: 'dev',
    hostKeyFp,
    privateKeyPath: fixture.clientKeyPath,
    ctlPath: CTL,
    log: silentLogger(),
    policy: FAST,
  });
  executor.start();
  return executor;
}

async function online(): Promise<RemoteExecutor> {
  const connected = connect();
  await vi.waitFor(() => expect(connected.status()).toBe('online'), { timeout: 5000 });
  return connected;
}

beforeEach(async () => {
  fixture = await startSshFixture();
});

afterEach(async () => {
  await executor?.close();
  executor = null;
  await fixture.close();
});

describe('createSshExecutor', () => {
  it('runs luady-ctl with quoted args and passes free text only on stdin', async () => {
    fixture.setExecHandler((call, channel) => {
      channel.write(call.stdin);
      channel.exit(0);
      channel.end();
    });
    const ssh = await online();
    const result = await ssh.exec(['send', '--target', 'cc-x:0.0'], { stdin: NASTY });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(NASTY);
    const call = fixture.execs[0];
    expect(call?.command).toBe(buildCommandLine(CTL, ['send', '--target', 'cc-x:0.0']));
    expect(call?.command).not.toContain('whoami');
    expect(call?.stdin.equals(Buffer.from(NASTY, 'utf8'))).toBe(true);
  });

  it('returns exit codes and stderr', async () => {
    const reply = '{"error":{"code":"refused","message":"no"}}';
    fixture.setExecHandler((_call, channel) => {
      channel.stderr.write('boom');
      channel.write(reply);
      channel.exit(3);
      channel.end();
    });
    const result = await (await online()).exec(['send', '--target', 'cc-x:0.0'], { stdin: 'hi' });
    expect(result).toEqual({ code: 3, stdout: reply, stderr: 'boom', truncated: false });
  });

  it('caps output and flags truncation', async () => {
    fixture.setExecHandler((_call, channel) => {
      channel.write(Buffer.alloc(200_000, 0x78));
      channel.exit(0);
      channel.end();
    });
    const result = await (await online()).exec(['version'], { maxOutputBytes: 1000 });
    expect(result.stdout).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('streams output until the remote side closes', async () => {
    fixture.setExecHandler((_call, channel) => {
      channel.write('a\n');
      setTimeout(() => {
        channel.write('b\n');
        channel.exit(0);
        channel.end();
      }, 20);
    });
    const chunks: string[] = [];
    const handle = (await online()).execStream(['tail-events', '--from', 'end'], (chunk) => chunks.push(chunk.toString('utf8')));
    await handle.done;
    expect(chunks.join('')).toBe('a\nb\n');
    expect(fixture.execs[0]?.command).toBe(buildCommandLine(CTL, ['tail-events', '--from', 'end']));
  });

  it('stop() ends a stream that never finishes', async () => {
    fixture.setExecHandler((_call, channel) => {
      channel.write('tick\n');
    });
    const handle = (await online()).execStream(['tail-events', '--from', 'end'], () => undefined);
    await vi.waitFor(() => expect(fixture.execs).toHaveLength(1), { timeout: 5000 });
    handle.stop();
    await handle.done;
  });

  it('opens a shell with the requested size, resizes it and reports the exit code', async () => {
    const shell = await (await online()).shell({ cols: 100, rows: 30 });
    const output: string[] = [];
    shell.onData((data) => output.push(data));
    const exited = new Promise<number | null>((resolve) => shell.onExit(resolve));
    await vi.waitFor(() => expect(output.join('')).toContain('ready'), { timeout: 5000 });
    shell.write('héllo');
    await vi.waitFor(() => expect(output.join('')).toContain('héllo'), { timeout: 5000 });
    shell.resize(120, 40);
    await vi.waitFor(() => expect(fixture.windowChanges).toContainEqual({ cols: 120, rows: 40 }), { timeout: 5000 });
    shell.write('exit');
    await expect(exited).resolves.toBe(0);
    expect(fixture.ptys[0]).toMatchObject({ cols: 100, rows: 30, term: 'xterm-256color' });
  });

  it('attaches tmux targets through a quoted command', async () => {
    const ssh = await online();
    const shell = await ssh.shell({ cols: 80, rows: 24, tmuxTarget: 'cc-x:0.0' });
    await vi.waitFor(() => expect(fixture.execs[0]?.command).toBe(`tmux attach -t ${shQuote('cc-x:0.0')}`), { timeout: 5000 });
    shell.close();
    await expect(ssh.shell({ cols: 80, rows: 24, tmuxTarget: 'x; rm -rf /' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('refuses a server whose host key does not match the pin', async () => {
    const ssh = connect(GITHUB_FP);
    await vi.waitFor(() => expect(ssh.status()).toBe('offline'), { timeout: 5000 });
    expect(fixture.authAttempts).toBe(0);
    await expect(ssh.exec(['version'])).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('reconnects after the connection drops', async () => {
    const ssh = await online();
    const statuses: LinkStatus[] = [];
    ssh.onStatus((status) => statuses.push(status));
    fixture.dropConnections();
    await vi.waitFor(() => expect(statuses).toContain('connecting'), { timeout: 5000 });
    await vi.waitFor(() => expect(ssh.status()).toBe('online'), { timeout: 5000 });
    await expect(ssh.exec(['version'])).resolves.toMatchObject({ code: 0, stdout: '{"ok":true}' });
  });

  it('close() during the handshake drops the late connection, so a short-lived process can exit', async () => {
    const ssh = connect();
    await ssh.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(fixture.openConnections).toBe(0);
    expect(ssh.status()).not.toBe('online');
  });

  it('rejects exec while disconnected', async () => {
    const idle = createSshExecutor({
      name: 'birch',
      host: '127.0.0.1',
      port: fixture.port,
      username: 'dev',
      hostKeyFp: fixture.hostKeyFp,
      privateKeyPath: fixture.clientKeyPath,
      ctlPath: CTL,
      log: silentLogger(),
    });
    await expect(idle.exec(['version'])).rejects.toMatchObject({ code: 'unreachable' });
    await idle.close();
  });
});
