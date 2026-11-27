#!/usr/bin/env node
// Runs a bash script with Git Bash on Windows (never WSL's System32\bash.exe) and with bash elsewhere.
//   node deploy/run-bash.mjs <script> [args...]      (used by `npm run deploy`)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GIT_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];

/** LUADY_BASH overrides; on Windows only Git Bash is accepted. */
export function findBash(env = process.env, platform = process.platform) {
  if (env.LUADY_BASH) return env.LUADY_BASH;
  if (platform !== 'win32') return 'bash';
  const found = GIT_BASH.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('Git Bash not found: install Git for Windows or set LUADY_BASH to its bash.exe');
  return found;
}

function main(argv) {
  const [script, ...rest] = argv;
  if (!script) {
    console.error('usage: node deploy/run-bash.mjs <script> [args...]');
    return 2;
  }
  const result = spawnSync(findBash(), [script, ...rest], { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
