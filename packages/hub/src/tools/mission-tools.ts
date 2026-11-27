import type { ToolName } from '@luady/shared';
import { sessionLabel } from '../actions/text.js';
import type { ToolContext, ToolHandler } from '../core/contracts.js';
import { RefusedError, ValidationError } from '../core/errors.js';
import { defineTool } from './common.js';
import { resolveSession } from './session-tools.js';

function missions(ctx: ToolContext): NonNullable<ToolContext['missions']> {
  if (ctx.missions === undefined) throw new RefusedError('Mission tracking is not available.');
  return ctx.missions;
}

export const MISSION_TOOLS = {
  mission_update: defineTool('mission_update', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    if (args.note.trim() === '' && args.title === undefined) throw new ValidationError('mission_update needs a note or a title');
    await missions(ctx).note(session, args.note, args.title);
    return `Mission status for ${sessionLabel(session)} updated.`;
  }),
  mission_done: defineTool('mission_done', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    const wasOpen = await missions(ctx).finish(session, args.summary);
    return wasOpen
      ? `Mission ${sessionLabel(session)} closed: "mission done" sent to the owner.`
      : `No open mission for ${sessionLabel(session)}; sent the summary to the owner as a "mission done" message.`;
  }),
} satisfies Partial<Record<ToolName, ToolHandler>>;
