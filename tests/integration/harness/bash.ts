import { findBash } from '../../../deploy/run-bash.mjs';
import { REPO_ROOT } from './paths.js';
import { runProc, type ProcResult } from './proc.js';

/** Runs bash from the repo root: Git Bash on Windows, never WSL's System32\bash.exe. */
export function runBash(args: readonly string[], env: Readonly<Record<string, string>> = {}): Promise<ProcResult> {
  return runProc(findBash(), args, { cwd: REPO_ROOT, env: { ...env }, timeoutMs: 300_000 });
}
