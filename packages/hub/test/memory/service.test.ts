import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { buildFtsQuery } from '../../src/memory/fts-query.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createFakeClock } from '../helpers/fakes.js';

function setup() {
  const db = openMemoryDb();
  const clock = createFakeClock('2026-10-09T12:00:00.000Z');
  return { db, memory: createMemoryService({ db, clock }) };
}

describe('createMemoryService', () => {
  it('records a message row and returns its DTO', () => {
    const { db, memory } = setup();
    const dto = memory.record({ thread: 'manager', role: 'owner', channel: 'test-channel', text: 'deploy meadow-hr', extId: 'wamid.1' });
    expect(dto).toEqual({
      id: expect.any(String),
      thread: 'manager',
      role: 'owner',
      channel: 'test-channel',
      text: 'deploy meadow-hr',
      ts: '2026-10-09T12:00:00.000Z',
    });
    expect(db.prepare('SELECT id, ext_id FROM messages').get()).toEqual({ id: dto.id, ext_id: 'wamid.1' });
  });

  it('finds messages containing every term, best match first', () => {
    const { memory } = setup();
    memory.record({ thread: 'manager', role: 'owner', channel: 'web', text: 'deploy meadow-hr to staging' });
    memory.record({ thread: 'session:cedar:cc-meadow-hr:0.0', role: 'assistant', channel: null, text: 'meadow-hr deploy failed: missing env' });
    memory.record({ thread: 'manager', role: 'manager', channel: null, text: 'meadow-hr meadow-hr deploy deploy deploy' });
    memory.record({ thread: 'manager', role: 'owner', channel: 'web', text: 'unrelated note' });
    const hits = memory.search('meadow-hr deploy', 10);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.text).toBe('meadow-hr meadow-hr deploy deploy deploy');
    expect(hits.map((hit) => hit.thread)).toContain('session:cedar:cc-meadow-hr:0.0');
  });

  it('treats FTS syntax in queries as plain words', () => {
    const { memory } = setup();
    memory.record({ thread: 'manager', role: 'owner', channel: 'test-channel', text: 'foo bar baz' });
    memory.record({ thread: 'manager', role: 'manager', channel: null, text: 'unrelated message' });
    memory.record({ thread: 'manager', role: 'owner', channel: 'web', text: 'the foo or 1=1 trick' });
    expect(buildFtsQuery('foo" OR 1=1')).toBe('"foo""" AND "OR" AND "1=1"');
    expect(memory.search('foo" OR 1=1', 10).map((hit) => hit.text)).toEqual(['the foo or 1=1 trick']);
    expect(() => memory.search('" OR "" NEAR(', 10)).not.toThrow();
    expect(memory.search('bar*', 10).map((hit) => hit.text)).toEqual(['foo bar baz']);
  });

  it('returns nothing when no searchable word remains', () => {
    const { memory } = setup();
    memory.record({ thread: 'manager', role: 'owner', channel: 'web', text: 'anything at all' });
    expect(buildFtsQuery('" * () -')).toBeNull();
    expect(memory.search('" * () -', 10)).toEqual([]);
  });

  it('clips snippets to 300 characters and honours the limit', () => {
    const { memory } = setup();
    const long = `${Array.from({ length: 60 }, (_, i) => `token${i}${'z'.repeat(15)}`).join(' ')} needle`;
    for (let i = 0; i < 5; i += 1) memory.record({ thread: 'manager', role: 'manager', channel: null, text: long });
    const hits = memory.search('needle', 2);
    expect(hits).toHaveLength(2);
    expect(Array.from(hits[0]?.text ?? '').length).toBeLessThanOrEqual(300);
  });

  it('searches Arabic text', () => {
    const { memory } = setup();
    memory.record({ thread: 'manager', role: 'owner', channel: 'test-channel', text: 'شغّل الاختبارات مرة أخرى' });
    expect(memory.search('الاختبارات', 5)).toEqual([expect.objectContaining({ text: 'شغّل الاختبارات مرة أخرى', role: 'owner' })]);
  });

  it('rejects invalid records', () => {
    const { memory } = setup();
    expect(() => memory.record({ thread: '', role: 'owner', channel: null, text: 'x' })).toThrow(ValidationError);
    expect(() => memory.record({ thread: 'manager', role: 'robot' as never, channel: null, text: 'x' })).toThrow(ValidationError);
  });
});
