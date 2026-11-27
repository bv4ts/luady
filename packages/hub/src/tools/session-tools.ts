import { isSelfHost, type SessionDTO, type ToolName, managerName } from '@luady/shared';
import { sessionLabel } from '../actions/text.js';
import type { ToolContext, ToolHandler } from '../core/contracts.js';
import { NotFoundError, RefusedError } from '../core/errors.js';
import { questionDetail } from '../notify/format.js';
import { checkProjectFolder, defineTool, formatActionResult, requestAsLuady } from './common.js';

const SUGGESTION_MAX = 8;
const MAX_EDIT_DISTANCE = 2;
const SEND_TEXT_MAX = 20_000;

/** Added to Luady's prompts so a session reports a ready result at once (kit luady-report), not only when its turn ends. */
export const REPORT_NOTE = `\n\n(From ${managerName()}: the moment something the owner is waiting for is ready (an account, a link, a change that is live, `
  + 'an answer), run `~/.luady/bin/luady-report "<one short line>"`, then carry on. Do not wait until you finish.)';

export function withReportNote(text: string): string {
  if (text.includes(REPORT_NOTE) || text.length + REPORT_NOTE.length > SEND_TEXT_MAX) return text;
  return `${text}${REPORT_NOTE}`;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

function isCloseMatch(session: SessionDTO, needle: string): boolean {
  const name = session.displayName.toLowerCase();
  return (
    name.includes(needle) ||
    needle.includes(name) ||
    session.id.toLowerCase().includes(needle) ||
    editDistance(name, needle) <= MAX_EDIT_DISTANCE
  );
}

/** A session the manager may steer: on any host but its own, and not the manager's own pane. */
const isWorker = (session: SessionDTO): boolean => !isSelfHost(session.host) && session.origin !== 'system';

export function unknownSessionMessage(ref: string, sessions: readonly SessionDTO[]): string {
  const live = sessions.filter((session) => isWorker(session) && session.state !== 'ended');
  const slash = ref.indexOf('/');
  const host = slash > 0 ? ref.slice(0, slash).toLowerCase() : null;
  const needle = (host !== null && live.some((session) => session.host === host) ? ref.slice(slash + 1) : ref).toLowerCase();
  const matches = live.filter((session) => isCloseMatch(session, needle));
  const shown = (matches.length > 0 ? matches : live)
    .slice(0, SUGGESTION_MAX)
    .map((session) => `${session.host}/${session.displayName} (${session.id})`);
  if (shown.length === 0) return `Unknown session "${ref}". No sessions are running on any server.`;
  return `Unknown session "${ref}". ${matches.length > 0 ? 'Did you mean' : 'Known sessions'}: ${shown.join(', ')}`;
}

/** Resolves a session reference to a worker session; the manager's own session is never a target. */
export function resolveSession(ref: string, ctx: ToolContext): SessionDTO {
  const found = ctx.sessions.findByRef(ref);
  if (found !== undefined && isWorker(found)) return found;
  throw new NotFoundError(unknownSessionMessage(ref, ctx.sessions.list()));
}

/** Cards handed over with a prompt (`todos`), checked before anything is sent; the paragraph the prompt gains. */
interface BoardItems { readonly ids: readonly number[]; readonly paragraph: string }

function boardItems(todos: readonly number[] | undefined, ctx: ToolContext): BoardItems {
  const ids = [...new Set(todos ?? [])];
  if (ids.length === 0) return { ids, paragraph: '' };
  if (ctx.board === undefined) throw new RefusedError('The board is not available, so todos cannot be linked.');
  return { ids, paragraph: ctx.board.briefFor(ids) };
}

function withBoardItems(text: string, cards: BoardItems): string {
  if (cards.paragraph === '') return text;
  const joined = text.trim() === '' ? cards.paragraph : `${text}

${cards.paragraph}`;
  return joined.length > SEND_TEXT_MAX ? text : joined;
}

/** `started <id> (<name>)` from the session.start action (actions/execute.ts). */
export function startedSessionId(result: string | null): string | null {
  return /^started (\S+)/.exec(result ?? '')?.[1] ?? null;
}

async function linkCards(sessionId: string, cards: BoardItems, ctx: ToolContext): Promise<void> {
  if (cards.ids.length > 0) await ctx.board?.link(sessionId, cards.ids);
}

function linkedNote(cards: BoardItems, linked: boolean): string {
  if (cards.ids.length === 0) return '';
  const list = cards.ids.map((id) => `#${id}`).join(', ');
  return linked ? `
Linked ${list}: the hub ticks them from the session's reports.` : `
${list} not linked (the action did not run).`;
}

export const SESSION_TOOLS = {
  session_read: defineTool('session_read', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    const text = await ctx.sessions.condensed(session.id, args.last_n);
    return `${sessionLabel(session)} · ${session.state}\n${text}`;
  }),
  session_send: defineTool('session_send', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    const cards = boardItems(args.todos, ctx);
    ctx.missions?.manage(session.id);
    const result = await requestAsLuady(ctx, 'session.send', { sessionId: session.id, text: withReportNote(withBoardItems(args.text, cards)) });
    if (result.status === 'done') await linkCards(session.id, cards, ctx);
    return `${formatActionResult(result)}${linkedNote(cards, result.status === 'done')}`;
  }),
  session_start: defineTool('session_start', async (args, ctx) => {
    checkProjectFolder(ctx.fleet, args.server, args.cwd);
    const cards = boardItems(args.todos, ctx);
    const prompt = args.prompt === '' && cards.ids.length === 0 ? '' : withReportNote(withBoardItems(args.prompt, cards));
    const params = {
      server: args.server,
      cwd: args.cwd,
      ...(prompt === '' ? {} : { prompt }),
      ...(args.name === undefined ? {} : { name: args.name }),
    };
    const result = await requestAsLuady(ctx, 'session.start', params);
    const started = result.status === 'done' ? startedSessionId(result.result) : null;
    if (started !== null) await linkCards(started, cards, ctx);
    return `${formatActionResult(result)}${linkedNote(cards, started !== null)}`;
  }),
  session_interrupt: defineTool('session_interrupt', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    return formatActionResult(await requestAsLuady(ctx, 'session.interrupt', { sessionId: session.id }));
  }),
  session_stop: defineTool('session_stop', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    const params = { sessionId: session.id, force: args.force, reason: args.reason };
    return formatActionResult(await requestAsLuady(ctx, 'session.stop', params));
  }),
  session_restart: defineTool('session_restart', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    return formatActionResult(await requestAsLuady(ctx, 'session.restart', { sessionId: session.id, reason: args.reason }));
  }),
  session_delete: defineTool('session_delete', async (args, ctx) => {
    const session = resolveSession(args.session, ctx);
    return formatActionResult(await requestAsLuady(ctx, 'session.delete', { sessionId: session.id, reason: args.reason }));
  }),
  question_list: defineTool('question_list', async (_args, ctx) => {
    const pending = ctx.questions.pending();
    return pending.length === 0 ? 'No pending questions.' : pending.map(questionDetail).join('\n\n');
  }),
  // An answer is typed into the session, so it follows the rule of session_send: the PIN outside an owner's turn.
  question_answer: defineTool('question_answer', async (args, ctx) =>
    formatActionResult(await requestAsLuady(ctx, 'question.answer', { qid: args.qid, answers: args.answers }))),
  question_release: defineTool('question_release', async (args, ctx) => {
    const question = await ctx.questions.release(args.qid, 'event');
    return `released #${question.qid} (${question.sessionLabel}) to the terminal dialog`;
  }),
} satisfies Partial<Record<ToolName, ToolHandler>>;
