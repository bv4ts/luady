import { isSelfHost, type BoardItemDTO, type ToolName } from '@luady/shared';
import type { BoardPatch, BoardService, ToolContext, ToolHandler } from '../core/contracts.js';
import { NotFoundError, RefusedError } from '../core/errors.js';
import { renderDetail } from '../board/render.js';
import { defineTool } from './common.js';

function board(ctx: ToolContext): BoardService {
  if (ctx.board === undefined) throw new RefusedError('The board is not available.');
  return ctx.board;
}

/** A session reference as todo_add / todo_update give it; the brain is never one. */
function sessionId(ref: string, ctx: ToolContext): string {
  const session = ctx.sessions.findByRef(ref);
  if (session === undefined || isSelfHost(session.host) || session.origin === 'system') throw new NotFoundError(`Unknown session "${ref}". fleet_status lists them.`);
  return session.id;
}

/** `due` / `snooze` as the board stores them (UTC ISO); null clears, undefined leaves it. */
function whenOf(value: string | null | undefined): string | null | undefined {
  return value === undefined || value === null ? value : new Date(value).toISOString();
}

/** The due and snooze part of a patch; empty when neither was given. */
function timesPatch(due: string | null | undefined, snooze: string | null | undefined): BoardPatch {
  const dueAt = whenOf(due);
  const snoozeUntil = whenOf(snooze);
  return { ...(dueAt === undefined ? {} : { dueAt }), ...(snoozeUntil === undefined ? {} : { snoozeUntil }) };
}

function where(card: BoardItemDTO): string {
  const parts = [card.project, card.server].filter((part): part is string => part !== null);
  return parts.length === 0 ? '' : ` (${parts.join(' · ')})`;
}

/** The to-do tools on the board. Every answer is one short line that names the card's #id. */
export const TODO_TOOLS = {
  todo_add: defineTool('todo_add', async (args, ctx) => {
    const linked = args.session === undefined ? null : sessionId(args.session, ctx);
    const added = await board(ctx).add({
      title: args.text, today: args.today, source: args.source,
      ...(args.details === undefined ? {} : { details: args.details }),
      ...(args.project === undefined ? {} : { project: args.project }),
      ...(args.server === undefined ? {} : { server: args.server }),
      ...(args.source_ref === undefined ? {} : { sourceRef: args.source_ref }),
      ...(linked === null ? {} : { sessionId: linked }),
    }, 'manager');
    // A new card takes no times: they are set right after, on the card the board just made.
    const times = timesPatch(args.due, args.snooze);
    const card = Object.keys(times).length === 0 ? added : await board(ctx).update(added.id, times, 'manager');
    const today = card.today ? " to today's pinned list" : '';
    return `Added #${card.id}${today}: ${card.title}${where(card)}${linked === null ? '' : ' · running'}`;
  }),
  todo_list: defineTool('todo_list', async (args, ctx) => board(ctx).render(args.state)),
  todo_get: defineTool('todo_get', async (args, ctx) => {
    const detail = board(ctx).detail(args.id);
    if (detail === null) throw new NotFoundError(`No card #${args.id}`);
    const session = detail.item.sessionId === null ? null : ctx.sessions.get(detail.item.sessionId) ?? null;
    return renderDetail(detail.item, detail.events, session, detail.mission, ctx.clock.now());
  }),
  todo_update: defineTool('todo_update', async (args, ctx) => {
    const service = board(ctx);
    const linked = args.session === undefined ? null : sessionId(args.session, ctx);
    const patch: BoardPatch = {
      ...(args.text === undefined ? {} : { title: args.text }),
      ...(args.details === undefined ? {} : { details: args.details }),
      ...(args.project === undefined ? {} : { project: args.project }),
      ...(args.server === undefined ? {} : { server: args.server }),
      ...(args.state === undefined ? {} : { state: args.state }),
      ...(args.result === undefined ? {} : { result: args.result }),
      ...(args.note === undefined ? {} : { note: args.note }),
      ...timesPatch(args.due, args.snooze),
    };
    if (service.get(args.id) === null) throw new NotFoundError(`No card #${args.id}`);
    if (linked !== null) await service.link(linked, [args.id]);
    const card = Object.keys(patch).length === 0 ? service.get(args.id) : await service.update(args.id, patch, 'manager');
    if (card === null) throw new NotFoundError(`No card #${args.id}`);
    return `Updated #${card.id}: ${card.title} · ${card.state}`;
  }),
  todo_done: defineTool('todo_done', async (args, ctx) => {
    const card = await board(ctx).update(args.id, { state: 'done', ...(args.result === undefined ? {} : { result: args.result }) }, 'manager');
    return `Done #${card.id}: ${card.title}`;
  }),
  todo_remove: defineTool('todo_remove', async (args, ctx) => {
    await board(ctx).remove(args.id, 'manager');
    return `Removed #${args.id}.`;
  }),
} satisfies Partial<Record<ToolName, ToolHandler>>;
