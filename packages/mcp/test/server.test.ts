import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from '@luady/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { HubTransportError, type HubTransport } from '../src/hub-transport.js';
import { createLuadyMcpServer, formatIssues, SERVER_INFO } from '../src/server.js';
import { buildToolList } from '../src/tool-list.js';
import { createFakeHub } from './helpers/fake-hub.js';

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(hub: HubTransport): Promise<Client> {
  const server = createLuadyMcpServer({ hub });
  const client = new Client({ name: 'luady-mcp-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

async function call(
  client: Client,
  name: string,
  args?: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const first = result.content[0];
  return { isError: result.isError === true, text: first?.type === 'text' ? first.text : '' };
}

describe('luady-mcp server', () => {
  it('identifies itself as "hub" with the tools capability', async () => {
    const client = await connect(createFakeHub());
    expect(client.getServerVersion()).toMatchObject(SERVER_INFO);
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
  });

  it('lists exactly the manager tools with their JSON Schemas', async () => {
    const client = await connect(createFakeHub());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(tools).toEqual(buildToolList());
  });

  it('forwards validated input with defaults applied and returns the hub text', async () => {
    const hub = createFakeHub(() => ({ ok: true, text: 'owner: run the tests\nassistant: 42 passed' }));
    const client = await connect(hub);
    await expect(call(client, 'session_read', { session: 'meadow-hr' })).resolves.toEqual({
      isError: false,
      text: 'owner: run the tests\nassistant: 42 passed',
    });
    expect(hub.calls).toEqual([{ name: 'session_read', input: { session: 'meadow-hr', last_n: 20 } }]);
  });

  it('calls argument-less tools with an empty object', async () => {
    const hub = createFakeHub(() => ({ ok: true, text: 'cedar online · birch online · ash offline' }));
    const client = await connect(hub);
    await expect(call(client, 'fleet_status')).resolves.toEqual({
      isError: false,
      text: 'cedar online · birch online · ash offline',
    });
    expect(hub.calls).toEqual([{ name: 'fleet_status', input: {} }]);
  });

  it('relays a pending_confirmation reply unchanged', async () => {
    const text = 'pending_confirmation A7: stop cedar · meadow-hr. The owner must approve with the PIN.';
    const hub = createFakeHub(() => ({ ok: true, text }));
    const client = await connect(hub);
    await expect(
      call(client, 'session_stop', { session: 'meadow-hr', reason: 'owner asked to stop it' }),
    ).resolves.toEqual({ isError: false, text });
    expect(hub.calls[0]?.input).toEqual({ session: 'meadow-hr', force: false, reason: 'owner asked to stop it' });
  });

  it('returns a hub ok:false reply as an isError result', async () => {
    const hub = createFakeHub(() => ({ ok: false, error: 'cedar · meadow-hr is waiting for an answer to #ABCDEFGH' }));
    const client = await connect(hub);
    await expect(call(client, 'session_send', { session: 'meadow-hr', text: 'continue' })).resolves.toEqual({
      isError: true,
      text: 'cedar · meadow-hr is waiting for an answer to #ABCDEFGH',
    });
  });

  it('turns a transport failure into an isError result', async () => {
    const timeout = createFakeHub(() => {
      throw new HubTransportError('Luady hub did not answer within 180 s');
    });
    await expect(call(await connect(timeout), 'fleet_status')).resolves.toEqual({
      isError: true,
      text: 'Luady hub did not answer within 180 s',
    });
    const odd = createFakeHub(() => Promise.reject('socket exploded'));
    await expect(call(await connect(odd), 'fleet_status')).resolves.toEqual({ isError: true, text: 'socket exploded' });
  });

  it('rejects invalid arguments with the zod issues and never calls the hub', async () => {
    const hub = createFakeHub();
    const client = await connect(hub);
    const bad = await call(client, 'session_read', { session: 'meadow-hr', last_n: 0, bogus: true });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Invalid arguments for session_read');
    expect(bad.text).toContain('last_n');
    expect(bad.text).toContain('bogus');
    const outside = await call(client, 'session_start', { server: 'cedar', cwd: '/home/dev/projects/../../etc' });
    expect(outside.isError).toBe(true);
    expect(outside.text).toContain('cwd');
    expect(hub.calls).toHaveLength(0);
  });

  it('returns isError for an unknown tool without calling the hub', async () => {
    const hub = createFakeHub();
    const client = await connect(hub);
    await expect(call(client, 'rm_rf')).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining('Unknown tool "rm_rf"'),
    });
    await expect(call(client, '__proto__')).resolves.toMatchObject({ isError: true });
    expect(hub.calls).toHaveLength(0);
  });

  it('formats zod issues as path: message pairs', () => {
    const issues = [
      { path: ['answers', 'Which DB?'], message: 'Too long' },
      { path: [], message: 'Unrecognized key: "x"' },
    ];
    expect(formatIssues(issues)).toBe('answers.Which DB?: Too long; (input): Unrecognized key: "x"');
  });
});
