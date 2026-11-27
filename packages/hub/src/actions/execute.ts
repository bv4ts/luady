import type { Channel, CtlExec } from '@luady/shared';
import type { PauseService } from '../activity/pause.js';
import type { Fleet, OwnerChannel, QuestionService, SessionService } from '../core/contracts.js';
import type { TicketStore } from '../security/tickets.js';
import { RefusedError, ValidationError } from '../core/errors.js';
import type { AccountTarget, ParsedAction } from './params.js';
import { resumeText } from './resume.js';
import { clipText } from './text.js';

/** Sign-in and sign-out (accounts/actions.ts). Neither result ever carries a link or a code. */
export interface AccountActions {
  /** From the chat (`channel` is its add-on id) the link is sent there by the sign-in itself; the result never holds it. */
  login(target: AccountTarget, channel?: Channel): Promise<string>;
  logout(target: AccountTarget): Promise<string>;
}

export interface ExecutorDeps {
  fleet: Fleet;
  sessions: SessionService;
  /** The owner's channel: `channel.unlink` asks the primary chat add-on to unlink. */
  channel: Pick<OwnerChannel, 'unlink'>;
  tickets: TicketStore;
  pauses: Pick<PauseService, 'pause' | 'resume'>;
  accounts?: AccountActions;
  /** The manager's answers to sessions' questions (`question.answer`). */
  questions?: Pick<QuestionService, 'check' | 'answer'>;
}

export interface ExecutionContext {
  actor: 'owner' | 'manager';
  channel: Channel;
  /** The website session that asked, kept in memory only: a terminal ticket is bound to it. */
  sid?: string;
}

/** server.exec timeout handed to luady-ctl. */
export const EXEC_TIMEOUT_SEC = 120;
/** Characters kept per output stream in an action result. */
export const EXEC_OUTPUT_MAX = 4000;

type SessionKind = 'session.start' | 'session.send' | 'session.interrupt' | 'session.stop' | 'session.restart' | 'session.delete';
type SessionAction = Extract<ParsedAction, { kind: SessionKind }>;
type PauseAction = Extract<ParsedAction, { kind: 'session.pause' | 'session.resume' }>;
type AccountAction = Extract<ParsedAction, { kind: 'account.login' | 'account.logout' | 'account.signed_in' }>;
type OtherAction = Exclude<ParsedAction, SessionAction | PauseAction | AccountAction>;

function clipOutput(text: string): string {
  return clipText(text, EXEC_OUTPUT_MAX, `\n… (${Math.max(0, text.length - EXEC_OUTPUT_MAX)} more chars)`);
}

export function formatExecResult(result: CtlExec): string {
  const flags = [result.timed_out ? 'timed out' : null, result.truncated ? 'output truncated by server' : null].filter(
    (flag): flag is string => flag !== null,
  );
  const header = `exit ${result.exit}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`;
  const parts = [
    header,
    result.stdout === '' ? null : `stdout:\n${clipOutput(result.stdout)}`,
    result.stderr === '' ? null : `stderr:\n${clipOutput(result.stderr)}`,
  ];
  return parts.filter((part): part is string => part !== null).join('\n');
}

async function runSessionAction(action: SessionAction, ctx: ExecutionContext, sessions: SessionService): Promise<string> {
  switch (action.kind) {
    case 'session.start': {
      const { server, cwd, prompt, name } = action.params;
      const session = await sessions.start({ server, cwd, prompt, name, origin: ctx.actor });
      return `started ${session.id} (${session.displayName})`;
    }
    case 'session.send':
      await sessions.send(action.params.sessionId, action.params.text, ctx.channel);
      return 'sent';
    case 'session.interrupt':
      await sessions.interrupt(action.params.sessionId);
      return 'interrupted';
    case 'session.stop':
      await sessions.stop(action.params.sessionId, action.params.force);
      return action.params.force ? 'stopped (forced)' : 'stopped';
    case 'session.restart':
      await sessions.restart(action.params.sessionId);
      return 'restarted';
    case 'session.delete':
      await sessions.remove(action.params.sessionId);
      return 'deleted; transcript moved to trash (restorable for 7 days)';
  }
}

async function runPauseAction(action: PauseAction, pauses: ExecutorDeps['pauses'], by: ExecutionContext['actor']): Promise<string> {
  if (action.kind === 'session.pause') {
    await pauses.pause(action.params.sessionId, by);
    return 'paused';
  }
  const outcome = await pauses.resume(action.params.sessionId, by);
  return resumeText({ wasHit: outcome.wasHit === true, sent: outcome.sent });
}

/** Where a command runs when none was named: the host's own home, else its projects folder (never a fixed path). */
export function execFolder(fleet: Pick<Fleet, 'hostInfo'>, server: string): string {
  const info = fleet.hostInfo(server);
  const folder = info?.homeDir ?? info?.projectsRoot ?? null;
  if (folder === null) throw new ValidationError(`No folder is known on ${server}: name one (cwd)`);
  return folder;
}

/** A terminal ticket opens one socket of the website session that asked for it, so a ticket needs that session. */
function issueTicket(tickets: TicketStore, params: { server: string; target?: string | undefined }, sid: string | undefined): string {
  if (sid === undefined || sid === '') throw new RefusedError('A terminal opens only from the website session that asks for it');
  const { server, target } = params;
  return tickets.issue(target === undefined ? { server, sid } : { server, target, sid });
}

async function runOtherAction(action: OtherAction, ctx: ExecutionContext, deps: ExecutorDeps): Promise<string> {
  switch (action.kind) {
    case 'server.exec': {
      const { server, command, cwd } = action.params;
      return formatExecResult(await deps.fleet.client(server).exec(command, cwd ?? execFolder(deps.fleet, server), EXEC_TIMEOUT_SEC));
    }
    case 'server.file_write': {
      const { server, path, content } = action.params;
      const written = await deps.fleet.client(server).fileWrite(path, content);
      return `wrote ${written.bytes} bytes to ${server}:${path}`;
    }
    case 'server.claude_update': {
      const update = await deps.fleet.client(action.params.server).updateClaude();
      return `Claude Code on ${action.params.server}: ${update.before ?? 'unknown'} → ${update.after ?? 'unknown'}`;
    }
    case 'channel.unlink':
      await deps.channel.unlink();
      return 'chat channel unlinked';
    case 'terminal.open':
      return issueTicket(deps.tickets, action.params, ctx.sid);
    case 'question.answer': {
      if (deps.questions === undefined) throw new RefusedError('Questions are not available on this hub');
      const question = await deps.questions.answer(action.params.qid, action.params.answers, ctx.channel);
      return `answered #${question.qid} (${question.sessionLabel})`;
    }
    case 'kb.write':
    case 'host.add':
    case 'host.pin':
    case 'host.kit':
    case 'host.edit':
    case 'host.remove':
    case 'host.local':
      // Records of the hosts flow and of knowledge-base writes (written through record); never requested as an action.
      throw new RefusedError(`${action.kind} is a record of the hosts flow, not an action`);
  }
}

async function runAccountAction(action: AccountAction, accounts: AccountActions | undefined, channel: Channel): Promise<string> {
  if (action.kind === 'account.signed_in') throw new RefusedError('account.signed_in is a record, not an action');
  if (accounts === undefined) throw new RefusedError('Sign-in is not available on this hub');
  return action.kind === 'account.login' ? accounts.login(action.params.target, channel) : accounts.logout(action.params.target);
}

function isAccountAction(action: ParsedAction): action is AccountAction {
  return action.kind === 'account.login' || action.kind === 'account.logout' || action.kind === 'account.signed_in';
}

function isPauseAction(action: ParsedAction): action is PauseAction {
  return action.kind === 'session.pause' || action.kind === 'session.resume';
}

function isSessionAction(action: ParsedAction): action is SessionAction {
  return action.kind.startsWith('session.') && !isPauseAction(action);
}

/** Runs one approved action against its dependency and returns a short result text. Errors propagate. */
export function executeAction(action: ParsedAction, ctx: ExecutionContext, deps: ExecutorDeps): Promise<string> {
  if (isAccountAction(action)) return runAccountAction(action, deps.accounts, ctx.channel);
  if (isPauseAction(action)) return runPauseAction(action, deps.pauses, ctx.actor);
  return isSessionAction(action) ? runSessionAction(action, ctx, deps.sessions) : runOtherAction(action, ctx, deps);
}
