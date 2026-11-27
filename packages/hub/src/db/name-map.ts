import { renameSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  ACTION_ACTORS, ACTION_STATUSES, BOARD_EVENT_KINDS, BOARD_SOURCES, BOARD_STATES, BUILTIN_CHANNELS, CHAT_ROLES, KB_AUTHORS,
  KB_SCOPES, NOTICE_KINDS, NOTICE_REF_KINDS, NOTICE_SETTLED_VIA, QUESTION_KINDS, QUESTION_STATES, ROOM_KINDS, ROOM_SIZES, ROOM_SPECIES,
  SESSION_ORIGINS, SESSION_STATES, SETTINGS_KEYS, isAddonId,
} from '@luady/shared';
import { ACTION_KINDS } from '../actions/params.js';
import { BRAIN_OUT_KEY, IDENTITY_KEY_PREFIX } from '../claude-login/state.js';
import type { Db } from '../core/contracts.js';
import { sealer } from '../core/seal.js';
import { LINK_KINDS } from '../inbound/router.js';
import { NOTICE_STATE_KEYS } from '../notices/state.js';
import { PREFS_KEY } from '../prefs/index.js';
import { ROOMS_SEEDED_KEY } from '../rooms/repo.js';
import { displayNameFor } from '../sessions/naming.js';
import { CHALLENGE_PURPOSES } from '../web/auth/challenges.js';

/**
 * The conversion engine: renames stored names between two releases, forward and back, in one
 * transaction. It is generic: the caller supplies the map, and the
 * registries below say which columns can hold which kind of name.
 */

/** What a name-bearing column can hold. */
export type ColumnKind =
  /** A host id: the self-host rewrite applies. */
  | 'host'
  /** A session id (`host:target`): the self host's prefix and the manager's pane are rewritten. */
  | 'session-id'
  /** An id of several kinds, one of them a session id: rewritten like a session id where it is one. */
  | 'ref'
  /** A tmux target: the manager's pane is rewritten on rows of the self host (`hostColumn`). */
  | 'target'
  /** A session display name, derived from its target: rewritten with the manager's pane on rows of the self host. */
  | 'display'
  /** A role, actor, author, source or kind value that can be the manager's: `map.values` applies. */
  | 'role'
  /** A channel name (an add-on id such as `test-channel`, or `web`): `map.values` applies. */
  | 'channel'
  /** JSON text with host, session-id or target fields (`json`). */
  | 'json'
  /** Ciphertext sealed with the hub's sealing label: resealed. */
  | 'sealed'
  /** A settings key: `map.settingsKeys` applies. */
  | 'settings-key';

export interface JsonField {
  readonly path: string;
  readonly kind: 'host' | 'session-id' | 'target';
}

export interface NameBearingColumn {
  readonly table: string;
  readonly column: string;
  readonly kind: ColumnKind;
  /** `target` and `display` columns: the row's host column, so only the self host's rows change. */
  readonly hostColumn?: string;
  /** `json` columns: the fields that carry names; a `target` field changes only where `hostPath` is the self host. */
  readonly json?: readonly JsonField[];
  readonly hostPath?: string;
}

/** Every column (public names, after migrations 001-016) that can hold a self-host id, a session id, a manager-role value or a channel name. */
export const NAME_BEARING_COLUMNS: readonly NameBearingColumn[] = Object.freeze([
  { table: 'sessions', column: 'id', kind: 'session-id' },
  { table: 'sessions', column: 'host', kind: 'host' },
  { table: 'sessions', column: 'tmux_target', kind: 'target', hostColumn: 'host' },
  { table: 'sessions', column: 'display_name', kind: 'display', hostColumn: 'host' },
  { table: 'sessions', column: 'origin', kind: 'role' },
  { table: 'events', column: 'host', kind: 'host' },
  { table: 'events', column: 'session_id', kind: 'session-id' },
  {
    table: 'events', column: 'payload_json', kind: 'json', hostPath: '$.host',
    json: [{ path: '$.host', kind: 'host' }, { path: '$.tmux', kind: 'target' }],
  },
  { table: 'questions', column: 'host', kind: 'host' },
  { table: 'questions', column: 'session_id', kind: 'session-id' },
  { table: 'questions', column: 'resolved_via', kind: 'channel' },
  { table: 'actions', column: 'actor', kind: 'role' },
  { table: 'actions', column: 'channel', kind: 'channel' },
  { table: 'actions', column: 'kind', kind: 'role' },
  {
    table: 'actions', column: 'params_json', kind: 'json',
    json: [{ path: '$.target', kind: 'host' }, { path: '$.server', kind: 'host' }, { path: '$.sessionId', kind: 'session-id' }],
  },
  { table: 'messages', column: 'thread', kind: 'role' },
  { table: 'messages', column: 'role', kind: 'role' },
  { table: 'messages', column: 'channel', kind: 'channel' },
  { table: 'channel_links', column: 'channel', kind: 'channel' },
  { table: 'channel_links', column: 'kind', kind: 'role' },
  { table: 'channel_links', column: 'ref_id', kind: 'ref' },
  { table: 'channel_seen', column: 'channel', kind: 'channel' },
  { table: 'injections', column: 'session_id', kind: 'session-id' },
  { table: 'injections', column: 'channel', kind: 'channel' },
  { table: 'projects', column: 'server', kind: 'host' },
  { table: 'settings', column: 'key', kind: 'settings-key' },
  { table: 'offsets', column: 'host', kind: 'host' },
  { table: 'manager_queue', column: 'channel', kind: 'channel' },
  { table: 'manager_state', column: 'last_input_channel', kind: 'channel' },
  { table: 'missions', column: 'session_id', kind: 'session-id' },
  { table: 'todos', column: 'server', kind: 'host' },
  { table: 'todos', column: 'source', kind: 'role' },
  { table: 'todos', column: 'source_ref', kind: 'ref' },
  { table: 'todos', column: 'session_id', kind: 'session-id' },
  { table: 'google_accounts', column: 'refresh_enc', kind: 'sealed' },
  { table: 'login_alerts', column: 'host', kind: 'host' },
  { table: 'wispr_auth', column: 'refresh_enc', kind: 'sealed' },
  { table: 'notices', column: 'ref_kind', kind: 'role' },
  { table: 'notices', column: 'ref_id', kind: 'ref' },
  { table: 'notices', column: 'settled_via', kind: 'channel' },
  { table: 'account_limits', column: 'host', kind: 'host' },
  { table: 'notes', column: 'source', kind: 'channel' },
  { table: 'kb_pages', column: 'server', kind: 'host' },
  { table: 'kb_pages', column: 'updated_by', kind: 'role' },
  { table: 'kb_sync', column: 'server', kind: 'host' },
  { table: 'jira_sites', column: 'token_enc', kind: 'sealed' },
  { table: 'servers', column: 'name', kind: 'host' },
] satisfies NameBearingColumn[]);

/**
 * Every other TEXT column, as `table.column`: none can hold a self-host id, a session id, a manager-role value or a
 * channel name. Prose, timestamps, hashes, paths and ids of other kinds. A new TEXT column must join one of the lists.
 */
export const NOT_NAME_BEARING: readonly string[] = Object.freeze([
  'account_limits.five_hour_json', 'account_limits.seven_day_json', 'account_limits.reported', 'account_limits.updated_at',
  'actions.id', 'actions.summary', 'actions.status', 'actions.created_at', 'actions.decided_at', 'actions.executed_at',
  'actions.result_text', 'actions.error',
  'auth_challenges.id', 'auth_challenges.challenge', 'auth_challenges.purpose', 'auth_challenges.expires_at',
  'auth_passkeys.cred_id', 'auth_passkeys.transports_json', 'auth_passkeys.label', 'auth_passkeys.created_at', 'auth_passkeys.last_used_at',
  'auth_sessions.sid', 'auth_sessions.csrf', 'auth_sessions.created_at', 'auth_sessions.last_seen_at', 'auth_sessions.page_key_sha256',
  'board.chat_msg_id', 'board.sent_at', 'board.shown',
  'channel_links.msg_id', 'channel_links.created_at', 'channel_seen.msg_id', 'channel_seen.seen_at',
  'daily_runs.job', 'daily_runs.day', 'daily_runs.ran_at',
  'events.id', 'events.type', 'events.ts',
  'google_accounts.email', 'google_accounts.label', 'google_accounts.added_at',
  'google_seen.account', 'google_seen.item', 'google_seen.seen_at',
  'injections.text_sha256', 'injections.created_at',
  // Room keys from 016 on (server names before it): never the self host, which is reserved as a room id too.
  'jira_seen.server', 'jira_seen.key', 'jira_seen.seen_at',
  'jira_sites.server', 'jira_sites.base_url', 'jira_sites.email', 'jira_sites.cloud_id', 'jira_sites.account_id',
  'jira_sites.display_name', 'jira_sites.connected_at', 'jira_sites.last_ok_at', 'jira_sites.last_error',
  'kb_pages.scope', 'kb_pages.project', 'kb_pages.slug', 'kb_pages.title', 'kb_pages.body', 'kb_pages.tags', 'kb_pages.updated_at',
  'kb_pages.created_at', 'kb_sync.synced_at', 'kb_sync.digest',
  'links.server', 'links.label', 'links.url', 'links.created_at',
  'login_alerts.alert', 'login_alerts.sent_at',
  'manager_queue.text', 'manager_queue.created_at', 'manager_state.claude_session_id', 'manager_state.started_at',
  'meetings.id', 'meetings.title', 'meetings.title_key', 'meetings.started_at', 'meetings.ended_at', 'meetings.people', 'meetings.state',
  'meetings.summary', 'meetings.todos', 'meetings.gist', 'meetings.project', 'meetings.notes', 'meetings.link', 'meetings.updated_at',
  'meetings.opened_at',
  // What an owner message is about: a note, a card or a Jira ticket (server:key of a server, never the self host).
  'message_refs.message_id', 'message_refs.ref_kind', 'message_refs.ref_id',
  'messages.id', 'messages.text', 'messages.ts', 'messages.ext_id',
  // Missions run on servers: their label names a server session.
  'missions.label', 'missions.title', 'missions.phase', 'missions.note', 'missions.last_text', 'missions.chat_msg_id', 'missions.sent_at',
  'missions.opened_at', 'missions.idle_since',
  'notes.title', 'notes.body', 'notes.project', 'notes.created_at', 'notes.updated_at',
  'notices.id', 'notices.kind', 'notices.text', 'notices.created_at', 'notices.chat_due_at', 'notices.chat_sent_at', 'notices.chat_msg_id',
  'notices.settled_at',
  'offsets.file',
  'pin_state.hash', 'pin_state.locked_until',
  'projects.path', 'projects.name', 'projects.git_json', 'projects.stack_json', 'projects.updated_at',
  // 016: a room id and its host are never the self host (both reserved), and its kind is a room kind, not a role.
  'rooms.id', 'rooms.name', 'rooms.short', 'rooms.kind', 'rooms.host', 'rooms.match_json', 'rooms.colour', 'rooms.accent',
  'rooms.species', 'rooms.size', 'rooms.created_at', 'rooms.updated_at',
  // The manager never asks: a question's label and payload name a server session.
  'questions.qid', 'questions.kind', 'questions.payload_json', 'questions.state', 'questions.created_at', 'questions.notified_at',
  'questions.escalated_at', 'questions.resolved_at', 'questions.answer_json',
  'schedules.id', 'schedules.when_spec', 'schedules.task', 'schedules.next_run_at', 'schedules.created_at',
  'schema_migrations.applied_at',
  'servers.host', 'servers.user', 'servers.host_key_fp', 'servers.status', 'servers.last_seen_at', 'servers.sysinfo_json',
  'servers.kit_version', 'servers.claude_version',
  // 016: the hosts table's kind, folders, source, state and times.
  'servers.kind', 'servers.projects_root', 'servers.home_dir', 'servers.claude_bin', 'servers.from_addr', 'servers.source', 'servers.state',
  'servers.created_at', 'servers.updated_at', 'servers.removed_at',
  'sessions.claude_session_id', 'sessions.transcript_path', 'sessions.cwd', 'sessions.project', 'sessions.state', 'sessions.created_at',
  'sessions.last_event_at', 'sessions.turn_started_at', 'sessions.pending_qid',
  'settings.value_json',
  'setup_codes.code_sha256', 'setup_codes.purpose', 'setup_codes.expires_at', 'setup_codes.used_at',
  'setup_state.step', 'setup_state.skipped_json', 'setup_state.completed_at', 'setup_state.updated_at',
  'todo_boards.chat_msg_id', 'todo_boards.sent_at', 'todo_boards.pinned_at',
  'todo_events.at', 'todo_events.kind', 'todo_events.text',
  'todos.text', 'todos.created_at', 'todos.done_at', 'todos.details', 'todos.project', 'todos.state', 'todos.run_id', 'todos.result',
  'todos.updated_at', 'todos.due_at', 'todos.snooze_until',
  'wispr_auth.client_id', 'wispr_auth.connected_at', 'wispr_auth.redirect_uri',
]);

/** A column read by a closed enum in a row parser, with the value set the parser accepts. */
export interface VocabularyEntry {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
  /** Keys that are valid by prefix (settings: `login.identity.<host>`). */
  readonly prefixes?: readonly string[];
  /**
   * An open vocabulary: values outside `values` the parser still accepts (a channel is a built-in one or any add-on
   * id). A stored value that fails it would fail the parser too.
   */
  readonly grammar?: (value: string) => boolean;
  /** The parser, relative to packages/hub/src, and the enum constant or schema it reads with. */
  readonly parser: string;
  readonly uses: string;
}

/** The hub's own settings keys beside the settings schema's. */
const HUB_SETTINGS_KEYS: readonly string[] = [BRAIN_OUT_KEY, ...Object.values(NOTICE_STATE_KEYS), PREFS_KEY, ROOMS_SEEDED_KEY];

/**
 * Every column read by a closed enum in a row parser (public names). A change to a stored value adds its
 * entry here. Host columns are not here: every row parser reads them with the open grammar, so no stored
 * host id can make a row unreadable; the self host's id is rewritten through NAME_BEARING_COLUMNS.
 */
export const STORED_VOCABULARY: readonly VocabularyEntry[] = Object.freeze([
  { table: 'sessions', column: 'origin', values: SESSION_ORIGINS, parser: 'sessions/repo.ts', uses: 'SESSION_ORIGINS' },
  { table: 'sessions', column: 'state', values: SESSION_STATES, parser: 'sessions/repo.ts', uses: 'SessionStateSchema' },
  { table: 'questions', column: 'kind', values: QUESTION_KINDS, parser: 'questions/repo.ts', uses: 'QUESTION_KINDS' },
  { table: 'questions', column: 'state', values: QUESTION_STATES, parser: 'questions/repo.ts', uses: 'QUESTION_STATES' },
  { table: 'actions', column: 'actor', values: ACTION_ACTORS, parser: 'actions/store.ts', uses: 'ACTION_ACTORS' },
  { table: 'actions', column: 'channel', values: BUILTIN_CHANNELS, grammar: isAddonId, parser: 'actions/store.ts', uses: 'ChannelSchema' },
  { table: 'actions', column: 'kind', values: ACTION_KINDS, parser: 'actions/store.ts', uses: 'ACTION_KINDS' },
  { table: 'actions', column: 'status', values: ACTION_STATUSES, parser: 'actions/store.ts', uses: 'ActionStatusSchema' },
  { table: 'messages', column: 'role', values: CHAT_ROLES, parser: 'luady/service.ts', uses: 'ChatMessageDTOSchema' },
  { table: 'messages', column: 'channel', values: BUILTIN_CHANNELS, grammar: isAddonId, parser: 'luady/service.ts', uses: 'ChatMessageDTOSchema' },
  { table: 'channel_links', column: 'kind', values: LINK_KINDS, parser: 'inbound/router.ts', uses: 'LINK_KINDS' },
  { table: 'notices', column: 'kind', values: NOTICE_KINDS, parser: 'notices/repo.ts', uses: 'NoticeKindSchema' },
  { table: 'notices', column: 'ref_kind', values: NOTICE_REF_KINDS, parser: 'notices/repo.ts', uses: 'NOTICE_REF_KINDS' },
  {
    table: 'notices', column: 'settled_via', values: NOTICE_SETTLED_VIA, grammar: isAddonId, parser: 'notices/repo.ts',
    uses: 'NoticeSettledViaSchema',
  },
  { table: 'todos', column: 'source', values: BOARD_SOURCES, parser: 'board/store.ts', uses: 'BOARD_SOURCES' },
  { table: 'todos', column: 'state', values: BOARD_STATES, parser: 'board/store.ts', uses: 'BOARD_STATES' },
  { table: 'todo_events', column: 'kind', values: BOARD_EVENT_KINDS, parser: 'board/store.ts', uses: 'BOARD_EVENT_KINDS' },
  { table: 'kb_pages', column: 'updated_by', values: KB_AUTHORS, parser: 'kb/store.ts', uses: 'KB_AUTHORS' },
  { table: 'kb_pages', column: 'scope', values: KB_SCOPES, parser: 'kb/store.ts', uses: 'KB_SCOPES' },
  { table: 'manager_queue', column: 'channel', values: BUILTIN_CHANNELS, grammar: isAddonId, parser: 'luady/inbox.ts', uses: 'ChannelSchema' },
  {
    table: 'manager_state', column: 'last_input_channel', values: BUILTIN_CHANNELS, grammar: isAddonId, parser: 'luady/replies.ts',
    uses: 'ChannelSchema',
  },
  { table: 'injections', column: 'channel', values: BUILTIN_CHANNELS, grammar: isAddonId, parser: 'luady/replies.ts', uses: 'ChannelSchema' },
  { table: 'auth_challenges', column: 'purpose', values: CHALLENGE_PURPOSES, parser: 'web/auth/challenges.ts', uses: 'CHALLENGE_PURPOSES' },
  { table: 'rooms', column: 'kind', values: ROOM_KINDS, parser: 'rooms/repo.ts', uses: 'ROOM_KINDS' },
  { table: 'rooms', column: 'species', values: ROOM_SPECIES, parser: 'rooms/repo.ts', uses: 'ROOM_SPECIES' },
  { table: 'rooms', column: 'size', values: ROOM_SIZES, parser: 'rooms/repo.ts', uses: 'ROOM_SIZES' },
  {
    table: 'settings', column: 'key', values: [...SETTINGS_KEYS, ...HUB_SETTINGS_KEYS], prefixes: [IDENTITY_KEY_PREFIX],
    parser: 'settings/service.ts', uses: 'SettingsSchema',
  },
] satisfies VocabularyEntry[]);

/** A rename, always written old → new; the inverse direction swaps it. */
export interface Rename {
  readonly from: string;
  readonly to: string;
}

/** A table whose shape changes: each new column takes an old column or a fixed value. */
export interface TableRebuild {
  readonly from: { readonly table: string; readonly ddl: string };
  readonly to: { readonly table: string; readonly ddl: string };
  readonly columns: readonly { readonly to: string; readonly from?: string; readonly value?: string }[];
}

/**
 * The names one conversion changes, always written old → new. Table and column references in `values` use the
 * public (new) names; the engine runs the renames first going forward and last going back.
 */
export interface NameMap {
  readonly tables?: readonly Rename[];
  readonly rebuilds?: readonly TableRebuild[];
  readonly columns?: readonly (Rename & { readonly table: string })[];
  readonly values?: readonly (Rename & { readonly table: string; readonly column: string })[];
  /** The self host's id. */
  readonly selfHost?: Rename;
  /** The manager's tmux pane on the self host (`session:window.pane`). */
  readonly targets?: readonly Rename[];
  /** Settings keys; when both keys exist the target key wins and the other row is dropped. */
  readonly settingsKeys?: readonly Rename[];
  /** The sealing label of the sealed columns. */
  readonly seal?: Rename;
  /** The database file name (renamed outside SQL, with -wal and -shm). */
  readonly file?: Rename;
}

export type Direction = 'forward' | 'inverse';

export interface ApplyOptions {
  readonly direction: Direction;
  /** The session secret the sealed columns were sealed with; needed when the map has `seal`. */
  readonly secret?: string;
  /** The database file: the result names the file it must be renamed to once the database is closed. */
  readonly file?: string;
}

export interface ApplyResult {
  /** Rows changed per `table.column` (renames of tables and columns are not counted). */
  readonly changed: Readonly<Record<string, number>>;
  /** Where the database file goes (`renameDatabaseFile`), when the map renames it and `file` was given. */
  readonly file: Rename | null;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_SEP = ':';

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`name-map: ${JSON.stringify(name)} is not a plain SQL name`);
  return `"${name}"`;
}

const swap = (rename: Rename, direction: Direction): Rename => (direction === 'forward' ? rename : { from: rename.to, to: rename.from });

function tableExists(db: Db, table: string): boolean {
  return db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.n === 1;
}

function columnsOf(db: Db, table: string): string[] {
  return db.prepare<[], { name: string }>(`PRAGMA table_info(${ident(table)})`).all().map((c) => c.name);
}

/** Collects how many rows each `table.column` changed. */
function counter(): { add(table: string, column: string, n: number): void; result(): Record<string, number> } {
  const counts = new Map<string, number>();
  return {
    add(table, column, n) {
      if (n > 0) counts.set(`${table}.${column}`, (counts.get(`${table}.${column}`) ?? 0) + n);
    },
    result: () => Object.fromEntries(counts),
  };
}

function renameTables(db: Db, renames: readonly Rename[], direction: Direction): void {
  for (const r of renames.map((rename) => swap(rename, direction))) {
    if (!tableExists(db, r.from)) throw new Error(`name-map: table ${r.from} does not exist`);
    db.exec(`ALTER TABLE ${ident(r.from)} RENAME TO ${ident(r.to)}`);
  }
}

function rebuild(db: Db, spec: TableRebuild, direction: Direction): void {
  const [source, target] = direction === 'forward' ? [spec.from, spec.to] : [spec.to, spec.from];
  if (!tableExists(db, source.table)) throw new Error(`name-map: table ${source.table} does not exist`);
  if (tableExists(db, target.table)) throw new Error(`name-map: table ${target.table} already exists`);
  db.exec(target.ddl);
  if (direction === 'forward') {
    const into = spec.columns.map((c) => ident(c.to)).join(', ');
    const values = spec.columns.map((c) => (c.from !== undefined ? ident(c.from) : '?')).join(', ');
    const constants = spec.columns.flatMap((c) => (c.from === undefined ? [c.value ?? null] : []));
    db.prepare(`INSERT INTO ${ident(target.table)} (${into}) SELECT ${values} FROM ${ident(source.table)}`).run(...constants);
  } else {
    const kept = spec.columns.filter((c) => c.from !== undefined);
    const fixed = spec.columns.filter((c) => c.from === undefined);
    const where = fixed.length === 0 ? '' : ` WHERE ${fixed.map((c) => `${ident(c.to)} IS ?`).join(' AND ')}`;
    const fixedValues = fixed.map((c) => c.value ?? null);
    const total = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${ident(source.table)}`).get()?.n ?? 0;
    const matching = db.prepare<unknown[], { n: number }>(`SELECT COUNT(*) AS n FROM ${ident(source.table)}${where}`).get(...fixedValues)?.n ?? 0;
    if (matching !== total) {
      throw new Error(`name-map: ${total - matching} row(s) of ${source.table} have no place in ${target.table}; nothing was changed`);
    }
    const into = kept.map((c) => ident(c.from ?? '')).join(', ');
    const values = kept.map((c) => ident(c.to)).join(', ');
    db.prepare(`INSERT INTO ${ident(target.table)} (${into}) SELECT ${values} FROM ${ident(source.table)}${where}`).run(...fixedValues);
  }
  db.exec(`DROP TABLE ${ident(source.table)}`);
}

function renameColumns(db: Db, renames: NonNullable<NameMap['columns']>, direction: Direction): void {
  for (const rename of renames) {
    const r = swap(rename, direction);
    const table = rename.table;
    if (!columnsOf(db, table).includes(r.from)) throw new Error(`name-map: column ${table}.${r.from} does not exist`);
    db.exec(`ALTER TABLE ${ident(table)} RENAME COLUMN ${ident(r.from)} TO ${ident(r.to)}`);
  }
}

/** Plain value rewrites, column by column. */
function rewriteValues(db: Db, map: NameMap, direction: Direction, count: ReturnType<typeof counter>): void {
  for (const entry of map.values ?? []) {
    const r = swap(entry, direction);
    const result = db.prepare(`UPDATE ${ident(entry.table)} SET ${ident(entry.column)} = ? WHERE ${ident(entry.column)} = ?`).run(r.to, r.from);
    count.add(entry.table, entry.column, result.changes);
  }
}

const startsWith = (column: string): string => `substr(${column}, 1, length(?)) = ?`;

/** The self host, the manager's pane, and every session id that names them. */
function rewriteHosts(db: Db, map: NameMap, direction: Direction, count: ReturnType<typeof counter>): void {
  if (map.selfHost === undefined) return;
  const host = swap(map.selfHost, direction);
  const targets = (map.targets ?? []).map((t) => swap(t, direction));
  const fromPrefix = `${host.from}${SESSION_SEP}`;
  const toPrefix = `${host.to}${SESSION_SEP}`;
  for (const col of NAME_BEARING_COLUMNS) {
    if (!tableExists(db, col.table)) continue;
    const t = ident(col.table);
    const c = ident(col.column);
    if (col.kind === 'host') {
      count.add(col.table, col.column, db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(host.to, host.from).changes);
    } else if (col.kind === 'session-id' || col.kind === 'ref') {
      for (const target of targets) {
        count.add(col.table, col.column,
          db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(`${toPrefix}${target.to}`, `${fromPrefix}${target.from}`).changes);
      }
      count.add(col.table, col.column, db.prepare(`UPDATE ${t} SET ${c} = ? || substr(${c}, length(?) + 1) WHERE ${startsWith(c)}`)
        .run(toPrefix, fromPrefix, fromPrefix, fromPrefix).changes);
    } else if ((col.kind === 'target' || col.kind === 'display') && col.hostColumn !== undefined) {
      for (const target of targets) {
        const [from, to] = col.kind === 'target' ? [target.from, target.to] : [displayNameFor(target.from), displayNameFor(target.to)];
        count.add(col.table, col.column, db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ? AND ${ident(col.hostColumn)} = ?`)
          .run(to, from, host.to).changes);
      }
    } else if (col.kind === 'json') {
      rewriteJson(db, col, host, targets, count);
    }
  }
}

function rewriteJson(db: Db, col: NameBearingColumn, host: Rename, targets: readonly Rename[], count: ReturnType<typeof counter>): void {
  const t = ident(col.table);
  const c = ident(col.column);
  const valid = `json_valid(${c})`;
  const fromPrefix = `${host.from}${SESSION_SEP}`;
  const toPrefix = `${host.to}${SESSION_SEP}`;
  for (const field of col.json ?? []) {
    const at = `json_extract(${c}, '${field.path.replace(/'/g, "''")}')`;
    const path = field.path;
    if (field.kind === 'host') {
      count.add(col.table, col.column, db.prepare(`UPDATE ${t} SET ${c} = json_set(${c}, ?, ?) WHERE ${valid} AND ${at} = ?`)
        .run(path, host.to, host.from).changes);
    } else if (field.kind === 'session-id') {
      for (const target of targets) {
        count.add(col.table, col.column, db.prepare(`UPDATE ${t} SET ${c} = json_set(${c}, ?, ?) WHERE ${valid} AND ${at} = ?`)
          .run(path, `${toPrefix}${target.to}`, `${fromPrefix}${target.from}`).changes);
      }
      count.add(col.table, col.column, db.prepare(
        `UPDATE ${t} SET ${c} = json_set(${c}, ?, ? || substr(${at}, length(?) + 1)) WHERE ${valid} AND ${startsWith(at)}`,
      ).run(path, toPrefix, fromPrefix, fromPrefix, fromPrefix).changes);
    } else if (col.hostPath !== undefined) {
      const owner = `json_extract(${c}, '${col.hostPath.replace(/'/g, "''")}')`;
      for (const target of targets) {
        count.add(col.table, col.column, db.prepare(`UPDATE ${t} SET ${c} = json_set(${c}, ?, ?) WHERE ${valid} AND ${at} = ? AND ${owner} = ?`)
          .run(path, target.to, target.from, host.to).changes);
      }
    }
  }
}

function renameSettingsKeys(db: Db, renames: readonly Rename[], direction: Direction, count: ReturnType<typeof counter>): void {
  const has = db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM settings WHERE key = ?');
  const drop = db.prepare<[string]>('DELETE FROM settings WHERE key = ?');
  const move = db.prepare<[string, string]>('UPDATE settings SET key = ? WHERE key = ?');
  for (const r of renames.map((rename) => swap(rename, direction))) {
    if ((has.get(r.from)?.n ?? 0) === 0) continue;
    if ((has.get(r.to)?.n ?? 0) > 0) drop.run(r.from);
    else move.run(r.to, r.from);
    count.add('settings', 'key', 1);
  }
}

function reseal(db: Db, labels: Rename, secret: string | undefined, direction: Direction, count: ReturnType<typeof counter>): void {
  if (secret === undefined || secret === '') throw new Error('name-map: resealing needs the session secret');
  const r = swap(labels, direction);
  const open = sealer(secret, r.from);
  const seal = sealer(secret, r.to);
  for (const col of NAME_BEARING_COLUMNS.filter((entry) => entry.kind === 'sealed')) {
    if (!tableExists(db, col.table)) continue;
    const t = ident(col.table);
    const c = ident(col.column);
    const rows = db.prepare<[], { rid: number; value: string | null }>(`SELECT rowid AS rid, ${c} AS value FROM ${t}`).all();
    const write = db.prepare<[string, number]>(`UPDATE ${t} SET ${c} = ? WHERE rowid = ?`);
    for (const row of rows) {
      if (row.value === null || row.value === '') continue;
      let plain: string;
      try {
        plain = open.open(row.value);
      } catch {
        throw new Error(`name-map: ${col.table}.${col.column} row ${row.rid} does not open with the ${direction === 'forward' ? 'old' : 'new'} sealing label`);
      }
      write.run(seal.seal(plain), row.rid);
      count.add(col.table, col.column, 1);
    }
  }
}

/**
 * Converts the database in one transaction: forward turns old names into the public ones, inverse turns them back.
 * The file itself is not renamed here (the database is open); `renameDatabaseFile` does that after it is closed.
 */
export function applyNameMap(db: Db, map: NameMap, opts: ApplyOptions): ApplyResult {
  const { direction } = opts;
  const count = counter();
  const renames = (): void => {
    if (direction === 'forward') {
      renameTables(db, map.tables ?? [], direction);
      for (const spec of map.rebuilds ?? []) rebuild(db, spec, direction);
      renameColumns(db, map.columns ?? [], direction);
    } else {
      renameColumns(db, map.columns ?? [], direction);
      for (const spec of map.rebuilds ?? []) rebuild(db, spec, direction);
      renameTables(db, map.tables ?? [], direction);
    }
  };
  const values = (): void => {
    rewriteValues(db, map, direction, count);
    rewriteHosts(db, map, direction, count);
    renameSettingsKeys(db, map.settingsKeys ?? [], direction, count);
    if (map.seal !== undefined) reseal(db, map.seal, opts.secret, direction, count);
  };
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (direction === 'forward') {
        renames();
        values();
      } else {
        values();
        renames();
      }
    })();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
  }
  const file = map.file !== undefined && opts.file !== undefined ? plannedFile(opts.file, swap(map.file, direction)) : null;
  return { changed: count.result(), file };
}

function plannedFile(file: string, names: Rename): Rename | null {
  return basename(file) === names.from ? { from: file, to: join(dirname(file), names.to) } : null;
}

const DB_FILE_SUFFIXES = ['', '-wal', '-shm'] as const;

/**
 * Renames the closed database file and its -wal and -shm companions. Nothing to move (already renamed) is a no-op;
 * a target that already exists beside a source is refused before anything moves.
 */
export function renameDatabaseFile(plan: Rename): void {
  const moving = DB_FILE_SUFFIXES.filter((suffix) => existsSync(`${plan.from}${suffix}`));
  if (moving.length === 0) return;
  for (const suffix of DB_FILE_SUFFIXES) {
    if (existsSync(`${plan.to}${suffix}`)) throw new Error(`name-map: ${plan.to}${suffix} already exists`);
  }
  for (const suffix of moving) renameSync(`${plan.from}${suffix}`, `${plan.to}${suffix}`);
}

export interface UnknownValue {
  readonly table: string;
  readonly column: string;
  readonly value: string;
  readonly rows: number;
}

export interface VocabularyCheck {
  readonly ok: boolean;
  readonly unknown: readonly UnknownValue[];
}

/** Where a public table and column live in the database before the conversion runs in `direction`. */
function storedName(map: NameMap, direction: Direction, table: string, column: string): { table: string; column: string } {
  if (direction === 'inverse') return { table, column };
  const rebuilt = (map.rebuilds ?? []).find((spec) => spec.to.table === table);
  if (rebuilt !== undefined) {
    const from = rebuilt.columns.find((c) => c.to === column)?.from;
    return { table: rebuilt.from.table, column: from ?? column };
  }
  const renamedTable = (map.tables ?? []).find((r) => r.to === table)?.from ?? table;
  const renamedColumn = (map.columns ?? []).find((r) => r.table === table && r.to === column)?.from ?? column;
  return { table: renamedTable, column: renamedColumn };
}

/** The stored values a conversion in `direction` rewrites in a public column: they are known too. */
function rewritten(map: NameMap, direction: Direction, table: string, column: string): Set<string> {
  const side = (r: Rename): string => (direction === 'forward' ? r.from : r.to);
  const known = new Set((map.values ?? []).filter((v) => v.table === table && v.column === column).map(side));
  const kind = NAME_BEARING_COLUMNS.find((c) => c.table === table && c.column === column)?.kind;
  if (kind === 'host' && map.selfHost !== undefined) known.add(side(map.selfHost));
  if (kind === 'settings-key') for (const r of map.settingsKeys ?? []) known.add(side(r));
  return known;
}

/**
 * Fails, listing table, column, value and row count, when a column of STORED_VOCABULARY holds a value that is neither
 * in the public set nor rewritten by the map. Run it before converting (`direction` is the conversion about to run).
 */
export function checkVocabulary(db: Db, map: NameMap, direction: Direction = 'forward'): VocabularyCheck {
  const unknown: UnknownValue[] = [];
  for (const entry of STORED_VOCABULARY) {
    const at = storedName(map, direction, entry.table, entry.column);
    if (!tableExists(db, at.table) || !columnsOf(db, at.table).includes(at.column)) continue;
    const allowed = new Set([...entry.values, ...rewritten(map, direction, entry.table, entry.column)]);
    const prefixes = entry.prefixes ?? [];
    const c = ident(at.column);
    const rows = db.prepare<[], { value: string; n: number }>(
      `SELECT ${c} AS value, COUNT(*) AS n FROM ${ident(at.table)} WHERE ${c} IS NOT NULL GROUP BY ${c} ORDER BY ${c}`,
    ).all();
    for (const row of rows) {
      const value = String(row.value);
      if (allowed.has(value) || prefixes.some((prefix) => value.startsWith(prefix)) || entry.grammar?.(value) === true) continue;
      unknown.push({ table: entry.table, column: entry.column, value, rows: row.n });
    }
  }
  return { ok: unknown.length === 0, unknown };
}
