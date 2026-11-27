import type { ToolName } from '@luady/shared';
import type { RoomsService, ToolHandler } from '../core/contracts.js';
import { roomsText } from '../rooms/rooms-file.js';
import { NOT_AVAILABLE_YET, defineTool } from './common.js';

/** The rooms service in the manager's tool context (wire/rooms.ts), added to the context by declaration merging. */
declare module '../core/contracts.js' {
  interface ToolContext {
    rooms?: RoomsService;
  }
}

/** `rooms_list`: read-only, the same lines as ROOMS.auto.md. */
export const ROOM_TOOLS = {
  rooms_list: defineTool('rooms_list', async (_args, ctx) => {
    if (ctx.rooms === undefined) return NOT_AVAILABLE_YET;
    const { items, grid } = ctx.rooms.list();
    return [`Rooms: ${items.length} (the office has ${grid.capacity} slots)`, roomsText(items)].join('\n');
  }),
} satisfies Partial<Record<ToolName, ToolHandler>>;
