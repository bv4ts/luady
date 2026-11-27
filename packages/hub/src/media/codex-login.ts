import { spawn } from 'node:child_process';
import type { CodexLoginDTO } from '@luady/shared';
import { systemClock } from '../core/clock.js';
import type { Clock, Logger, OutboundChannel } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { codexBin, codexEnv, spawnRun, type CodexRun } from './codex.js';

export const CODEX_LOGIN_TIMEOUT_MS = 16 * 60_000;
/** codex prints the link and code within seconds; past this the sign-in is given up. */
export const CODEX_CODE_WAIT_MS = 60_000;
/** A device code is good for 15 minutes. */
export const CODEX_CODE_TTL_MS = 15 * 60_000;
export const CODEX_STATUS_TIMEOUT_MS = 10_000;
const OUTPUT_MAX = 64 * 1024;
const STATUS_OUTPUT_MAX = 16 * 1024;
const URL_RE = /https:\/\/auth\.openai\.com\/\S+/;
const CODE_RE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const NOT_LOGGED_IN_RE = /not logged in/i;

export const CODEX_CONNECTED = '✅ ChatGPT connected for images.';
export const CODEX_LOGIN_FAILED = "⚠️ ChatGPT sign-in didn't finish. Send /login codex to try again.";
export const CODEX_NOT_STARTED = 'ChatGPT sign-in did not start. Try again.';

export const codexCodeText = (url: string, code: string): string =>
  `🔑 Connect ChatGPT for images: open ${url} and enter *${code}* (expires in 15 min). `
  + 'Device-code login must be on in ChatGPT → Settings → Security.';

/** The device-code link and one-time code from `codex login --device-auth` output, once both are there. */
export function parseDeviceCode(output: string): { url: string; code: string } | null {
  const text = output.replace(ANSI_RE, '');
  const url = URL_RE.exec(text)?.[0];
  if (url === undefined) return null;
  const code = CODE_RE.exec(text.replace(URL_RE, ' '))?.[0];
  return code === undefined ? null : { url, code };
}

/** codex output fit for a log line: no link, no code. */
const loggable = (output: string): string =>
  output.replace(ANSI_RE, '').replace(new RegExp(URL_RE.source, 'g'), '[link]').replace(new RegExp(CODE_RE.source, 'g'), '[code]').slice(-500);

export interface LoginProcess {
  onOutput(cb: (text: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}
export type LoginSpawn = (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => LoginProcess;

const defaultSpawn: LoginSpawn = (file, args, env) => {
  const child = spawn(file, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    onOutput(cb) {
      child.stdout.on('data', (chunk: Buffer) => cb(chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => cb(chunk.toString('utf8')));
    },
    onExit(cb) {
      child.on('error', () => cb(null));
      child.on('close', (code) => cb(code));
    },
    kill: () => child.kill('SIGTERM'),
  };
};

export interface CodexLoginOptions {
  /** The hub user's home: the Codex CLI is in its .local/bin. */
  home: string;
  /** The hub's own Codex home (media/codex.ts hubCodexHome), where the sign-in is kept. */
  codexDir: string;
  log: Logger;
  outbound: Pick<OutboundChannel, 'send'>;
  spawn?: LoginSpawn;
  run?: CodexRun;
  clock?: Clock;
}

export interface CodexLogin {
  /** Starts `codex login --device-auth` (or joins the running one); resolves to the chat message with link and code. The result is then sent on the chat. */
  begin(): Promise<string>;
  /** The same running sign-in as data; its result is not sent on the chat. Rejects when codex ends before a link and code. */
  beginData(): Promise<CodexLoginDTO>;
  /** `codex login status`: in, out, or unknown (old CLI, timeout, missing binary). */
  status(): Promise<'in' | 'out' | 'unknown'>;
  /** `codex logout`; true on exit 0. */
  logout(): Promise<boolean>;
  /** Every finished device sign-in, however it was started. Returns the unsubscriber. */
  onResult(listener: (ok: boolean) => void): () => void;
}

/** How a running device sign-in turned out first: its link and code were shown, or it ended before that. */
type Outcome = { readonly kind: 'shown'; readonly dto: CodexLoginDTO } | { readonly kind: 'ended'; readonly ok: boolean };

export function createCodexLogin(opts: CodexLoginOptions): CodexLogin {
  const start = opts.spawn ?? defaultSpawn;
  const run = opts.run ?? spawnRun;
  const clock = opts.clock ?? systemClock;
  let current: Promise<Outcome> | null = null;
  /** A begin() joined the running sign-in: its result goes to the chat. */
  let toChat = false;
  let listeners: ReadonlyArray<(ok: boolean) => void> = [];

  function finished(ok: boolean, shown: boolean): void {
    for (const listener of listeners) {
      try {
        listener(ok);
      } catch (err) {
        opts.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'codex-login: result listener failed');
      }
    }
    if (!shown || !toChat) return;
    void opts.outbound.send(ok ? CODEX_CONNECTED : CODEX_LOGIN_FAILED, null)
      .catch((err: unknown) => opts.log.warn({ err }, 'codex-login: result not sent'));
  }

  function launch(): Promise<Outcome> {
    let resolve: (outcome: Outcome) => void = () => undefined;
    const outcome = new Promise<Outcome>((done) => {
      resolve = done;
    });
    current = outcome;
    toChat = false;
    const proc = start(codexBin(opts.home), ['login', '--device-auth'], codexEnv(opts.home, opts.codexDir));
    let output = '';
    let shown = false;
    let ended = false;
    const timers = [setTimeout(() => proc.kill(), CODEX_LOGIN_TIMEOUT_MS), setTimeout(() => shown || proc.kill(), CODEX_CODE_WAIT_MS)];
    proc.onOutput((chunk) => {
      if (shown) return;
      output = `${output}${chunk}`.slice(-OUTPUT_MAX);
      const found = parseDeviceCode(output);
      if (found === null) return;
      shown = true;
      opts.log.info({ shown: true }, 'codex-login: device code shown');
      resolve({ kind: 'shown', dto: { ...found, expiresAt: new Date(clock.now().getTime() + CODEX_CODE_TTL_MS).toISOString() } });
    });
    proc.onExit((code) => {
      if (ended) return;
      ended = true;
      timers.forEach((timer) => clearTimeout(timer));
      current = null;
      opts.log.info({ code, output: shown ? undefined : loggable(output) }, 'codex-login: finished');
      if (!shown) resolve({ kind: 'ended', ok: code === 0 });
      finished(code === 0, shown);
    });
    return outcome;
  }

  const running = (): Promise<Outcome> => current ?? launch();
  const runOpts = { env: codexEnv(opts.home, opts.codexDir), cwd: opts.home, input: '', timeoutMs: CODEX_STATUS_TIMEOUT_MS, maxOutput: STATUS_OUTPUT_MAX };

  return {
    async begin() {
      const outcome = running();
      toChat = true;
      const first = await outcome;
      if (first.kind === 'shown') return codexCodeText(first.dto.url, first.dto.code);
      return first.ok ? CODEX_CONNECTED : CODEX_LOGIN_FAILED;
    },
    async beginData() {
      const first = await running();
      if (first.kind !== 'shown') throw new RefusedError(CODEX_NOT_STARTED);
      return first.dto;
    },
    async status() {
      const result = await run(codexBin(opts.home), ['login', 'status'], runOpts).catch(() => null);
      if (result === null) return 'unknown';
      if (NOT_LOGGED_IN_RE.test(`${result.stdout}\n${result.stderr}`)) return 'out';
      return result.code === 0 ? 'in' : 'unknown';
    },
    async logout() {
      const result = await run(codexBin(opts.home), ['logout'], runOpts).catch(() => null);
      const ok = result?.code === 0;
      opts.log.info({ ok }, 'codex-login: signed out');
      return ok;
    },
    onResult(listener) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    },
  };
}
