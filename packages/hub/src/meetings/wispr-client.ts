import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Logger } from '../core/contracts.js';
import { WISPR_MCP_URL } from './wispr-auth.js';

/** One Wispr Flow MCP tool call; resolves to the parsed JSON result (or the plain text when it is not JSON). */
export interface WisprApi {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface WisprClientDeps {
  log: Logger;
  /** A valid access token (refreshed when needed). */
  token(): Promise<string>;
  /** Forget the cached access token so the next token() refreshes. */
  expire(): void;
  url?: string;
}

const CALL_TIMEOUT_MS = 60_000;

function isUnauthorized(err: unknown): boolean {
  return err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403);
}

interface ToolResult { content?: unknown; structuredContent?: unknown; isError?: boolean }

function textOf(result: ToolResult): string {
  const parts = Array.isArray(result.content) ? result.content : [];
  return parts
    .map((part: unknown) => (part !== null && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

export function parseToolResult(result: ToolResult): unknown {
  const text = textOf(result);
  if (result.isError === true) throw new Error(`Wispr Flow: ${text.slice(0, 300) || 'tool error'}`);
  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Wispr Flow's MCP over Streamable HTTP; the bearer token is added per request, a 401 refreshes it once. */
export function createWisprClient(deps: WisprClientDeps): WisprApi {
  let client: Client | null = null;

  async function connect(): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(deps.url ?? WISPR_MCP_URL), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${await deps.token()}`);
        return fetch(input, { ...init, headers });
      },
    });
    const fresh = new Client({ name: 'luady-hub', version: '1.0.0' });
    await fresh.connect(transport);
    return fresh;
  }

  async function drop(): Promise<void> {
    const old = client;
    client = null;
    await old?.close().catch(() => undefined);
  }

  return {
    async call(tool, args) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          client ??= await connect();
          const result = (await client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as ToolResult;
          return parseToolResult(result);
        } catch (err) {
          await drop();
          if (attempt === 0 && isUnauthorized(err)) {
            deps.log.info('wispr: access token refused, refreshing');
            deps.expire();
            continue;
          }
          throw err;
        }
      }
    },
    close: drop,
  };
}
