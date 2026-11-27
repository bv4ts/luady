import { join } from 'node:path';
import { IT_DIR, REPO_ROOT } from './paths.js';
import { mustRun, runProc, type ProcResult } from './proc.js';

export const DEPLOY_IMAGE = 'luady-it-deploy:24.04';
let building: Promise<void> | undefined;

/** Builds the disposable VPS-like Ubuntu 24.04 image once per test process. */
export function ensureDeployImage(): Promise<void> {
  building ??= mustRun('docker', ['build', '-t', DEPLOY_IMAGE, join(IT_DIR, 'deploy')], { timeoutMs: 1_200_000 }).then(() => undefined);
  return building;
}

export interface DeployRunOptions { env?: Readonly<Record<string, string>>; network?: boolean; timeoutMs?: number }

/** Runs a bash snippet as root in a fresh container, with the repo mounted read-only at /work. */
export async function runInDeployImage(script: string, opts: DeployRunOptions = {}): Promise<ProcResult> {
  await ensureDeployImage();
  const envArgs = Object.entries(opts.env ?? {}).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const network = opts.network === false ? ['--network', 'none'] : [];
  return runProc('docker', [
    'run', '--rm', ...network, '--mount', `type=bind,source=${REPO_ROOT},target=/work,readonly`, '-w', '/work',
    ...envArgs, DEPLOY_IMAGE, 'bash', '-c', script,
  ], { timeoutMs: opts.timeoutMs ?? 600_000 });
}
