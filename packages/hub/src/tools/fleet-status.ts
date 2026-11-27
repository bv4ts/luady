import { isSelfHost, type ActionDTO, type QuestionDTO, type ServerDTO, type SessionDTO } from '@luady/shared';
import { oneLine } from '../actions/text.js';
import { defineTool } from './common.js';

const KB_PER_GB = 1024 * 1024;
const QUESTION_PREVIEW_MAX = 100;
const SUMMARY_PREVIEW_MAX = 160;

function freeGb(kb: number): string {
  return (kb / KB_PER_GB).toFixed(1);
}

function minutesSince(iso: string | null, nowMs: number): string {
  if (iso === null) return 'no activity yet';
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 'unknown' : `${Math.max(0, Math.floor((nowMs - at) / 60_000))}m ago`;
}

function formatServers(servers: readonly ServerDTO[]): string {
  if (servers.length === 0) return 'Servers: none configured';
  const lines = servers.map((server) => {
    const load = server.sysinfo === null ? '?' : server.sysinfo.load1.toFixed(2);
    const disk = server.sysinfo === null ? '?' : freeGb(server.sysinfo.disk_free_kb);
    return `- ${server.name} ${server.status} · load ${load} · disk ${disk} GB free`;
  });
  return ['Servers:', ...lines].join('\n');
}

/**
 * Every server of the fleet, plus any other host a live session runs on; the manager's own session and ended
 * sessions are left out.
 */
function formatSessions(servers: readonly ServerDTO[], sessions: readonly SessionDTO[], nowMs: number): string {
  const live = sessions.filter((session) => !isSelfHost(session.host) && session.origin !== 'system' && session.state !== 'ended');
  const hosts = [...new Set([...servers.map((server) => server.name), ...live.map((session) => session.host)])];
  if (hosts.length === 0) return 'Sessions: none';
  const blocks = hosts.map((host) => {
    const mine = live.filter((session) => session.host === host);
    if (mine.length === 0) return `${host}: no sessions`;
    const lines = mine.map((session) => `  - ${session.displayName} · ${session.state} · ${minutesSince(session.lastEventAt, nowMs)}`);
    return [`${host}:`, ...lines].join('\n');
  });
  return ['Sessions:', ...blocks].join('\n');
}

function questionPreview(question: QuestionDTO): string {
  if (question.kind === 'permission') return `wants to use ${question.permission?.toolName ?? 'a tool'}`;
  const first = oneLine(question.questions[0]?.question ?? '', QUESTION_PREVIEW_MAX);
  return question.questions.length > 1 ? `${first} (+${question.questions.length - 1} more)` : first;
}

function formatQuestions(questions: readonly QuestionDTO[]): string {
  if (questions.length === 0) return 'Pending questions: none';
  const lines = questions.map((question) => `- #${question.qid} ${question.sessionLabel}: ${questionPreview(question)}`);
  return ['Pending questions:', ...lines].join('\n');
}

function formatActions(actions: readonly ActionDTO[], nowMs: number): string {
  if (actions.length === 0) return 'Pending actions: none';
  const lines = actions.map(
    (action) => `- ${action.id} ${oneLine(action.summary, SUMMARY_PREVIEW_MAX)} (requested ${minutesSince(action.createdAt, nowMs)})`,
  );
  return ['Pending actions:', ...lines].join('\n');
}

export const fleetStatusTool = defineTool('fleet_status', async (_args, ctx) => {
  const nowMs = ctx.clock.now().getTime();
  const servers = ctx.fleet.servers();
  return [
    formatServers(servers),
    formatSessions(servers, ctx.sessions.list(), nowMs),
    formatQuestions(ctx.questions.pending()),
    formatActions(ctx.actions.pending(), nowMs),
  ].join('\n');
});
