import type { ConfigPaths } from '../config/load.js';
import type { Db, HubConfig } from '../core/contracts.js';
import type { HubStatus } from '../wire/status.js';

/**
 * `luady doctor`: each check says PASS, WARN or FAIL in plain words, with a fix.
 * The default output is safe to paste into a bug report: states and counts only. Names, addresses, e-mail, phone
 * numbers and paths appear only in `detail`, which is printed with `--full`. No check ever reads out a secret.
 */
export type CheckState = 'PASS' | 'WARN' | 'FAIL';

export type CheckGroup = 'system' | 'install' | 'hub' | 'hosts' | 'add-ons' | 'manager';

export interface CheckResult {
  readonly id: string;
  readonly group: CheckGroup;
  readonly state: CheckState;
  /** One line, safe to share: no names, addresses, paths or secrets. */
  readonly summary: string;
  /** The private particulars (paths, names, addresses), shown with `--full` only; null when there are none. */
  readonly detail: string | null;
  /** What to do, in plain words; null for a PASS. */
  readonly fix: string | null;
}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FileFacts {
  readonly isFile: boolean;
  readonly isDir: boolean;
  /** Permission bits (`mode & 0o777`). */
  readonly mode: number;
  readonly executable: boolean;
}

/** The outside world the checks read; tests pass a fake. */
export interface DoctorProbe {
  nodeVersion(): string;
  platform(): NodeJS.Platform;
  stat(path: string): FileFacts | null;
  /** A small text file, or null when it cannot be read. */
  readText(path: string): string | null;
  /** Runs a program (argv, no shell) with a short timeout; never throws. */
  exec(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ExecResult>;
  /** True when nothing listens on host:port. */
  portFree(host: string, port: number): Promise<boolean>;
  /** `GET /internal/status` over the hub socket; null when the hub does not answer. */
  status(config: HubConfig): Promise<HubStatus | null>;
}

export interface DoctorInput {
  readonly paths: ConfigPaths;
  /** The config, or null when it could not be read. */
  readonly config: HubConfig | null;
  /** Why the config could not be read (a refusal's one line, or a validation message). */
  readonly configError: string | null;
  readonly db: Db | null;
  readonly dbError: string | null;
  readonly probe: DoctorProbe;
}

export const pass = (id: string, group: CheckGroup, summary: string, detail: string | null = null): CheckResult =>
  ({ id, group, state: 'PASS', summary, detail, fix: null });
export const warn = (id: string, group: CheckGroup, summary: string, fix: string, detail: string | null = null): CheckResult =>
  ({ id, group, state: 'WARN', summary, detail, fix });
export const fail = (id: string, group: CheckGroup, summary: string, fix: string, detail: string | null = null): CheckResult =>
  ({ id, group, state: 'FAIL', summary, detail, fix });
