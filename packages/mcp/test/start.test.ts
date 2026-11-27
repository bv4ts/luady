import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { McpEnvSchema, parseMcpEnv, startStdioServer } from '../src/start.js';

const ENV = { LUADY_HUB_SOCKET: '/home/luady/run/hub.sock', LUADY_HUB_TOKEN_FILE: '/home/luady/.config/luady/hub-token' };

function jsonLines(stream: PassThrough): { next(): Promise<Record<string, unknown>>; close(): void } {
  const rl = createInterface({ input: stream });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async next() {
      const line = await lines.next();
      if (line.done === true) throw new Error('stdout closed before a reply arrived');
      return JSON.parse(line.value) as Record<string, unknown>;
    },
    close: () => rl.close(),
  };
}

function send(stdin: PassThrough, message: Record<string, unknown>): void {
  stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

describe('luady-mcp stdio entry', () => {
  it('reads exactly LUADY_HUB_SOCKET and LUADY_HUB_TOKEN_FILE', () => {
    expect(Object.keys(McpEnvSchema.shape)).toEqual(['LUADY_HUB_SOCKET', 'LUADY_HUB_TOKEN_FILE']);
    expect(parseMcpEnv({ ...ENV, PATH: '/usr/bin', HOME: '/home/luady' })).toEqual(ENV);
  });

  it('rejects a missing or empty variable with a clear message', () => {
    expect(() => parseMcpEnv({ LUADY_HUB_TOKEN_FILE: ENV.LUADY_HUB_TOKEN_FILE })).toThrow(
      /invalid environment: LUADY_HUB_SOCKET/,
    );
    expect(() => parseMcpEnv({ LUADY_HUB_SOCKET: ENV.LUADY_HUB_SOCKET, LUADY_HUB_TOKEN_FILE: '' })).toThrow(
      /LUADY_HUB_TOKEN_FILE/,
    );
  });

  it('refuses to start with a bad environment before touching stdio', async () => {
    await expect(startStdioServer({ env: {} })).rejects.toThrow(/luady-mcp: invalid environment/);
  });

  it('answers initialize and tools/list over stdio', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const replies = jsonLines(stdout);
    const running = await startStdioServer({ env: ENV, stdin, stdout });
    send(stdin, {
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stdio-test', version: '0.0.0' } },
    });
    expect(await replies.next()).toMatchObject({ id: 1, result: { serverInfo: { name: 'hub' }, capabilities: { tools: {} } } });
    send(stdin, { method: 'notifications/initialized' });
    send(stdin, { id: 2, method: 'tools/list' });
    const list = await replies.next();
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    replies.close();
    await running.close();
  });
});
