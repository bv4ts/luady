import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { retireBoard } from '../../src/missions/board-cleanup.js';
import { createFakeOutbound, silentLogger } from '../helpers/fakes.js';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function withBoard(): Db {
  const db = openMemoryDb();
  db.prepare("INSERT INTO board (id, chat_msg_id, sent_at, shown) VALUES (1, 'wamid.BOARD', '2026-11-13T10:00:00.000Z', 'x')").run();
  return db;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('retireBoard', () => {
  it('unpins and deletes the pinned board message once, then empties the table (the table itself stays)', () => {
    const db = withBoard();
    const outbound = createFakeOutbound();
    expect(retireBoard({ db, outbound, log: silentLogger() })).toBe(true);
    expect(outbound.pins).toEqual([{ msgId: 'wamid.BOARD', on: false }]);
    expect(outbound.revokes).toEqual(['wamid.BOARD']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM board').get()).toEqual({ n: 0 });
    expect(retireBoard({ db, outbound, log: silentLogger() })).toBe(true);
    expect(outbound.revokes).toEqual(['wamid.BOARD']);
  });

  it('waits while the chat is down and keeps the row', () => {
    const db = withBoard();
    const outbound = createFakeOutbound();
    outbound.up = false;
    expect(retireBoard({ db, outbound, log: silentLogger() })).toBe(false);
    expect(outbound.pins).toEqual([]);
    expect(outbound.revokes).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM board').get()).toEqual({ n: 1 });
  });

  it('has nothing to do without a board row', () => {
    const outbound = createFakeOutbound();
    expect(retireBoard({ db: openMemoryDb(), outbound, log: silentLogger() })).toBe(true);
    expect(outbound.pins).toEqual([]);
    expect(outbound.revokes).toEqual([]);
  });

  it('is done when a later release already dropped the table', () => {
    const db = openMemoryDb();
    db.exec('DROP TABLE board');
    expect(retireBoard({ db, outbound: createFakeOutbound(), log: silentLogger() })).toBe(true);
  });

  it('nothing in the hub source builds or names the "Running now" board any more (migrations are a ledger, left as they are)', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => !relative(SRC, path).startsWith(join('db', 'migrations')))
      .filter((path) => /Running now|createRunningBoard/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(offenders).toEqual([]);
  });
});
