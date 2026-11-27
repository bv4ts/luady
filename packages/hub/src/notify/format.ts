import { LIMITS, managerName, permissionAllowOffered } from '@luady/shared';
import { NUMBER_ANSWER_HINT } from '../questions/validate.js';
import type { AskQuestion, Channel, LuadyStatusDTO, PermissionPreview, QuestionDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { clock12, humanDuration } from '../core/time.js';
import { permissionBody, terminalOnlyNote, chatFence, chatNoAllowReason } from './permission-text.js';

export const ELLIPSIS = '…';
const FENCE = '`'.repeat(3);
const RESULT_MAX = 500;
const QUESTION_HINT = '↩️ Reply to this message: a number (1,3 for several), or your own answer.';
const MULTI_QUESTION_HINT = '(2+ questions: one line per question, in order.)';
const PERMISSION_HINT = '↩️ Reply *yes* to allow or *no* to deny (anything else = deny with your message).';
/** A request that offers no Allow (part of the command is hidden). */
const DENY_ONLY_HINT = '↩️ Reply *no* to deny (anything else = deny with your message).';
const FINISHED_HINT = '↩️ Reply to this message to continue this session.';
const CONFIRM_HINT = 'Reply to this message with your PIN to approve, or *no* to cancel. Expires in 30 min.';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Length in characters (code points), the unit the server kit uses for LIMITS. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** Cuts to at most `max` characters, `…` included, never inside a grapheme cluster. */
export function truncateChars(text: string, max: number): string {
  if (charCount(text) <= max) return text;
  if (max < 1) return '';
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const size = charCount(segment);
    if (used + size > max - 1) break;
    out += segment;
    used += size;
  }
  return out + ELLIPSIS;
}

function hardLimitIndex(text: string, max: number): number {
  let index = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (index + segment.length > max) break;
    index += segment.length;
  }
  return index > 0 ? index : Math.min(text.length, max);
}

/** Splits into chunks of at most `max` UTF-16 units (a chat channel's maxText), preferring newline, then space. */
export function splitForChat(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const hard = hardLimitIndex(rest, max);
    const window = rest.slice(0, hard);
    const newline = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    const cut = newline > 0 ? newline : space > 0 ? space : hard;
    chunks.push(rest.slice(0, cut));
    rest = cut === hard ? rest.slice(cut) : rest.slice(cut + 1);
  }
  chunks.push(rest);
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

export function sessionLabel(session: Pick<SessionDTO, 'host' | 'displayName'>): string {
  return `${session.host} · ${session.displayName}`;
}

export function questionLabel(question: QuestionDTO, session: SessionDTO | undefined): string {
  if (session) return sessionLabel(session);
  return question.sessionLabel.includes(' · ') ? question.sessionLabel : `${question.host} · ${question.sessionLabel}`;
}

function optionLine(option: AskQuestion['options'][number], index: number): string {
  const description = option.description?.trim();
  return description ? `${index + 1}) ${option.label} — ${description}` : `${index + 1}) ${option.label}`;
}

function questionBlock(question: AskQuestion, prefix: string): string {
  return [`${prefix}${question.question}`, ...question.options.map(optionLine)].join('\n');
}

/** Session questions and permission prompts stand apart from everything else Luady sends: 🔴, pinned until answered. */
export const ATTENTION = '🔴';

export function formatQuestion(label: string, qid: string, questions: readonly AskQuestion[]): string {
  const multi = questions.length > 1;
  const blocks = questions.map((q, i) => questionBlock(q, multi ? `${i + 1}. ` : ''));
  const hints = multi ? [QUESTION_HINT, MULTI_QUESTION_HINT] : [QUESTION_HINT];
  return [`${ATTENTION} *Needs your answer* · ${label}  #${qid}`, ...blocks, ...hints].join('\n');
}

/**
 * Built from the structured preview when the kit sent one (kit 2), else from the raw input text (kit 1). A request
 * that offers no Allow says why and asks only for a deny.
 */
export function formatPermission(
  label: string, qid: string, toolName: string, inputPreview: string, structured?: PermissionPreview | null,
): string {
  const head = `${ATTENTION} *Needs your OK* · ${label}  #${qid}`;
  // No Allow from the chat when part of the request is hidden, or when the chat had to cut it (any kind): either way the
  // owner would allow what they could not read. The note says which; the router refuses a yes on the same rule.
  const reason = chatNoAllowReason({ toolName, inputPreview, preview: structured });
  const hint = reason === null ? PERMISSION_HINT : DENY_ONLY_HINT;
  if (structured !== undefined && structured !== null) {
    return [head, ...permissionBody(inputPreview, structured, reason), hint].join('\n');
  }
  return [head, `Wants to use *${toolName}*:`, chatFence(inputPreview), ...(reason === null ? [] : [terminalOnlyNote(reason)]), hint].join('\n');
}

/** A pending question in full for Luady (question_list): exact option labels, numbered as the owner saw them. */
export function questionDetail(question: QuestionDTO): string {
  const head = `#${question.qid} · ${question.sessionLabel}`;
  if (question.kind === 'permission') {
    const how = question.permission === null || chatNoAllowReason(question.permission) === null
      ? 'the owner answers yes/no by replying to it'
      : !permissionAllowOffered(question.permission)
        ? 'no Allow from afar: part of it is hidden, so the owner denies it or answers in the terminal'
        : 'too long for the chat: there the owner can only deny it; they allow it on the website or in the terminal';
    return `${head} · wants to use ${question.permission?.toolName ?? 'a tool'} (${how})`;
  }
  const blocks = question.questions.map((q, i) => [
    `${i + 1}. ${q.question}${q.multiSelect ? ' (several allowed)' : ''}`,
    ...q.options.map((o, j) => `   ${j + 1}) ${o.label}`),
  ].join('\n'));
  return [head, ...blocks].join('\n');
}

export function formatPending(label: string, question: QuestionDTO): string {
  if (question.kind === 'permission' && question.permission) {
    const { toolName, inputPreview, preview } = question.permission;
    return formatPermission(label, question.qid, toolName, inputPreview, preview);
  }
  return formatQuestion(label, question.qid, question.questions);
}

export function formatFinished(label: string, durationSec: number, lastMessage: string): string {
  const head = `✅ *${label}* finished (${humanDuration(durationSec)})`;
  const excerpt = truncateChars(lastMessage.trim(), LIMITS.chatFinishedExcerpt);
  return (excerpt ? [head, '', excerpt, '', FINISHED_HINT] : [head, '', FINISHED_HINT]).join('\n');
}

export function formatError(label: string, error: string): string {
  const excerpt = truncateChars(error.trim(), LIMITS.chatErrorExcerpt);
  return excerpt ? `⚠️ *${label}* error\n${excerpt}` : `⚠️ *${label}* error`;
}

export function formatEnded(label: string, reason: string): string {
  return `💤 *${label}* ended unexpectedly (${reason.trim() || 'unknown'}).`;
}

/** The summary's first line says what; its further lines (a file's first lines, Luady's reason) follow as they are. */
export function formatConfirmation(summary: string, actionId: string): string {
  const [what = '', ...details] = summary.split('\n');
  return [`⚠️ ${managerName()} wants to: ${what} (#${actionId})`, ...details, CONFIRM_HINT].join('\n');
}

export function finishedLine(label: string, durationSec: number): string {
  return `✅ ${label} finished (${humanDuration(durationSec)})`;
}

export function errorLine(label: string): string {
  return `⚠️ ${label} error`;
}

export function endedLine(label: string, reason: string): string {
  return `💤 ${label} ended unexpectedly (${reason.trim() || 'unknown'})`;
}

export function formatBatch(lines: readonly string[]): string {
  return [`📦 *${lines.length} updates*`, ...lines].join('\n');
}

export function answerDeliveredAck(label: string): string {
  return `✔ Answer delivered to ${label}`;
}

export function sentAck(label: string): string {
  return `✔ Sent to ${label}`;
}

export function approvedAck(actionId: string, result: string | null): string {
  const text = result?.trim();
  return text ? `✔ Approved #${actionId}: ${truncateChars(text, RESULT_MAX)}` : `✔ Approved #${actionId}`;
}

export function cancelledAck(actionId: string): string {
  return `✖ Cancelled #${actionId}`;
}

export function alreadyNotice(qid: string, state: string): string {
  return `ℹ️ #${qid} was already ${state} — your reply was not sent.`;
}

export function waitingNotice(label: string, qid: string): string {
  return `ℹ️ ${label} is waiting for an answer to #${qid} — reply to that question first.`;
}

export function wrongPinNotice(remaining: number): string {
  return `⛔ Wrong PIN (${remaining} tries left)`;
}

export function pinLockedNotice(untilIso: string): string {
  return `🔒 PIN locked until ${clock12(new Date(untilIso))}`;
}

export function failedPinNotice(via: Channel, remaining: number): string {
  return `⚠️ Failed PIN attempt via ${via} (${remaining} tries left)`;
}

export function optionRangeHelp(qid: string, count: number): string {
  return `ℹ️ #${qid}: reply with a number from 1 to ${count} (1,3 for several), or with your own answer.`;
}

export function singleChoiceHelp(qid: string): string {
  return `ℹ️ #${qid} takes one option — reply with a single number, or with your own answer.`;
}

export function lineCountHelp(qid: string, count: number): string {
  return `ℹ️ #${qid} has ${count} questions — reply with one line per question, in order.`;
}

export function questionGoneNotice(qid: string): string {
  return `ℹ️ #${qid} is no longer available — your reply was not sent.`;
}

export function actionReplyHelp(actionId: string): string {
  return `ℹ️ Reply with your PIN to approve #${actionId}, or *no* to cancel.`;
}

export function actionFailedNotice(actionId: string, error: string | null): string {
  return `⚠️ #${actionId} failed: ${truncateChars(error?.trim() || 'unknown error', RESULT_MAX)}`;
}

export function releasedAck(qid: string): string {
  return `✔ #${qid} released to the terminal`;
}

export function notFoundNotice(message: string): string {
  return `ℹ️ ${message}`;
}

export function errorNotice(message: string): string {
  return `⚠️ ${message}`;
}

export const PIN_NOT_SET_NOTICE = '⚠️ No PIN is set yet — set one on the website first.';
export const PIN_LIKE_NOTICE =
  `ℹ️ That looks like a PIN, so it was not passed on to ${managerName()} or any session. To approve an action, reply to its confirmation message with your PIN. ${NUMBER_ANSWER_HINT}`;
export const TEXT_ONLY_NOTICE = 'ℹ️ I can only read text messages for now.';
export const NO_PENDING_NOTICE = 'ℹ️ No pending questions.';
export const AWAY_ON_ACK = '✔ Away mode on — every finished turn will be sent.';
export const AWAY_OFF_ACK = '✔ Away mode off';
export const LOCAL_USAGE = 'ℹ️ Usage: /local <qid>';
export const GENERIC_ERROR_NOTICE = '⚠️ Something went wrong — check the website.';
/** A chat message while the manager is switched off: it is not kept for later. */
export const MANAGER_OFF_NOTICE = 'ℹ️ The manager is switched off, so this message was not passed on. Commands like /status still work; switch the manager on in Settings on the website.';
export const LUADY_CRASH_NOTICE = `⚠️ ${managerName()} crashed 3 times in 10 minutes — retrying in 10 minutes.`;

export interface StatusInput {
  servers: readonly ServerDTO[];
  sessions: readonly SessionDTO[];
  pendingQuestions: number;
  pendingActions: number;
  luady: LuadyStatusDTO['state'];
  away: boolean;
}

const SERVER_DOT: Record<ServerDTO['status'], string> = { online: '🟢', offline: '🔴', connecting: '🟡' };

function sessionStatusLine(session: SessionDTO): string {
  const state = session.pendingQid ? `waiting for #${session.pendingQid}` : session.state.replace('_', ' ');
  return `• ${sessionLabel(session)} — ${state}`;
}

export function statusText(input: StatusInput): string {
  const servers = input.servers.length > 0
    ? input.servers.map((s) => `${s.name} ${SERVER_DOT[s.status]}`).join(' · ')
    : 'none';
  const live = input.sessions.filter((s) => s.state !== 'ended' && s.origin !== 'system');
  const lines = live.length > 0 ? live.map(sessionStatusLine) : ['No live sessions'];
  return [
    '📊 *Status*',
    `Servers: ${servers}`,
    ...lines,
    `Questions: ${input.pendingQuestions} · Confirmations: ${input.pendingActions}`,
    `${managerName()}: ${input.luady} · Away: ${input.away ? 'on' : 'off'}`,
  ].join('\n');
}

const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ['/status', 'servers and sessions at a glance'],
  ['/missions', 'open missions and their status'],
  ['/sessions', 'every session on your servers'],
  ['/new <server> <project> <task>', 'start a mission'],
  ['/today', `${managerName()} sums up today's work`],
  ['/todo', 'your to-do list'],
  ['/todo <text>', `add a card to your board at once (or say "add … to my to-do" to ${managerName()})`],
  ['/google', 'connect Gmail + Calendar accounts'],
  ['/wispr', `connect Wispr Flow so ${managerName()} notes every meeting`],
  ['/login [server]', `sign ${managerName()} (or one of your servers) in to Claude`],
  ['/login codex', 'connect ChatGPT for images'],
  ['/q', 'resend pending questions'],
  ['/mute <hours>', 'silence updates (questions still come); /mute off'],
  ['/away · /back', `away mode on/off (${managerName()} also tracks your own terminal work)`],
  ['/reset', `restart ${managerName()} fresh (memory kept)`],
  ['/local <qid>', 'answer a question in the terminal instead'],
  ['/help', 'this list'],
];

export function helpText(): string {
  return [
    `🤖 *${managerName()} commands*`,
    ...COMMANDS.map(([command, what]) => `${command} — ${what}`),
    `Reply to a question to answer it. Everything else (voice notes, photos and files too) goes to ${managerName()}.`,
  ].join('\n');
}

/** The chat profile's "About" line (max 139 characters), for a channel that has a profile. */
export const PROFILE_ABOUT = `${managerName()} 🤖 your AI assistant · send /help for all commands`;

/** The chat profile's description (max 512 characters): the command list. */
export function profileDescription(): string {
  const lines = [`I'm ${managerName()}, your AI assistant. Commands:`, ...COMMANDS.map(([command, what]) => `${command} – ${what}`)];
  const text = lines.join('\n');
  return text.length <= 512 ? text : `${text.slice(0, 511)}…`;
}

const STATE_ICON: Readonly<Record<string, string>> = {
  working: '⏳', idle: '💤', waiting_question: '❓', waiting_permission: '❓', error: '⚠️', starting: '🔄', ended: '⏹',
};

export function sessionsText(sessions: ReadonlyArray<Pick<SessionDTO, 'host' | 'displayName' | 'state'>>): string {
  const live = sessions.filter((session) => session.state !== 'ended');
  if (live.length === 0) return 'No sessions are running on your servers.';
  const hosts = [...new Set(live.map((session) => session.host))].sort();
  return hosts
    .map((host) => [`*${host}*`, ...live.filter((s) => s.host === host).map((s) => `${STATE_ICON[s.state] ?? '•'} ${s.displayName} · ${s.state.replace('_', ' ')}`)].join('\n'))
    .join('\n\n');
}
