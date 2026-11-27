import type { ToolName, ToolResponse } from '@luady/shared';
import type { HubTransport } from '../../src/hub-transport.js';

export interface HubCall {
  name: ToolName;
  input: unknown;
}

export type FakeReply = (call: HubCall) => ToolResponse | Promise<ToolResponse>;

/** In-memory HubTransport that records every call and answers with `reply`. */
export function createFakeHub(
  reply: FakeReply = () => ({ ok: true, text: 'ok' }),
): HubTransport & { calls: HubCall[] } {
  const calls: HubCall[] = [];
  return {
    calls,
    async callTool(name, input) {
      const call: HubCall = { name, input };
      calls.push(call);
      return reply(call);
    },
  };
}
