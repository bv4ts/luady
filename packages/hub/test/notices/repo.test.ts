import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createNoticesRepo, NOTICE_RETENTION_DAYS, toNoticeDto, type NoticeRow } from '../../src/notices/repo.js';

const T0 = '2026-11-14T10:00:00.000Z';
const opened: Db[] = [];

function freshDb(): Db {
  const db = openMemoryDb();
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function row(over: Partial<NoticeRow> = {}): NoticeRow {
  return {
    id: 'n1', kind: 'result', text: 'Mission done', ref: { kind: 'session', id: 'cedar:cc-a:0.0' }, createdAt: T0,
    chatDueAt: at(10), chatSentAt: null, chatMsgId: null, settledAt: null, settledVia: null, ...over,
  };
}

describe('notices repository', () => {
  it('round-trips a row, a null ref included, and maps it to the wire shape', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row());
    repo.insert(row({ id: 'n2', ref: null, chatDueAt: null }));
    expect(repo.get('n1')).toEqual(row());
    expect(repo.get('n2')).toEqual(row({ id: 'n2', ref: null, chatDueAt: null }));
    expect(repo.get('missing')).toBeUndefined();
    expect(toNoticeDto(row())).toEqual({
      id: 'n1', kind: 'result', text: 'Mission done', ref: { kind: 'session', id: 'cedar:cc-a:0.0' }, createdAt: T0,
      chatDueAt: at(10), chatSentAt: null, settledAt: null, settledVia: null,
    });
  });

  it('due() returns only unsent, unsettled rows whose time has come, oldest first', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row({ id: 'late', createdAt: at(2), chatDueAt: at(12) }));
    repo.insert(row({ id: 'early', createdAt: at(0), chatDueAt: at(10) }));
    repo.insert(row({ id: 'future', createdAt: at(5), chatDueAt: at(15) }));
    repo.insert(row({ id: 'sent', chatDueAt: at(1), chatSentAt: at(1) }));
    repo.insert(row({ id: 'settled', chatDueAt: at(1), settledAt: at(1), settledVia: 'web' }));
    repo.insert(row({ id: 'none', chatDueAt: null }));
    expect(repo.due(at(9)).map((r) => r.id)).toEqual([]);
    expect(repo.due(at(12)).map((r) => r.id)).toEqual(['early', 'late']);
  });

  it('claimSend wins once, never for a settled row', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row());
    repo.insert(row({ id: 'n2', settledAt: T0, settledVia: 'web' }));
    expect(repo.claimSend('n1', at(10))).toBe(true);
    expect(repo.claimSend('n1', at(10))).toBe(false);
    expect(repo.get('n1')?.chatSentAt).toBe(at(10));
    expect(repo.claimSend('n2', at(10))).toBe(false);
    expect(repo.claimSend('missing', at(10))).toBe(false);
  });

  it('settle wins once and a settled row is no longer due', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row());
    expect(repo.settle('n1', 'web', at(3))).toBe(true);
    expect(repo.settle('n1', 'answer', at(4))).toBe(false);
    expect(repo.get('n1')).toMatchObject({ settledAt: at(3), settledVia: 'web' });
    expect(repo.due(at(20))).toEqual([]);
  });

  it('openByRef finds the unsettled notices that point at a question', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row({ id: 'q1', kind: 'question', ref: { kind: 'question', id: 'ABCDEFGH' } }));
    repo.insert(row({ id: 'q2', kind: 'question', ref: { kind: 'question', id: 'ABCDEFGH' }, settledAt: T0, settledVia: 'answer' }));
    repo.insert(row({ id: 'other', ref: { kind: 'question', id: 'ZZZZZZZZ' } }));
    expect(repo.openByRef('question', 'ABCDEFGH').map((r) => r.id)).toEqual(['q1']);
    expect(repo.openByRef('action', 'ABCDEFGH')).toEqual([]);
  });

  it('setMessage and setDue update one row', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row());
    repo.setMessage('n1', 'wamid.1');
    repo.setDue('n1', at(30));
    expect(repo.get('n1')).toMatchObject({ chatMsgId: 'wamid.1', chatDueAt: at(30) });
  });

  it('bringForward makes every pending fallback due now and leaves a sent one alone', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row({ id: 'a', chatDueAt: at(10) }));
    repo.insert(row({ id: 'b', chatDueAt: at(9) }));
    repo.insert(row({ id: 'sent', chatDueAt: at(10), chatSentAt: at(1) }));
    repo.insert(row({ id: 'none', chatDueAt: null }));
    expect(repo.bringForward(at(1))).toBe(2);
    expect(repo.due(at(1)).map((r) => r.id)).toEqual(['a', 'b']);
    expect(repo.get('sent')?.chatDueAt).toBe(at(10));
    expect(repo.get('none')?.chatDueAt).toBeNull();
  });

  it('recent() returns every unsettled row first, then the newest settled ones, newest first', () => {
    const repo = createNoticesRepo(freshDb());
    for (let i = 0; i < 5; i += 1) repo.insert(row({ id: `open-${i}`, createdAt: at(i) }));
    repo.insert(row({ id: 'done-old', createdAt: at(-10), settledAt: at(-9), settledVia: 'web' }));
    repo.insert(row({ id: 'done-new', createdAt: at(-5), settledAt: at(-4), settledVia: 'test-channel' }));
    expect(repo.recent(3).map((r) => r.id)).toEqual(['open-4', 'open-3', 'open-2', 'open-1', 'open-0']);
    expect(repo.recent(6).map((r) => r.id)).toEqual(['open-4', 'open-3', 'open-2', 'open-1', 'open-0', 'done-new']);
    expect(repo.recent(10).map((r) => r.id)).toEqual(['open-4', 'open-3', 'open-2', 'open-1', 'open-0', 'done-new', 'done-old']);
  });

  it('purge deletes only settled rows settled before the cut', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row({ id: 'old-settled', createdAt: at(-100), settledAt: at(-90), settledVia: 'web' }));
    repo.insert(row({ id: 'new-settled', settledAt: at(1), settledVia: 'web' }));
    repo.insert(row({ id: 'old-open', createdAt: at(-100) }));
    expect(repo.purge(at(0))).toBe(1);
    expect(repo.get('old-settled')).toBeUndefined();
    expect(repo.get('new-settled')).toBeDefined();
    expect(repo.get('old-open')).toBeDefined();
  });

  it('expire settles unsettled rows older than the cut as expired, so nothing open piles up forever', () => {
    const repo = createNoticesRepo(freshDb());
    repo.insert(row({ id: 'old-open', createdAt: at(-100) }));
    repo.insert(row({ id: 'new-open', createdAt: at(1) }));
    expect(repo.expire(at(0), at(2))).toBe(1);
    expect(repo.get('old-open')).toMatchObject({ settledAt: at(2), settledVia: 'expired' });
    expect(repo.get('new-open')?.settledAt).toBeNull();
    expect(NOTICE_RETENTION_DAYS).toBe(30);
  });

  it('skips rows whose kind or ref kind no longer parses', () => {
    const db = freshDb();
    const repo = createNoticesRepo(db);
    repo.insert(row({ id: 'good' }));
    db.prepare("INSERT INTO notices (id, kind, text, ref_kind, ref_id, created_at) VALUES ('bogus', 'bogus', 'x', NULL, NULL, ?)").run(at(1));
    db.prepare("INSERT INTO notices (id, kind, text, ref_kind, ref_id, created_at) VALUES ('badref', 'result', 'x', 'board', '1', ?)").run(at(2));
    expect(repo.recent(10).map((r) => r.id)).toEqual(['good']);
    expect(repo.get('bogus')).toBeUndefined();
  });
});
