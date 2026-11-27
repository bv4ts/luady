import { describe, expect, it, vi } from 'vitest';
import { RefusedError } from '../../src/core/errors.js';
import type { CodexRun, RunResult } from '../../src/media/codex.js';
import {
  CODEX_CONNECTED, CODEX_LOGIN_FAILED, CODEX_STATUS_TIMEOUT_MS, createCodexLogin, parseDeviceCode, type LoginProcess,
} from '../../src/media/codex-login.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

function fakeProcess() {
  let output: (text: string) => void = () => undefined;
  let exit: (code: number | null) => void = () => undefined;
  const proc: LoginProcess = {
    onOutput: (cb) => {
      output = cb;
    },
    onExit: (cb) => {
      exit = cb;
    },
    kill: vi.fn(() => exit(null)),
  };
  return { proc, print: (text: string) => output(text), exit: (code: number | null) => exit(code) };
}

const OUTPUT = 'Welcome to Codex\n1. Open this link in your browser\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n'
  + '2. Enter this one-time code \u001b[94mAB12-CD34Z\u001b[0m\n';

describe('/login codex', () => {
  it('finds the device link and one-time code in codex output', () => {
    expect(parseDeviceCode(OUTPUT)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z' });
    expect(parseDeviceCode('Open https://auth.openai.com/codex/device')).toBeNull();
  });

  it('sends one message with link and code, re-sends it for a second /login codex, then reports the result', async () => {
    const outbound = createFakeOutbound();
    const fake = fakeProcess();
    const spawn = vi.fn((_file: string, _args: readonly string[], _env: NodeJS.ProcessEnv) => fake.proc);
    process.env.OPENAI_API_KEY = 'sk-x';
    const login = createCodexLogin({ home: '/home/luady', codexDir: '/home/luady/.local/share/luady/data/codex', log: silentLogger(), outbound, spawn });
    const first = login.begin();
    fake.print(OUTPUT.slice(0, 40));
    fake.print(OUTPUT.slice(40));
    const text = await first;
    delete process.env.OPENAI_API_KEY;
    expect(text).toBe('🔑 Connect ChatGPT for images: open https://auth.openai.com/codex/device and enter *AB12-CD34Z* (expires in 15 min). '
      + 'Device-code login must be on in ChatGPT → Settings → Security.');
    expect(await login.begin()).toBe(text);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe('/home/luady/.local/bin/codex');
    expect(spawn.mock.calls[0]?.[1]).toEqual(['login', '--device-auth']);
    expect(spawn.mock.calls[0]?.[2].CODEX_HOME).toBe('/home/luady/.local/share/luady/data/codex');
    expect(spawn.mock.calls[0]?.[2].HOME).toBe('/home/luady/.local/share/luady/data/codex');
    expect(spawn.mock.calls[0]?.[2].OPENAI_API_KEY).toBeUndefined();
    fake.exit(0);
    await vi.waitFor(() => expect(outbound.sent.at(-1)?.text).toBe(CODEX_CONNECTED));
  });

  it('says the sign-in did not finish when codex fails, and can start again', async () => {
    const outbound = createFakeOutbound();
    const fake = fakeProcess();
    const spawn = vi.fn(() => fake.proc);
    const login = createCodexLogin({ home: '/home/luady', codexDir: '/home/luady/.local/share/luady/data/codex', log: silentLogger(), outbound, spawn });
    const first = login.begin();
    fake.print(OUTPUT);
    await first;
    fake.exit(1);
    await vi.waitFor(() => expect(outbound.sent.at(-1)?.text).toBe(CODEX_LOGIN_FAILED));
    const again = login.begin();
    fake.exit(1);
    expect(await again).toBe(CODEX_LOGIN_FAILED);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

const T0 = '2026-11-14T10:00:00.000Z';

function fakeRun(result: RunResult) {
  const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number; codexHome: string | undefined }> = [];
  const run: CodexRun = async (file, args, opts) => {
    calls.push({ file, args, timeoutMs: opts.timeoutMs, codexHome: opts.env.CODEX_HOME });
    return result;
  };
  return { run, calls };
}

function dataSetup(run: CodexRun = fakeRun({ code: 0, stdout: '', stderr: '' }).run) {
  const outbound = createFakeOutbound();
  const fake = fakeProcess();
  const spawn = vi.fn(() => fake.proc);
  const capture = createCaptureLogger();
  const login = createCodexLogin({ home: '/home/luady', codexDir: '/home/luady/.local/share/luady/data/codex', log: capture.log, outbound, spawn, run, clock: createFakeClock(T0) });
  return { login, fake, spawn, outbound, lines: capture.lines };
}

describe('Codex sign-in as data', () => {
  it('beginData resolves with the link and code; a second call while it runs shares the same sign-in', async () => {
    const t = dataSetup();
    const first = t.login.beginData();
    t.fake.print(OUTPUT);
    const pair = await first;
    expect(pair).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z', expiresAt: '2026-11-14T10:15:00.000Z' });
    expect(await t.login.beginData()).toEqual(pair);
    expect(await t.login.begin()).toContain('AB12-CD34Z');
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it('a data-started sign-in tells onResult and sends nothing on the chat', async () => {
    const t = dataSetup();
    const results: boolean[] = [];
    t.login.onResult((ok) => results.push(ok));
    const pending = t.login.beginData();
    t.fake.print(OUTPUT);
    await pending;
    t.fake.exit(0);
    expect(results).toEqual([true]);
    await new Promise((done) => setImmediate(done));
    expect(t.outbound.sent).toEqual([]);
  });

  it('a begin()-started sign-in still sends CODEX_CONNECTED, and tells onResult too', async () => {
    const t = dataSetup();
    const results: boolean[] = [];
    const off = t.login.onResult((ok) => results.push(ok));
    const pending = t.login.begin();
    t.fake.print(OUTPUT);
    await pending;
    t.fake.exit(0);
    await vi.waitFor(() => expect(t.outbound.sent.at(-1)?.text).toBe(CODEX_CONNECTED));
    expect(results).toEqual([true]);
    off();
    const again = t.login.beginData();
    t.fake.exit(1);
    await expect(again).rejects.toBeInstanceOf(RefusedError);
    expect(results).toEqual([true]);
  });

  it('beginData refuses when codex ends before printing a link and code', async () => {
    const t = dataSetup();
    const pending = t.login.beginData();
    t.fake.print('error: device code login is disabled');
    t.fake.exit(1);
    await expect(pending).rejects.toThrow('ChatGPT sign-in did not start. Try again.');
  });

  it('no log line holds the device code or the link', async () => {
    const t = dataSetup();
    const pending = t.login.beginData();
    t.fake.print(OUTPUT);
    await pending;
    t.fake.exit(0);
    const half = dataSetup();
    const failed = half.login.beginData();
    half.fake.print('Enter this one-time code AB12-CD34Z\n');
    half.fake.exit(1);
    await failed.catch(() => undefined);
    for (const line of [...t.lines, ...half.lines]) {
      expect(line).not.toContain('AB12-CD34Z');
      expect(line).not.toContain('auth.openai.com');
    }
    expect(t.lines.some((line) => line.includes('"shown":true'))).toBe(true);
  });

  it('status: exit 0 is in, "Not logged in" is out, anything else is unknown', async () => {
    const yes = fakeRun({ code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' });
    expect(await dataSetup(yes.run).login.status()).toBe('in');
    expect(yes.calls).toEqual([{ file: '/home/luady/.local/bin/codex', args: ['login', 'status'], timeoutMs: CODEX_STATUS_TIMEOUT_MS, codexHome: '/home/luady/.local/share/luady/data/codex' }]);
    expect(await dataSetup(fakeRun({ code: 1, stdout: '', stderr: 'Not logged in\n' }).run).login.status()).toBe('out');
    expect(await dataSetup(fakeRun({ code: 2, stdout: '', stderr: "error: unrecognized subcommand 'status'" }).run).login.status()).toBe('unknown');
    expect(await dataSetup(fakeRun({ code: null, stdout: '', stderr: '' }).run).login.status()).toBe('unknown');
  });

  it('logout is true on exit 0 and false otherwise', async () => {
    const ok = fakeRun({ code: 0, stdout: 'Successfully logged out', stderr: '' });
    expect(await dataSetup(ok.run).login.logout()).toBe(true);
    expect(ok.calls[0]?.args).toEqual(['logout']);
    expect(await dataSetup(fakeRun({ code: 1, stdout: '', stderr: 'Not logged in' }).run).login.logout()).toBe(false);
  });
});
