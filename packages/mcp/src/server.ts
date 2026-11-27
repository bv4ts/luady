import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { TOOL_DEFS, TOOL_NAMES, type ToolName } from '@luady/shared';
import { ADDON_TOOL_TIMEOUT_MS, type HubTransport, type ToolCatalogue } from './hub-transport.js';
import { buildToolList } from './tool-list.js';

/** The MCP server name is "hub" (mcp.json key), so Claude sees mcp__hub__<tool>. */
export const SERVER_INFO = { name: 'hub', version: '0.1.0' } as const;

export interface LuadyMcpDeps {
  hub: HubTransport;
  /** The hub's tool list read at start; null or absent: the built-in tools only (the fallback). */
  catalogue?: ToolCatalogue | null;
}

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

export function formatIssues(issues: readonly IssueLike[]): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(input)'}: ${issue.message}`)
    .join('; ');
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** An add-on tool goes to the hub as given: the hub checks its size, the add-on validates it. */
async function callAddonTool(hub: HubTransport, name: string, args: unknown): Promise<CallToolResult> {
  try {
    const response = await hub.callTool(name, args ?? {}, { timeoutMs: ADDON_TOOL_TIMEOUT_MS });
    return response.ok ? ok(response.text) : fail(response.error);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Validate with the zod schema, forward to the hub, and never throw: every failure is an isError result. */
export async function handleToolCall(
  hub: HubTransport, name: string, args: unknown, addonTools: ReadonlySet<string> = new Set(),
): Promise<CallToolResult> {
  if (addonTools.has(name)) return callAddonTool(hub, name, args);
  if (!isToolName(name)) {
    return fail(`Unknown tool "${name}". Only the mcp__hub__* tools listed by this server exist.`);
  }
  const schema: z.ZodType = TOOL_DEFS[name].input;
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    return fail(`Invalid arguments for ${name}: ${formatIssues(parsed.error.issues)}`);
  }
  try {
    const response = await hub.callTool(name, parsed.data);
    return response.ok ? ok(response.text) : fail(response.error);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function createLuadyMcpServer(deps: LuadyMcpDeps): Server {
  const tools = buildToolList(deps.catalogue ?? null);
  const builtin = new Set<string>(TOOL_NAMES);
  const addonTools = new Set(tools.map((tool) => tool.name).filter((name) => !builtin.has(name)));
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    handleToolCall(deps.hub, request.params.name, request.params.arguments, addonTools),
  );
  return server;
}
