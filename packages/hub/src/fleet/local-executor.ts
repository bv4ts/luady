import { spawn } from 'node:child_process';
import type { Logger, ShellStream } from '../core/contracts.js';
import { CtlError, RefusedError } from '../core/errors.js';
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  createOutputCollector,
  type ExecOptions,
  type ExecResult,
  type Executor,
  type LinkStatus,
  type RemoteExecutor,
  type StreamHandle,
} from './executor.js';

export interface LocalExecutorOptions {
  ctlPath: string;
  log: Logger;
  /**
   * The child's whole environment (fleet/local-env.ts): the manager's HOME and its own TMUX_TMPDIR for the self host,
   * the user's own for "this computer". Absent: the hub's environment.
   */
  env?: NodeJS.ProcessEnv;
}

/** Runs this machine's luady-ctl with an argv array (`shell: false`): no shell ever parses the arguments. */
export function createLocalExecutor(opts: LocalExecutorOptions): Executor {
  const running = new Set<() => void>();

  function exec(args: readonly string[], execOpts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const collector = createOutputCollector(execOpts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
      const child = spawn(opts.ctlPath, [...args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...envOption(opts) });
      const kill = (): void => {
        child.kill('SIGKILL');
      };
      running.add(kill);
      const timer = setTimeout(() => {
        kill();
        reject(new CtlError('timeout', `local luady-ctl ${args[0] ?? ''} timed out`, -1));
      }, execOpts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
      const finish = (): void => {
        clearTimeout(timer);
        running.delete(kill);
      };
      child.stdout.on('data', (chunk: Buffer) => collector.stdout(chunk));
      child.stderr.on('data', (chunk: Buffer) => collector.stderr(chunk));
      child.on('error', (err) => {
        finish();
        reject(new CtlError('unreachable', `cannot run local luady-ctl: ${err.message}`, -1));
      });
      child.on('close', (code) => {
        finish();
        resolve(collector.result(code));
      });
      child.stdin.on('error', (err) => opts.log.debug({ err: err.message }, 'local luady-ctl closed stdin early'));
      if (execOpts.stdin === undefined) child.stdin.end();
      else child.stdin.end(Buffer.from(execOpts.stdin, 'utf8'));
    });
  }

  function execStream(args: readonly string[], onData: (chunk: Buffer) => void): StreamHandle {
    let stopped = false;
    let kill: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      const child = spawn(opts.ctlPath, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...envOption(opts) });
      const stopChild = (): void => {
        child.kill('SIGTERM');
      };
      kill = stopChild;
      running.add(stopChild);
      const end = (): void => {
        running.delete(stopChild);
        resolve();
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (!stopped) onData(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        opts.log.debug({ stderr: chunk.toString('utf8').slice(0, 500) }, 'local luady-ctl stream stderr');
      });
      child.on('error', (err) => {
        opts.log.warn({ err: err.message }, 'local luady-ctl stream failed');
        end();
      });
      child.on('close', end);
    });
    return {
      stop() {
        stopped = true;
        kill?.();
      },
      done,
    };
  }

  return {
    exec,
    execStream,
    async close() {
      for (const kill of [...running]) kill();
      running.clear();
    },
  };
}

function envOption(opts: LocalExecutorOptions): { env?: NodeJS.ProcessEnv } {
  return opts.env === undefined ? {} : { env: opts.env };
}

/**
 * A local executor in the fleet's shape (the local host's row): always online, no web terminal.
 */
export function asLocalRoom(executor: Executor): RemoteExecutor {
  return {
    exec: (args, execOpts) => executor.exec(args, execOpts),
    execStream: (args, onData) => executor.execStream(args, onData),
    close: () => executor.close(),
    start: () => undefined,
    status: (): LinkStatus => 'online',
    onStatus: () => () => undefined,
    shell: async (): Promise<ShellStream> => {
      throw new RefusedError('This computer has no web terminal');
    },
  };
}
