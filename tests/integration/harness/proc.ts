import { spawn } from 'node:child_process';

export interface ProcResult { code: number; stdout: string; stderr: string }
export interface ProcOptions { input?: string; env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number }

/** Runs a program without a shell; stdin receives `input` (UTF-8) and is then closed. */
export function runProc(cmd: string, args: readonly string[], opts: ProcOptions = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.end(opts.input ?? '');
  });
}

export async function mustRun(cmd: string, args: readonly string[], opts: ProcOptions = {}): Promise<string> {
  const result = await runProc(cmd, args, opts);
  if (result.code !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${result.code}\n${result.stderr}${result.stdout}`);
  return result.stdout;
}

/** Single-quotes a fixed test value for bash; user text never goes through a shell. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
