import type { RouteModule } from '../context.js';
import { terminalRoutes } from '../terminal.js';
import { wsRoutes } from '../ws.js';
import { accountRoutes } from './accounts.js';
import { actionRoutes } from './actions.js';
import { activityRoutes } from './activity.js';
import { authRoutes } from './auth.js';
import { luadyRoutes } from './luady.js';
import { noticeRoutes } from './notices.js';
import { overviewRoutes } from './overview.js';
import { questionRoutes } from './questions.js';
import { serverRoutes } from './servers.js';
import { sessionRoutes } from './sessions.js';
import { settingsRoutes } from './settings.js';
import { googleRoutes } from './google.js';
import { wisprRoutes } from './wispr.js';
import { boardRoutes } from './board.js';
import { delegateRoutes } from './delegate.js';
import { missionRoutes } from './missions.js';
import { noteRoutes } from './notes.js';
import { saidRoutes } from './said.js';
import { kbRoutes } from './kb.js';
import { libraryRoutes } from './library.js';
import { jiraRoutes } from './jira.js';
import { recapRoutes } from './recap.js';
import { fleetHistoryRoutes } from './fleet-history.js';
import { winsRoutes } from './wins.js';
import { timelineRoutes } from './timeline.js';
import { scheduleRoutes } from './schedules.js';
import { linkRoutes } from './links.js';
import { prefsRoutes } from './prefs.js';
import { channelRoutes } from './channels.js';
import { connectRoutes } from './connect.js';
import { hostRoutes } from './hosts.js';
import { roomRoutes } from './rooms.js';
import { setupRoutes } from './setup.js';
import type { WebDeps } from '../server.js';

/** API and WebSocket route modules, registered in this order by buildWebServer. */
export const ROUTE_MODULES: readonly RouteModule[] = [
  authRoutes,
  overviewRoutes,
  sessionRoutes,
  activityRoutes,
  questionRoutes,
  actionRoutes,
  settingsRoutes,
  luadyRoutes,
  noticeRoutes,
  accountRoutes,
  serverRoutes,
  googleRoutes,
  wisprRoutes,
  // Board, delegation, missions, notes, speech, knowledge base, library and Jira.
  boardRoutes,
  delegateRoutes,
  missionRoutes,
  noteRoutes,
  saidRoutes,
  kbRoutes,
  libraryRoutes,
  jiraRoutes,
  // Recap, fleet history, wins, timeline, links, prefs; schedules sit on the scheduler.
  recapRoutes,
  fleetHistoryRoutes,
  winsRoutes,
  timelineRoutes,
  scheduleRoutes,
  linkRoutes,
  prefsRoutes,
  wsRoutes,
  terminalRoutes,
];

/**
 * The route modules of the optional services. Each registers only when its service is in WebDeps,
 * so a hub without it answers 404 there, never a crash.
 */
export const OPTIONAL_ROUTE_MODULES: ReadonlyArray<{ readonly service: 'rooms' | 'hosts' | 'channels' | 'setup' | 'connect'; readonly register: RouteModule }> = [
  { service: 'rooms', register: roomRoutes },
  { service: 'hosts', register: hostRoutes },
  { service: 'channels', register: channelRoutes },
  { service: 'setup', register: setupRoutes },
  { service: 'connect', register: connectRoutes },
] satisfies ReadonlyArray<{ service: keyof WebDeps; register: RouteModule }>;
