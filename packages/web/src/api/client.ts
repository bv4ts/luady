import {
  AccountsDTOSchema, ActionDTOSchema, ActionTextDTOSchema, ActivityListDTOSchema, AnswerBodySchema, ChatMessageDTOSchema, CodexLoginDTOSchema,
  CreateSessionBodySchema, CtlFileReadSchema, ExecBodySchema, FileWriteBodySchema, LuadyStatusDTOSchema, LoginCodeBodySchema,
  LoginResultDTOSchema, LoginStartDTOSchema, MeDTOSchema, NoticeListDTOSchema, OverviewDTOSchema,
  PasskeyRegisterOptionsBodySchema, PasskeyVerifyBodySchema, PinBodySchema, PinSchema, PresenceDTOSchema, PresenceForceBodySchema,
  LuadySendBodySchema, ProjectDTOSchema, QuestionDTOSchema, SendBodySchema, ServerDTOSchema, SessionDTOSchema, SessionDetailDTOSchema,
  SetPinBodySchema, SettingsPatchSchema, SettingsSchema, StopBodySchema, TerminalOpenBodySchema, TranscriptItemDTOSchema,
  pageSchema,
  type ActionStatus, type HostId, type SettingsPatch,
} from '@luady/shared';
import { z } from 'zod';
import { boardRoutes } from './board.js';
import { channelRoutes } from './channels.js';
import { clearPageKey } from '../auth/page-key.js';
import { createHttp, type Http, type HttpOptions } from './http.js';
import { jiraRoutes } from './jira.js';
import { kbRoutes } from './kb.js';
import { noteRoutes } from './notes.js';
import { saidRoutes } from './said.js';
import { recapRoutes } from './recap.js';
import { fleetRoutes } from './fleet.js';
import { winsRoutes } from './wins.js';
import { timelineRoutes } from './timeline.js';
import { scheduleRoutes } from './schedules.js';
import { linkRoutes } from './links.js';
import { prefsRoutes } from './prefs.js';
import { hostRoutes } from './hosts.js';
import { roomRoutes } from './rooms.js';
import { EMPTY, checked, query, seg, verbsFor, type Verbs } from './verbs.js';
import {
  CreationOptionsSchema, LuadySendResultSchema, ResumeAnswerSchema, LoginVerifySchema, RegisterVerifySchema, MemoryFileSchema, MemoryListSchema, OkSchema, PasskeyListSchema, RequestOptionsSchema,
  TicketSchema,
} from './schemas.js';

export type CreateSessionBody = z.input<typeof CreateSessionBodySchema>;
export type SendBody = z.input<typeof SendBodySchema>;
/** A message to Luady, optionally about a note, a card or a ticket. */
export type LuadySendBody = z.input<typeof LuadySendBodySchema>;
export type PinBody = z.input<typeof PinBodySchema>;
export type StopBody = z.input<typeof StopBodySchema>;
export type AnswerBody = z.input<typeof AnswerBodySchema>;
export type ExecBody = z.input<typeof ExecBodySchema>;
export type FileWriteBody = z.input<typeof FileWriteBodySchema>;
export type SetPinBody = z.input<typeof SetPinBodySchema>;
export type TerminalOpenBody = z.input<typeof TerminalOpenBodySchema>;
export type PasskeyRegisterOptionsBody = z.input<typeof PasskeyRegisterOptionsBodySchema>;
export type PasskeyVerifyBody = z.input<typeof PasskeyVerifyBodySchema>;
export type PresenceBody = z.input<typeof PresenceForceBodySchema>;
export type LoginCodeBody = z.input<typeof LoginCodeBodySchema>;
/** The notices the website keeps (the hub allows 1 to 200). */
export const NOTICES_LIMIT = 100;

const SessionListSchema = z.array(SessionDTOSchema);
const QuestionListSchema = z.array(QuestionDTOSchema);
const ActionListSchema = z.array(ActionDTOSchema);
const ServerListSchema = z.array(ServerDTOSchema);
const ProjectListSchema = z.array(ProjectDTOSchema);
const TranscriptPageSchema = pageSchema(TranscriptItemDTOSchema);
const ChatPageSchema = pageSchema(ChatMessageDTOSchema);

/** Auth routes also manage the CSRF token: `/api/me` and login set it, logout clears it. */
function authRoutes(http: Http, { get, post }: Verbs) {
  return {
    me: async () => {
      const me = await get('/api/me', MeDTOSchema);
      http.setCsrf(me.csrf);
      return me;
    },
    passkeyRegisterOptions: async (body: PasskeyRegisterOptionsBody) =>
      post('/api/auth/passkey/register/options', CreationOptionsSchema, checked(PasskeyRegisterOptionsBodySchema, body)),
    passkeyRegisterVerify: async (body: PasskeyVerifyBody) =>
      post('/api/auth/passkey/register/verify', RegisterVerifySchema, checked(PasskeyVerifyBodySchema, body)),
    passkeyLoginOptions: () => post('/api/auth/passkey/login/options', RequestOptionsSchema, EMPTY),
    passkeyLoginVerify: async (body: PasskeyVerifyBody) => {
      const result = await post('/api/auth/passkey/login/verify', LoginVerifySchema, checked(PasskeyVerifyBodySchema, body));
      http.setCsrf(result.csrf);
      return result;
    },
    logout: async () => {
      try {
        return await post('/api/auth/logout', OkSchema, EMPTY);
      } finally {
        http.setCsrf(null);
        clearPageKey();
      }
    },
    setPin: async (body: SetPinBody) => post('/api/auth/pin', OkSchema, checked(SetPinBodySchema, body)),
    passkeys: () => get('/api/auth/passkeys', PasskeyListSchema),
    deletePasskey: async (id: string, body: PinBody) =>
      post(`/api/auth/passkeys/${seg(id)}/delete`, OkSchema, checked(PinBodySchema, body)),
  };
}

function sessionRoutes({ get, post }: Verbs) {
  const session = (id: string, verb: string) => `/api/sessions/${seg(id)}/${verb}`;
  return {
    overview: () => get('/api/overview', OverviewDTOSchema),
    sessions: () => get('/api/sessions', SessionListSchema),
    transcript: (id: string, cursor: string | null, limit = 50) =>
      get(`${session(id, 'transcript')}${query({ cursor, limit })}`, TranscriptPageSchema),
    createSession: async (body: CreateSessionBody) => post('/api/sessions', ActionDTOSchema, checked(CreateSessionBodySchema, body)),
    sendToSession: async (id: string, body: SendBody) => post(session(id, 'send'), ActionDTOSchema, checked(SendBodySchema, body)),
    interruptSession: (id: string) => post(session(id, 'interrupt'), ActionDTOSchema, EMPTY),
    stopSession: async (id: string, body: StopBody) => post(session(id, 'stop'), ActionDTOSchema, checked(StopBodySchema, body)),
    restartSession: async (id: string, body: PinBody) => post(session(id, 'restart'), ActionDTOSchema, checked(PinBodySchema, body)),
    deleteSession: async (id: string, body: PinBody) => post(session(id, 'delete'), ActionDTOSchema, checked(PinBodySchema, body)),
  };
}

function inboxRoutes({ get, post }: Verbs) {
  return {
    questions: () => get(`/api/questions${query({ state: 'pending' })}`, QuestionListSchema),
    answerQuestion: async (qid: string, body: AnswerBody) =>
      post(`/api/questions/${seg(qid)}/answer`, QuestionDTOSchema, checked(AnswerBodySchema, body)),
    releaseQuestion: (qid: string) => post(`/api/questions/${seg(qid)}/release`, QuestionDTOSchema, EMPTY),
    actions: (filter: { status?: ActionStatus; limit?: number } = {}) =>
      get(`/api/actions${query({ status: filter.status, limit: filter.limit ?? 100 })}`, ActionListSchema),
    confirmAction: async (id: string, body: PinBody) =>
      post(`/api/actions/${seg(id)}/confirm`, ActionDTOSchema, checked(PinBodySchema, body)),
    denyAction: (id: string) => post(`/api/actions/${seg(id)}/deny`, ActionDTOSchema, EMPTY),
    actionText: (id: string) => get(`/api/actions/${seg(id)}/text`, ActionTextDTOSchema),
  };
}

function luadyRoutes({ get, post }: Verbs) {
  return {
    luadyMessages: (cursor: string | null, limit = 50) => get(`/api/manager/messages${query({ cursor, limit })}`, ChatPageSchema),
    sendToLuady: async (body: LuadySendBody) => post('/api/manager/messages', LuadySendResultSchema, checked(LuadySendBodySchema, body)),
    luadyStatus: () => get('/api/manager/status', LuadyStatusDTOSchema),
    memoryFiles: () => get('/api/manager/memory', MemoryListSchema),
    memoryFile: (name: string) => get(`/api/manager/memory/file${query({ name })}`, MemoryFileSchema),
  };
}

function serverRoutes({ get, post, put }: Verbs) {
  const serverPath = (server: HostId, verb: string) => `/api/servers/${seg(server)}/${verb}`;
  return {
    servers: () => get('/api/servers', ServerListSchema),
    projects: (server: HostId) => get(serverPath(server, 'projects'), ProjectListSchema),
    exec: async (server: HostId, body: ExecBody) => post(serverPath(server, 'exec'), ActionDTOSchema, checked(ExecBodySchema, body)),
    readFile: (server: HostId, path: string) => get(`${serverPath(server, 'file')}${query({ path })}`, CtlFileReadSchema),
    writeFile: async (server: HostId, body: FileWriteBody) =>
      put(serverPath(server, 'file'), ActionDTOSchema, checked(FileWriteBodySchema, body)),
    updateClaude: async (server: HostId, body: PinBody) =>
      post(serverPath(server, 'update-claude'), ActionDTOSchema, checked(PinBodySchema, body)),
    openTerminal: async (body: TerminalOpenBody) => post('/api/terminal/open', TicketSchema, checked(TerminalOpenBodySchema, body)),
  };
}

function settingsRoutes({ get, put }: Verbs) {
  return {
    settings: () => get('/api/settings', SettingsSchema),
    updateSettings: async (patch: SettingsPatch) => put('/api/settings', SettingsSchema, checked(SettingsPatchSchema, patch)),
  };
}

/** Live activity, pause, notices and presence. An older hub answers these with 404. */
function agencyRoutes({ get, post, put }: Verbs) {
  const session = (id: string, verb: string) => `/api/sessions/${seg(id)}/${verb}`;
  return {
    activity: () => get('/api/activity', ActivityListDTOSchema),
    sessionActivity: (id: string) => get(session(id, 'activity'), SessionDetailDTOSchema),
    pauseSession: (id: string) => post(session(id, 'pause'), ActionDTOSchema, EMPTY),
    resumeSession: (id: string) => post(session(id, 'resume'), ResumeAnswerSchema, EMPTY),
    notices: (limit = NOTICES_LIMIT) => get(`/api/notices${query({ limit })}`, NoticeListDTOSchema),
    presence: () => get('/api/presence', PresenceDTOSchema),
    setPresence: async (body: PresenceBody) => put('/api/presence', PresenceDTOSchema, checked(PresenceForceBodySchema, body)),
  };
}

/**
 * Starting a sign-in. A host that is signed in may need the PIN (it could move to another account): the hub then
 * answers 428 pin_required and the start is sent again with `{ pin }`. A signed-out host never needs one.
 */
const LoginStartBodySchema = z.strictObject({ pin: PinSchema.optional() });
export type LoginStartBody = z.input<typeof LoginStartBodySchema>;

/** Claude and ChatGPT sign-ins and their limits. A sign-in code goes only into the request body. */
function accountRoutes({ get, post }: Verbs) {
  const account = (host: HostId | 'codex', verb: string) => `/api/accounts/${seg(host)}/${verb}`;
  return {
    accounts: () => get('/api/accounts', AccountsDTOSchema),
    refreshAccount: (host: HostId) => post(account(host, 'refresh'), AccountsDTOSchema, EMPTY),
    loginAccount: async (host: HostId, body: LoginStartBody = EMPTY) =>
      post(account(host, 'login'), LoginStartDTOSchema, checked(LoginStartBodySchema, body)),
    submitLoginCode: async (host: HostId, body: LoginCodeBody) =>
      post(account(host, 'code'), LoginResultDTOSchema, checked(LoginCodeBodySchema, body)),
    logoutAccount: async (host: HostId | 'codex', body: PinBody) =>
      post(account(host, 'logout'), ActionDTOSchema, checked(PinBodySchema, body)),
    codexLogin: () => post(account('codex', 'login'), CodexLoginDTOSchema, EMPTY),
  };
}

/** One typed function per route, plus `csrf()`. */
export function createApiClient(options: HttpOptions = {}) {
  const http = createHttp(options);
  const verbs = verbsFor(http);
  return {
    csrf: (): string | null => http.csrf(),
    ...authRoutes(http, verbs),
    ...sessionRoutes(verbs),
    ...inboxRoutes(verbs),
    ...luadyRoutes(verbs),
    ...serverRoutes(verbs),
    ...settingsRoutes(verbs),
    ...agencyRoutes(verbs),
    ...accountRoutes(verbs),
    // Board, notes, knowledge pages, Jira, speech: an older hub answers 404, a stub hub 501 (changes) or empty lists (reads).
    ...boardRoutes(verbs),
    ...noteRoutes(verbs),
    ...kbRoutes(verbs),
    ...jiraRoutes(verbs),
    ...saidRoutes(verbs),
    // Recap, fleet, wins, timeline, schedules, links, prefs: an older hub answers 404, a stub hub 501 (changes) or empty answers (reads).
    ...recapRoutes(verbs),
    ...fleetRoutes(verbs),
    ...winsRoutes(verbs),
    ...timelineRoutes(verbs),
    ...scheduleRoutes(verbs),
    ...linkRoutes(verbs),
    ...prefsRoutes(verbs),
    // The rooms, the hosts (a host's grant goes in its own header) and the channels.
    ...roomRoutes(verbs),
    hosts: hostRoutes(verbs),
    channels: channelRoutes(http, verbs),
  };
}

export type LuadyApi = ReturnType<typeof createApiClient>;
