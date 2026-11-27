import type { Logger } from 'pino';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  ActionDTO, ActionStatus, Channel, ChatMessageDTO, CtlAuthCode, CtlAuthLogin, CtlAuthLogout, CtlAuthStatus, CtlConfig, CtlDelete, CtlExec, CtlFileGet, CtlFilePut, CtlFileRead, CtlFileWrite, CtlGraphifyRun, CtlGraphQuery,
  CtlPause, CtlPending, CtlProjects, CtlResume, CtlSessions, CtlStart, CtlStop, CtlSysinfo, CtlTranscript, CtlUpdate, CtlVersion,
  HelperDTO, HostId, LuadyStatusDTO, RoomImport, NoticeDTO, PermissionAnswerFile, PresenceDTO, ProjectDTO, QuestionAnswerFile, QuestionDTO, RateWindowDTO, ServerDTO,
  SessionActivityDTO, SessionDTO, Settings, SettingsPatch, SpoolEvent, StepDTO, TodoItem, TranscriptItemDTO,
  BoardItemDTO, BoardItemDetailDTO, BoardPriority, BoardSource, BoardState, CreateKbPageBody, CreateNoteBody, CtlGitStatus, CtlKbFile,
  CtlKbPut, CtlSkills, DelegateBody, DelegateResultDTO, JiraBoardDTO, JiraEditBody, JiraIssueDTO, JiraIssueDetailDTO, JiraSiteDTO,
  JiraSitesDTO, JiraView, KbAuthor, KbListDTO, KbPageDTO, KbPageFullDTO, KbScope, LibraryDTO, MissionDTO, NoteDTO, NoteTranscriptDTO,
  SaidDTO, UpdateKbPageBody, UpdateNoteBody,
  CreateLinkBody, FleetHistoryDTO, LinkDTO, RecapDTO, TimelineDTO, UpdateLinkBody, UpdateWebPrefsBody, WebPrefsDTO, WinsDTO,
  ChannelInfoDTO, HostDTO, HostJobDTO, RoomDTO, RoomsDTO, SetupStateDTO,
} from '@luady/shared';

export type Db = BetterSqlite3.Database;
export type { Logger };

export interface Clock { now(): Date; }

export interface ServerConfig {
  name: HostId; host: string; user: string; port: number; hostKeyFp: string;
  /** The host's folders and Claude Code, and an address restriction for its key line. */
  projectsRoot?: string | undefined; homeDir?: string | undefined; claudeBin?: string | undefined; fromAddr?: string | undefined;
}

export interface HubConfig {
  servers: ServerConfig[];
  fleetKeyPath: string;
  dataDir: string;
  brainDir: string;
  runDir: string;
  webDir: string;
  webPort: number;
  publicOrigin: string;
  rpId: string;
  /** The owner's phone number (digits, with the country code): present only when the phone is set up. */
  ownerPhone?: string | undefined;
  /** The owner's Access e-mail: present only in `cloudflare-access` mode. */
  ownerEmail?: string | undefined;
  /** Cloudflare Access only (`authMode: 'cloudflare-access'`): the team domain. */
  cfTeamDomain?: string | undefined;
  /** Cloudflare Access only: the application's AUD tag (CF_ACCESS_AUD in secrets.env). */
  cfAccessAud?: string | undefined;
  sessionSecret: string;
  hubSocketToken: string;
  claudePath: string;
  localCtlPath: string;
  remoteCtlPath: string;
  /** https://voice.<domain>, Twilio's way in (tunnel → 127.0.0.1:7411). Phone stays off without it. */
  voiceOrigin?: string;
  /** TWILIO_* from secrets.env; null = phone off. */
  twilio: { accountSid: string; authToken: string; from: string } | null;
  /** GOOGLE_CLIENT_ID/SECRET from secrets.env; null = no Gmail/Calendar. */
  google: { clientId: string; clientSecret: string } | null;
  /** IMAP_* from secrets.env; null = no extra mailbox. */
  imap: { host: string; port: number; user: string; password: string; label: string } | null;
  /** "This computer": the seed of the local host row (id `computer`); absent until the config file names one. */
  localHost?: { projectsRoot: string; claudeBin?: string | undefined; ctlPath?: string | undefined } | undefined;
  /** The manager's own home folder (default `<dataDir>/manager-home`). */
  managerHome: string;
  managerFiles: 'own-folder' | 'any';
  /** Imported once into an empty rooms table. */
  rooms?: RoomImport[] | undefined;
  addons: Array<{ id: string; kind: 'channel' | 'tools'; name: string; owner?: string | undefined; primary?: boolean | undefined }>;
  fleetFrom?: string[] | undefined;
  /** The web server's listen address (default 127.0.0.1). */
  bindHost: string;
  allowRemote: boolean;
  /** The Host values the hub answers to (default: the host of publicOrigin). */
  allowedHosts: string[];
  trustedProxy: 'cloudflare' | null;
  authMode: 'local' | 'cloudflare-access';
  ownerLabel: string;
}

export interface HubEvents {
  'server.updated': ServerDTO;
  'session.updated': SessionDTO;
  'session.removed': { id: string };
  'question.updated': QuestionDTO;
  'action.updated': ActionDTO;
  'manager.message': ChatMessageDTO;
  'manager.status': LuadyStatusDTO;
  'settings.updated': Settings;
  'spool.event': { host: HostId; event: SpoolEvent; replay: boolean };
  'turn.finished': { session: SessionDTO; durationSec: number; remote: boolean; lastMessage: string; replay: boolean };
  'session.failed': { session: SessionDTO; error: string; replay: boolean };
  'session.ended': { session: SessionDTO; unexpected: boolean; reason: string; replay: boolean };
  'usage.notice': { session: SessionDTO; message: string; replay: boolean };
  /** A session ran `luady-report` mid-turn: a result the owner waits for is ready now. */
  'session.report': { session: SessionDTO; text: string; replay: boolean };
  'transcript.appended': { sessionId: string; items: TranscriptItemDTO[] };
  /** Map views of the sessions whose view changed; at most one a second (activity/service.ts). */
  'activity.updated': { items: SessionActivityDTO[] };
  /** Changed steps of one watched session, collected for 250 ms; `todos`/`helpers` null = unchanged. */
  'steps.appended': { sessionId: string; steps: StepDTO[]; todos: TodoItem[] | null; helpers: HelperDTO[] | null };
  /** Every status-line reading at once (plan limits per host); `sessionId` null when the pane is unknown. */
  'meters.updated': { host: HostId; sessionId: string | null; fiveHour: RateWindowDTO | null; sevenDay: RateWindowDTO | null; at: string };
  /** Where Luady-started updates go right now (notices/presence.ts); only when mode, online or forcedUntil changed. */
  'presence.updated': PresenceDTO;
  /** A notice was stored (notices/router.ts): on the website now, maybe with a chat fallback. */
  'notice.created': NoticeDTO;
  /** Seen, answered, delivered by the fallback, or moved past quiet hours. */
  'notice.updated': NoticeDTO;
  /** The fallback put this notice on the chat just now; `msgId` null = the channel queued it. Hub-internal. */
  'notice.delivered': { notice: NoticeDTO; msgId: string | null };
  /** A sign-in started, finished or was signed out, a check found a new state, or limits moved (accounts/). */
  'accounts.changed': { at: string };
  // ── Forwarded to every website client by web/ws.ts fanOut ──
  /** Cards that changed (board/). */
  'board.updated': { items: BoardItemDTO[] };
  'board.removed': { ids: number[] };
  /** A mission opened, moved on or changed its note (board/, from missions/). */
  'mission.updated': MissionDTO;
  'mission.removed': { sessionId: string; outcome: 'done' | 'ended'; summary: string | null };
  /** What an agent said (said/); never Luady's own session, never a replay. */
  'session.said': SaidDTO;
  /** Notes, knowledge pages, the library or one office's Jira changed: the website refetches. */
  'notes.changed': { at: string };
  'kb.changed': { at: string };
  'library.changed': { at: string };
  /** The room whose Jira site changed (Jira sites are keyed by room). */
  'jira.changed': { room: string; at: string };
  // ── Schedules, links and preferences: forwarded to every website client by web/ws.ts fanOut ──
  /** A schedule was added, cancelled or ran (scheduler/, through app.ts). */
  'schedules.changed': { at: string };
  /** A link was added, changed or removed (links/). */
  'links.changed': { at: string };
  /** The website preferences changed (prefs/). */
  'prefs.changed': { at: string };
  // ── Forwarded by web/ws.ts fanOut; rooms and hosts carry full lists (coalesced by their services) ──
  'rooms.changed': { rooms: RoomDTO[]; at: string };
  'hosts.changed': { hosts: HostDTO[]; at: string };
  /** A host job (kit install, …) changed state: to every client. */
  'host.job': { host: string; job: string; state: HostJobDTO['state']; summary?: string; error?: string };
  /** One line of a host job's log: only to sockets subscribed to that host (`subscribe.host`). */
  'host.log': { host: string; job: string; line: string; at: string };
  'channel.status': { channel: ChannelInfoDTO };
  'setup.changed': { state: SetupStateDTO };
}

export interface EventBus {
  emit<K extends keyof HubEvents>(name: K, payload: HubEvents[K]): void;
  on<K extends keyof HubEvents>(name: K, fn: (payload: HubEvents[K]) => void): () => void;
}

export type CtlKey = 'Escape' | 'C-c' | 'Enter';
export interface StartArgs { name: string; cwd: string; model?: string; resume?: string; prompt?: string; }
export interface TranscriptWindow { tail?: number; from?: number; before?: number; max?: number; }

export interface ShellStream {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  close(): void;
}

export interface CtlClient {
  version(): Promise<CtlVersion>;
  sysinfo(): Promise<CtlSysinfo>;
  sessions(): Promise<CtlSessions>;
  pending(): Promise<CtlPending>;
  answer(qid: string, payload: QuestionAnswerFile): Promise<void>;
  permission(qid: string, payload: PermissionAnswerFile): Promise<void>;
  send(target: string, text: string): Promise<void>;
  keys(target: string, key: CtlKey): Promise<void>;
  start(args: StartArgs): Promise<CtlStart>;
  stop(target: string, force: boolean): Promise<CtlStop>;
  restart(target: string): Promise<void>;
  remove(sessionId: string): Promise<CtlDelete>;
  transcript(sessionId: string, window: TranscriptWindow): Promise<CtlTranscript>;
  capture(target: string, lines: number): Promise<string>;
  updateClaude(): Promise<CtlUpdate>;
  projects(): Promise<CtlProjects>;
  exec(command: string, cwd: string, timeoutSec: number): Promise<CtlExec>;
  fileRead(path: string, maxBytes: number): Promise<CtlFileRead>;
  /** Whole file as base64; refused when larger than maxBytes. */
  fileGet(path: string, maxBytes: number): Promise<CtlFileGet>;
  /** Base64 bytes into ~/luady-inbox/<name> on the server (never overwrites). */
  filePut(name: string, b64: string): Promise<CtlFilePut>;
  /** `graphify update` on a project (nightly code map, no LLM). */
  graphifyRun(path: string, timeoutSec: number): Promise<CtlGraphifyRun>;
  /** `graphify query` against a project's code map. */
  graphQuery(path: string, question: string, budget: number): Promise<CtlGraphQuery>;
  fileWrite(path: string, content: string): Promise<CtlFileWrite>;
  getConfig(): Promise<CtlConfig>;
  setConfig(key: 'remote_answering' | 'hook_wait_seconds', value: string): Promise<CtlConfig>;
  /** `claude auth status`: signed in, as whom, and when the login runs out. */
  authStatus(): Promise<CtlAuthStatus>;
  /** Starts `claude auth login` on the host and returns its sign-in link. */
  authLogin(): Promise<CtlAuthLogin>;
  /** Types the owner's sign-in code into the waiting login (stdin only). */
  authCode(code: string): Promise<CtlAuthCode>;
  /** `claude auth logout` on the host; resolves with the sign-in state afterwards (kit 2; kit 1 answers `usage`). */
  authLogout(): Promise<CtlAuthLogout>;
  /** Kit 2: sets the pane's pause flag; the session stops at its next tool call. */
  pause(target: string): Promise<CtlPause>;
  /** Kit 2: clears the flag and, when the pause had stopped the session, types the resume text. */
  resume(target: string): Promise<CtlResume>;
  /** Kit 2.1: the Claude Code skills installed on the host (user, project and plug-in). */
  skills(): Promise<CtlSkills>;
  /** Kit 2.1: writes knowledge-base files into ~/luady-kb/ (JSON on stdin); `prune` removes files not listed. */
  kbPut(files: readonly CtlKbFile[], prune: boolean): Promise<CtlKbPut>;
  /** Kit 2.1: branch, uncommitted work and unpushed commits per project. */
  gitStatus(): Promise<CtlGitStatus>;
}

/** A host the fleet reaches: the self host, an SSH server, or "this computer". */
export interface FleetHostInfo {
  readonly id: HostId;
  readonly kind: 'self' | 'ssh' | 'local';
  /** Where sessions start on this host; null for the self host, which takes none. */
  readonly projectsRoot: string | null;
  /** The host's home: its row's, else the usual home of its user; null for the self host (and when unknown). */
  readonly homeDir: string | null;
  /** The web terminal: SSH servers only. */
  readonly terminal: boolean;
}

export interface Fleet {
  start(): Promise<void>;
  stop(): Promise<void>;
  client(host: HostId): CtlClient;
  servers(): ServerDTO[];
  openShell(server: HostId, opts: { cols: number; rows: number; tmuxTarget?: string }): Promise<ShellStream>;
  /** Runs `luady-ctl tail-events --from <from>` on host; calls onLine for each complete stdout line; `done` resolves when the stream ends (error or EOF). */
  tailEvents(host: HostId, from: string, onLine: (line: string) => void): { stop(): void; done: Promise<void> };
  /** Every host the fleet reaches, the self host included; read again at every call (never capture it). */
  hosts(): HostId[];
  /** A pinned SSH host. */
  hasServer(id: string): boolean;
  /** The local host ("this computer"). */
  hasLocal(id: string): boolean;
  /** hasServer, hasLocal or the self host. */
  hasHost(id: string): boolean;
  /** What the fleet knows about one host; null when it has no such host. */
  hostInfo(id: string): FleetHostInfo | null;
  /**
   * Why `path` on `host` may not be touched: it lies in the hub's own folders on "this computer" (security/hub-paths.ts).
   * Null for any other host or path. Absent on fakes that have no such folders.
   */
  hubPathRefusal?(host: string, path: string, use?: 'read' | 'write'): string | null;
}

export interface SessionService {
  list(opts?: { includeSystem?: boolean }): SessionDTO[];
  get(id: string): SessionDTO | undefined;
  /** Accepts a session id, a display name, or "<host>/<display name>". */
  findByRef(ref: string): SessionDTO | undefined;
  /** Throws QuestionPendingError when a question is pending on that session; NotFoundError when unknown. */
  send(id: string, text: string, channel: Channel): Promise<void>;
  /** True while a question of that session went back to its terminal and Claude Code's own dialog may still wait there. */
  dialogInTerminal?(id: string): boolean;
  interrupt(id: string): Promise<void>;
  start(args: { server: HostId; cwd: string; prompt?: string; name?: string; origin: 'owner' | 'manager' }): Promise<SessionDTO>;
  stop(id: string, force: boolean): Promise<void>;
  restart(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  transcript(id: string, cursor: string | null, limit: number): Promise<{ items: TranscriptItemDTO[]; nextCursor: string | null }>;
  condensed(id: string, lastN: number): Promise<string>;
}

export interface QuestionService {
  pending(): QuestionDTO[];
  get(qid: string): QuestionDTO | undefined;
  /** The checks of answer() without delivering anything: the question is open and the answers fit it. */
  check(qid: string, answers: Record<string, string>): QuestionDTO;
  /** Throws QuestionClosedError (not pending), NotFoundError, ValidationError (bad keys/labels). */
  answer(qid: string, answers: Record<string, string>, via: Channel): Promise<QuestionDTO>;
  /** `opts.always`: also add the preview's "Allow always" rule for this session (allow only; kit 2). */
  answerPermission(
    qid: string, behavior: 'allow' | 'deny', message: string | undefined, via: Channel, opts?: { always?: boolean },
  ): Promise<QuestionDTO>;
  release(qid: string, via: Channel): Promise<QuestionDTO>;
  markNotified(qid: string): void;
  markEscalated(qid: string): void;
}

export interface SettingsService { get(): Settings; update(patch: SettingsPatch): Settings; }

export interface PinService {
  isSet(): boolean;
  /** First set requires a valid setupCode; later changes require currentPin. */
  set(newPin: string, auth: { currentPin?: string; setupCode?: string }): Promise<void>;
  /** Throws PinInvalidError, PinLockedError, PinNotSetError. */
  verify(pin: string, via: Channel): Promise<void>;
}

/** What a setup code is for: the first passkey and PIN (30 minutes), or a login link (5 minutes). */
export type SetupCodePurpose = 'owner_setup' | 'owner_login';

export interface SetupCodeService {
  /** Returns the plain code once; stores only its sha256. Valid for its purpose's lifetime, single use. */
  issue(purpose: SetupCodePurpose): string;
  /** Throws AuthError when invalid/expired/used. Marks used. */
  consume(code: string, purpose: SetupCodePurpose): void;
  /** Like consume but does not mark used. */
  check(code: string, purpose: SetupCodePurpose): void;
}

export type ActionKind =
  | 'session.start' | 'session.send' | 'session.interrupt' | 'session.stop' | 'session.restart' | 'session.delete'
  | 'session.pause' | 'session.resume'
  | 'server.exec' | 'server.file_write' | 'server.claude_update' | 'channel.unlink' | 'terminal.open'
  | 'account.login' | 'account.logout'
  /** The manager's answer to a session's question: typed into that session, so it follows the session.send rule. */
  | 'question.answer'
  /** A record only (never requested): a sign-in finished, with the host and the account it is now on. */
  | 'account.signed_in'
  /** A record only (never requested): the manager wrote a knowledge-base page. */
  | 'kb.write'
  /** Records of the hosts flow, one per change. */
  | 'host.add' | 'host.pin' | 'host.kit' | 'host.edit' | 'host.remove' | 'host.local';

export interface ActionRequest {
  kind: ActionKind;
  actor: 'owner' | 'manager';
  channel: Channel;
  params: Record<string, unknown>;
  /** When present on a tier-1 request, verified immediately (web step-up). */
  pin?: string;
  /**
   * The owner changing an account on the website: tier 1 and the PIN is checked whatever `require_pin` says (that
   * setting governs Luady's own tier-1 actions only).
   */
  alwaysPin?: boolean;
  /**
   * The website session asking, when the action runs within its request: never stored or logged. A terminal ticket is
   * bound to it, so only that session's socket can use the ticket.
   */
  sid?: string;
}

export interface ActionService {
  /** Tier 0 executes now; tier 1 without pin → pending_confirmation (+confirmation notice); with pin → verify then execute. */
  request(req: ActionRequest): Promise<ActionDTO>;
  confirm(id: string, pin: string, via: Channel): Promise<ActionDTO>;
  deny(id: string, via: Channel): Promise<ActionDTO>;
  get(id: string): ActionDTO | undefined;
  list(filter: { status?: ActionStatus; limit: number }): ActionDTO[];
  pending(): ActionDTO[];
  sweepExpired(): number;
  /** Writes an audit row for something that already happened (a finished sign-in); never runs anything. */
  record?(entry: ActionRecordEntry): ActionDTO;
  /**
   * The whole text an action would type or write (a session's prompt or message, a file's content, an answer), with
   * every hidden character marked: what the website's confirmation card opens. Null for an action without one;
   * undefined for an unknown id.
   */
  fullText?(id: string): string | null | undefined;
}

export interface ActionRecordEntry {
  kind: ActionKind;
  actor: 'owner' | 'manager';
  channel: Channel;
  params: Record<string, unknown>;
  summary: string;
  result: string;
}

export interface OutboundLink { kind: 'question' | 'session' | 'action' | 'manager'; refId: string; }

export interface OutboundChannel {
  isUp(): boolean;
  /** Splits at LIMITS.chatMessageMax; the link is stored for the last chunk's msgId. Returns that msgId, or null when queued. */
  send(text: string, link: OutboundLink | null, quotedId?: string | null): Promise<string | null>;
  /**
   * Notice channels only: like send, with `urgent` (the chat at once, never held), and says whether the text waits on
   * the website first (`held`) rather than having been handed to the chat.
   */
  deliver?(text: string, link: OutboundLink | null, opts?: { urgent?: boolean }): Promise<{ msgId: string | null; held: boolean }>;
  /** The raw channel only: like send, and tells an adapter refusal apart from no acknowledgement yet (or queued). */
  sendChecked?(text: string, link: OutboundLink | null, quotedId?: string | null): Promise<{ msgId: string | null; refused: boolean }>;
  /** Sends one file now; resolves to the msgId, or rejects when no chat channel takes it or the send fails. */
  sendMedia?(media: OutboundMedia): Promise<string>;
  /** Sends a file that lives on the hub machine (the chat add-on reads it from disk); for big files. */
  sendMediaPath?(media: OutboundMediaPath): Promise<string>;
  /** Owner-chat "typing…" presence while the manager works. Best effort: ignored while the chat is down. */
  typing?(on: boolean): void;
  /** Marks the owner's voice note as played (blue microphone). Best effort. */
  markPlayed?(msgId: string): void;
  /** Replaces the text of a message the manager sent (when the chat allows it). True when the chat accepted it. */
  edit?(msgId: string, text: string): Promise<boolean>;
  /** Pins (7 days) or unpins one of Luady's messages. Best effort. */
  pin?(msgId: string, on: boolean, seconds?: 86_400 | 604_800 | 2_592_000): void;
  /** Deletes one of Luady's messages for everyone. Best effort. */
  revoke?(msgId: string): void;
}

/**
 * The owner's channel: every owner-facing sender of the hub, plus the profile and unlinking the primary channel (the
 * owner action `channel.unlink`).
 */
export interface OwnerChannel extends OutboundChannel {
  setProfile(about: string, description: string): void;
  /** Asks the primary channel's add-on to unlink; refused when none is connected. */
  unlink(): Promise<void>;
}

// ═══ Services provided by their own modules. Each route module registers only when its service is present. ═══
// Each owner adds its methods by declaration merging in its own files, e.g.
//   declare module '../core/contracts.js' { interface HostsService { add(body: HostCreateBody): Promise<HostDTO> } }
// so this file needs no edit.

/** Rooms. */
export interface RoomsService { list(): RoomsDTO; }
/** Hosts from the website. */
export interface HostsService { list(): HostDTO[]; }
/** The declared channels and add-ons. */
export interface ChannelsService { list(): ChannelInfoDTO[]; }
/** The first run: the state machine, the passkey skip, and the sessions a login link made. */
export interface SetupService {
  state(): SetupStateDTO;
  advance(step: import('@luady/shared').SkippableSetupStep, action: 'done' | 'skip', who: { readonly linkSession: boolean; readonly localRequest: boolean }): SetupStateDTO;
  finish(): SetupStateDTO;
  /** Sends `setup.changed` when the state differs from the last one sent. */
  notify(): void;
  /** The login route keeps the new session's page key (its sha256, in memory); only such sessions may skip the passkey. */
  keepLinkSession(pageKey: string): void;
  isLinkSession(pageKey: string | undefined): boolean;
}
/** Connecting Google and Wispr; the chat `/google` command reads its link text here. */
export interface ConnectService { googleStatusText(): string | null; }

export interface OutboundMedia { kind: 'image' | 'document'; mime: string; fileName: string; caption: string; b64: string; }
export interface OutboundMediaPath { kind: 'image' | 'document'; mime: string; fileName: string; caption: string; path: string; }

/** deliver 'owner': sent to the owner by itself (the chat, or the website); 'manager': nothing goes to the owner, the manager gets the paths in an Event. */
export interface ImageJobOptions { references: readonly ImageReference[]; transparent: boolean; deliver: 'owner' | 'manager'; caption: string; }
/** A picture the image is based on: `source` is an inbox path, an earlier image id, `cedar:/path` or a link. */
export interface ImageReference { source: string; role: 'edit' | 'style' | 'subject' | 'composition' | 'reference'; note: string; }
/** Background image generation (Codex CLI on the owner's ChatGPT plan): the job id and where its first image will be. */
export interface ImageJobs { start(prompt: string, opts: ImageJobOptions): { id: string; path: string }; }

/**
 * `ownerOnWebsite`: the owner asked on the website, in a request that passed their session and page key (only the
 * delegate route sets it). The manager then gets the work as the owner's own request (LuadyService.postOwnerRequest).
 */
export interface DelegateOptions {
  readonly ownerOnWebsite?: boolean;
}

export interface LuadyService {
  status(): LuadyStatusDTO;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** `about`: the stored message keeps the owner's words; Luady gets the block in front of them. */
  postOwnerMessage(text: string, channel: Channel, about?: import('../luady/about.js').AboutContext): Promise<void>;
  postEvent(text: string, kind: 'Event' | 'Scheduled'): Promise<void>;
  messages(cursor: string | null, limit: number): { items: ChatMessageDTO[]; nextCursor: string | null };
  /** Daily fresh start: ends an idle brain so the supervisor relaunches it without --resume. False while busy. */
  rotate?(force?: boolean): Promise<boolean>;
  /** A tool messaged the owner during the running turn, so its closing reply is not sent on the chat too. */
  ownerTold?(): void;
  /** Where the running turn came from (a chat channel id, web, phone, event, scheduled), or null when idle or Remote Control. */
  turnSource?(): Channel | null;
  /**
   * True while the running turn answers the owner: their own message, or an Event the hub posted for their request on
   * the website (postOwnerRequest). The manager's session starts and sends need no PIN only then (actions/policy.ts).
   */
  ownerTurn?(): boolean;
  /**
   * An Event for a request the owner made on the website (the board's Run and Give), posted only after the website
   * checked their session and page key: the turn it starts counts as the owner's (ownerTurn), and only that turn.
   */
  postOwnerRequest?(text: string): Promise<void>;
  /** True while the running turn is the morning brief (luady/replies.ts). */
  morningTurn?(): boolean;
  /** Luady's own sign-in is out: everything meant for the brain is kept in its queue until it is back. */
  signedOut?(): boolean;
  /** Luady is signed in again: pass on everything kept meanwhile (when the brain is running). */
  release?(): Promise<void>;
}

export interface PhoneService {
  enabled(): boolean;
  callForQuestion(qid: string): Promise<void>;
  callOwner(reason: string): Promise<void>;
  /** Speaks the manager's reply on the live call; false when no call is on (the reply then goes to the chat). */
  say?(text: string): boolean;
}

export interface MemoryHit { thread: string; role: string; text: string; ts: string; }
export interface MemoryService {
  record(msg: { thread: string; role: ChatMessageDTO['role']; channel: Channel | null; text: string; extId?: string | null }): ChatMessageDTO;
  search(query: string, limit: number): MemoryHit[];
}

export interface ProjectsService { list(server?: HostId): ProjectDTO[]; refresh(server: HostId): Promise<void>; }

export interface ScheduledTask { id: string; when: string; task: string; nextRunAt: string | null; }
export interface Scheduler {
  add(when: string, task: string): ScheduledTask;
  list(): ScheduledTask[];
  cancel(id: string): boolean;
  start(): void;
  stop(): void;
}

export interface AccessIdentity { email: string; }
export interface AccessVerifier { verify(token: string | undefined): Promise<AccessIdentity>; }

/** The part of the mission service other components use (missions/service.ts). */
export interface MissionTracker {
  isOpen(sessionId: string): boolean;
  isManaged(sessionId: string): boolean;
  manage(sessionId: string): void;
  list(): string[];
  /** Progress note and/or a short title on the mission's status message. */
  note(session: SessionDTO, note: string, title?: string): Promise<void>;
  finish(session: SessionDTO, summary: string): Promise<boolean>;
}

// ═══ Service contracts: board, notes, speech bubbles, knowledge base, library and Jira ═══
// Unknown ids throw NotFoundError (404); refusals RefusedError (409); Jira without a connection JiraNotConnectedError (409).

// ── Board, delegation and missions on the website (board/) ──

/** Who changed a card: the owner (website, chat), the manager (its tools) or the hub itself (missions, session reports). */
export type BoardActor = 'owner' | 'manager' | 'hub';

/** `todo_list` lanes: running = queued and running; done = the last 14 days. */
export type BoardFilter = 'open' | 'running' | 'review' | 'done' | 'all';

/** A new card from any channel (website body, /todo, todo_add, a mission, a ticket or note sent to work). */
export interface BoardAddInput {
  readonly title: string;
  readonly details?: string;
  readonly project?: string | null;
  readonly server?: HostId | null;
  readonly today?: boolean;
  readonly priority?: BoardPriority;
  readonly source: BoardSource;
  readonly sourceRef?: string | null;
  /** A session already working on it (todo_add `session`). */
  readonly sessionId?: string | null;
}

/** A change to a card from the owner (UpdateBoardItemBody), Luady (todo_update, todo_done) or the hub. `note` adds a log line. */
export interface BoardPatch {
  readonly title?: string;
  readonly details?: string;
  readonly project?: string | null;
  readonly server?: HostId | null;
  readonly today?: boolean;
  readonly priority?: BoardPriority;
  readonly state?: BoardState;
  readonly result?: string | null;
  readonly sessionId?: string | null;
  readonly dueAt?: string | null;
  readonly snoozeUntil?: string | null;
  readonly note?: string;
}

export interface BoardService {
  /** GET /api/board: everything not done, plus done in the last 14 days. */
  list(): BoardItemDTO[];
  /** One lane, for todo_list. */
  find(filter: BoardFilter): BoardItemDTO[];
  get(id: number): BoardItemDTO | null;
  /** GET /api/board/:id: the card, its log and its mission. */
  detail(id: number): BoardItemDetailDTO | null;
  add(input: BoardAddInput, by: BoardActor): Promise<BoardItemDTO>;
  update(id: number, patch: BoardPatch, by: BoardActor): Promise<BoardItemDTO>;
  remove(id: number, by: BoardActor): Promise<void>;
  /** Run and Give to… (POST /api/delegate): tickets and notes become cards, cards go `queued`, Luady gets one event. */
  delegate(body: DelegateBody, opts?: DelegateOptions): Promise<DelegateResultDTO>;
  /** The paragraph session_start / session_send add to the prompt for linked cards. */
  briefFor(ids: readonly number[]): string;
  /** Links cards to the session that now works on them (only that session's reports tick them). */
  link(sessionId: string, ids: readonly number[]): Promise<void>;
  /** Plain text of a lane for /todo and todo_list. */
  render(filter: BoardFilter): string;
  /** GET /api/missions: the missions Luady runs now. */
  missions(): MissionDTO[];
  start(): void;
  stop(): void;
}

// ── Notes: Wispr meetings and typed notes (notes/) ──

export interface NotesQuery {
  readonly query?: string;
  readonly limit: number;
}

export interface NotesService {
  /** Newest first; summaries cut to LIMITS.noteListSummaryMax. */
  list(query: NotesQuery): Promise<NoteDTO[]>;
  get(id: string): Promise<NoteDTO | null>;
  /** `discuss: true` also sends it to Luady as an owner message about the note. */
  create(body: CreateNoteBody): Promise<NoteDTO>;
  /** Typed notes only; a meeting is refused (RefusedError, 409). */
  update(id: string, body: UpdateNoteBody): Promise<NoteDTO>;
  remove(id: string): Promise<void>;
  /** A meeting's transcript from `start`, read live from Wispr Flow in parts. */
  transcript(id: string, start: number): Promise<NoteTranscriptDTO>;
  /** The owner opened it: a new meeting stops being new (one notes.changed). A typed note: nothing to do. */
  opened(id: string): Promise<void>;
  /** Notes not opened yet, over all notes (the "NEW" pills and "Notes · 2 new"). */
  newCount(): number;
}

// ── What agents said, for the speech bubbles (said/) ──

export interface SaidService {
  /** GET /api/said: the newest per live session (kept in memory). */
  list(): SaidDTO[];
  start(): void;
  stop(): void;
}

// ── Knowledge base and its copy on the servers (kb/) ──

export interface KbListQuery {
  readonly scope?: KbScope;
  readonly server?: HostId;
  readonly project?: string;
  readonly query?: string;
}

/** A kb_search hit: the page and the start of its body. */
export type KbHit = KbPageDTO & { readonly excerpt: string };

export interface KbService {
  list(query: KbListQuery): KbListDTO;
  get(id: number): KbPageFullDTO | null;
  create(body: CreateKbPageBody, by: KbAuthor): Promise<KbPageFullDTO>;
  update(id: number, body: UpdateKbPageBody, by: KbAuthor): Promise<KbPageFullDTO>;
  remove(id: number): Promise<void>;
  /** kb_write: creates, or replaces the page with the same slug in its scope, server and project. */
  write(body: CreateKbPageBody, by: KbAuthor): Promise<KbPageFullDTO>;
  search(query: string, opts: { readonly project?: string; readonly server?: HostId; readonly limit: number }): KbHit[];
  /** Copies the pages to one server's ~/luady-kb/ now, or to every server when none is named. */
  sync(server?: HostId): Promise<void>;
  start(): void;
  stop(): void;
}

// ── Library: projects, skills and pages per office (library/) ──

export interface LibraryService {
  get(): Promise<LibraryDTO>;
  /** Re-reads projects and skills of one office, or of all of them. */
  refresh(server?: HostId): Promise<void>;
  start(): void;
  stop(): void;
}

// ── Jira per office (jira/) ──

/** What the owner typed to connect an office; the PIN is checked by the route before this is called. */
export interface JiraConnectInput {
  readonly baseUrl: string;
  readonly email: string;
  readonly token: string;
}

export interface JiraSearchInput {
  readonly view?: JiraView;
  readonly jql?: string;
  readonly limit: number;
}

export interface JiraService {
  sites(): JiraSitesDTO;
  /** Checks the sign-in against the site, then stores the token sealed. */
  connect(server: HostId, input: JiraConnectInput): Promise<JiraSiteDTO>;
  disconnect(server: HostId): Promise<void>;
  /** A board view, kept 60 s unless `refresh`. */
  board(server: HostId, view: JiraView, refresh: boolean): Promise<JiraBoardDTO>;
  /** A ticket in full; `seen` marks it seen (the owner opened it), Luady's reads do not. */
  issue(server: HostId, key: string, opts: { readonly seen: boolean }): Promise<JiraIssueDetailDTO>;
  transition(server: HostId, key: string, transitionId: string): Promise<JiraIssueDetailDTO>;
  comment(server: HostId, key: string, text: string): Promise<JiraIssueDetailDTO>;
  edit(server: HostId, key: string, patch: JiraEditBody): Promise<JiraIssueDetailDTO>;
  assign(server: HostId, key: string, me: boolean): Promise<JiraIssueDetailDTO>;
  /** The office a tool means: `server`, or the only connected one; RefusedError when that is ambiguous. */
  pick(server?: HostId): HostId;
  search(server: HostId, input: JiraSearchInput): Promise<JiraIssueDTO[]>;
  /** jira_transition: moves by status name or transition name. */
  moveTo(server: HostId, key: string, to: string): Promise<JiraIssueDetailDTO>;
  start(): void;
  stop(): void;
}

// ═══ Service contracts: welcome-back recap, fleet history, wins, timeline, links and preferences ═══

// ── Welcome-back card (recap/) ──

export interface RecapService {
  /**
   * What happened since `since` until now: cards finished, alerts, questions waiting, meetings announced, counts.
   * `since` older than LIMITS.recapSinceMaxDays counts as that many days; 12 lines a list, newest first.
   */
  recap(since: Date): RecapDTO;
}

// ── Fleet wall (fleet-history/) ──

export interface FleetHistoryService {
  /** The last 24 hours per server and per account, thinned to LIMITS.fleetPointsMax points a series. */
  history(): FleetHistoryDTO;
  /** Starts sampling the servers once a minute and following the accounts' limits. */
  start(): void;
  stop(): void;
}

// ── Wins wall (wins/) ──

export interface WinsService {
  /** Done cards of the last `days` days (1..30), newest first, with their links and the count per office. */
  wins(days: number): WinsDTO;
}

// ── Today strip (timeline/) ──

export interface TimelineService {
  /** One owner day (`YYYY-MM-DD`), oldest first, at most LIMITS.timelineItemsMax. */
  day(day: string): TimelineDTO;
}

// ── Links shelf (links/) ──

export interface LinksService {
  /** Every office's links, by server then position. */
  list(): LinkDTO[];
  /** At most LIMITS.linksPerOfficeMax per office (RefusedError beyond); `https://` only. Emits `links.changed`. */
  create(body: CreateLinkBody): Promise<LinkDTO>;
  /** NotFoundError for an unknown id. Emits `links.changed`. */
  update(id: number, body: UpdateLinkBody): Promise<LinkDTO>;
  remove(id: number): Promise<void>;
}

// ── Website preferences (prefs/) ──

export interface PrefsService {
  /** What is stored, over DEFAULT_WEB_PREFS. */
  get(): WebPrefsDTO;
  /** Merges the change over what is stored (mergeWebPrefs) and emits `prefs.changed` when something changed. */
  update(patch: UpdateWebPrefsBody): Promise<WebPrefsDTO>;
}

export interface ToolContext {
  fleet: Fleet; sessions: SessionService; questions: QuestionService; actions: ActionService;
  projects: ProjectsService; memory: MemoryService; outbound: OutboundChannel; phone: PhoneService;
  scheduler: Scheduler; settings: SettingsService; clock: Clock;
  /** Where files the owner sends are kept for the manager (the brain inbox). */
  inboxDir: string;
  /** Luady's own folder for personal things it makes itself; send_file with the self host as server sends only from here. */
  workspaceDir?: string;
  missions?: MissionTracker;
  images?: ImageJobs;
  todos?: import('../todos/service.js').TodoService;
  google?: import('../google/service.js').GoogleService | null;
  imap?: import('../mail/imap.js').ImapService | null;
  meetings?: import('../meetings/service.js').MeetingsService | null;
  /** Plan limits per account, for `account_limits` (accounts/service.ts). */
  accounts?: Pick<import('../accounts/service.js').AccountsService, 'limitsText'>;
  /** Where Luady's updates reach the owner now, for `owner_presence` (notices/presence.ts). */
  presence?: Pick<import('../notices/presence.js').PresenceService, 'state'>;
  /** The board, for the todo_* tools and the `todos` of session_start / session_send (board/). */
  board?: BoardService;
  /** Notes (notes/). */
  notes?: NotesService;
  /** kb_search, kb_read, kb_write (kb/). */
  kb?: KbService;
  /** The library (library/). */
  library?: LibraryService;
  /** jira_search, jira_get, jira_comment, jira_transition (jira/). */
  jira?: JiraService;
}
export type ToolHandler = (input: unknown, ctx: ToolContext) => Promise<string>;
