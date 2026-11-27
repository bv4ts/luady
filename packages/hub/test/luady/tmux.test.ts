import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExecTmuxRunner } from '../../src/luady/tmux.js';

describe('createExecTmuxRunner', () => {
  it('runs the binary with an argv array and reports exit code, stdout and stderr', async () => {
    const runner = createExecTmuxRunner(process.execPath);
    const result = await runner.run(['-e', "process.stdout.write('pane'); process.stderr.write('warn'); process.exit(3)"]);
    expect(result).toEqual({ code: 3, stdout: 'pane', stderr: 'warn' });
  });

  it('resolves with code 127 instead of rejecting when the binary is missing', async () => {
    const runner = createExecTmuxRunner(join(tmpdir(), 'luady-no-such-binary'));
    await expect(runner.run(['has-session'])).resolves.toMatchObject({ code: 127 });
  });
});
