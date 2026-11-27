import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createHttpHubTransport } from './hub-transport.js';
import { createLuadyMcpServer, formatIssues } from './server.js';

/** Environment set by brain/.manager/mcp.json. Other variables are ignored. */
export const McpEnvSchema = z.object({
  LUADY_HUB_SOCKET: z.string().min(1),
  LUADY_HUB_TOKEN_FILE: z.string().min(1),
});
export type McpEnv = z.infer<typeof McpEnvSchema>;

export interface StdioOptions {
  env: Record<string, string | undefined>;
  stdin?: Readable;
  stdout?: Writable;
}

export interface RunningServer {
  close(): Promise<void>;
}

export function parseMcpEnv(env: Record<string, string | undefined>): McpEnv {
  const parsed = McpEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`luady-mcp: invalid environment: ${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

/** Validates the environment first, then serves MCP on stdin/stdout (defaults: the process streams). */
export async function startStdioServer(opts: StdioOptions): Promise<RunningServer> {
  const env = parseMcpEnv(opts.env);
  const hub = createHttpHubTransport({ socketPath: env.LUADY_HUB_SOCKET, tokenFile: env.LUADY_HUB_TOKEN_FILE });
  // The tool list is read once: add-on tools appear after a restart of the manager. Without the hub,
  // the built-in tools only.
  const catalogue = await hub.listTools().catch((err: unknown) => {
    process.stderr.write(`luady-mcp: listing the hub's tools failed, serving the built-in ones (${err instanceof Error ? err.message : String(err)})
`);
    return null;
  });
  const server = createLuadyMcpServer({ hub, catalogue });
  await server.connect(new StdioServerTransport(opts.stdin, opts.stdout));
  return { close: () => server.close() };
}
