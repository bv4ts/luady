import type { ToolName } from '@luady/shared';
import type { ToolContext, ToolHandler } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { defineTool } from './common.js';

function meetings(ctx: ToolContext): NonNullable<ToolContext['meetings']> {
  if (ctx.meetings === undefined || ctx.meetings === null) throw new RefusedError('Meetings are not set up on the hub.');
  return ctx.meetings;
}

export const MEETING_TOOLS = {
  meeting_search: defineTool('meeting_search', async (args, ctx) => meetings(ctx).search({
    query: args.query, limit: args.limit,
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.until === undefined ? {} : { until: args.until }),
  })),
  meeting_get: defineTool('meeting_get', async (args, ctx) => meetings(ctx).get(args.id, args.transcript, args.start_char)),
  meeting_note: defineTool('meeting_note', async (args, ctx) => meetings(ctx).note(args.id, {
    ...(args.gist === undefined ? {} : { gist: args.gist }),
    ...(args.project === undefined ? {} : { project: args.project }),
    ...(args.note === undefined ? {} : { note: args.note }),
  })),
} satisfies Partial<Record<ToolName, ToolHandler>>;
