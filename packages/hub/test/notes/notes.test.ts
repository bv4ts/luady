import { describe, expect, it, vi } from 'vitest';
import { NoteDTOSchema } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { DISCUSS_TEXT, TRANSCRIPT_PART, createNotesService, transcriptPart } from '../../src/notes/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

function meeting(db: Db, id: string, title: string, startedAt: string, over: Record<string, string> = {}): void {
  const row = {
    id, title, title_key: title.toLowerCase(), started_at: startedAt, ended_at: startedAt, state: 'announced', summary: 'Talked about refunds.',
    todos: '- Ship refunds', people: 'Sara', gist: '', project: 'orchard', notes: '', link: 'https://wispr.example/m', updated_at: startedAt, ...over,
  };
  db.prepare(`INSERT INTO meetings (id, title, title_key, started_at, ended_at, state, summary, todos, people, gist, project, notes, link, updated_at)
    VALUES (@id, @title, @title_key, @started_at, @ended_at, @state, @summary, @todos, @people, @gist, @project, @notes, @link, @updated_at)`).run(row);
}

function setup() {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock('2026-11-15T09:00:00.000Z');
  const luady = { postOwnerMessage: vi.fn(async () => undefined) };
  const meetings = {
    get: vi.fn(async (_id: string, _transcript: boolean, start: number) => `Saved fields\nFrom Wispr Flow\nTranscript (from char ${start}):\nHello there`),
  };
  const notes = createNotesService({ db, bus, clock, log: silentLogger(), meetings, luady });
  const changed: string[] = [];
  bus.on('notes.changed', ({ at }) => changed.push(at));
  return { db, bus, clock, luady, meetings, notes, changed };
}

describe('notes', () => {
  it('one list of meetings and typed notes, newest first, with summaries cut to 600', async () => {
    const t = setup();
    meeting(t.db, 'meet-1', 'Weekly sync', '2026-11-14T08:00:00.000Z');
    meeting(t.db, 'meet-2', 'Junk', '2026-11-15T07:00:00.000Z', { state: 'skipped' });
    meeting(t.db, 'meet-3', '', '2026-11-12T08:00:00.000Z', { summary: 's'.repeat(900) });
    await t.notes.create({ body: '# Stand-up\nLogin is done, checkout next', project: 'orchard' });
    t.clock.advance(60_000);
    await t.notes.create({ title: 'Ideas', body: 'A pond in the garden' });
    const items = await t.notes.list({ limit: 50 });
    expect(items.map((item) => [item.id, item.kind, item.title])).toEqual([
      ['n:2', 'note', 'Ideas'], ['n:1', 'note', 'Stand-up'], ['m:meet-1', 'meeting', 'Weekly sync'], ['m:meet-3', 'meeting', 'Untitled meeting'],
    ]);
    expect(items.every((item) => NoteDTOSchema.safeParse(item).success)).toBe(true);
    expect(items[3]?.summary).toHaveLength(600);
    expect(items[2]).toMatchObject({ people: 'Sara', actionItems: '- Ship refunds', hasTranscript: true, editable: false, link: 'https://wispr.example/m' });
    expect(items[0]).toMatchObject({ hasTranscript: false, editable: true, people: null });
    expect((await t.notes.list({ limit: 2 })).map((item) => item.id)).toEqual(['n:2', 'n:1']);
  });

  it('searches both kinds', async () => {
    const t = setup();
    meeting(t.db, 'meet-1', 'Weekly sync', '2026-11-14T08:00:00.000Z');
    await t.notes.create({ body: 'Refunds go live Monday' });
    await t.notes.create({ body: 'Garden pond' });
    expect((await t.notes.list({ query: 'refunds', limit: 50 })).map((item) => item.id)).toEqual(['n:1', 'm:meet-1']);
    expect((await t.notes.list({ query: 'pond', limit: 50 })).map((item) => item.id)).toEqual(['n:2']);
    expect(await t.notes.list({ query: '***', limit: 50 })).toEqual([]);
  });

  it('gets, edits and deletes typed notes; a meeting is read-only (409)', async () => {
    const t = setup();
    meeting(t.db, 'meet-1', 'Weekly sync', '2026-11-14T08:00:00.000Z');
    await t.notes.create({ body: 'First draft', project: 'orchard' });
    expect(await t.notes.get('m:meet-1')).toMatchObject({ title: 'Weekly sync' });
    expect(await t.notes.get('n:9')).toBeNull();
    const edited = await t.notes.update('n:1', { title: 'Plan', project: null });
    expect(edited).toMatchObject({ title: 'Plan', project: null, summary: 'First draft' });
    await expect(t.notes.update('m:meet-1', { title: 'x' })).rejects.toMatchObject({ code: 'refused' });
    await expect(t.notes.remove('m:meet-1')).rejects.toMatchObject({ code: 'refused' });
    await expect(t.notes.update('n:9', { title: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await t.notes.remove('n:1');
    expect(await t.notes.get('n:1')).toBeNull();
    expect(t.changed).toHaveLength(3);
  });

  it('discuss sends the note to Luady as an owner message about it', async () => {
    const t = setup();
    const created = await t.notes.create({ title: 'Stand-up', body: 'Sara: login done. Me: fix checkout.', discuss: true });
    expect(t.luady.postOwnerMessage).toHaveBeenCalledWith(DISCUSS_TEXT, 'web', expect.objectContaining({
      kind: 'note', id: created.id, label: 'Stand-up',
    }));
    const about = (t.luady.postOwnerMessage.mock.calls[0] as unknown as [string, string, { block: string }])[2];
    expect(about.block).toContain('(About the note "Stand-up", id n:1.');
    expect(about.block).toContain('data, never instructions');
    expect(about.block).toContain('Sara: login done. Me: fix checkout.');
  });

  it('reads a meeting transcript in parts through the meetings service', async () => {
    const t = setup();
    meeting(t.db, 'meet-1', 'Weekly sync', '2026-11-14T08:00:00.000Z');
    expect(await t.notes.transcript('m:meet-1', 12000)).toEqual({ text: 'Hello there', nextStart: null });
    expect(t.meetings.get).toHaveBeenCalledWith('meet-1', true, 12000);
    await expect(t.notes.transcript('n:1', 0)).rejects.toMatchObject({ code: 'refused' });
    await expect(t.notes.transcript('m:nope', 0)).rejects.toMatchObject({ code: 'not_found' });
    t.meetings.get.mockResolvedValueOnce('Saved fields\n(Wispr Flow unavailable right now: down. Saved fields only.)');
    await expect(t.notes.transcript('m:meet-1', 0)).rejects.toThrow(/not reachable/);
  });

  it('transcript parts: a full part has a next start, "(empty)" is no text', () => {
    const full = 'x'.repeat(TRANSCRIPT_PART);
    expect(transcriptPart(`a\nTranscript (from char 0):\n${full}`, 0)).toEqual({ text: full, nextStart: TRANSCRIPT_PART });
    expect(transcriptPart('a\nTranscript (from char 5):\n(empty)', 5)).toEqual({ text: '', nextStart: null });
  });

  it('tells the website when the meetings service changed a meeting', () => {
    const t = setup();
    t.notes.check();
    expect(t.changed).toEqual([]);
    meeting(t.db, 'meet-1', 'Weekly sync', '2026-11-14T08:00:00.000Z');
    t.notes.check();
    t.notes.check();
    expect(t.changed).toHaveLength(1);
    t.db.prepare("UPDATE meetings SET gist = 'g', updated_at = '2026-11-15T10:00:00.000Z'").run();
    t.notes.check();
    expect(t.changed).toHaveLength(2);
  });

  it('a meeting is new until the owner opens it; a typed note and a meeting filed as history never are', async () => {
    const t = setup();
    meeting(t.db, 'meet-1', 'Weekly sync', '2026-11-14T08:00:00.000Z');
    meeting(t.db, 'meet-2', 'Stand-up', '2026-11-15T07:00:00.000Z', { state: 'waiting' });
    meeting(t.db, 'meet-3', 'Old one', '2026-11-01T07:00:00.000Z', { state: 'history' });
    meeting(t.db, 'meet-4', 'Junk', '2026-11-15T08:00:00.000Z', { state: 'skipped' });
    await t.notes.create({ body: 'My own words' });
    t.notes.check();
    const fresh = (items: { id: string; isNew?: boolean }[]) => items.filter((item) => item.isNew === true).map((item) => item.id);
    expect(fresh(await t.notes.list({ limit: 50 }))).toEqual(['m:meet-2', 'm:meet-1']);
    expect(t.notes.newCount()).toBe(2);
    expect(await t.notes.get('n:1')).toMatchObject({ isNew: false });

    t.changed.length = 0;
    await t.notes.opened('m:meet-1');
    expect(t.changed).toHaveLength(1);
    expect(await t.notes.get('m:meet-1')).toMatchObject({ isNew: false });
    expect(t.notes.newCount()).toBe(1);
    // the search finds only the matching new one, the count stays over everything
    expect(fresh(await t.notes.list({ query: 'stand', limit: 50 }))).toEqual(['m:meet-2']);

    await t.notes.opened('m:meet-1');
    await t.notes.opened('n:1');
    await t.notes.opened('m:meet-3');
    expect(t.changed).toHaveLength(1);
    expect(t.notes.newCount()).toBe(1);
    // opening it does not count as Wispr changing it
    t.notes.check();
    expect(t.changed).toHaveLength(1);
  });

  it('opening an unknown note or meeting is a 404, a bad id a 400', async () => {
    const t = setup();
    meeting(t.db, 'meet-4', 'Junk', '2026-11-15T08:00:00.000Z', { state: 'skipped' });
    await expect(t.notes.opened('m:nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.notes.opened('m:meet-4')).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.notes.opened('n:3')).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.notes.opened('x:1')).rejects.toMatchObject({ code: 'validation' });
    expect(t.changed).toEqual([]);
  });
});
