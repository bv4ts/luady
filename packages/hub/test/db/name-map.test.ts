import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shared from '@luady/shared';
import { ChannelSchema, ChatMessageDTOSchema } from '@luady/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_KINDS } from '../../src/actions/params.js';
import { createActionStore } from '../../src/actions/store.js';
import { createLimitsStore } from '../../src/accounts/limits.js';
import { createCardStore } from '../../src/board/store.js';
import { createLoginState } from '../../src/claude-login/state.js';
import { createBus } from '../../src/core/bus.js';
import type { Db } from '../../src/core/contracts.js';
import { SEAL_LABEL, sealer } from '../../src/core/seal.js';
import {
  NAME_BEARING_COLUMNS, NOT_NAME_BEARING, STORED_VOCABULARY, applyNameMap, checkVocabulary, renameDatabaseFile, type NameMap,
} from '../../src/db/name-map.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createServersRepo } from '../../src/fleet/servers-repo.js';
import { LINK_KINDS } from '../../src/inbound/router.js';
import { createOffsetsRepo } from '../../src/ingest/offsets.js';
import { createJiraStore } from '../../src/jira/store.js';
import { createKbStore } from '../../src/kb/store.js';
import { readLuadyState } from '../../src/luady/launch.js';
import { createMeetingStore } from '../../src/meetings/store.js';
import { createNoteStore } from '../../src/notes/store.js';
import { createNoticesRepo } from '../../src/notices/repo.js';
import { createQuestionsRepo } from '../../src/questions/repo.js';
import { createSessionsRepo } from '../../src/sessions/repo.js';
import { createSettingsService } from '../../src/settings/service.js';
import { CHALLENGE_PURPOSES } from '../../src/web/auth/challenges.js';

const T = '2026-11-21T12:00:00.000Z';
const SECRET = 'round-trip-session-secret';
const OLD_LABEL = 'oldname-google:';
const PLAIN = { google: 'google-refresh-token', wispr: 'wispr-refresh-token', jira: 'jira-api-token' } as const;

const OLD_LINKS_DDL = 'CREATE TABLE old_links (old_msg_id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL)';
const OLD_SEEN_DDL = 'CREATE TABLE old_seen (msg_id TEXT PRIMARY KEY, seen_at TEXT NOT NULL)';
const NEW_LINKS_DDL = `CREATE TABLE channel_links (
  channel TEXT NOT NULL, msg_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (channel, msg_id)
)`;
const NEW_SEEN_DDL = 'CREATE TABLE channel_seen (channel TEXT NOT NULL, msg_id TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (channel, msg_id))';

/** The name map with placeholder old names (old → new). A real conversion supplies its own map when it runs; no real names are stored here. */
const MAP: NameMap = {
  tables: [{ from: 'oldname_queue', to: 'manager_queue' }, { from: 'oldname_state', to: 'manager_state' }],
  rebuilds: [
    {
      from: { table: 'old_links', ddl: OLD_LINKS_DDL }, to: { table: 'channel_links', ddl: NEW_LINKS_DDL },
      columns: [{ to: 'channel', value: 'test-channel' }, { to: 'msg_id', from: 'old_msg_id' }, { to: 'kind', from: 'kind' },
        { to: 'ref_id', from: 'ref_id' }, { to: 'created_at', from: 'created_at' }],
    },
    {
      from: { table: 'old_seen', ddl: OLD_SEEN_DDL }, to: { table: 'channel_seen', ddl: NEW_SEEN_DDL },
      columns: [{ to: 'channel', value: 'test-channel' }, { to: 'msg_id', from: 'msg_id' }, { to: 'seen_at', from: 'seen_at' }],
    },
  ],
  columns: [
    { table: 'missions', from: 'old_msg_id', to: 'chat_msg_id' },
    { table: 'todo_boards', from: 'old_msg_id', to: 'chat_msg_id' },
    { table: 'board', from: 'old_msg_id', to: 'chat_msg_id' },
    { table: 'notices', from: 'old_msg_id', to: 'chat_msg_id' },
    { table: 'notices', from: 'old_due_at', to: 'chat_due_at' },
    { table: 'notices', from: 'old_sent_at', to: 'chat_sent_at' },
  ],
  values: [
    { table: 'sessions', column: 'origin', from: 'oldname', to: 'manager' },
    { table: 'actions', column: 'actor', from: 'oldname', to: 'manager' },
    { table: 'actions', column: 'kind', from: 'old.logout', to: 'channel.unlink' },
    { table: 'messages', column: 'role', from: 'oldname', to: 'manager' },
    { table: 'messages', column: 'thread', from: 'oldname', to: 'manager' },
    { table: 'channel_links', column: 'kind', from: 'oldname', to: 'manager' },
    { table: 'notices', column: 'ref_kind', from: 'oldname', to: 'manager' },
    { table: 'todos', column: 'source', from: 'oldname', to: 'manager' },
    { table: 'todos', column: 'source', from: 'oldchat', to: 'chat' },
    { table: 'kb_pages', column: 'updated_by', from: 'oldname', to: 'manager' },
  ],
  selfHost: { from: 'oldhost', to: 'hq' },
  targets: [{ from: 'oldname:0.0', to: 'manager:0.0' }],
  settingsKeys: [
    { from: 'oldname_model', to: 'manager_model' }, { from: 'oldname_effort', to: 'manager_effort' },
    { from: 'login.identity.oldhost', to: 'login.identity.hq' },
  ],
  seal: { from: OLD_LABEL, to: SEAL_LABEL },
  file: { from: 'oldname.db', to: 'hub.db' },
};

const open: Db[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function fresh(): Db {
  const db = openMemoryDb();
  open.push(db);
  return db;
}

/** One row (or more) in every table of the public 001-016, with names in every name-bearing column. */
function seed(db: Db): void {
  const box = sealer(SECRET);
  const run = (sql: string, ...args: unknown[]): void => {
    db.prepare(sql).run(...args);
  };
  run(`INSERT INTO servers (name, host, user, host_key_fp, status, last_seen_at, sysinfo_json, kit_version, claude_version)
    VALUES ('cedar', 'cedar.example.invalid', 'dev', 'SHA256:abc', 'online', ?, NULL, '2.1.0', '2.1.0')`, T);
  // 016: a room (setup_state has its row from the migration).
  run(`INSERT INTO rooms (id, name, short, kind, host, match_json, colour, accent, species, position, created_at, updated_at)
    VALUES ('meadow', 'Meadow', 'Meadow', 'server', 'cedar', '[]', '#7c5cff', '#bdadff', 'shield', 2, ?, ?)`, T, T);
  const session = `INSERT INTO sessions (id, host, tmux_target, claude_session_id, transcript_path, cwd, project, display_name, state, origin,
    registered, created_at, last_event_at, turn_started_at, turn_remote, pending_qid, unexpected_end) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?, ?, NULL, 0, NULL, 0)`;
  run(session, 'hq:manager:0.0', 'hq', 'manager:0.0', '/srv/brain', 'brain', 'manager', 'idle', 'system', T, T);
  run(session, 'cedar:cc-orchard:0.0', 'cedar', 'cc-orchard:0.0', '/home/dev/projects/orchard', 'orchard', 'orchard', 'working', 'manager', T, T);
  run('INSERT INTO events (id, host, session_id, type, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)', 'e1', 'hq', 'hq:manager:0.0', 'stop', T,
    JSON.stringify({ v: 1, id: 'e1', ts: T, host: 'hq', session_id: 'c-1', cwd: '/srv/brain', tmux: 'manager:0.0', event: 'stop', data: {} }));
  run(`INSERT INTO questions (qid, kind, host, session_id, payload_json, state, created_at, notified_at, escalated_at, resolved_at, answer_json, resolved_via)
    VALUES ('ABCDEFGH', 'question', 'hq', 'hq:manager:0.0', ?, 'answered', ?, NULL, NULL, ?, '{}', 'test-channel')`, JSON.stringify({ label: 'cedar · orchard' }), T, T);
  const action = `INSERT INTO actions (id, seq, actor, channel, kind, tier, summary, params_json, status, created_at, decided_at, executed_at, result_text, error)
    VALUES (?, ?, ?, ?, ?, 1, 'x', ?, 'done', ?, ?, ?, 'ok', NULL)`;
  run(action, 'A1', 1, 'manager', 'test-channel', 'channel.unlink', '{"reason":"test"}', T, T, T);
  run(action, 'A2', 2, 'owner', 'web', 'account.logout', '{"target":"hq"}', T, T, T);
  run(action, 'A3', 3, 'manager', 'event', 'session.stop', '{"sessionId":"hq:manager:0.0","force":false}', T, T, T);
  const message = 'INSERT INTO messages (id, thread, role, channel, text, ts, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
  run(message, 'm1', 'manager', 'owner', 'test-channel', 'status?', T, null);
  run(message, 'm2', 'manager', 'manager', 'web', 'All good.', T, 'e1');
  const link = 'INSERT INTO channel_links (channel, msg_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)';
  run(link, 'test-channel', 'wamid.1', 'manager', 'm2', T);
  run(link, 'test-channel', 'wamid.2', 'session', 'hq:manager:0.0', T);
  run('INSERT INTO channel_seen (channel, msg_id, seen_at) VALUES (?, ?, ?)', 'test-channel', 'wamid.in.1', T);
  run('INSERT INTO injections (session_id, text_sha256, channel, created_at) VALUES (?, ?, ?, ?)', 'hq:manager:0.0', 'f'.repeat(64), 'web', T);
  run('INSERT INTO projects (server, path, name, git_json, stack_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    'cedar', '/home/dev/projects/orchard', 'orchard', '{"remote":null,"branch":"main","commits":[]}', '["node"]', T);
  const setting = 'INSERT INTO settings (key, value_json) VALUES (?, ?)';
  run(setting, 'manager_model', '"sonnet"');
  run(setting, 'manager_effort', '"high"');
  run(setting, 'login.identity.hq', JSON.stringify({ orgId: 'org_1', email: 'o@example.invalid', orgName: 'Org', plan: 'max' }));
  run(setting, 'login.brain_signed_out', 'false');
  run('INSERT INTO offsets (host, file, offset) VALUES (?, ?, ?)', 'hq', 'events-20261121.jsonl', 42);
  run(`INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at, last_used_at)
    VALUES ('cred-1', x'00', 0, '["internal"]', 'Passkey', ?, NULL)`, T);
  run('INSERT INTO auth_sessions (sid, csrf, created_at, last_seen_at) VALUES (?, ?, ?, ?)', 'sid-1', 'csrf-1', T, T);
  run('INSERT INTO auth_challenges (id, challenge, purpose, expires_at) VALUES (?, ?, ?, ?)', 'ch-1', 'abc', 'login', T);
  run('UPDATE pin_state SET hash = ? WHERE id = 1', 'pin-hash');
  run('INSERT INTO setup_codes (code_sha256, purpose, expires_at, used_at) VALUES (?, ?, ?, NULL)', 'c'.repeat(64), 'owner_setup', T);
  run('INSERT INTO schedules (id, when_spec, task, next_run_at, created_at, active) VALUES (?, ?, ?, ?, ?, 1)', 's1', '0 9 * * *', 'brief', T, T);
  run('INSERT INTO manager_queue (text, channel, created_at) VALUES (?, ?, ?)', 'queued for the manager', 'web', T);
  run('UPDATE manager_state SET claude_session_id = ?, started_at = ?, last_input_channel = ? WHERE id = 1', 'claude-1', T, 'web');
  run('INSERT INTO daily_runs (job, day, ran_at) VALUES (?, ?, ?)', 'digest', '2026-11-21', T);
  run(`INSERT INTO missions (session_id, label, title, phase, turns, note, last_text, managed, chat_msg_id, sent_at, opened_at, idle_since)
    VALUES (?, 'cedar · orchard', 'Fix login', 'working', 1, NULL, NULL, 1, 'wamid.3', ?, ?, NULL)`, 'hq:manager:0.0', T, T);
  const todo = `INSERT INTO todos (id, text, today, done, created_at, details, project, server, source, source_ref, state, priority, auto, session_id, updated_at)
    VALUES (?, ?, 0, 0, ?, '', ?, ?, ?, ?, 'open', 0, 0, ?, ?)`;
  run(todo, 1, 'From the manager', T, 'orchard', 'cedar', 'manager', null, null, T);
  run(todo, 2, 'From the chat', T, null, null, 'chat', null, null, T);
  run(todo, 3, 'From a session', T, 'orchard', 'cedar', 'session', 'hq:manager:0.0', 'hq:manager:0.0', T);
  run('INSERT INTO todo_boards (chat_msg_id, sent_at, pinned_at) VALUES (?, ?, ?)', 'wamid.4', T, T);
  run('INSERT INTO google_accounts (email, label, refresh_enc, added_at) VALUES (?, ?, ?, ?)', 'o@example.invalid', 'Work', box.seal(PLAIN.google), T);
  run('INSERT INTO google_seen (account, item, seen_at) VALUES (?, ?, ?)', 'o@example.invalid', 'mail-1', T);
  run('INSERT INTO board (id, chat_msg_id, sent_at, shown) VALUES (1, ?, ?, ?)', 'wamid.5', T, '');
  run('INSERT INTO login_alerts (host, alert, sent_at) VALUES (?, ?, ?)', 'hq', 'out', T);
  run('INSERT INTO wispr_auth (id, client_id, refresh_enc, connected_at, redirect_uri) VALUES (1, ?, ?, ?, ?)', 'client-1', box.seal(PLAIN.wispr), T,
    'https://hub.example.invalid/api/wispr/callback');
  run(`INSERT INTO meetings (id, title, title_key, started_at, ended_at, state, updated_at) VALUES ('mt-1', 'Stand-up', 'stand-up', ?, ?, 'history', ?)`, T, T, T);
  const notice = `INSERT INTO notices (id, kind, text, ref_kind, ref_id, created_at, chat_due_at, chat_sent_at, chat_msg_id, settled_at, settled_via)
    VALUES (?, 'reply', 'All good.', ?, ?, ?, ?, ?, ?, ?, ?)`;
  run(notice, 'n1', 'manager', 'm2', T, T, T, 'wamid.6', T, 'test-channel');
  run(notice, 'n2', 'session', 'hq:manager:0.0', T, T, null, null, null, null);
  run('INSERT INTO account_limits (host, five_hour_json, seven_day_json, reported, empty_readings, updated_at) VALUES (?, NULL, NULL, ?, 0, ?)', 'hq', 'no', T);
  run('INSERT INTO todo_events (todo_id, at, kind, text) VALUES (1, ?, ?, ?)', T, 'created', 'Added by the manager.');
  run('INSERT INTO message_refs (message_id, ref_kind, ref_id) VALUES (?, ?, ?)', 'm1', 'todo', '1');
  run("INSERT INTO notes (title, body, project, source, created_at, updated_at) VALUES ('Note', 'Body', NULL, 'web', ?, ?)", T, T);
  run(`INSERT INTO kb_pages (scope, server, project, slug, title, body, tags, updated_at, updated_by, created_at)
    VALUES ('office', 'cedar', '', 'deploy', 'Deploy', 'Run the migrations first', '[]', ?, 'manager', ?)`, T, T);
  run('INSERT INTO kb_sync (server, synced_at, digest) VALUES (?, ?, ?)', 'cedar', T, 'd1');
  run(`INSERT INTO jira_sites (server, base_url, email, token_enc, cloud_id, account_id, display_name, connected_at, last_ok_at, last_error)
    VALUES ('birch', 'https://orchard.example.invalid', 'o@example.invalid', ?, NULL, NULL, NULL, ?, NULL, NULL)`, box.seal(PLAIN.jira), T);
  run('INSERT INTO jira_seen (server, key, seen_at) VALUES (?, ?, ?)', 'birch', 'ORC-1', T);
  run('INSERT INTO links (server, label, url, position, created_at) VALUES (?, ?, ?, 0, ?)', 'birch', 'Jira', 'https://orchard.example.invalid', T);
}

/** The base tables (no full-text shadow tables): their rows are what a conversion may change. */
function baseTables(db: Db): string[] {
  return db.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE '%_fts_%' ORDER BY name",
  ).all().map((row) => row.name);
}

const SEALED = new Set(NAME_BEARING_COLUMNS.filter((c) => c.kind === 'sealed').map((c) => `${c.table}.${c.column}`));

/** Every base table's rows, ordered, with sealed values replaced by their plaintext under `label`. */
function rows(db: Db, label: string): Record<string, unknown[]> {
  const box = sealer(SECRET, label);
  return Object.fromEntries(baseTables(db).map((table) => {
    const all = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
    const opened = all.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [
      column, SEALED.has(`${table}.${column}`) && typeof value === 'string' ? `open:${box.open(value)}` : value,
    ])));
    return [table, opened.map((row) => JSON.stringify(row)).sort()];
  }));
}

/** Tables, indexes and triggers as SQLite stores them. */
function schema(db: Db): string[] {
  return db.prepare<[], { line: string }>(
    "SELECT type || ' ' || name || ': ' || COALESCE(sql, '') AS line FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name",
  ).all().map((row) => row.line);
}

/** The raw ciphertexts: a reseal changes them (a new IV), while the plaintext stays. */
function sealedValues(db: Db): string[] {
  return NAME_BEARING_COLUMNS.filter((c) => c.kind === 'sealed')
    .flatMap((c) => (db.prepare(`SELECT "${c.column}" AS v FROM "${c.table}"`).all() as Array<{ v: string }>).map((row) => row.v));
}

function textColumns(db: Db): string[] {
  return baseTables(db).flatMap((table) => db.prepare<[], { name: string; type: string }>(`PRAGMA table_info("${table}")`).all()
    .filter((c) => c.type.toUpperCase() === 'TEXT').map((c) => `${table}.${c.name}`));
}

/** The public database turned into the old shape with the placeholder names. */
function oldShaped(): Db {
  const db = fresh();
  seed(db);
  applyNameMap(db, MAP, { direction: 'inverse', secret: SECRET });
  return db;
}

describe('name-map: completeness', () => {
  it('classifies every TEXT column after the migrations as name-bearing or not', () => {
    const db = fresh();
    const registered = [...NAME_BEARING_COLUMNS.map((c) => `${c.table}.${c.column}`), ...NOT_NAME_BEARING];
    expect(new Set(registered).size).toBe(registered.length);
    expect(textColumns(db).filter((column) => !registered.includes(column))).toEqual([]);
    expect(registered.filter((column) => !textColumns(db).includes(column))).toEqual([]);
  });

  it('seeds at least one row in every table', () => {
    const db = fresh();
    seed(db);
    const empty = baseTables(db).filter((table) => table !== 'sqlite_sequence')
      .filter((table) => (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n === 0);
    expect(empty).toEqual([]);
  });
});

describe('name-map: round trip on the public 001-016', () => {
  it('the inverse map gives an old-shaped database with only the placeholder names', () => {
    const db = oldShaped();
    const tables = baseTables(db);
    expect(tables).toEqual(expect.arrayContaining(['oldname_queue', 'oldname_state', 'old_links', 'old_seen']));
    expect(tables).not.toEqual(expect.arrayContaining(['manager_queue']));
    expect(tables.filter((t) => ['manager_queue', 'manager_state', 'channel_links', 'channel_seen'].includes(t))).toEqual([]);
    const dump = Object.values(rows(db, OLD_LABEL)).flat().join('\n');
    expect(dump).toContain('"origin":"oldname"');
    expect(dump).not.toMatch(/"hq"|hq:|"manager"|manager:0\.0|channel\.unlink|"chat"|manager_model|login\.identity\.hq/);
    expect(db.prepare('SELECT id, host, tmux_target, display_name, origin FROM sessions ORDER BY id').all()).toEqual([
      { id: 'cedar:cc-orchard:0.0', host: 'cedar', tmux_target: 'cc-orchard:0.0', display_name: 'orchard', origin: 'oldname' },
      { id: 'oldhost:oldname:0.0', host: 'oldhost', tmux_target: 'oldname:0.0', display_name: 'oldname', origin: 'system' },
    ]);
    expect(db.prepare("SELECT params_json FROM actions WHERE id = 'A3'").get()).toEqual({ params_json: '{"sessionId":"oldhost:oldname:0.0","force":false}' });
    expect(db.prepare('SELECT old_msg_id, kind, ref_id FROM old_links ORDER BY old_msg_id').all()).toEqual([
      { old_msg_id: 'wamid.1', kind: 'oldname', ref_id: 'm2' }, { old_msg_id: 'wamid.2', kind: 'session', ref_id: 'oldhost:oldname:0.0' },
    ]);
    expect(db.prepare('SELECT key FROM settings ORDER BY key').all().map((r) => (r as { key: string }).key))
      .toEqual(['login.brain_signed_out', 'login.identity.oldhost', 'oldname_effort', 'oldname_model']);
  });

  it('forward gives back every row, read through the hub repositories and parsers, and the action listing does not throw', () => {
    const db = oldShaped();
    applyNameMap(db, MAP, { direction: 'forward', secret: SECRET });

    const sessions = createSessionsRepo(db);
    expect(sessions.list().map((s) => [s.id, s.host, s.tmuxTarget, s.displayName, s.origin]).sort()).toEqual([
      ['cedar:cc-orchard:0.0', 'cedar', 'cc-orchard:0.0', 'orchard', 'manager'],
      ['hq:manager:0.0', 'hq', 'manager:0.0', 'manager', 'system'],
    ]);
    expect(createQuestionsRepo(db).get('ABCDEFGH')).toMatchObject({ host: 'hq', sessionId: 'hq:manager:0.0' });
    const actions = createActionStore(db).list({ limit: 100 });
    expect(actions.map((a) => [a.id, a.actor, a.kind, a.params])).toEqual(expect.arrayContaining([
      ['A1', 'manager', 'channel.unlink', { reason: 'test' }],
      ['A2', 'owner', 'account.logout', { target: 'hq' }],
      ['A3', 'manager', 'session.stop', { sessionId: 'hq:manager:0.0', force: false }],
    ]));
    expect(actions).toHaveLength(3);
    const messages = db.prepare('SELECT id, thread, role, channel, text, ts FROM messages ORDER BY id').all()
      .map((row) => ChatMessageDTOSchema.parse(row));
    expect(messages.map((m) => [m.id, m.thread, m.role])).toEqual([['m1', 'manager', 'owner'], ['m2', 'manager', 'manager']]);
    const links = db.prepare("SELECT msg_id, kind, ref_id FROM channel_links WHERE channel = 'test-channel' ORDER BY msg_id").all() as
      Array<{ msg_id: string; kind: string; ref_id: string }>;
    expect(links).toEqual([{ msg_id: 'wamid.1', kind: 'manager', ref_id: 'm2' }, { msg_id: 'wamid.2', kind: 'session', ref_id: 'hq:manager:0.0' }]);
    expect(links.every((l) => (LINK_KINDS as readonly string[]).includes(l.kind))).toBe(true);
    expect(db.prepare('SELECT channel, msg_id FROM channel_seen').all()).toEqual([{ channel: 'test-channel', msg_id: 'wamid.in.1' }]);
    const notices = createNoticesRepo(db);
    expect(notices.get('n1')).toMatchObject({ ref: { kind: 'manager', id: 'm2' }, chatMsgId: 'wamid.6', settledVia: 'test-channel' });
    expect(notices.get('n2')).toMatchObject({ ref: { kind: 'session', id: 'hq:manager:0.0' } });
    const cards = createCardStore(db);
    expect([1, 2, 3].map((id) => [cards.get(id)?.source, cards.get(id)?.source_ref, cards.get(id)?.session_id]))
      .toEqual([['manager', null, null], ['chat', null, null], ['session', 'hq:manager:0.0', 'hq:manager:0.0']]);
    expect(createKbStore(db).all().map((page) => page.updatedBy)).toEqual(['manager']);
    expect(createJiraStore(db).sites().map((site) => site.server)).toEqual(['birch']);
    expect(createServersRepo(db).get('cedar')).toMatchObject({ name: 'cedar' });
    expect(createLimitsStore(db).all().map((l) => l.host)).toEqual(['hq']);
    expect(createOffsetsRepo(db).get('hq')).toEqual({ file: 'events-20261121.jsonl', offset: 42 });
    expect(createNoteStore(db).notes(undefined, 10)).toHaveLength(1);
    expect(createMeetingStore(db).get('mt-1')).toBeDefined();
    const queued = db.prepare('SELECT channel FROM manager_queue').all() as Array<{ channel: string }>;
    expect(queued.map((q) => ChannelSchema.parse(q.channel))).toEqual(['web']);
    expect(readLuadyState(db)).toEqual({ claude_session_id: 'claude-1', started_at: T, last_input_channel: 'web' });
    expect(createSettingsService({ db, bus: createBus() }).get()).toMatchObject({ manager_model: 'sonnet', manager_effort: 'high' });
    expect(createLoginState(db).identity('hq')).toMatchObject({ orgId: 'org_1' });
    expect(db.prepare("SELECT json_extract(payload_json, '$.host') AS host, json_extract(payload_json, '$.tmux') AS tmux FROM events").get())
      .toEqual({ host: 'hq', tmux: 'manager:0.0' });
  });

  it('forward then inverse equals the old-shaped database; sealed columns open to the same plaintext', () => {
    const db = oldShaped();
    const before = { schema: schema(db), rows: rows(db, OLD_LABEL), sealed: sealedValues(db) };
    applyNameMap(db, MAP, { direction: 'forward', secret: SECRET });
    applyNameMap(db, MAP, { direction: 'inverse', secret: SECRET });
    expect(schema(db)).toEqual(before.schema);
    expect(rows(db, OLD_LABEL)).toEqual(before.rows);
    expect(sealedValues(db)).not.toEqual(before.sealed);
  });

  it('inverse then forward gives back the public rows', () => {
    const db = fresh();
    seed(db);
    const before = rows(db, SEAL_LABEL);
    applyNameMap(db, MAP, { direction: 'inverse', secret: SECRET });
    applyNameMap(db, MAP, { direction: 'forward', secret: SECRET });
    expect(rows(db, SEAL_LABEL)).toEqual(before);
  });

  it('reseals: a Jira token sealed under the placeholder label opens under hub-seal-v1: after the forward run', () => {
    const db = oldShaped();
    const old = (db.prepare("SELECT token_enc FROM jira_sites WHERE server = 'birch'").get() as { token_enc: string }).token_enc;
    expect(sealer(SECRET, OLD_LABEL).open(old)).toBe(PLAIN.jira);
    expect(() => sealer(SECRET).open(old)).toThrow();
    applyNameMap(db, MAP, { direction: 'forward', secret: SECRET });
    const sealed = (db.prepare("SELECT token_enc FROM jira_sites WHERE server = 'birch'").get() as { token_enc: string }).token_enc;
    expect(SEAL_LABEL).toBe('hub-seal-v1:');
    expect(sealer(SECRET).open(sealed)).toBe(PLAIN.jira);
    expect(() => sealer(SECRET, OLD_LABEL).open(sealed)).toThrow();
  });

  it('runs in one transaction: a failure (a wrong secret) leaves the database as it was', () => {
    const db = oldShaped();
    const before = rows(db, OLD_LABEL);
    expect(() => applyNameMap(db, MAP, { direction: 'forward', secret: 'another secret' })).toThrow(/does not open/);
    expect(rows(db, OLD_LABEL)).toEqual(before);
    expect(baseTables(db)).toContain('oldname_queue');
  });

  it('a settings key whose new name already exists is dropped, and the new row wins', () => {
    const db = oldShaped();
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('manager_model', '\"opus\"')").run();
    applyNameMap(db, MAP, { direction: 'forward', secret: SECRET });
    expect(db.prepare("SELECT key, value_json FROM settings WHERE key LIKE '%_model' ORDER BY key").all())
      .toEqual([{ key: 'manager_model', value_json: '"opus"' }]);
  });

  it('refuses an inverse that would lose rows of a rebuilt table', () => {
    const db = fresh();
    seed(db);
    db.prepare("INSERT INTO channel_links (channel, msg_id, kind, ref_id, created_at) VALUES ('signal', 's1', 'question', 'QQQQQQQQ', ?)").run(T);
    expect(() => applyNameMap(db, MAP, { direction: 'inverse', secret: SECRET })).toThrow(/no place in old_links/);
    expect(baseTables(db)).toContain('channel_links');
  });
});

describe('name-map: the database file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('names the target of the file rename, and renames the file with -wal and -shm once closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'name-map-file-'));
    dirs.push(dir);
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(join(dir, `oldname.db${suffix}`), suffix);
    const db = fresh();
    const plan = applyNameMap(db, { file: MAP.file }, { direction: 'forward', file: join(dir, 'oldname.db') }).file;
    expect(plan).toEqual({ from: join(dir, 'oldname.db'), to: join(dir, 'hub.db') });
    renameDatabaseFile(plan!);
    expect(readdirSync(dir).sort()).toEqual(['hub.db', 'hub.db-shm', 'hub.db-wal']);
    expect(readFileSync(join(dir, 'hub.db-wal'), 'utf8')).toBe('-wal');
    expect(() => renameDatabaseFile(plan!)).not.toThrow();
    writeFileSync(join(dir, 'oldname.db'), '');
    expect(() => renameDatabaseFile(plan!)).toThrow(/already exists/);
    expect(existsSync(join(dir, 'oldname.db'))).toBe(true);
  });
});

/** The value set each registry entry's `uses` stands for, read from the code the parser imports. */
const USES: Readonly<Record<string, readonly string[]>> = {
  SESSION_ORIGINS: shared.SESSION_ORIGINS, SessionStateSchema: shared.SessionStateSchema.options,
  QUESTION_KINDS: shared.QUESTION_KINDS, QUESTION_STATES: shared.QUESTION_STATES, ACTION_ACTORS: shared.ACTION_ACTORS,
  ChannelSchema: shared.BUILTIN_CHANNELS, ACTION_KINDS, ActionStatusSchema: shared.ActionStatusSchema.options,
  ChatMessageDTOSchema: [], LINK_KINDS, NoticeKindSchema: shared.NoticeKindSchema.options, NOTICE_REF_KINDS: shared.NOTICE_REF_KINDS,
  NoticeSettledViaSchema: shared.NOTICE_SETTLED_VIA, BOARD_SOURCES: shared.BOARD_SOURCES, BOARD_STATES: shared.BOARD_STATES,
  BOARD_EVENT_KINDS: shared.BOARD_EVENT_KINDS, KB_AUTHORS: shared.KB_AUTHORS, KB_SCOPES: shared.KB_SCOPES, CHALLENGE_PURPOSES,
  SettingsSchema: [], ROOM_KINDS: shared.ROOM_KINDS, ROOM_SPECIES: shared.ROOM_SPECIES, ROOM_SIZES: shared.ROOM_SIZES,
};

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith('.ts') ? [path] : [];
  });
}

/** Whether a schema or constant named in a row schema is a closed enum: a local `z.enum(` or a shared enum schema. */
function closedEnum(expr: string, text: string): boolean {
  if (expr.startsWith('z.enum(')) return true;
  const name = /^([A-Za-z_]\w*)/.exec(expr)?.[1];
  if (name === undefined) return false;
  if (new RegExp(`const ${name}\\s*=\\s*z\\.enum\\(`).test(text)) return true;
  const value = (shared as Record<string, unknown>)[name] as { _zod?: { def?: { type?: string } } } | undefined;
  return value?._zod?.def?.type === 'enum';
}

/** `field: <expr>` pairs of every `const …Row…Schema = z.object({ … })` in a file. */
function rowSchemaFields(text: string): Array<{ field: string; expr: string }> {
  const fields: Array<{ field: string; expr: string }> = [];
  const head = /const\s+\w*Row\w*Schema\s*=\s*z\.(?:object|strictObject)\(\{/g;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') depth -= 1;
      i += 1;
    }
    const body = text.slice(start, i - 1);
    for (const f of body.matchAll(/(?:^|[\s,{])([a-z_][a-z0-9_]*):\s*([^,\n]+(?:\([^)]*\))?)/g)) fields.push({ field: f[1]!, expr: f[2]!.trim() });
  }
  return fields;
}

describe('name-map: stored vocabulary', () => {
  it('each registered column reads with the enum its parser uses, and the registry holds exactly its values', () => {
    for (const entry of STORED_VOCABULARY) {
      const text = readFileSync(join(SRC, entry.parser), 'utf8');
      expect(text, `${entry.parser} reads ${entry.table}.${entry.column} with ${entry.uses}`).toContain(entry.uses);
      if (entry.uses === 'ChatMessageDTOSchema') {
        const shape = shared.ChatMessageDTOSchema.shape;
        const options = entry.column === 'role' ? shape.role.options : shared.BUILTIN_CHANNELS;
        expect([...entry.values]).toEqual([...options]);
      } else if (entry.uses === 'SettingsSchema') {
        expect(entry.values).toEqual(expect.arrayContaining([...shared.SETTINGS_KEYS]));
      } else {
        expect([...entry.values], `${entry.table}.${entry.column}`).toEqual([...(USES[entry.uses] ?? ['(unknown)'])]);
      }
    }
  });

  it('an open column (a channel) accepts an add-on id through its parser, and refuses what the grammar refuses', () => {
    const open = STORED_VOCABULARY.filter((entry) => entry.grammar !== undefined);
    expect(open.map((entry) => `${entry.table}.${entry.column}`)).toEqual([
      'actions.channel', 'messages.channel', 'notices.settled_via', 'manager_queue.channel', 'manager_state.last_input_channel',
      'injections.channel',
    ]);
    const parsers: Readonly<Record<string, { safeParse(value: unknown): { success: boolean } }>> = {
      ChannelSchema: shared.ChannelSchema, ChatMessageDTOSchema: shared.ChannelSchema, NoticeSettledViaSchema: shared.NoticeSettledViaSchema,
    };
    for (const entry of open) {
      const parser = parsers[entry.uses];
      for (const value of ['test-channel', 'test-channel', 'Not An Id', 'manager', 'hub']) {
        expect(parser?.safeParse(value).success, `${entry.uses} ${value}`).toBe(entry.grammar?.(value) === true || entry.values.includes(value));
      }
    }
  });

  it('registers no host column: the row parsers read every host with the open grammar, so a new host never trips them', () => {
    expect(STORED_VOCABULARY.filter((entry) => entry.column === 'host').map((entry) => entry.table)).toEqual([]);
    for (const parser of ['sessions/repo.ts', 'questions/repo.ts']) {
      const text = readFileSync(join(SRC, parser), 'utf8');
      expect(text, parser).toMatch(/host: HostIdSchema/);
      expect(text, parser).not.toMatch(/HostNameSchema|SERVER_NAMES|HOST_NAMES/);
    }
  });

  it('a source scan of hub/src finds no closed enum in a row schema that the registry is missing', () => {
    const missing: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, 'utf8');
      const parser = relative(SRC, path).split(sep).join('/');
      for (const { field, expr } of rowSchemaFields(text)) {
        if (!closedEnum(expr, text)) continue;
        if (!STORED_VOCABULARY.some((entry) => entry.parser === parser && entry.column === field)) missing.push(`${parser}: ${field} (${expr})`);
      }
      for (const m of text.matchAll(/\b(\w+Schema)\.(?:safeParse|parse)\(\s*\w+\??\.(\w+)\s*\)/g)) {
        const [, schema, field] = m;
        if (!closedEnum(schema!, text)) continue;
        if (!STORED_VOCABULARY.some((entry) => entry.parser === parser && entry.column === field)) missing.push(`${parser}: ${field} (${schema})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('checkVocabulary passes on the old-shaped database before the forward conversion, and on the public one before the inverse', () => {
    expect(checkVocabulary(oldShaped(), MAP, 'forward')).toEqual({ ok: true, unknown: [] });
    const db = fresh();
    seed(db);
    expect(checkVocabulary(db, MAP, 'inverse')).toEqual({ ok: true, unknown: [] });
  });

  it('checkVocabulary fails on a planted unknown value, and passes once the map rewrites it', () => {
    const db = oldShaped();
    db.prepare(`INSERT INTO actions (id, seq, actor, channel, kind, tier, summary, params_json, status, created_at)
      VALUES ('A9', 9, 'owner', 'web', 'zz.unknown', 0, 'x', '{}', 'done', ?)`).run(T);
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('zz_unknown_key', '1')").run();
    expect(checkVocabulary(db, MAP, 'forward')).toEqual({
      ok: false,
      unknown: [
        { table: 'actions', column: 'kind', value: 'zz.unknown', rows: 1 },
        { table: 'settings', column: 'key', value: 'zz_unknown_key', rows: 1 },
      ],
    });
    const fuller: NameMap = {
      ...MAP,
      values: [...MAP.values ?? [], { table: 'actions', column: 'kind', from: 'zz.unknown', to: 'channel.unlink' }],
      settingsKeys: [...MAP.settingsKeys ?? [], { from: 'zz_unknown_key', to: 'login.brain_signed_out' }],
    };
    expect(checkVocabulary(db, fuller, 'forward')).toEqual({ ok: true, unknown: [] });
  });
});
