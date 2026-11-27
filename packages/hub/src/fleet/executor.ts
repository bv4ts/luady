import type { ShellStream } from '../core/contracts.js';
import type { FixedScriptId } from './fixed-scripts.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
/** Generous cap: the largest legitimate luady-ctl reply is a JSON-encoded 512 KiB transcript chunk. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type LinkStatus = 'connecting' | 'online' | 'offline';

export interface ExecOptions {
  /** Free text for luady-ctl: sent as UTF-8 on stdin, never on the command line. */
  stdin?: string;
  /** Raw bytes on stdin (a fixed script's payload); wins over `stdin`. */
  stdinBytes?: Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Each stdout / stderr chunk as it arrives (a kit job's log); the result still collects them up to the cap. */
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

/**
 * Why a link is down (`lastError`): the server refused the fleet key (`auth`), its host key is not the
 * pinned one (`hostkey`), or it could not be reached (`network`). After `auth` or `hostkey` the link stops retrying
 * until `resume()` ("Try again"), so a server with fail2ban is never hammered.
 */
export type LinkError = 'auth' | 'network' | 'hostkey';

export interface ExecResult {
  /** Exit status; null when the process died from a signal or reported no status. */
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface StreamHandle {
  stop(): void;
  done: Promise<void>;
}

export interface ShellOptions {
  cols: number;
  rows: number;
  tmuxTarget?: string;
}

/** Runs the host's luady-ctl. `args` start with the verb; the executor supplies the program path. */
export interface Executor {
  exec(args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  execStream(args: readonly string[], onData: (chunk: Buffer) => void): StreamHandle;
  close(): Promise<void>;
}

export interface RemoteExecutor extends Executor {
  start(): void;
  status(): LinkStatus;
  onStatus(listener: (status: LinkStatus) => void): () => void;
  shell(opts: ShellOptions): Promise<ShellStream>;
  /** Why the link is down, or null (always null for this computer and for fakes without it). */
  lastError?(): LinkError | null;
  /** Retries again after a stop on `auth` or `hostkey` ("Try again"). */
  resume?(): void;
  /** One of the fixed remote scripts (fleet/fixed-scripts.ts); SSH links only. */
  runFixed?(id: FixedScriptId, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
}

export interface OutputCollector {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  result(code: number | null): ExecResult;
}

interface Sink {
  add(chunk: Buffer): boolean;
  text(): string;
}

function createSink(maxBytes: number): Sink {
  const chunks: Buffer[] = [];
  let used = 0;
  return {
    add(chunk) {
      const room = Math.max(0, maxBytes - used);
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length > 0) {
        chunks.push(piece);
        used += piece.length;
      }
      return piece.length === chunk.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Collects stdout and stderr up to `maxBytes` each; anything beyond is dropped and flagged. */
export function createOutputCollector(maxBytes: number): OutputCollector {
  const out = createSink(maxBytes);
  const err = createSink(maxBytes);
  let truncated = false;
  return {
    stdout(chunk) {
      if (!out.add(chunk)) truncated = true;
    },
    stderr(chunk) {
      if (!err.add(chunk)) truncated = true;
    },
    result: (code) => ({ code, stdout: out.text(), stderr: err.text(), truncated }),
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
