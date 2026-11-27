import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpHubTransport, HUB_TIMEOUT_MS, HubTransportError, readHubToken } from '../src/hub-transport.js';
import { sendJson, startFakeHubServer, testSocketPath, type FakeHubServer } from './helpers/hub-server.js';

const TOKEN = 'test-token-0123456789abcdef';

describe('createHttpHubTransport', () => {
  let dir = '';
  let tokenFile = '';
  let fake: FakeHubServer | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'luady-mcp-token-'));
    tokenFile = join(dir, 'hub-token');
    writeFileSync(tokenFile, `  ${TOKEN}\n`, 'utf8');
  });

  afterEach(async () => {
    await fake?.close();
    fake = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('posts the input to /internal/tools/<name> with the trimmed bearer token', async () => {
    fake = await startFakeHubServer((_req, res) => sendJson(res, 200, { ok: true, text: 'cedar · meadow-hr: idle' }));
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile });
    await expect(transport.callTool('session_read', { session: 'meadow-hr', last_n: 20 })).resolves.toEqual({
      ok: true,
      text: 'cedar · meadow-hr: idle',
    });
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/internal/tools/session_read');
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request?.body ?? 'null')).toEqual({ session: 'meadow-hr', last_n: 20 });
  });

  it('returns ok:false replies from HTTP 200 and 400 as tool errors', async () => {
    fake = await startFakeHubServer((req, res) =>
      req.url.endsWith('/session_send')
        ? sendJson(res, 200, { ok: false, error: 'cedar · meadow-hr is waiting for an answer to #ABCDEFGH' })
        : sendJson(res, 400, { ok: false, error: 'last_n: Too big' }),
    );
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile });
    await expect(transport.callTool('session_send', { session: 'meadow-hr', text: 'go on' })).resolves.toEqual({
      ok: false,
      error: 'cedar · meadow-hr is waiting for an answer to #ABCDEFGH',
    });
    await expect(transport.callTool('session_read', { session: 'meadow-hr', last_n: 500 })).resolves.toEqual({
      ok: false,
      error: 'last_n: Too big',
    });
  });

  it('maps HTTP 401 to an auth error that never contains the token', async () => {
    fake = await startFakeHubServer((_req, res) => sendJson(res, 401, { error: 'unauthorized' }));
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile });
    const error = await transport.callTool('fleet_status', {}).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(HubTransportError);
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it('maps HTTP 404 and non-JSON replies to clear errors', async () => {
    fake = await startFakeHubServer((req, res) => {
      if (req.url.endsWith('/fleet_status')) {
        sendJson(res, 404, { message: 'Route not found' });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('oops');
    });
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile });
    await expect(transport.callTool('fleet_status', {})).rejects.toThrow(
      'Luady hub does not know the tool fleet_status (HTTP 404)',
    );
    await expect(transport.callTool('schedule_list', {})).rejects.toThrow('Unexpected reply from the Luady hub (HTTP 200)');
  });

  it('fails clearly when the token file is missing and sends nothing', async () => {
    fake = await startFakeHubServer((_req, res) => sendJson(res, 200, { ok: true, text: 'unused' }));
    const missing = join(dir, 'no-such-dir', 'hub-token');
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile: missing });
    await expect(transport.callTool('fleet_status', {})).rejects.toThrow(`Hub token file not found: ${missing}`);
    expect(fake.requests).toHaveLength(0);
  });

  it('fails clearly when the token file is empty or unreadable', async () => {
    writeFileSync(tokenFile, '\n', 'utf8');
    const empty = createHttpHubTransport({ socketPath: testSocketPath(), tokenFile });
    await expect(empty.callTool('fleet_status', {})).rejects.toThrow(`Hub token file is empty or malformed: ${tokenFile}`);
    const directory = createHttpHubTransport({ socketPath: testSocketPath(), tokenFile: dir });
    await expect(directory.callTool('fleet_status', {})).rejects.toThrow(/Cannot read hub token file/);
  });

  it('rejects with a timeout error when the hub never answers', async () => {
    fake = await startFakeHubServer(() => undefined);
    const transport = createHttpHubTransport({ socketPath: fake.socketPath, tokenFile, timeoutMs: 150 });
    const started = Date.now();
    await expect(transport.callTool('fleet_status', {})).rejects.toThrow('Luady hub did not answer within 0.15 s');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports an unreachable hub socket', async () => {
    const socketPath = testSocketPath();
    const transport = createHttpHubTransport({ socketPath, tokenFile });
    await expect(transport.callTool('fleet_status', {})).rejects.toThrow(`Luady hub is not reachable at ${socketPath}`);
  });

  it('defaults to a 180 s timeout and reads the token trimmed', async () => {
    expect(HUB_TIMEOUT_MS).toBe(180_000);
    await expect(readHubToken(tokenFile)).resolves.toBe(TOKEN);
  });
});
