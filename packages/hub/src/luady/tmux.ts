import { execFile, type ExecFileException } from 'node:child_process';
import type { TmuxRunner } from './types.js';

const TMUX_TIMEOUT_MS = 10_000;
const NOT_RUNNABLE_CODE = 127;

function exitCode(error: ExecFileException | null): number {
  if (!error) return 0;
  return typeof error.code === 'number' ? error.code : NOT_RUNNABLE_CODE;
}

/**
 * Runs `binary ...args` with execFile (never a shell). Never rejects: failures come back as a non-zero code. `env` is the
 * whole environment of every call: the manager's own HOME and TMUX_TMPDIR (fleet/local-env.ts managerEnv), so its tmux
 * server is never the user's. Absent: the hub's environment.
 */
export function createExecTmuxRunner(binary = 'tmux', env?: NodeJS.ProcessEnv): TmuxRunner {
  const options = { timeout: TMUX_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' as const, ...(env === undefined ? {} : { env }) };
  return {
    run: (args) =>
      new Promise((resolve) => {
        execFile(binary, args, options, (error, stdout, stderr) => {
          resolve({ code: exitCode(error), stdout, stderr });
        });
      }),
  };
}
