import { readFile } from 'node:fs/promises';
import ssh2 from 'ssh2';
import type { Client as SshClient, ClientChannel, ConnectConfig, PseudoTtyOptions } from 'ssh2';
import { TARGET_RE, type HostId } from '@luady/shared';
import type { Logger, ShellStream } from '../core/contracts.js';
import { CtlError, ValidationError } from '../core/errors.js';
import { shQuote } from '../core/ids.js';
import { resolveChecked, systemLookup, type LookupFn } from '../hosts/resolve.js';
import { buildCommandLine } from './command-line.js';
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  createOutputCollector,
  errorMessage,
  type ExecOptions,
  type ExecResult,
  type LinkError,
  type LinkStatus,
  type RemoteExecutor,
  type ShellOptions,
  type StreamHandle,
} from './executor.js';
import { compileFixed, type FixedScriptId } from './fixed-scripts.js';
import { createHostVerifier } from './host-key.js';
import { DEFAULT_RECONNECT_POLICY, createReconnector, type ReconnectPolicy } from './reconnect.js';
import { wrapShellChannel } from './ssh-shell.js';

export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_COUNT_MAX = 3;
export const READY_TIMEOUT_MS = 20_000;
export const TERMINAL_TYPE = 'xterm-256color';
/** A fixed script's default bounds: remote output is hostile, so it is capped in size and time. */
export const FIXED_TIMEOUT_MS = 60_000;
export const FIXED_MAX_OUTPUT_BYTES = 256 * 1024;

export interface SshExecutorOptions {
  name: HostId;
  host: string;
  port: number;
  username: string;
  hostKeyFp: string;
  privateKeyPath: string;
  ctlPath: string;
  log: Logger;
  policy?: ReconnectPolicy;
  /** Resolves `host` before every connect; each address is checked and the checked one is dialled (hosts/resolve.ts). */
  lookup?: LookupFn;
}

type ChannelCallback = (err: Error | undefined, channel: ClientChannel) => void;

/** Collects one remote run: stdin written then EOF, stdout/stderr capped (and streamed), timeout closes the channel. */
function collect(channel: ClientChannel, what: string, execOpts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const collector = createOutputCollector(execOpts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    let exitCode: number | null = null;
    const timer = setTimeout(() => {
      channel.close();
      reject(new CtlError('timeout', `${what} timed out`, -1));
    }, execOpts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
    channel.on('data', (chunk: Buffer) => {
      collector.stdout(chunk);
      execOpts.onStdout?.(chunk);
    });
    channel.stderr.on('data', (chunk: Buffer) => {
      collector.stderr(chunk);
      execOpts.onStderr?.(chunk);
    });
    channel.on('exit', (code: unknown) => {
      exitCode = typeof code === 'number' ? code : null;
    });
    channel.on('close', () => {
      clearTimeout(timer);
      resolve(collector.result(exitCode));
    });
    const input = execOpts.stdinBytes ?? (execOpts.stdin === undefined ? undefined : Buffer.from(execOpts.stdin, 'utf8'));
    if (input === undefined) channel.end();
    else channel.end(input);
  });
}

/** What a failed handshake means for the link: a refused key, a changed host key, or the network. */
function linkErrorOf(err: unknown, hostKeyMismatch: boolean): LinkError {
  if (hostKeyMismatch) return 'hostkey';
  const level = typeof err === 'object' && err !== null ? (err as { level?: unknown }).level : undefined;
  return level === 'client-authentication' ? 'auth' : 'network';
}

/**
 * One persistent ssh2 connection per server: pinned host key, 15 s keepalive, reconnect with backoff. Before every
 * connect the host is resolved and every address checked. A refused fleet key or a changed host key stops the
 * retries until `resume()`: the link reads `offline` with `lastError` `auth` or `hostkey`.
 */
export function createSshExecutor(opts: SshExecutorOptions): RemoteExecutor {
  const log = opts.log.child({ server: opts.name });
  const lookup = opts.lookup ?? systemLookup;
  let mismatch = false;
  const verifier = createHostVerifier(opts.hostKeyFp, (actual) => {
    mismatch = true;
    log.error({ expected: opts.hostKeyFp, actual }, 'ssh host key mismatch; refusing to connect');
  });
  let conn: SshClient | null = null;
  /** The client whose handshake is in flight; close() ends it too, or it would keep the process alive. */
  let pending: SshClient | null = null;
  let closed = false;
  let lastError: LinkError | null = null;
  /** Stopped after `auth` or `hostkey`: no attempt until resume(). */
  let halted = false;
  const listeners = new Set<(status: LinkStatus) => void>();
  let reported: LinkStatus = 'connecting';

  const reconnector = createReconnector({
    connect: connectOnce,
    policy: opts.policy ?? DEFAULT_RECONNECT_POLICY,
    onFailure: (err, failures) => {
      log.warn({ err: errorMessage(err), failures, reason: lastError }, 'ssh connect failed');
      // After a resume the reconnector may already read `offline` and stay there silently: report what it says.
      queueMicrotask(() => {
        if (!halted) publish(reconnector.status());
      });
    },
  });

  function publish(next: LinkStatus): void {
    if (next === reported) return;
    reported = next;
    for (const listener of [...listeners]) listener(next);
  }
  reconnector.onStatus((status) => {
    if (!halted) publish(status);
  });

  function halt(reason: 'auth' | 'hostkey'): void {
    halted = true;
    reconnector.stop();
    publish('offline');
    log.warn({ reason }, reason === 'auth'
      ? 'ssh: the server refused the fleet key; not retrying until Try again'
      : 'ssh: the host key changed; not retrying until it is checked again');
  }

  function connectConfig(address: string, privateKey: Buffer): ConnectConfig {
    return {
      host: address,
      port: opts.port,
      username: opts.username,
      privateKey,
      hostVerifier: verifier,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      readyTimeout: READY_TIMEOUT_MS,
    };
  }

  async function prepare(): Promise<{ address: string; privateKey: Buffer }> {
    try {
      const address = await resolveChecked(opts.host, lookup);
      return { address, privateKey: await readFile(opts.privateKeyPath) };
    } catch (err) {
      lastError = 'network';
      throw err;
    }
  }

  async function connectOnce(): Promise<void> {
    const { address, privateKey } = await prepare();
    mismatch = false;
    await new Promise<void>((resolve, reject) => {
      const client = new ssh2.Client();
      let ready = false;
      pending = client;
      client.on('ready', () => {
        ready = true;
        lastError = null;
        if (pending === client) pending = null;
        if (closed) {
          client.end();
          resolve();
          return;
        }
        conn = client;
        log.info('ssh connected');
        resolve();
      });
      client.on('error', (err) => {
        if (ready) {
          log.warn({ err: err.message }, 'ssh connection error');
          return;
        }
        lastError = linkErrorOf(err, mismatch);
        if (lastError !== 'network' && !closed) halt(lastError);
        reject(err);
      });
      client.on('close', () => {
        if (pending === client) pending = null;
        if (!ready) {
          lastError ??= 'network';
          reject(new Error('ssh connection closed during handshake'));
          return;
        }
        if (conn !== client) return;
        conn = null;
        log.warn('ssh connection lost');
        reconnector.connectionLost();
      });
      client.connect(connectConfig(address, privateKey));
    });
  }

  function openChannel(run: (client: SshClient, done: ChannelCallback) => void): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      const client = conn;
      if (client === null) {
        reject(new CtlError('unreachable', `${opts.name} is not connected`, -1));
        return;
      }
      try {
        run(client, (err, channel) => {
          if (err) reject(new CtlError('unreachable', `${opts.name}: ${err.message}`, -1));
          else resolve(channel);
        });
      } catch (err) {
        reject(new CtlError('unreachable', `${opts.name}: ${errorMessage(err)}`, -1));
      }
    });
  }

  async function exec(args: readonly string[], execOpts: ExecOptions = {}): Promise<ExecResult> {
    const command = buildCommandLine(opts.ctlPath, args);
    const channel = await openChannel((client, done) => client.exec(command, done));
    return collect(channel, `luady-ctl on ${opts.name}`, execOpts);
  }

  /** `sh -c '<constant>' luady <quoted args>`; the payload goes on stdin as raw bytes. */
  async function runFixed(id: FixedScriptId, args: readonly string[], execOpts: ExecOptions = {}): Promise<ExecResult> {
    const command = compileFixed(id, args);
    const channel = await openChannel((client, done) => client.exec(command, done));
    return collect(channel, `the ${id} script on ${opts.name}`, {
      timeoutMs: FIXED_TIMEOUT_MS, maxOutputBytes: FIXED_MAX_OUTPUT_BYTES, ...execOpts,
    });
  }

  function pipeStream(channel: ClientChannel, onData: (chunk: Buffer) => void, isStopped: () => boolean): Promise<void> {
    return new Promise((resolve) => {
      channel.on('data', (chunk: Buffer) => {
        if (!isStopped()) onData(chunk);
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        log.debug({ stderr: chunk.toString('utf8').slice(0, 500) }, 'luady-ctl stream stderr');
      });
      channel.on('close', () => resolve());
      channel.end();
      if (isStopped()) channel.close();
    });
  }

  function execStream(args: readonly string[], onData: (chunk: Buffer) => void): StreamHandle {
    let stopped = false;
    let channel: ClientChannel | null = null;
    const done = (async (): Promise<void> => {
      try {
        const command = buildCommandLine(opts.ctlPath, args);
        channel = await openChannel((client, cb) => client.exec(command, cb));
      } catch (err) {
        log.warn({ err: errorMessage(err) }, 'luady-ctl stream could not start');
        return;
      }
      await pipeStream(channel, onData, () => stopped);
    })();
    return {
      stop() {
        stopped = true;
        channel?.close();
      },
      done,
    };
  }

  async function shell(shellOpts: ShellOptions): Promise<ShellStream> {
    const target = shellOpts.tmuxTarget;
    if (target !== undefined && !TARGET_RE.test(target)) {
      throw new ValidationError(`invalid tmux target: ${JSON.stringify(target)}`);
    }
    const pty: PseudoTtyOptions = { rows: shellOpts.rows, cols: shellOpts.cols, term: TERMINAL_TYPE };
    const channel = await openChannel((client, done) => {
      if (target === undefined) client.shell(pty, done);
      else client.exec(`tmux attach -t ${shQuote(target)}`, { pty }, done);
    });
    return wrapShellChannel(channel);
  }

  return {
    start: () => {
      if (!halted) reconnector.start();
    },
    status: () => (halted ? 'offline' : reconnector.status()),
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    lastError: () => lastError,
    resume() {
      if (closed || !halted) return;
      halted = false;
      lastError = null;
      publish('connecting');
      reconnector.start();
    },
    exec,
    execStream,
    shell,
    runFixed,
    async close() {
      closed = true;
      reconnector.stop();
      const client = conn;
      const inFlight = pending;
      conn = null;
      pending = null;
      client?.end();
      inFlight?.end();
    },
  };
}
