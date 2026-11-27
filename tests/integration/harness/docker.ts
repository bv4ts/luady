import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMPOSE_FILE } from './paths.js';
import { mustRun, runProc, shq, type ProcResult } from './proc.js';
import type { RunEnv } from './run-env.js';

export type ServerService = 'fake-server' | 'bare-server';
export type ContainerUser = 'root' | 'dev';
export interface FakeLogEntry { ts: string; sid: string; target: string | null; cwd: string; kind: string; [key: string]: unknown }
export interface SpoolLine { id: string; event: string; session_id: string | null; [key: string]: unknown }

export interface FakeServer {
  readonly project: string;
  readonly service: ServerService;
  readonly port: number;
  readonly env: RunEnv;
  exec(user: ContainerUser, script: string, input?: string): Promise<ProcResult>;
  execOk(user: ContainerUser, script: string, input?: string): Promise<string>;
  /** Starts fake-claude the way the owner does: tmux session cc-<name>, bypassPermissions. Returns "cc-<name>:0.0". */
  startClaude(name: string, cwd: string, extraEnv?: Readonly<Record<string, string>>): Promise<string>;
  /** Types printable ASCII into a pane and presses Enter (the owner typing in the terminal). */
  typeInto(target: string, text: string): Promise<void>;
  fakeLog(): Promise<FakeLogEntry[]>;
  spoolEvents(): Promise<SpoolLine[]>;
  hasTmuxSession(name: string): Promise<boolean>;
  down(): Promise<void>;
}

const HOME: Readonly<Record<ContainerUser, string>> = { root: '/root', dev: '/home/dev' };

function composeArgs(project: string, args: readonly string[]): string[] {
  return ['compose', '-f', COMPOSE_FILE, '-p', project, '--profile', 'bare', ...args];
}

function composeEnv(keysDir: string): NodeJS.ProcessEnv {
  return { LUADY_IT_KEYS_DIR: keysDir };
}

function defaultService(): ServerService {
  return process.env.LUADY_IT_SERVICE === 'bare-server' ? 'bare-server' : 'fake-server';
}

function parseJsonLines<T>(text: string): T[] {
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  return complete.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T);
}

export async function ensureDocker(): Promise<void> {
  const result = await runProc('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`Docker is not available; start Docker Desktop.\n${result.stderr.trim()}`);
}

export async function buildImages(keysDir: string): Promise<void> {
  await mustRun('docker', composeArgs('luady-it-build', ['build']), { env: composeEnv(keysDir), timeoutMs: 1_200_000 });
}

/** Fails fast when a file that ends up inside Linux containers has CRLF line endings. */
export function assertLfOnly(paths: readonly string[]): void {
  const offenders: string[] = [];
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) if (!['__pycache__', 'node_modules', '.git'].includes(name)) walk(join(path, name));
    } else if (readFileSync(path).includes(13)) {
      offenders.push(path);
    }
  };
  paths.forEach(walk);
  if (offenders.length > 0) throw new Error(`CRLF line endings found (convert to LF):\n${offenders.join('\n')}`);
}

function serverApi(project: string, service: ServerService, port: number, env: RunEnv): FakeServer {
  const compose = (args: readonly string[], input?: string) =>
    runProc('docker', composeArgs(project, args), { env: composeEnv(env.keysDir), input, timeoutMs: 120_000 });
  const exec = (user: ContainerUser, script: string, input?: string) =>
    compose(['exec', '-T', '-u', user, '-e', `HOME=${HOME[user]}`, '-w', HOME[user], service, 'bash', '-c', script], input);
  const execOk = async (user: ContainerUser, script: string, input?: string) => {
    const result = await exec(user, script, input);
    if (result.code !== 0) throw new Error(`[${service}] ${script} -> exit ${result.code}\n${result.stderr}${result.stdout}`);
    return result.stdout;
  };
  return {
    project, service, port, env, exec, execOk,
    async startClaude(name, cwd, extraEnv = {}) {
      const envFlags = Object.entries(extraEnv).map(([key, value]) => `-e ${shq(`${key}=${value}`)}`).join(' ');
      await execOk('dev', `tmux new-session -d -s ${shq(`cc-${name}`)} -c ${shq(cwd)} ${envFlags} -- /home/dev/.local/bin/claude --permission-mode bypassPermissions`);
      return `cc-${name}:0.0`;
    },
    async typeInto(target, text) {
      if (!/^[\x20-\x7e]+$/.test(text)) throw new Error('typeInto types printable ASCII only; use sessions.send for other text');
      await execOk('dev', `tmux send-keys -t ${shq(target)} -l ${shq(text)} && tmux send-keys -t ${shq(target)} Enter`);
    },
    async fakeLog() {
      return parseJsonLines<FakeLogEntry>(await execOk('dev', 'cat "$HOME/.fake-claude/log.jsonl" 2>/dev/null || true'));
    },
    async spoolEvents() {
      return parseJsonLines<SpoolLine>(await execOk('dev', 'python3 /opt/fake-claude/spool_dump.py'));
    },
    async hasTmuxSession(name) {
      return (await exec('dev', `tmux has-session -t ${shq(name)} 2>/dev/null`)).code === 0;
    },
    async down() {
      await compose(['down', '-v', '--remove-orphans', '-t', '1']);
    },
  };
}

/** Starts one compose project (unique name); sshd is published on a random 127.0.0.1 port. */
export async function startFakeServer(env: RunEnv, service: ServerService = defaultService()): Promise<FakeServer> {
  const project = `luady-it-${randomBytes(4).toString('hex')}`;
  const opts = { env: composeEnv(env.keysDir), timeoutMs: 180_000 };
  const up = await runProc('docker', composeArgs(project, ['up', '-d', '--wait', '--no-build', service]), opts);
  if (up.code !== 0) {
    await runProc('docker', composeArgs(project, ['down', '-v', '-t', '1']), opts);
    throw new Error(`docker compose up ${service} failed:\n${up.stderr}`);
  }
  const portOut = (await mustRun('docker', composeArgs(project, ['port', service, '22']), opts)).trim();
  const port = Number(portOut.split(':').pop());
  if (!Number.isInteger(port) || port <= 0) throw new Error(`cannot parse the mapped sshd port from "${portOut}"`);
  return serverApi(project, service, port, env);
}
