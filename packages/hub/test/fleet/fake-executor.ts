import type { ShellStream } from '../../src/core/contracts.js';
import type {
  ExecOptions,
  ExecResult,
  LinkStatus,
  RemoteExecutor,
  ShellOptions,
  StreamHandle,
} from '../../src/fleet/executor.js';

export type Responder = (args: readonly string[], opts: ExecOptions) => ExecResult | Promise<ExecResult>;

export interface FakeStream {
  readonly args: readonly string[];
  push(chunk: string | Buffer): void;
  end(): void;
  readonly stopped: boolean;
}

export interface FakeExecutor extends RemoteExecutor {
  readonly execs: Array<{ args: readonly string[]; opts: ExecOptions }>;
  readonly streams: FakeStream[];
  readonly shells: ShellOptions[];
  readonly closed: boolean;
  readonly started: boolean;
  setStatus(status: LinkStatus): void;
  respond(responder: Responder): void;
}

export function okJson(value: unknown): ExecResult {
  return { code: 0, stdout: JSON.stringify(value), stderr: '', truncated: false };
}

export function createFakeShell(): ShellStream & { readonly written: string[] } {
  const written: string[] = [];
  return {
    written,
    write(data) {
      written.push(data);
    },
    resize: () => undefined,
    onData: () => undefined,
    onExit: () => undefined,
    close: () => undefined,
  };
}

function fakeStream(args: readonly string[], onData: (chunk: Buffer) => void): { stream: FakeStream; handle: StreamHandle } {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let stopped = false;
  const stream: FakeStream = {
    args: [...args],
    push(chunk) {
      if (!stopped) onData(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    },
    end: () => finish(),
    get stopped() {
      return stopped;
    },
  };
  const handle: StreamHandle = {
    stop() {
      stopped = true;
      finish();
    },
    done,
  };
  return { stream, handle };
}

export function createFakeExecutor(initial: Responder = () => okJson({ ok: true })): FakeExecutor {
  let responder = initial;
  let status: LinkStatus = 'connecting';
  let closed = false;
  let started = false;
  const listeners = new Set<(status: LinkStatus) => void>();
  const execs: Array<{ args: readonly string[]; opts: ExecOptions }> = [];
  const streams: FakeStream[] = [];
  const shells: ShellOptions[] = [];
  return {
    execs,
    streams,
    shells,
    get closed() {
      return closed;
    },
    get started() {
      return started;
    },
    setStatus(next) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
    respond(next) {
      responder = next;
    },
    start() {
      started = true;
    },
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async exec(args, opts = {}) {
      execs.push({ args: [...args], opts });
      return responder(args, opts);
    },
    execStream(args, onData) {
      const { stream, handle } = fakeStream(args, onData);
      streams.push(stream);
      return handle;
    },
    async shell(opts) {
      shells.push(opts);
      return createFakeShell();
    },
    async close() {
      closed = true;
    },
  };
}
