import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AddonToHubSchema } from '@luady/shared';
import { addonUrl, parseHubFrame } from '../src/client.js';
import { ECHO_CAPABILITIES, ECHO_PANEL, ECHO_TOOL, createEchoAddon } from '../src/examples/echo.js';
import { readAddonToken } from '../src/token.js';

const dir = mkdtempSync(join(tmpdir(), 'addon-sdk-'));

describe('readAddonToken', () => {
  it('reads the 64-hex token the hub wrote, and never repeats a bad one in its error', async () => {
    const good = join(dir, 'good.token');
    writeFileSync(good, `${'c'.repeat(64)}\n`);
    await expect(readAddonToken(good)).resolves.toBe('c'.repeat(64));
    const bad = join(dir, 'bad.token');
    writeFileSync(bad, 'not-a-token-value');
    const err = await readAddonToken(bad).catch((e: unknown) => e as Error);
    expect(err.message).toMatch(/does not hold a token/);
    expect(err.message).not.toContain('not-a-token-value');
    await expect(readAddonToken(join(dir, 'missing.token'))).rejects.toThrow(/ENOENT/);
  });
});

describe('addonUrl and parseHubFrame', () => {
  it('speaks over the Unix socket, or a TCP stand-in', () => {
    expect(addonUrl('echo', { socketPath: '/run/hub.sock' })).toBe('ws+unix:///run/hub.sock:/internal/addon/echo');
    expect(addonUrl('echo', { url: 'ws://127.0.0.1:5/' })).toBe('ws://127.0.0.1:5/internal/addon/echo');
    expect(() => addonUrl('echo', {})).toThrow(/socketPath/);
  });

  it('accepts only frames the shared schema accepts', () => {
    expect(parseHubFrame('{"t":"typing","on":true}')).toEqual({ t: 'typing', on: true });
    expect(parseHubFrame('{"t":"typing","on":"yes"}')).toBeNull();
    expect(parseHubFrame('not json')).toBeNull();
  });
});

describe('the echo example', () => {
  it("declares a hello the hub's schema accepts", () => {
    const hello = { t: 'hello', protocol: 1, kind: 'channel', version: '1.0.0', capabilities: ECHO_CAPABILITIES, panel: ECHO_PANEL, tools: [ECHO_TOOL] };
    expect(AddonToHubSchema.safeParse(hello).success).toBe(true);
  });

  it('says nothing before the hub named the owner in its welcome', () => {
    const echo = createEchoAddon({ id: 'echo', token: 'd'.repeat(64), url: 'ws://127.0.0.1:9', now: () => 1_800_000_000_000 });
    expect(echo.say('hello')).toBeNull();
    expect(echo.client.buffered()).toBe(0);
  });
});
