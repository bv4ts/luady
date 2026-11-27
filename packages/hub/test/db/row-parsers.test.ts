import { describe, expect, it } from 'vitest';
import { createBus } from '../../src/core/bus.js';
import type { Db, Fleet } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { toCardDto, type CardRow } from '../../src/board/store.js';
import { createJiraStore } from '../../src/jira/store.js';
import { createKbStore } from '../../src/kb/store.js';
import { createLinksService } from '../../src/links/index.js';
import { createProjectsService } from '../../src/projects/service.js';
import { createQuestionsRepo } from '../../src/questions/repo.js';
import { createSessionsRepo } from '../../src/sessions/repo.js';
import { serverOf } from '../../src/timeline/sources.js';
import { createWinsService } from '../../src/wins/index.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import { createFakeClock } from '../helpers/fakes.js';

/**
 * Every row parser below keeps a row whose host passes the open grammar (a host no fixed list knew, `mars`,
 * and the self host, `hq`), and logs any other row with its table and key, so no row is dropped silently.
 */
const NOW = '2026-11-21T08:00:00.000Z';
const HOSTS = ['mars', 'hq'] as const;

function seed(db: Db, host: string): void {
  db.prepare(`INSERT INTO sessions (id, host, tmux_target, display_name, state, origin, created_at) VALUES (?, ?, 'cc-x:0.0', 'x', 'idle', 'owner', ?)`)
    .run(`${host}:cc-x:0.0`, host, NOW);
  db.prepare(`INSERT INTO questions (qid, kind, host, session_id, payload_json, state, created_at) VALUES (?, 'question', ?, ?, '{"label":"x"}', 'pending', ?)`)
    .run(host === 'hq' ? 'HQAAAAAA' : 'MARSAAAA', host, `${host}:cc-x:0.0`, NOW);
  db.prepare(`INSERT INTO projects (server, path, name, git_json, stack_json, updated_at) VALUES (?, '/srv/x', 'x', '{"remote":null,"branch":null,"commits":[]}', '[]', ?)`)
    .run(host, NOW);
  db.prepare(`INSERT INTO kb_pages (scope, server, project, slug, title, updated_at, updated_by, created_at) VALUES ('office', ?, '', ?, 'x', ?, 'owner', ?)`)
    .run(host, `p-${host}`, NOW, NOW);
  db.prepare('INSERT INTO kb_sync (server, synced_at, digest) VALUES (?, ?, ?)').run(host, NOW, 'd');
  db.prepare('INSERT INTO todos (text, done, created_at, done_at, server, state) VALUES (?, 1, ?, ?, ?, \'done\')').run(`card ${host}`, NOW, NOW, host);
  db.prepare('INSERT INTO links (server, label, url, position, created_at) VALUES (?, ?, ?, 0, ?)').run(host, host, `https://example.com/${host}`, NOW);
  db.prepare(`INSERT INTO jira_sites (server, base_url, email, token_enc, connected_at) VALUES (?, 'https://x.atlassian.net', 'o@example.com', 's', ?)`)
    .run(host, NOW);
}

const noFleet = { servers: () => [] } as unknown as Fleet;

function readAll(db: Db, log = createCaptureLogger().log) {
  return {
    sessions: createSessionsRepo(db, log).list().map((row) => row.host),
    questions: createQuestionsRepo(db, log).pending().map((row) => row.host),
    projects: createProjectsService({ db, clock: createFakeClock(NOW), fleet: noFleet, log }).list().map((p) => p.server),
    kbPages: createKbStore(db, log).all().map((page) => page.server),
    kbSync: [...createKbStore(db, log).synced().keys()],
    cards: (db.prepare('SELECT * FROM todos ORDER BY id').all() as CardRow[]).map((row) => toCardDto(row, log).server),
    wins: createWinsService({ db, clock: createFakeClock(NOW), log }).wins(7).items.map((win) => win.server),
    links: createLinksService({ db, bus: createBus(), clock: createFakeClock(NOW), log }).list().map((link) => link.server),
    jira: createJiraStore(db, log).sites().map((site) => site.server),
  };
}

describe('row parsers keep every host id', () => {
  it('a mars row and an hq row come back from every table', () => {
    const db = openMemoryDb();
    for (const host of HOSTS) seed(db, host);
    const read = readAll(db);
    for (const [table, hosts] of Object.entries(read)) expect([...hosts].sort(), table).toEqual(['hq', 'mars']);
    expect(serverOf('mars')).toBe('mars');
  });

  it('a row whose key is no host id is left out and logged with its table and key, never silently', () => {
    const db = openMemoryDb();
    seed(db, 'mars');
    db.prepare(`INSERT INTO sessions (id, host, tmux_target, display_name, state, origin, created_at) VALUES ('Bad:x', 'Bad Host', 'cc-x:0.0', 'x', 'idle', 'owner', ?)`).run(NOW);
    db.prepare(`INSERT INTO questions (qid, kind, host, session_id, payload_json, state, created_at) VALUES ('BADAAAAA', 'question', 'Bad Host', 'x', '{}', 'pending', ?)`).run(NOW);
    db.prepare(`INSERT INTO projects (server, path, name, git_json, stack_json, updated_at) VALUES ('Bad Host', '/x', 'x', '{}', '[]', ?)`).run(NOW);
    db.prepare(`INSERT INTO links (server, label, url, position, created_at) VALUES ('Bad Host', 'x', 'https://example.com', 0, ?)`).run(NOW);
    db.prepare(`INSERT INTO jira_sites (server, base_url, email, token_enc, connected_at) VALUES ('Bad Host', 'https://x.atlassian.net', 'o', 's', ?)`).run(NOW);
    const capture = createCaptureLogger();
    const read = readAll(db, capture.log);
    expect(read.sessions).toEqual(['mars']);
    expect(read.questions).toEqual(['mars']);
    expect(read.projects).toEqual(['mars']);
    expect(read.links).toEqual(['mars']);
    expect(read.jira).toEqual(['mars']);
    const tables = capture.lines.map((line) => JSON.parse(line) as { level: number; table?: string }).filter((entry) => entry.level === 40);
    expect(tables.map((entry) => entry.table)).toEqual(expect.arrayContaining(['sessions', 'questions', 'projects', 'links', 'jira_sites']));
  });

  it('a card or win whose host is no host id keeps its row, shown without a host, and is logged with its table and key', () => {
    const db = openMemoryDb();
    db.prepare(`INSERT INTO todos (text, server, done, done_at, created_at) VALUES ('fix it', 'Bad Host', 1, ?, ?)`).run(NOW, NOW);
    const capture = createCaptureLogger();
    const read = readAll(db, capture.log);
    expect(read.cards).toEqual([null]);
    expect(read.wins).toEqual([null]);
    const warned = capture.lines.map((line) => JSON.parse(line) as { level: number; table?: string; id?: number; server?: string })
      .filter((entry) => entry.level === 40 && entry.table === 'todos');
    expect(warned).toEqual([expect.objectContaining({ id: 1, server: 'Bad Host' }), expect.objectContaining({ id: 1, server: 'Bad Host' })]);
  });
});
