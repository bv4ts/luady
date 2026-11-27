import { connectPagePath, type ConnectService } from '@luady/shared';
import { CODEX_SIGN_IN_AGAIN, codexSignInMoved, codexUserHome } from '../media/codex.js';
import { createAccountActions } from '../accounts/actions.js';
import { createLimitsStore } from '../accounts/limits.js';
import { createAccountsService } from '../accounts/service.js';
import type { AccountActions } from '../actions/execute.js';
import { createActionService } from '../actions/service.js';
import { createPauseService } from '../activity/pause.js';
import { createActivityService } from '../activity/service.js';
import { createBoardService } from '../board/index.js';
import { createClaudeLoginService } from '../claude-login/service.js';
import { isoNow } from '../core/time.js';
import { createClaudeUpdater } from '../daily/claude-update.js';
import { writeProjectsAuto } from '../daily/projects-file.js';
import { createFleetHistoryService } from '../fleet-history/index.js';
import { createIngester } from '../ingest/ingester.js';
import { createJiraService } from '../jira/index.js';
import { createKbService } from '../kb/index.js';
import { createLibraryService } from '../library/index.js';
import { createLinksService } from '../links/index.js';
import { createMemoryService } from '../memory/service.js';
import { createProjectsService } from '../projects/service.js';
import { createQuestionService } from '../questions/service.js';
import { createTicketStore } from '../security/tickets.js';
import { createSessionService } from '../sessions/service.js';
import { createWinsService } from '../wins/index.js';
import type { WireContext, Wired } from './context.js';

/** The website page that starts connecting a service, as a link only on an https origin. */
function connectPageUrl(origin: string, service: ConnectService): string | null {
  try {
    const url = new URL(connectPagePath(service), origin);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Work: memory, tickets, pauses, sessions and activity, questions, the ingester (its hosts a function of the fleet),
 * projects, actions, limits, the Claude sign-ins and the account actions, Jira, accounts (with the declared channels),
 * the Claude updater, the board, the knowledge base, the library, fleet history, wins and links. The activity service
 * and the ingester are the `feeds` phase: they start after every other service and stop before any.
 */
export function wireWork(ctx: WireContext): Wired {
  const { config, overrides } = ctx;
  const db = ctx.get('db');
  const bus = ctx.get('bus');
  const clock = ctx.get('clock');
  const log = ctx.get('log');
  const fleet = ctx.get('fleet');
  const settings = ctx.get('settings');
  const memory = ctx.provide('memory', createMemoryService({ db, clock }));
  const tickets = ctx.provide('tickets', createTicketStore(clock));
  const pauses = ctx.provide('pauses', createPauseService({
    fleet, log: log.child({ mod: 'pause' }), clock, bus, sessions: () => ctx.get('sessions'),
  }));
  const sessions = ctx.provide('sessions', createSessionService({
    db, bus, clock, fleet, memory, log,
    isPaused: pauses.isPaused, pausedBy: pauses.pausedBy, isHeld: pauses.isHeld, onReleased: pauses.onReleased, onPanes: pauses.sync,
    ensureSynced: pauses.ensureSynced,
    afterReconcile: () => ctx.get('activity').sweep(),
  }));
  const activity = ctx.provide('activity', createActivityService({
    bus, clock, log: log.child({ mod: 'activity' }), pauses, isSystem: (id) => sessions.get(id)?.origin === 'system',
    isLive: (id) => {
      const session = sessions.get(id);
      return session !== undefined && session.state !== 'ended';
    },
  }));
  const questions = ctx.provide('questions', createQuestionService({ db, bus, clock, fleet, memory, log }));
  const ingester = createIngester({ db, bus, clock, fleet, log, hosts: () => fleet.hosts(), activity });
  const projects = ctx.provide('projects', createProjectsService({
    db, clock, fleet, log,
    onUpdated: (all) => {
      const hosts = fleet.servers().map((server) => server.name);
      writeProjectsAuto(config.brainDir, all, isoNow(clock), hosts).catch((err: unknown) => log.warn({ err }, 'PROJECTS.auto.md not written'));
    },
  }));
  // Office names come from the rooms (wire/rooms.ts, wired after this module): read at call time.
  const officeName = (key: string): string => ctx.get('rooms').officeName(key);
  const accountActions = (): AccountActions => ctx.get('accountActions');
  const actions = ctx.provide('actions', createActionService({
    db, bus, clock, log, fleet, sessions, questions, pin: ctx.later('pin'), channel: ctx.later('ownerChannel'), tickets, pauses,
    requirePin: () => settings.get().require_pin,
    // The manager starts or steers a session without the PIN only while its running turn answers the owner: their own
    // message, or their Run or Give on the website. A turn the hub cannot place (none running, Remote Control) is not the
    // owner's (actions/policy.ts, luady/replies.ts ownerTurn).
    managerOwnerTurn: () => ctx.get('luady').ownerTurn?.() === true,
    accounts: { login: (target, channel) => accountActions().login(target, channel), logout: (target) => accountActions().logout(target) },
    // A sign-in start is tier 0 only on a host known to be signed out (actions/policy.ts).
    hostSignedOut: (host) => ctx.get('claudeLogin').statuses().find((status) => status.host === host)?.loggedIn === false,
  }));
  const limits = ctx.provide('limits', createLimitsStore(db));
  const claudeLogin = ctx.provide('claudeLogin', createClaudeLoginService({
    db, clock, log: log.child({ mod: 'claude-login' }), bus, fleet, settings, luady: ctx.later('luady'),
    // Every host the fleet lists: the self host only while the manager is switched on.
    hosts: () => fleet.hosts(),
    // Sign-in alerts: the service already decides when they may go at night; never held for the morning.
    outbound: ctx.lazy(() => ctx.get('toOwner')({ kind: 'system', source: 'hub', urgent: true })),
    // A finished sign-in leaves an audit row naming the host and its account (never the code).
    audit: (entry) => actions.record?.({
      kind: 'account.signed_in', actor: 'owner', channel: entry.via, params: { target: entry.host }, summary: entry.summary, result: 'signed in',
    }),
    // Limits follow the account: a host that moved or signed out drops what it reported for the old one.
    onAccountChange: (host, at) => limits.reset(host, at),
  }));
  ctx.provide('accountActions', createAccountActions({
    login: claudeLogin, codex: ctx.later('codexLogin'), bus, clock, chat: (text) => ctx.get('ownerChannel').send(text, null),
  }));
  const jira = ctx.provide('jira', createJiraService({
    db, bus, clock, log: log.child({ mod: 'jira' }), secret: config.sessionSecret, fetch: overrides.jiraFetch ?? globalThis.fetch,
    clientsPresent: () => ctx.get('presence').state().clients > 0, officeName,
  }));
  const accounts = ctx.provide('accounts', createAccountsService({
    bus, clock, log: log.child({ mod: 'accounts' }), fleet, login: claudeLogin, limits, codex: ctx.later('codexLogin'),
    // A ChatGPT sign-in made where an older release kept it is not used: Settings says to sign in again.
    codexNote: () => (codexSignInMoved(config.dataDir, codexUserHome()) ? CODEX_SIGN_IN_AGAIN : null),
    google: config.google ? ctx.later('google') : null,
    imapLabel: config.imap?.label ?? null, wisprConnected: () => ctx.get('meetings').connected(), jiraSites: () => jira.sites().sites,
    // The declared channels, read at call time.
    channels: () => ctx.get('channels').list(),
    officeName,
    connectUrl: (service) => connectPageUrl(config.publicOrigin, service),
  }));
  ctx.provide('claudeUpdater', createClaudeUpdater({
    fleet, sessions, log: log.child({ mod: 'claude-update' }), report: (text) => ctx.get('luady').postEvent(text, 'Event'),
  }));
  const board = ctx.provide('board', createBoardService({
    db, bus, clock, log: log.child({ mod: 'board' }), sessions, missions: ctx.later('missions'), luady: ctx.later('luady'), projects,
    todos: ctx.later('todos'), jira, notes: ctx.later('notes'),
    reminders: ctx.lazy(() => ctx.get('toOwner')({ kind: 'system', source: 'hub' })),
  }));
  const kb = ctx.provide('kb', createKbService({ db, bus, clock, log: log.child({ mod: 'kb' }), fleet, projects, officeName }));
  const library = ctx.provide('library', createLibraryService({
    bus, clock, log: log.child({ mod: 'library' }), fleet, projects, sessions, board, kb, brainDir: config.brainDir,
    rooms: () => ctx.get('rooms').list().items,
  }));
  const fleetHistory = ctx.provide('fleetHistory', createFleetHistoryService({
    bus, clock, log: log.child({ mod: 'fleet-history' }), fleet, accounts,
  }));
  const wins = ctx.provide('wins', createWinsService({ db, clock, log: log.child({ mod: 'wins' }) }));
  const links = ctx.provide('links', createLinksService({ db, bus, clock, log: log.child({ mod: 'links' }) }));

  return {
    name: 'work',
    services: {
      sessions, questions, actions, memory, projects, activity, pauses, accounts, limits, login: claudeLogin,
      board, kb, library, jira, fleetHistory, wins, links,
    },
    web: {
      sessions, questions, actions, projects, tickets, activity, pauses, accounts, login: claudeLogin,
      board, kb, library, jira, fleetHistory, wins, links,
    },
    tools: { sessions, questions, actions, projects, memory, accounts, board, kb, library, jira },
    async start(phase) {
      if (phase === 'services') {
        await ctx.start('pauses', () => pauses.start());
        await ctx.start('sessions', () => sessions.start());
        await ctx.start('questions', () => questions.start());
        await ctx.start('projects', () => projects.start());
        await ctx.start('claude-login', () => claudeLogin.start());
        await ctx.start('accounts', () => accounts.start());
        await ctx.start('board', () => board.start());
        await ctx.start('kb', () => kb.start());
        await ctx.start('library', () => library.start());
        await ctx.start('jira', () => jira.start());
        await ctx.start('fleet-history', () => fleetHistory.start());
      } else if (phase === 'feeds') {
        // Every bus subscriber is in place before the ingester emits.
        await ctx.start('activity', () => activity.start());
        await ctx.start('ingester', () => ingester.start());
      }
    },
    async stop(phase) {
      if (phase === 'feeds') {
        await ctx.stop('ingester', () => ingester.stop());
        await ctx.stop('activity', () => activity.stop());
      } else if (phase === 'services') {
        await ctx.stop('fleet-history', () => fleetHistory.stop());
        await ctx.stop('jira', () => jira.stop());
        await ctx.stop('library', () => library.stop());
        await ctx.stop('kb', () => kb.stop());
        await ctx.stop('board', () => board.stop());
        await ctx.stop('accounts', () => accounts.stop());
        await ctx.stop('claude-login', () => claudeLogin.stop());
        await ctx.stop('projects', () => projects.stop());
        await ctx.stop('questions', () => questions.stop());
        await ctx.stop('sessions', () => sessions.stop());
        await ctx.stop('pauses', () => pauses.stop());
      }
    },
  };
}
