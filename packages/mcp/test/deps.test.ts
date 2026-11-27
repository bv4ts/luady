import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { INTERNAL_PATHS, TOOL_DEFS, TOOL_NAMES, ToolResponseSchema } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('@luady/mcp wiring', () => {
  it('resolves @luady/shared from source with the 52 tools', () => {
    expect(TOOL_NAMES).toHaveLength(52);
    expect(Object.keys(TOOL_DEFS)).toEqual(TOOL_NAMES);
    expect(INTERNAL_PATHS.tools).toBe('/internal/tools');
    expect(ToolResponseSchema.safeParse({ ok: false, error: 'x' }).success).toBe(true);
  });

  it('has the zod 4 and MCP SDK APIs this package is built on', () => {
    expect(typeof z.toJSONSchema).toBe('function');
    expect(typeof Server).toBe('function');
    expect(typeof InMemoryTransport.createLinkedPair).toBe('function');
  });
});
