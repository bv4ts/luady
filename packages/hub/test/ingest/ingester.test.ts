import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SELF_HOST_ID, type ActivitySpoolEvent, type HostId, type PermissionPreview, type SpoolEvent } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, Logger } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createIngester, forStorage, type ActivitySink } from '../../src/ingest/ingester.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeFleet, type FakeFleet, type FakeTail } from '../fleet/fake-fleet.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import {
  meters, pausedEvent, permission, permissionWithPreview, prompt, stop, subagent, toolEnd, toolStart,
} from '../sessions/spool-events.js';

const FILE = 'events-20261009.jsonl';

function tailLine(event: unknown, offset: number, file: string = FILE): string {
  return JSON.stringify({ file, offset, event });
}

function offsetRow(db: Db, host: HostId): unknown {
  return db.prepare('SELECT file, "offset" AS offset FROM offsets WHERE host = ?').get(host);
}

function eventCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
}

function tailAt(fleet: FakeFleet, index: number): FakeTail {
  const tail = fleet.tails[index];
  if (tail === undefined) throw new Error(`no tail #${index}`);
  return tail;
}

interface HarnessOptions {
  activity?: ActivitySink;
  log?: Logger;
}

function harness(db: Db = openMemoryDb(), options: HarnessOptions = {}) {
  const bus = createBus();
  const fleet = createFakeFleet();
  const seen: Array<{ host: HostId; id: string; replay: boolean }> = [];
  const busEvents: SpoolEvent[] = [];
  bus.on('spool.event', ({ host, event, replay }) => {
    seen.push({ host, id: event.id, replay });
    busEvents.push(event);
  });
  const ingester = createIngester({
    db,
    bus,
    clock: createFakeClock('2026-10-09T12:00:00.000Z'),
    fleet,
    log: options.log ?? silentLogger(),
    hosts: () => ['cedar'],
    ...(options.activity === undefined ? {} : { activity: options.activity }),
  });
  return { db, fleet, seen, busEvents, ingester };
}

function recordingSink(): ActivitySink & { calls: Array<{ host: HostId; event: ActivitySpoolEvent; replay: boolean }> } {
  const calls: Array<{ host: HostId; event: ActivitySpoolEvent; replay: boolean }> = [];
  return { calls, accept: (host, event, replay) => calls.push({ host, event, replay }) };
}

function storedPayload(db: Db, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT payload_json FROM events WHERE id = ?').get(id) as { payload_json: string } | undefined;
  if (row === undefined) throw new Error(`no events row ${id}`);
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

const PREVIEW: PermissionPreview = {
  tool: 'Bash', kind: 'command', command: 'rm -rf build', path: null, cwd: '/home/dev/projects/meadow-hr',
  edits: [], truncated: false, always: { label: 'rm commands in this project' },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createIngester', () => {
  it('starts from end on the first run and from the stored offset afterwards', async () => {
    const first = harness();
    first.ingester.start();
    expect(first.fleet.tails.map((tail) => [tail.host, tail.from])).toEqual([['cedar', 'end']]);
    await first.ingester.stop();
    first.db.prepare('INSERT INTO offsets (host, file, "offset") VALUES (?, ?, ?)').run('cedar', FILE, 512);
    const second = harness(first.db);
    second.ingester.start();
    expect(tailAt(second.fleet, 0).from).toBe(`${FILE}:512`);
    await second.ingester.stop();
  });

  it('reads the manager\'s own spool from its start on the first run (its first session start is written before the tail is up)', async () => {
    const db = openMemoryDb();
    const fleet = createFakeFleet();
    const ingester = createIngester({
      db, bus: createBus(), clock: createFakeClock('2026-10-09T12:00:00.000Z'), fleet, log: silentLogger(),
      hosts: () => ['cedar', SELF_HOST_ID],
    });
    ingester.start();
    expect(fleet.tails.map((tail) => [tail.host, tail.from])).toEqual([['cedar', 'end'], [SELF_HOST_ID, 'start']]);
    // While the manager is still setting up, its stream ends at once; the restart still reads from the start.
    const self = tailAt(fleet, 1);
    self.end();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fleet.tails.filter((tail) => tail.host === SELF_HOST_ID).map((tail) => tail.from)).toEqual(['start', 'start']);
    await ingester.stop();
    // With a stored offset, the manager's spool goes on from there like any host's.
    db.prepare('INSERT INTO offsets (host, file, "offset") VALUES (?, ?, ?)').run(SELF_HOST_ID, FILE, 64);
    const again = createFakeFleet();
    const next = createIngester({ db, bus: createBus(), clock: createFakeClock('2026-10-09T12:00:00.000Z'), fleet: again, log: silentLogger(), hosts: () => [SELF_HOST_ID] });
    next.start();
    expect(tailAt(again, 0).from).toBe(`${FILE}:64`);
    await next.stop();
  });

  it('resume from stored offset without duplicates', async () => {
    const a = stop('first', { id: 'evt-resume-0001' });
    const b = stop('second', { id: 'evt-resume-0002' });
    const c = stop('third', { id: 'evt-resume-0003' });
    const run1 = harness();
    run1.ingester.start();
    tailAt(run1.fleet, 0).emit(tailLine(a, 100));
    tailAt(run1.fleet, 0).emit(tailLine(b, 200));
    await run1.ingester.stop();
    expect(offsetRow(run1.db, 'cedar')).toEqual({ file: FILE, offset: 200 });

    // A crash after b was stored but before its offset was flushed leaves the older offset behind.
    run1.db.prepare('UPDATE offsets SET "offset" = 100 WHERE host = ?').run('cedar');
    const run2 = harness(run1.db);
    run2.ingester.start();
    const tail = tailAt(run2.fleet, 0);
    expect(tail.from).toBe(`${FILE}:100`);
    tail.emit(tailLine(b, 200));
    tail.emit(tailLine(c, 64, 'events-20261010.jsonl'));
    await run2.ingester.stop();
    expect([...run1.seen, ...run2.seen].map((entry) => entry.id)).toEqual(['evt-resume-0001', 'evt-resume-0002', 'evt-resume-0003']);
    expect(eventCount(run1.db)).toBe(3);
    expect(offsetRow(run1.db, 'cedar')).toEqual({ file: 'events-20261010.jsonl', offset: 64 });
  });

  it('skips invalid lines and invalid events but keeps the offset moving', async () => {
    const { ingester, fleet, seen, db } = harness();
    ingester.start();
    const tail = tailAt(fleet, 0);
    tail.emit('{"file":"events-20261009.jsonl","offset":');
    tail.emit('{"heartbeat":"2026-10-09T12:00:30Z"}');
    tail.emit(tailLine({ v: 1, id: 'bad-event-01', event: 'stop' }, 300));
    tail.emit(JSON.stringify({ file: '../../etc/passwd', offset: 1, event: {} }));
    await ingester.stop();
    expect(seen).toEqual([]);
    expect(eventCount(db)).toBe(0);
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 300 });
  });

  it('flags events older than ten minutes as replay', async () => {
    const { ingester, fleet, seen } = harness();
    ingester.start();
    tailAt(fleet, 0).emit(tailLine(stop('old', { id: 'evt-replay-0001', ts: '2026-10-09T11:49:00.000Z' }), 10));
    tailAt(fleet, 0).emit(tailLine(stop('recent', { id: 'evt-replay-0002', ts: '2026-10-09T11:55:00Z' }), 20));
    await ingester.stop();
    expect(seen.map((entry) => [entry.id, entry.replay])).toEqual([
      ['evt-replay-0001', true],
      ['evt-replay-0002', false],
    ]);
  });

  it('persists offsets within one second', async () => {
    const { ingester, fleet, db } = harness();
    ingester.start();
    tailAt(fleet, 0).emit(tailLine(stop('x', { id: 'evt-flush-0001' }), 42));
    expect(offsetRow(db, 'cedar')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 42 });
    await ingester.stop();
  });

  it('restarts a finished tail with backoff from the last position', async () => {
    const { ingester, fleet } = harness();
    ingester.start();
    tailAt(fleet, 0).emit(tailLine(stop('x', { id: 'evt-restart-0001' }), 77));
    tailAt(fleet, 0).end();
    await vi.advanceTimersByTimeAsync(999);
    expect(fleet.tails).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tailAt(fleet, 1).from).toBe(`${FILE}:77`);
    tailAt(fleet, 1).end();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fleet.tails).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fleet.tails).toHaveLength(3);
    await ingester.stop();
  });

  it('stop() is idempotent, stops the tails and flushes offsets', async () => {
    const { ingester, fleet, db } = harness();
    ingester.start();
    const tail = tailAt(fleet, 0);
    tail.emit(tailLine(stop('x', { id: 'evt-stop-0001' }), 99));
    await ingester.stop();
    await ingester.stop();
    expect(tail.stopped).toBe(true);
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 99 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fleet.tails).toHaveLength(1);
  });
});

describe('the activity fast path', () => {
  const SIX_KINDS: Array<[string, () => ActivitySpoolEvent]> = [
    ['tool_start', () => toolStart('Bash', 'npm test', { toolUseId: 'toolu_1' })],
    ['tool_end', () => toolEnd('Bash', 'npm test', { toolUseId: 'toolu_1', ok: true })],
    ['subagent_start', () => subagent('start', 'agent-1')],
    ['subagent_stop', () => subagent('stop', 'agent-1')],
    ['meters', () => meters({ context_pct: 41.6 })],
    ['paused', () => pausedEvent()],
  ];

  it('hands a tool_start line to the activity sink and nothing else, and still saves the offset', async () => {
    const sink = recordingSink();
    const { ingester, fleet, seen, db } = harness(openMemoryDb(), { activity: sink });
    ingester.start();
    const event = toolStart('Bash', 'npm test', { toolUseId: 'toolu_01' });
    tailAt(fleet, 0).emit(tailLine(event, 120));
    await ingester.stop();
    expect(sink.calls).toEqual([{ host: 'cedar', event, replay: false }]);
    expect(eventCount(db)).toBe(0);
    expect(seen).toEqual([]);
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 120 });
  });

  it.each(SIX_KINDS)('routes %s past the events table and the bus', async (_name, make) => {
    const sink = recordingSink();
    const { ingester, fleet, seen, db } = harness(openMemoryDb(), { activity: sink });
    ingester.start();
    const event = make();
    tailAt(fleet, 0).emit(tailLine(event, 77));
    await ingester.stop();
    expect(sink.calls).toEqual([{ host: 'cedar', event, replay: false }]);
    expect(eventCount(db)).toBe(0);
    expect(seen).toEqual([]);
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 77 });
  });

  it('skips activity lines silently without a sink and keeps the offset moving', async () => {
    const capture = createCaptureLogger();
    const { ingester, fleet, seen, db } = harness(openMemoryDb(), { log: capture.log });
    ingester.start();
    tailAt(fleet, 0).emit(tailLine(toolStart('Read', 'src/app.ts'), 55));
    await ingester.stop();
    expect(seen).toEqual([]);
    expect(eventCount(db)).toBe(0);
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 55 });
    expect(capture.lines.filter((line) => line.includes('"level":40'))).toEqual([]);
  });

  it('warns once about an invalid activity event and advances', async () => {
    const capture = createCaptureLogger();
    const sink = recordingSink();
    const { ingester, fleet, db } = harness(openMemoryDb(), { activity: sink, log: capture.log });
    ingester.start();
    const valid = toolEnd('Bash', 'npm test', { toolUseId: 'toolu_1' });
    const { ok: _ok, ...withoutOk } = valid.data as Record<string, unknown>;
    tailAt(fleet, 0).emit(tailLine({ ...valid, data: withoutOk }, 300));
    await ingester.stop();
    expect(sink.calls).toEqual([]);
    expect(eventCount(db)).toBe(0);
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 300 });
    const warnings = capture.lines.filter((line) => line.includes('"level":40'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"kind":"activity"');
    expect(warnings[0]).toContain('skipping invalid spool event');
  });

  it('passes an 11-minute-old step with replay: true', async () => {
    const sink = recordingSink();
    const { ingester, fleet } = harness(openMemoryDb(), { activity: sink });
    ingester.start();
    tailAt(fleet, 0).emit(tailLine(toolStart('Bash', 'old', { ts: '2026-10-09T11:49:00.000Z' }), 10));
    tailAt(fleet, 0).emit(tailLine(toolStart('Bash', 'new', { ts: '2026-10-09T11:55:00Z' }), 20));
    await ingester.stop();
    expect(sink.calls.map((call) => call.replay)).toEqual([true, false]);
  });

  it('a prompt line makes one events row and one bus event and reaches no activity sink', async () => {
    const sink = recordingSink();
    const { ingester, fleet, seen, db } = harness(openMemoryDb(), { activity: sink });
    ingester.start();
    tailAt(fleet, 0).emit(tailLine(prompt('run the tests', { id: 'evt-prompt-0001' }), 30));
    await ingester.stop();
    expect(sink.calls).toEqual([]);
    expect(eventCount(db)).toBe(1);
    expect(seen.map((entry) => entry.id)).toEqual(['evt-prompt-0001']);
  });

  it('stores a permission event without its preview while the bus event keeps it', async () => {
    const { ingester, fleet, busEvents, db } = harness();
    ingester.start();
    const event = permissionWithPreview('ABCDEFGH', 'Bash', 'rm -rf build', PREVIEW, { id: 'evt-perm-00001' });
    tailAt(fleet, 0).emit(tailLine(event, 40));
    await ingester.stop();
    const stored = storedPayload(db, 'evt-perm-00001');
    expect(stored.data).toEqual({ qid: 'ABCDEFGH', tool_name: 'Bash', input_preview: 'rm -rf build' });
    expect(busEvents).toEqual([event]);
  });

  it('a permission whose preview is malformed is kept without the preview, with one warning', async () => {
    const capture = createCaptureLogger();
    const { ingester, fleet, busEvents, db } = harness(openMemoryDb(), { log: capture.log });
    ingester.start();
    const event = permissionWithPreview('ABCDEFGH', 'Bash', 'rm -rf build', PREVIEW, { id: 'evt-perm-00003' });
    const broken = { ...event, data: { ...event.data, preview: { ...PREVIEW, kind: 'shell', tool: 'x'.repeat(500) } } };
    tailAt(fleet, 0).emit(tailLine(broken, 42));
    await ingester.stop();
    expect(busEvents).toEqual([{ ...event, data: { qid: 'ABCDEFGH', tool_name: 'Bash', input_preview: 'rm -rf build' } }]);
    expect(storedPayload(db, 'evt-perm-00003').data).toEqual({ qid: 'ABCDEFGH', tool_name: 'Bash', input_preview: 'rm -rf build' });
    const warnings = capture.lines.filter((line) => line.includes('"level":40'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('permission preview');
    expect(offsetRow(db, 'cedar')).toEqual({ file: FILE, offset: 42 });
  });

  it('a permission that is broken outside its preview is still skipped', async () => {
    const { ingester, fleet, busEvents, db } = harness();
    ingester.start();
    const event = permissionWithPreview('ABCDEFGH', 'Bash', 'rm -rf build', PREVIEW, { id: 'evt-perm-00004' });
    tailAt(fleet, 0).emit(tailLine({ ...event, data: { ...event.data, qid: 'not a qid' } }, 43));
    await ingester.stop();
    expect(busEvents).toEqual([]);
    expect(eventCount(db)).toBe(0);
  });

  it('stores a permission event without a preview unchanged', async () => {
    const { ingester, fleet, db } = harness();
    ingester.start();
    const event = permission('ABCDEFGH', 'Bash', 'ls -la', { id: 'evt-perm-00002' });
    tailAt(fleet, 0).emit(tailLine(event, 41));
    await ingester.stop();
    expect(storedPayload(db, 'evt-perm-00002')).toEqual(event);
  });
});

describe('forStorage', () => {
  it('drops only the preview of a permission event and returns every other event as the same object', () => {
    const plain = stop('done');
    expect(forStorage(plain)).toBe(plain);
    const legacy = permission('ABCDEFGH', 'Bash', 'ls');
    expect(forStorage(legacy)).toBe(legacy);
    const rich = permissionWithPreview('ABCDEFGH', 'Bash', 'rm -rf build', PREVIEW);
    const stored = forStorage(rich);
    expect(stored).toEqual({ ...rich, data: { qid: 'ABCDEFGH', tool_name: 'Bash', input_preview: 'rm -rf build' } });
    expect(rich.event === 'permission' && rich.data.preview).toEqual(PREVIEW);
  });
});
