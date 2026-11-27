import { randomUUID } from 'node:crypto';
import { isActivityEventName } from '@luady/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { shq } from '../harness/proc.js';
import { syncStream, waitForLog, waitForSession } from '../harness/scenario.js';
import { sleep, waitFor } from '../harness/wait.js';

const TARGET = 'cc-alpha:0.0';
const ID = `cedar:${TARGET}`;

function spoolFileName(date: Date): string {
  return `events-${date.toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`;
}

/** A valid spool line that maps to no session. */
function syntheticLine(id: string): string {
  return JSON.stringify({
    v: 1, id, ts: new Date().toISOString(), host: 'cedar', event: 'notification',
    session_id: null, cwd: null, transcript_path: null, tmux: null, permission_mode: null,
    data: { notification_type: 'luady_it_synthetic', message: `synthetic ${id}`, title: null },
  });
}

function occurrences(hub: TestHub, ids: readonly string[]): Array<[string, number]> {
  return ids.map((id) => [id, hub.spool.filter((r) => r.event.id === id).length]);
}

async function startAlpha(hub: TestHub, server: FakeServer): Promise<string> {
  await server.startClaude('alpha', '/home/dev/projects/alpha');
  const start = await waitForLog(server, (e) => e.kind === 'start' && e.target === TARGET, 'fake-claude start');
  await waitForSession(hub, ID, (s) => s.state === 'idle' && s.claudeSessionId === start.sid, 'alpha idle');
  return String(start.sid);
}

async function typeTurns(server: FakeServer, sid: string, prefix: string, count: number): Promise<void> {
  for (let n = 1; n <= count; n += 1) {
    const text = `${prefix} ${n}`;
    await server.typeInto(TARGET, text);
    await waitForLog(server, (e) => e.kind === 'received' && e.sid === sid && e.text === text, text);
  }
}

describe('sshd dies mid-stream', () => {
  let server: FakeServer;
  let hub: TestHub;

  beforeAll(async () => {
    server = await startFakeServer(inject('luadyIt'));
    hub = await startTestHub({ env: inject('luadyIt'), server });
    await syncStream(hub, server);
  });

  afterAll(async () => {
    await hub?.stop();
    await server?.down();
  });

  it('loses and duplicates nothing when sshd dies mid-stream, a line is split and the spool rotates', async () => {
    const sid = await startAlpha(hub, server);
    for (const n of [1, 2, 3]) {
      await hub.app.services.sessions.send(ID, `before the drop ${n}`, 'web');
      await waitForLog(server, (e) => e.kind === 'received' && e.sid === sid && e.text === `before the drop ${n}`, `remote turn ${n}`);
    }
    // Kill the listener and the hub's session process; tmux and fake-claude keep running.
    await server.execOk('root', 'pkill -x sshd; sleep 1; if pgrep -x sshd >/dev/null; then exit 1; fi');
    await typeTurns(server, sid, 'during the outage', 3);

    const partial = randomUUID();
    const line = syntheticLine(partial);
    const cut = Math.floor(line.length / 2);
    const today = spoolFileName(new Date());
    await server.execOk('dev', `printf '%s' ${shq(line.slice(0, cut))} >> "$HOME/.luady/spool/${today}"`);
    await server.execOk('root', '/usr/sbin/sshd');
    await waitFor(() => hub.app.services.fleet.servers().find((s) => s.name === 'cedar' && s.status === 'online'), { timeoutMs: 120_000, what: 'cedar online again' });
    await sleep(3_000); // the resumed stream reaches the half-written line and must not emit it
    await server.execOk('dev', `printf '%s\\n' ${shq(line.slice(cut))} >> "$HOME/.luady/spool/${today}"`);

    const rotated = [randomUUID(), randomUUID()];
    const tomorrow = spoolFileName(new Date(Date.now() + 86_400_000));
    await server.execOk('dev', `cat >> "$HOME/.luady/spool/${tomorrow}"`, `${rotated.map(syntheticLine).join('\n')}\n`);

    const extra: string[] = [partial, ...rotated];
    // Activity kinds (meters, tool_*, subagent_*, paused) flow through the activity sink, not the spool.event bus, so
    // they never reach hub.spool; this test checks exactly-once delivery of the spool.event stream only.
    const expected = (await server.spoolEvents())
      .filter((e) => (e.session_id === sid || extra.includes(String(e.id))) && !isActivityEventName(e.event))
      .map((e) => e.id);
    // session_start + 3 remote turns (prompt, stop) + 3 outage turns (prompt, stop) + split line + 2 rotated lines
    expect(expected.length).toBeGreaterThanOrEqual(16);
    await waitFor(() => expected.every((id) => hub.spool.some((r) => r.event.id === id)), { timeoutMs: 120_000, what: 'every spool event ingested after the reconnect' });
    expect(occurrences(hub, expected).filter(([, n]) => n !== 1)).toEqual([]);
    const stored = hub.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE id IN (${expected.map(() => '?').join(',')})`).get(...expected) as { n: number };
    expect(stored.n).toBe(expected.length);
    // The ingester flushes offsets once a second, so poll instead of reading the row once.
    const offsetFile = await waitFor(() => {
      const row = hub.db.prepare('SELECT file FROM offsets WHERE host = ?').get('cedar') as { file: string } | undefined;
      return row?.file === tomorrow ? row.file : undefined;
    }, { timeoutMs: 15_000, what: 'offsets row follows the rotation to the newer spool file' });
    expect(offsetFile).toBe(tomorrow);
  });
});

describe('hub restart', () => {
  let server: FakeServer;
  let hub: TestHub;

  beforeAll(async () => {
    server = await startFakeServer(inject('luadyIt'));
    hub = await startTestHub({ env: inject('luadyIt'), server });
    await syncStream(hub, server);
  });

  afterAll(async () => {
    await hub?.stop();
    await server?.down();
  });

  it('replays events written while the hub was down exactly once and re-emits nothing it had already ingested', async () => {
    const sid = await startAlpha(hub, server);
    await hub.app.services.sessions.send(ID, 'before the restart', 'web');
    await waitForLog(server, (e) => e.kind === 'received' && e.sid === sid && e.text === 'before the restart', 'remote turn');
    const before = await waitFor(async () => {
      // syncStream's first sentinel may predate the live stream, so only this session's events must have arrived.
      const events = await server.spoolEvents();
      // Exclude activity kinds (e.g. the session's kit-2 meters event): they go to the activity sink, not hub.spool.
      const mine = events.filter((e) => e.session_id === sid && !isActivityEventName(e.event)).map((e) => e.id);
      return mine.every((id) => hub.spool.some((r) => r.event.id === id)) ? events.map((e) => e.id) : undefined;
    }, { timeoutMs: 60_000, what: 'hub caught up before the restart' });

    const dir = hub.dir;
    await hub.stop({ keepDir: true });
    await typeTurns(server, sid, 'while the hub was down', 2);
    hub = await startTestHub({ env: inject('luadyIt'), server, dir });

    // Same reason: activity kinds never reach hub.spool, so they are not part of the replayed spool.event set.
    const fresh = (await server.spoolEvents())
      .filter((e) => !isActivityEventName(e.event) && !before.includes(String(e.id)))
      .map((e) => e.id);
    expect(fresh.length).toBeGreaterThanOrEqual(4); // 2 turns × (prompt, stop)
    await waitFor(() => fresh.every((id) => hub.spool.some((r) => r.event.id === id)), { timeoutMs: 120_000, what: 'downtime events replayed' });
    expect(occurrences(hub, fresh).filter(([, n]) => n !== 1)).toEqual([]);
    expect(hub.spool.filter((r) => before.includes(r.event.id as string))).toEqual([]);
  });
});
