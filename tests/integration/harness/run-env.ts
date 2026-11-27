import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLfOnly, buildImages, ensureDocker } from './docker.js';
import { IT_DIR, REPO_ROOT } from './paths.js';
import { mustRun } from './proc.js';

/** Per-run SSH material shared by every test file (structured-clone safe). */
export interface RunEnv {
  keysDir: string;      // ssh_host_ed25519_key(.pub), client_ed25519(.pub); mounted read-only into containers
  clientKey: string;    // the hub's fleetKeyPath in tests
  hostKeyFp: string;    // "SHA256:…" pinned as HubConfig.servers[].hostKeyFp
  hostKeyLine: string;  // "ssh-ed25519 AAAA…" for known_hosts files
}

export const RUN_ENV_VAR = 'LUADY_IT_RUN';

async function keygen(file: string, comment: string): Promise<void> {
  await mustRun('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
}

export async function fingerprint(pubFile: string): Promise<string> {
  const out = await mustRun('ssh-keygen', ['-l', '-f', pubFile]);
  const fp = out.split(/\s+/)[1];
  if (!fp?.startsWith('SHA256:')) throw new Error(`unexpected ssh-keygen -l output: ${out}`);
  return fp;
}

export async function prepareRun(): Promise<RunEnv> {
  if (!existsSync(join(REPO_ROOT, 'packages', 'hub', 'dist', 'app.js'))) {
    throw new Error('packages/hub/dist/app.js is missing: run `npm run build` first (npm run test:integration does it)');
  }
  await ensureDocker();
  assertLfOnly([join(REPO_ROOT, 'server-kit'), join(IT_DIR, 'fake-server')]);
  const keysDir = await mkdtemp(join(tmpdir(), 'luady-it-'));
  await keygen(join(keysDir, 'ssh_host_ed25519_key'), 'luady-it-host');
  await keygen(join(keysDir, 'client_ed25519'), 'luady-it-client');
  await buildImages(keysDir);
  const hostPub = join(keysDir, 'ssh_host_ed25519_key.pub');
  const [type, blob] = readFileSync(hostPub, 'utf8').trim().split(/\s+/);
  return { keysDir, clientKey: join(keysDir, 'client_ed25519'), hostKeyFp: await fingerprint(hostPub), hostKeyLine: `${type} ${blob}` };
}

export async function cleanupRun(env: RunEnv): Promise<void> {
  await rm(env.keysDir, { recursive: true, force: true, maxRetries: 5 });
}

/** Playwright workers read the RunEnv that its global setup stored in the environment. */
export function runEnvFromProcess(): RunEnv {
  const raw = process.env[RUN_ENV_VAR];
  if (!raw) throw new Error(`${RUN_ENV_VAR} is not set: run through the Playwright global setup`);
  return JSON.parse(raw) as RunEnv;
}
