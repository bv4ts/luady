import { SELF_HOST_ID, isSelfHost, type Channel, type HostId, managerName } from '@luady/shared';
import { LOOSE_CODE_RE } from '../claude-login/service.js';
import type { ChatLogin } from '../claude-login/chat-login.js';
import { listWords, loginUsage, signInFailedText, signInPinText } from '../claude-login/text.js';
import type {
  ActionService, BoardService, Fleet, LuadyService, Logger, MissionTracker, OutboundChannel, PhoneService, QuestionService, SessionService,
  SettingsService,
} from '../core/contracts.js';
import { clock12 } from '../core/time.js';
import {
  AWAY_OFF_ACK, AWAY_ON_ACK, LOCAL_USAGE, NO_PENDING_NOTICE, PIN_LIKE_NOTICE, formatPending, helpText,
  questionLabel, releasedAck, sessionsText, statusText,
} from '../notify/format.js';
import type { NoticeRouter } from '../notices/router.js';
import { noticeForError } from './errors.js';
import { postToLuady } from './held.js';
import { looksLikePin, type Command } from './parse.js';

export interface CommandDeps {
  /** The chat channel the command came from (an add-on id): replies, audit rows and answers carry it. */
  channel: Channel;
  log: Logger;
  outbound: OutboundChannel;
  questions: QuestionService;
  sessions: SessionService;
  actions: ActionService;
  luady: LuadyService;
  settings: SettingsService;
  phone: PhoneService;
  fleet: Fleet;
  missions?: Pick<MissionTracker, 'list'>;
  todos?: { render(): string };
  /** /todo <text> adds a card straight to the board, without a Luady turn. */
  board?: Pick<BoardService, 'add'>;
  /** Connected accounts + connect links, or null when Google is not set up. */
  googleStatus?: () => string | null;
  /** /login: Claude sign-in for the manager or a server, from the chat. */
  login?: ChatLogin;
  /** /wispr: connect Wispr Flow (meetings). */
  wispr?: { command(arg: string | null): Promise<string> };
  /** /q: a re-sent question counts as sent, so its website-first fallback does not repeat it. */
  notices?: Pick<NoticeRouter, 'sentElsewhere'>;
}

export type Reply = (text: string) => Promise<void>;

const MUTE_MAX_HOURS = 72;
const MUTE_USAGE = 'Usage: /mute <hours> (1-72) or /mute off';

/** The hosts of the fleet that sessions run on (its servers and this computer, never the manager's own host). */
const workHosts = (deps: CommandDeps): readonly HostId[] => deps.fleet.hosts().filter((id) => !isSelfHost(id));

/** /new without a usable server: the usage, with an example on the first host of the fleet. */
function newUsage(deps: CommandDeps): string {
  const first = workHosts(deps)[0];
  return `Usage: /new <server> <project> <task>${first === undefined ? '' : `\ne.g. /new ${first} web-app fix the login loop`}`;
}

/** /today for the manager: the day across the fleet's own hosts. */
function todayPrompt(deps: CommandDeps): string {
  const hosts = workHosts(deps);
  const across = hosts.length === 0 ? 'your servers' : listWords(hosts, 'and');
  return `/today: sum up today's work across ${across} in a few short lines: what finished, what is in progress, what needs me.`;
}

async function mute(arg: string | null, deps: CommandDeps, reply: Reply): Promise<void> {
  if (arg === 'off' || arg === '0') {
    deps.settings.update({ mute_until: null });
    return reply('🔔 Notifications are back on.');
  }
  const hours = arg === null ? NaN : Number(arg);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MUTE_MAX_HOURS) return reply(MUTE_USAGE);
  const until = new Date(Date.now() + hours * 60 * 60_000);
  deps.settings.update({ mute_until: until.toISOString() });
  return reply(`🔕 Muted until ${clock12(until)}. Questions still come. /mute off to undo.`);
}

async function startMission(server: string | null, project: string | null, task: string | null, deps: CommandDeps, reply: Reply): Promise<void> {
  if (server === null || project === null || task === null || !deps.fleet.hasServer(server)) return reply(newUsage(deps));
  const text = `/new mission on ${server}, project "${project}": ${task}\n(Start it as a mission: session_start, or session_send to that project's existing session.)`;
  return postToLuady(deps.luady, text, reply, deps.channel);
}

async function reset(deps: CommandDeps, reply: Reply): Promise<void> {
  const done = (await deps.luady.rotate?.(true)) ?? false;
  return reply(done ? `♻️ ${managerName()} restarted with a fresh conversation (memory files kept).` : `${managerName()} isn't running right now; it will start by itself.`);
}

function fleetStatus(deps: CommandDeps): string {
  return statusText({
    servers: deps.fleet.servers(),
    sessions: deps.sessions.list(),
    pendingQuestions: deps.questions.pending().length,
    pendingActions: deps.actions.pending().length,
    luady: deps.luady.status().state,
    away: deps.settings.get().away,
  });
}

async function resendPending(deps: CommandDeps, reply: Reply): Promise<void> {
  const pending = deps.questions.pending();
  if (pending.length === 0) return reply(NO_PENDING_NOTICE);
  for (const question of pending) {
    const label = questionLabel(question, deps.sessions.get(question.sessionId));
    const msgId = await deps.outbound.send(formatPending(label, question), { kind: 'question', refId: question.qid });
    deps.notices?.sentElsewhere('question', question.qid, msgId);
  }
}


async function releaseQuestion(qid: string | null, deps: CommandDeps, reply: Reply): Promise<void> {
  if (!qid) return reply(LOCAL_USAGE);
  try {
    await deps.questions.release(qid, deps.channel);
    return reply(releasedAck(qid));
  } catch (err) {
    return reply(noticeForError(err, { log: deps.log, qid }));
  }
}

/**
 * Every sign-in start is an audited action (without the link): the action sends the link on the chat itself. On a
 * signed-in host with PIN confirmations on, it waits for the owner's PIN in a reply to its own message.
 */
async function startSignIn(target: HostId | 'codex', deps: CommandDeps, reply: Reply): Promise<void> {
  const action = await deps.actions.request({ kind: 'account.login', actor: 'owner', channel: deps.channel, params: { target } });
  if (action.status === 'pending_confirmation' && target !== 'codex') {
    await deps.outbound.send(signInPinText(target, action.id), { kind: 'action', refId: action.id });
    return;
  }
  if (action.status === 'failed') {
    const error = action.error ?? 'unknown error';
    return reply(target === 'codex' ? `❌ ChatGPT sign-in failed: ${error}\nSend /login codex to try again.` : signInFailedText(target, error));
  }
}

/** /login → Luady; /login <host> → that host; /login codex → ChatGPT for images; /login <code> → the waiting sign-in. */
async function login(arg: string | null, deps: CommandDeps, reply: Reply): Promise<void> {
  if (arg?.toLowerCase() === 'codex') return startSignIn('codex', deps, reply);
  if (deps.login === undefined) return reply('Sign-in from the chat is not available.');
  const host = arg === null ? SELF_HOST_ID : arg.toLowerCase();
  if (isSelfHost(host) || deps.fleet.hasHost(host)) {
    await reply(`⏳ Starting the sign-in for ${isSelfHost(host) ? managerName() : host}…`);
    return startSignIn(host, deps, reply);
  }
  if (arg !== null && LOOSE_CODE_RE.test(arg)) return reply(await deps.login.submit(arg, deps.channel));
  return reply(loginUsage(workHosts(deps)));
}

async function addTodo(text: string, deps: CommandDeps, reply: Reply): Promise<void> {
  if (deps.board === undefined) return reply('The board is not available.');
  if (looksLikePin(text)) return reply(PIN_LIKE_NOTICE);
  const card = await deps.board.add({ title: text, source: 'chat' }, 'owner');
  return reply(`Added #${card.id}: ${card.title}`);
}

export async function runCommand(command: Command, deps: CommandDeps, reply: Reply): Promise<void> {
  switch (command.name) {
    case 'status':
      return reply(fleetStatus(deps));
    case 'q':
      return resendPending(deps, reply);
    case 'away':
      deps.settings.update({ away: true });
      return reply(AWAY_ON_ACK);
    case 'back':
      deps.settings.update({ away: false });
      return reply(AWAY_OFF_ACK);
    case 'local':
      return releaseQuestion(command.qid, deps, reply);
    case 'help':
      return reply(helpText());
    case 'missions': {
      const lines = deps.missions?.list() ?? [];
      return reply(lines.length > 0 ? lines.join('\n') : 'No open missions.');
    }
    case 'sessions':
      return reply(sessionsText(deps.sessions.list()));
    case 'google':
      return reply(deps.googleStatus?.() ?? 'Gmail and Calendar are not set up on the hub yet.');
    case 'todo':
      return reply(deps.todos?.render() ?? 'The to-do list is not available.');
    case 'todo_add':
      return addTodo(command.text, deps, reply);
    case 'mute':
      return mute(command.arg, deps, reply);
    case 'login':
      return login(command.arg, deps, reply);
    case 'wispr':
      return reply(deps.wispr === undefined ? 'Meetings are not set up on the hub.' : await deps.wispr.command(command.arg));
    case 'new':
      return startMission(command.server, command.project, command.task, deps, reply);
    case 'reset':
      return reset(deps, reply);
    case 'today':
      return postToLuady(deps.luady, todayPrompt(deps), reply, deps.channel);
  }
}
