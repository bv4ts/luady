import { ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TOOL_DEFS, TOOL_NAMES, type AddonToolDef, type ToolName } from '@luady/shared';
import type { ToolCatalogue } from './hub-transport.js';

/** zod check names that toJSONSchema emits as `format` but JSON Schema does not define; their `pattern` already carries the rule. */
const ZOD_ONLY_FORMATS = new Set(['starts_with', 'ends_with', 'includes', 'lowercase', 'uppercase']);
/** Every add-on tool says which add-on it comes from: its description is the add-on's own text. */
export const addonPrefix = (addon: string): string => `(From the add-on ${addon}.) `;

function isZodOnlyFormat(key: string, value: unknown): boolean {
  return key === 'format' && typeof value === 'string' && ZOD_ONLY_FORMATS.has(value);
}

function cleanValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanValue);
  if (value !== null && typeof value === 'object') return cleanNode(value);
  return value;
}

function cleanNode(node: object): Record<string, unknown> {
  const kept = Object.entries(node).filter(([key, value]) => !isZodOnlyFormat(key, value));
  return Object.fromEntries(kept.map(([key, value]) => [key, cleanValue(value)]));
}

/**
 * JSON Schema 2020-12 for one tool input, input side: fields with defaults stay optional.
 * `$schema` is dropped because 2020-12 is MCP's default dialect and every byte here is context.
 */
export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = cleanNode(z.toJSONSchema(schema, { io: 'input' }));
  return Object.fromEntries(Object.entries(json).filter(([key]) => key !== '$schema'));
}

/** One MCP tool definition, validated against the SDK's ToolSchema (inputSchema must be an object schema). */
export function describeTool(name: ToolName): Tool {
  const def = TOOL_DEFS[name];
  return ToolSchema.parse({ name, description: def.description, inputSchema: toInputJsonSchema(def.input) });
}

/** An add-on's tool as MCP lists it, or null when its schema is not an object schema MCP accepts. */
export function describeAddonTool(def: AddonToolDef & { addon: string }): Tool | null {
  const parsed = ToolSchema.safeParse({ name: def.name, description: `${addonPrefix(def.addon)}${def.description}`, inputSchema: { ...def.input, type: 'object' } });
  return parsed.success ? parsed.data : null;
}

const isToolName = (name: string): name is ToolName => (TOOL_NAMES as readonly string[]).includes(name);

/**
 * The tools this server lists. With the hub's list (read once at start): the built-in tools it names, in TOOL_DEFS
 * order, then each add-on tool. Without it (the hub was not reachable): every built-in tool.
 */
export function buildToolList(catalogue: ToolCatalogue | null = null): Tool[] {
  if (catalogue === null) return TOOL_NAMES.map((name) => describeTool(name));
  const builtin = new Set(catalogue.builtin);
  const own = TOOL_NAMES.filter((name) => builtin.has(name)).map((name) => describeTool(name));
  const taken = new Set<string>(own.map((tool) => tool.name));
  const addons = catalogue.addon.flatMap((def) => {
    if (taken.has(def.name) || isToolName(def.name) && builtin.has(def.name)) return [];
    taken.add(def.name);
    const tool = describeAddonTool(def);
    return tool === null ? [] : [tool];
  });
  return [...own, ...addons];
}
