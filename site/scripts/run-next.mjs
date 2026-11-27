#!/usr/bin/env node
/**
 * Runs the Next.js command line from site/ with its telemetry off: `node scripts/run-next.mjs dev` (or `build`).
 * Every script of the site goes through here or build.mjs, so nothing is ever sent to Next.js's telemetry service.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The environment every Next.js run gets: the caller's, with telemetry off. */
export function nextEnv(extra = {}) {
  return { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}

/** Runs `next <args>` in site/ and resolves with its exit code. */
export function runNext(args, extraEnv = {}) {
  const bin = createRequire(join(SITE, 'package.json')).resolve('next/dist/bin/next');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: SITE, stdio: 'inherit', env: nextEnv(extraEnv) });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const code = await runNext(process.argv.slice(2));
  process.exit(code);
}
