import { readFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { z } from 'zod';
import { AddonIdSchema, AddonToolDefSchema, INTERNAL_PATHS, ToolResponseSchema, type AddonToolDef, type ToolResponse } from '@luady/shared';

/** End-to-end limit for one tool call (180 s; the hub's server_exec itself times out at 120 s). */
export const HUB_TIMEOUT_MS = 180_000;
/** An add-on tool may take up to 15 minutes in the hub; this waits a little longer. */
export const ADDON_TOOL_TIMEOUT_MS = 16 * 60_000;
/** The tool list is read once at start; a hub that does not answer quickly gets the built-in list instead. */
export const LIST_TIMEOUT_MS = 5_000;

/** `GET /internal/tools`: the built-in names the manager may call and each connected add-on's tools, with the add-on's id. */
export const ToolCatalogueSchema = z.object({ builtin: z.array(z.string()), addon: z.array(AddonToolDefSchema.extend({ addon: AddonIdSchema })) });
export type ToolCatalogue = { builtin: string[]; addon: Array<AddonToolDef & { addon: string }> };

/** The hub-token file holds HUB_SOCKET_TOKEN only — printable ASCII, no spaces. */
const TOKEN_RE = /^[\x21-\x7E]{16,1024}$/;
const UNREACHABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'ENOTSOCK', 'ECONNRESET', 'EPIPE']);

export class HubTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HubTransportError';
  }
}

export interface HubTransport {
  /** Resolves with the hub's ToolResponse; rejects with HubTransportError when the hub cannot be used. */
  callTool(name: string, input: unknown, opts?: { timeoutMs?: number }): Promise<ToolResponse>;
  /** The hub's tool list (built-in names plus add-on tools); rejects when the hub cannot be used. */
  listTools?(): Promise<ToolCatalogue>;
}

export interface HttpHubTransportOptions {
  socketPath: string;
  tokenFile: string;
  timeoutMs?: number;
}

export interface RawHubResponse {
  status: number;
  body: string;
}

interface RequestTarget {
  socketPath: string;
  path: string;
  token: string;
  timeoutMs: number;
  method?: 'GET' | 'POST';
}

function tokenFileError(err: unknown, tokenFile: string): HubTransportError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT'
    ? new HubTransportError(`Hub token file not found: ${tokenFile}`)
    : new HubTransportError(`Cannot read hub token file ${tokenFile} (${code ?? 'unknown error'})`);
}

/** Read on every call so a rotated token is picked up. The token itself never appears in any message. */
export async function readHubToken(tokenFile: string): Promise<string> {
  const raw = await readFile(tokenFile, 'utf8').catch((err: unknown) => {
    throw tokenFileError(err, tokenFile);
  });
  const token = raw.trim();
  if (!TOKEN_RE.test(token)) {
    throw new HubTransportError(`Hub token file is empty or malformed: ${tokenFile}`);
  }
  return token;
}

function toTransportError(err: unknown, target: RequestTarget, timedOut: boolean): HubTransportError {
  if (err instanceof HubTransportError) return err;
  if (timedOut) return new HubTransportError(`Luady hub did not answer within ${target.timeoutMs / 1000} s`);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return new HubTransportError(`Luady hub is not reachable at ${target.socketPath} (${code})`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new HubTransportError(`Luady hub request failed: ${message}`);
}

function requestOptions(target: RequestTarget, body: string, signal: AbortSignal): RequestOptions {
  return {
    socketPath: target.socketPath,
    path: target.path,
    method: target.method ?? 'POST',
    agent: false,
    signal,
    headers: target.method === 'GET'
      ? { authorization: `Bearer ${target.token}` }
      : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body, 'utf8'), authorization: `Bearer ${target.token}` },
  };
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
    res.on('close', () => {
      if (!res.complete) reject(new Error('response closed before it was complete'));
    });
  });
}

function sendRequest(target: RequestTarget, body: string): Promise<RawHubResponse> {
  const signal = AbortSignal.timeout(target.timeoutMs);
  return new Promise((resolve, reject) => {
    const fail = (err: unknown): void => reject(toTransportError(err, target, signal.aborted));
    const req = httpRequest(requestOptions(target, body, signal), (res) => {
      readBody(res).then((text) => resolve({ status: res.statusCode ?? 0, body: text }), fail);
    });
    req.on('error', fail);
    req.end(body);
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 200 → ToolResponse; 400 → { ok:false, error }; 401 → bad token; 404 → unknown tool. */
export function interpretResponse(name: string, raw: RawHubResponse): ToolResponse {
  if (raw.status === 401) throw new HubTransportError('Luady hub rejected the access token (HTTP 401)');
  const parsed = ToolResponseSchema.safeParse(parseJson(raw.body));
  if (parsed.success && (raw.status === 200 || !parsed.data.ok)) return parsed.data;
  if (raw.status === 404) throw new HubTransportError(`Luady hub does not know the tool ${name.slice(0, 64)} (HTTP 404)`);
  throw new HubTransportError(`Unexpected reply from the Luady hub (HTTP ${raw.status})`);
}

export function createHttpHubTransport(opts: HttpHubTransportOptions): HubTransport & Required<Pick<HubTransport, 'listTools'>> {
  const timeoutMs = opts.timeoutMs ?? HUB_TIMEOUT_MS;
  return {
    async callTool(name, input, call = {}) {
      const token = await readHubToken(opts.tokenFile);
      const target: RequestTarget = {
        socketPath: opts.socketPath,
        path: `${INTERNAL_PATHS.tools}/${encodeURIComponent(name)}`,
        token,
        timeoutMs: call.timeoutMs ?? timeoutMs,
      };
      return interpretResponse(name, await sendRequest(target, JSON.stringify(input ?? {})));
    },
    async listTools() {
      const token = await readHubToken(opts.tokenFile);
      const raw = await sendRequest({ socketPath: opts.socketPath, path: INTERNAL_PATHS.tools, token, timeoutMs: LIST_TIMEOUT_MS, method: 'GET' }, '');
      if (raw.status === 401) throw new HubTransportError('Luady hub rejected the access token (HTTP 401)');
      const parsed = ToolCatalogueSchema.safeParse(parseJson(raw.body));
      if (raw.status !== 200 || !parsed.success) throw new HubTransportError(`Unexpected tool list from the Luady hub (HTTP ${raw.status})`);
      return parsed.data;
    },
  };
}
