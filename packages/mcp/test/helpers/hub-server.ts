import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type Responder = (req: RecordedRequest, res: ServerResponse) => void;

export interface FakeHubServer {
  socketPath: string;
  requests: readonly RecordedRequest[];
  close(): Promise<void>;
}

/** A Unix socket path on Linux/macOS, a named pipe on Windows; node:http accepts both as socketPath. */
export function testSocketPath(): string {
  const id = randomBytes(6).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\luady-mcp-test-${id}` : join(tmpdir(), `luady-mcp-${id}.sock`);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A stand-in for the hub's internal API: records each request, then lets `respond` answer (or not). */
export async function startFakeHubServer(respond: Responder): Promise<FakeHubServer> {
  const socketPath = testSocketPath();
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      respond(recorded, res);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { socketPath, requests, close };
}
