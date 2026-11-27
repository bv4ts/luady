import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAMES } from '@luady/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ADDON_TOOL_TIMEOUT_MS, createHttpHubTransport, type HubTransport, type ToolCatalogue } from '../src/hub-transport.js';
import { createLuadyMcpServer } from '../src/server.js';
import { addonPrefix, buildToolList } from '../src/tool-list.js';
import { sendJson, startFakeHubServer, type FakeHubServer } from './helpers/hub-server.js';

/** Add-on tools reach the manager through `GET /internal/tools`, read at start, with a fallback. */
const WEATHER = {
  name: 'weather_now', description: 'The weather in a city.', input: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, addon: 'helper-tools',
};
const BUILTIN = [...TOOL_NAMES];
const CATALOGUE: ToolCatalogue = { builtin: BUILTIN, addon: [WEATHER] };

const clients: Client[] = [];
let fake: FakeHubServer | null = null;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await fake?.close();
  fake = null;
});

interface Call { name: string; input: unknown; timeoutMs: number | undefined }

function recordingHub(): HubTransport & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async callTool(name, input, opts) {
      calls.push({ name, input, timeoutMs: opts?.timeoutMs });
      return { ok: true, text: `ran ${name}` };
    },
  };
}

async function connect(hub: HubTransport, catalogue: ToolCatalogue | null): Promise<Client> {
  const server = createLuadyMcpServer({ hub, catalogue });
  const client = new Client({ name: 'addon-test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

describe('the tool list with add-on tools', () => {
  it('lists the built-in tools the hub names, then the add-on tools, each naming the add-on that owns it', () => {
    const tools = buildToolList(CATALOGUE);
    expect(tools.map((tool) => tool.name)).toEqual([...BUILTIN, 'weather_now']);
    expect(tools.at(-1)).toMatchObject({ description: '(From the add-on helper-tools.) The weather in a city.', inputSchema: { type: 'object', required: ['city'] } });
  });

  it('falls back to every built-in tool when the hub could not be asked', () => {
    expect(buildToolList(null).map((tool) => tool.name)).toEqual(TOOL_NAMES);
  });

  it('never lets an add-on tool take a built-in name', () => {
    const tools = buildToolList({ builtin: BUILTIN, addon: [{ ...WEATHER, name: 'notify_user' }] });
    expect(tools.filter((tool) => tool.name === 'notify_user')).toHaveLength(1);
    expect(tools.find((tool) => tool.name === 'notify_user')?.description).not.toContain(addonPrefix('helper-tools'));
  });

  it('forwards an add-on tool call as given, with the long add-on timeout; built-ins keep their checks', async () => {
    const hub = recordingHub();
    const client = await connect(hub, CATALOGUE);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('weather_now');
    const result = CallToolResultSchema.parse(await client.callTool({ name: 'weather_now', arguments: { city: 'Example', extra: 1 } }));
    expect(result.isError).not.toBe(true);
    expect(hub.calls).toEqual([{ name: 'weather_now', input: { city: 'Example', extra: 1 }, timeoutMs: ADDON_TOOL_TIMEOUT_MS }]);
    const unknown = CallToolResultSchema.parse(await client.callTool({ name: 'not_listed', arguments: {} }));
    expect(unknown.isError).toBe(true);
    expect(hub.calls).toHaveLength(1);
  });
});

describe('GET /internal/tools over the hub socket', () => {
  function tokenFile(): string {
    const file = join(mkdtempSync(join(tmpdir(), 'luady-mcp-list-')), 'hub-token');
    writeFileSync(file, `${'t'.repeat(64)}\n`);
    return file;
  }

  it('reads the catalogue with the hub token', async () => {
    fake = await startFakeHubServer((_req, res) => sendJson(res, 200, { ok: true, ...CATALOGUE }));
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile: tokenFile() });
    await expect(transport.listTools()).resolves.toEqual(CATALOGUE);
    expect(fake.requests[0]).toMatchObject({ method: 'GET', url: '/internal/tools' });
    expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${'t'.repeat(64)}`);
  });

  it('rejects a malformed answer, so the server falls back', async () => {
    fake = await startFakeHubServer((_req, res) => sendJson(res, 200, { ok: true, builtin: 'all' }));
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile: tokenFile() });
    await expect(transport.listTools()).rejects.toThrow(/Unexpected tool list/);
  });
});
