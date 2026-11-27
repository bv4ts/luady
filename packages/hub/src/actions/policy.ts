import { posix } from 'node:path';
import { classifyCommand, classifyExec, type RiskVerdict } from '../security/risk.js';
import { isLocalHost, managerName, type HostId } from '@luady/shared';
import type { ParsedAction } from './params.js';
import { oneLine } from './text.js';
import { fileWriteSummary, typedTextSummary, visibleCommand, visibleText } from './visible.js';
import { hostLabel } from '../claude-login/text.js';

const REASON_MAX = 300;

export interface PolicyContext {
  /** The host's sign-in is known to be out right now (a sign-in there cannot move it off an account). */
  signedOut?: (host: HostId) => boolean;
  /** Who asks; the action service always says. */
  actor?: 'owner' | 'manager';
  /**
   * The manager asks while its running turn answers a message from the owner (the website, the phone or a chat app).
   * Anything else (a schedule, a hub event, a mission's reply, mail, a turn the hub cannot place) is not the owner's.
   */
  ownerTurn?: boolean;
}

/** The manager starts, steers or answers a session without the PIN only while it answers the owner. */
const NOT_OWNER_TURN: RiskVerdict = {
  tier: 1, reason: 'the manager starts, steers or answers a session without the PIN only while it answers a message from the owner',
};

/** "This computer" runs commands as the hub's own user, next to its secrets: whoever asks, the PIN approves each. */
const LOCAL_COMMAND: RiskVerdict = {
  tier: 1, reason: 'a command on this computer, where the hub itself runs, always needs the owner\'s PIN',
};

/**
 * Tiers: interrupt/pause/resume are tier 0; start/send and a question's answer (all typed into a session) are tier 0
 * for the owner, and for the manager only while it answers the owner; exec follows the classifier, except on this
 * computer (always tier 1, whoever asks); everything else needs a PIN. A sign-in start is tier 0 only on a host known to
 * be signed out: anywhere else it can move the host (Luady's own included) to another account. The Codex sign-in only
 * ever adds the owner's ChatGPT for pictures.
 */
export function tierOf(action: ParsedAction, ctx: PolicyContext = {}): RiskVerdict {
  switch (action.kind) {
    case 'session.start':
    case 'session.send':
    case 'question.answer':
      if (ctx.actor === 'manager' && ctx.ownerTurn !== true) return NOT_OWNER_TURN;
      return { tier: 0, reason: `${action.kind} needs no PIN here` };
    case 'session.interrupt':
    case 'session.pause':
    case 'session.resume':
    case 'account.signed_in':
      return { tier: 0, reason: `${action.kind} never needs a PIN` };
    case 'account.login': {
      const { target } = action.params;
      if (target === 'codex' || ctx.signedOut?.(target) === true) return { tier: 0, reason: 'a sign-in on a signed-out host needs no PIN' };
      return { tier: 1, reason: `${hostLabel(target)} is signed in: a new sign-in can move it to another account` };
    }
    case 'server.exec':
      if (isLocalHost(action.params.server)) return LOCAL_COMMAND;
      // The service names the host's folder before it asks (actions/service.ts); without one, relative paths are tier 1.
      return action.params.cwd === undefined ? classifyCommand(action.params.command) : classifyExec(action.params.command, action.params.cwd);
    default:
      return { tier: 1, reason: `${action.kind} changes state and needs the owner PIN` };
  }
}

export { visibleCommand } from './visible.js';

/** Manager-written text in a summary: on one line, cut, every hidden character marked. */
const preview = (text: string, max: number): string => visibleText(oneLine(text, max));

/** How much of a question names it under its answer: enough to tell questions apart, never enough to push the answer away. */
const QUESTION_LABEL_MAX = 60;

/**
 * A question's answers as one text, the manager's own words first: each answer on its own line(s), then the question it
 * answers as a short one-line label. The session writes the question, often long or on many lines; put first, it could
 * fill the five lines an approval shows and keep the answer out of view.
 */
function answersText(answers: Readonly<Record<string, string>>): string {
  return Object.entries(answers).map(([asked, answer]) => `${answer}\n(the answer to: ${oneLine(asked, QUESTION_LABEL_MAX)})`).join('\n');
}

/**
 * The whole text an action types or writes: a session's prompt or message, a file's content, an answer. The summary's
 * SHA-256 is of exactly this text, so the website's full view can be checked against it. Null for any other action.
 */
export function actionText(action: ParsedAction): string | null {
  switch (action.kind) {
    case 'session.start':
      return action.params.prompt === undefined || action.params.prompt === '' ? null : action.params.prompt;
    case 'session.send':
      return action.params.text;
    case 'server.file_write':
      return action.params.content;
    case 'question.answer':
      return answersText(action.params.answers);
    default:
      return null;
  }
}

function baseSummary(action: ParsedAction, labelFor: (sessionId: string) => string, questionLabel: (qid: string) => string | null): string {
  switch (action.kind) {
    case 'session.start': {
      const { server, cwd, prompt, name } = action.params;
      const head = `start session ${name ?? visibleText(posix.basename(cwd))} on ${server} in ${visibleText(cwd)}`;
      return prompt === undefined || prompt === '' ? head : typedTextSummary(`${head}, with this prompt`, prompt);
    }
    case 'session.send':
      return typedTextSummary(`send to ${labelFor(action.params.sessionId)}`, action.params.text);
    case 'question.answer': {
      const from = questionLabel(action.params.qid);
      return typedTextSummary(`answer question #${action.params.qid}${from === null ? '' : ` from ${from}`}`, answersText(action.params.answers));
    }
    case 'kb.write':
      return `write knowledge page #${visibleText(action.params.page)}`;
    case 'session.interrupt':
      return `interrupt session ${labelFor(action.params.sessionId)}`;
    case 'session.pause':
      return `pause session ${labelFor(action.params.sessionId)}`;
    case 'session.resume':
      return `resume session ${labelFor(action.params.sessionId)}`;
    case 'session.stop':
      return `${action.params.force ? 'force-stop' : 'stop'} session ${labelFor(action.params.sessionId)}`;
    case 'session.restart':
      return `restart session ${labelFor(action.params.sessionId)}`;
    case 'session.delete':
      return `delete session ${labelFor(action.params.sessionId)} (transcript to trash)`;
    case 'server.exec': {
      const where = action.params.cwd === undefined ? '' : ` in ${visibleText(action.params.cwd)}`;
      return `run on ${action.params.server}: \`${visibleCommand(action.params.command)}\`${where}`;
    }
    case 'server.file_write':
      return fileWriteSummary(action.params.server, action.params.path, action.params.content);
    case 'server.claude_update':
      return `update Claude Code on ${action.params.server}`;
    case 'channel.unlink':
      return 'unlink the chat channel';
    case 'account.login':
      return action.params.target === 'codex' ? 'start a ChatGPT (images) sign-in' : `start a Claude sign-in on ${hostLabel(action.params.target)}`;
    case 'account.logout':
      return action.params.target === 'codex' ? 'sign ChatGPT (images) out' : `sign ${hostLabel(action.params.target)} out`;
    case 'account.signed_in':
      return `${hostLabel(action.params.target)} signed in`;
    case 'host.add':
      return `add host ${action.params.host}`;
    case 'host.pin':
      return `pin the host key of ${action.params.host}`;
    case 'host.kit':
      return `change the kit on ${action.params.host}`;
    case 'host.edit':
      return `edit host ${action.params.host}`;
    case 'host.remove':
      return `remove host ${action.params.host}`;
    case 'host.local':
      return `set up this computer as ${action.params.host}`;
    case 'terminal.open': {
      const attach = action.params.target === undefined ? '' : ` attached to ${action.params.target}`;
      return `open a terminal on ${action.params.server}${attach}`;
    }
  }
}

/**
 * Human summary shown in the confirmation request and the audit log. Luady's reason, when it gave one, goes on a line of
 * its own with a label, so it can never read as part of what is being approved.
 */
export function describeAction(
  action: ParsedAction, labelFor: (sessionId: string) => string, questionLabel: (qid: string) => string | null = () => null,
): string {
  const base = baseSummary(action, labelFor, questionLabel);
  const reason = action.params.reason;
  return reason === undefined || reason.trim() === '' ? base : `${base}\n${managerName()}'s reason: ${preview(reason, REASON_MAX)}`;
}
