import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CtlError } from '../../src/core/errors.js';
import { createLocalExecutor } from '../../src/fleet/local-executor.js';
import { silentLogger } from '../helpers/fakes.js';

const NASTY = 'مرحبا 👋\nline two "double" \'single\' $(whoami) `id` \\ end';

function nodeExecutor() {
  return createLocalExecutor({ ctlPath: process.execPath, log: silentLogger() });
}

describe('createLocalExecutor', () => {
  it('passes argv verbatim without a shell', async () => {
    const script = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const result = await nodeExecutor().exec(['-e', script, '$(whoami)', '`id`', 'a b', "it's"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['$(whoami)', '`id`', 'a b', "it's"]);
  });

  it('delivers stdin byte-for-byte', async () => {
    const result = await nodeExecutor().exec(['-e', 'process.stdin.pipe(process.stdout)'], { stdin: NASTY });
    expect(Buffer.from(result.stdout, 'utf8').equals(Buffer.from(NASTY, 'utf8'))).toBe(true);
  });

  it('reports exit codes and stderr', async () => {
    const result = await nodeExecutor().exec(['-e', 'process.stderr.write("bad", () => process.exit(3))']);
    expect(result).toEqual({ code: 3, stdout: '', stderr: 'bad', truncated: false });
  });

  it('caps output and flags truncation', async () => {
    const result = await nodeExecutor().exec(['-e', 'process.stdout.write("x".repeat(100000))'], { maxOutputBytes: 1000 });
    expect(result.stdout).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });

  it('rejects with a timeout CtlError', async () => {
    const pending = nodeExecutor().exec(['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects with unreachable when luady-ctl is missing', async () => {
    const executor = createLocalExecutor({ ctlPath: join(tmpdir(), 'luady-missing-dir', 'luady-ctl'), log: silentLogger() });
    const failure = await executor.exec(['version']).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CtlError);
    expect(failure).toMatchObject({ code: 'unreachable' });
  });

  it('streams stdout until exit, and stop() ends a stream early', async () => {
    const executor = nodeExecutor();
    const chunks: string[] = [];
    const finite = executor.execStream(
      ['-e', 'process.stdout.write("a\\n"); setTimeout(() => process.stdout.write("b\\n"), 50)'],
      (chunk) => chunks.push(chunk.toString('utf8')),
    );
    await finite.done;
    expect(chunks.join('')).toBe('a\nb\n');

    const ticks: string[] = [];
    const endless = executor.execStream(
      ['-e', 'setInterval(() => process.stdout.write("tick\\n"), 20)'],
      (chunk) => ticks.push(chunk.toString('utf8')),
    );
    await vi.waitFor(() => expect(ticks.length).toBeGreaterThan(0), { timeout: 5000 });
    endless.stop();
    await endless.done;
    await executor.close();
  });
});
