import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type SessionDTO, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, SessionService } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { MISSION_EDIT_WINDOW_MS, MISSION_SETTLE_MS, MISSION_TICK_MS, createMissionService } from '../../src/missions/service.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

const T0 = '2026-10-10T10:00:00.000Z';

function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 'birch:cc-orchard:0.0', host: 'birch', target: 'cc-orchard:0.0', claudeSessionId: null, cwd: '/home/dev/projects/orchard',
    project: 'orchard', displayName: 'orchard', state: 'working', origin: 'owner', registered: true, lastEventAt: null,
    turnStartedAt: null, pendingQid: null, unexpectedEnd: false, ...over,
  };
}

function seedSession(db: Db, remote: number): void {
  db.prepare(`INSERT INTO sessions (id, host, tmux_target, display_name, state, created_at, turn_remote)
    VALUES ('birch:cc-orchard:0.0', 'birch', 'cc-orchard:0.0', 'orchard', 'working', ?, ?)`).run(T0, remote);
  db.prepare(`INSERT INTO events (id, host, session_id, type, ts, payload_json)
    VALUES ('p1', 'birch', 'birch:cc-orchard:0.0', 'prompt', ?, '{"data":{"prompt_preview":"Fix the 5 Orchard issues"}}')`).run(T0);
}

function setup(remote = 1, settings: Partial<Settings> = {}) {
  const db = openMemoryDb();
  seedSession(db, remote);
  const bus = createBus();
  const clock = createFakeClock(T0);
  const outbound = createFakeOutbound();
  const results = createFakeOutbound();
  const current: Settings = { ...DEFAULT_SETTINGS, ...settings };
  const missions = createMissionService({
    db, bus, clock, log: silentLogger(), outbound, results, settings: { get: () => current, update: vi.fn() },
    sessions: { list: () => [] } as unknown as SessionService,
  });
  missions.start();
  const settle = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const finishTurn = async (text: string): Promise<void> => {
    bus.emit('turn.finished', { session: session({ state: 'idle' }), durationSec: 60, remote: true, lastMessage: text, replay: false });
    await settle();
  };
  const statusRow = () => db.prepare('SELECT chat_msg_id, sent_at FROM missions WHERE session_id = ?').get('birch:cc-orchard:0.0');
  return { db, bus, clock, outbound, results, missions, settle, finishTurn, statusRow };
}

describe('missions', () => {
  it('sends one status for a remote turn (not pinned), edits it per turn, then sends one done message as a result', async () => {
    const t = setup();
    t.bus.emit('session.updated', session());
    await t.settle();
    expect(t.missions.isOpen('birch:cc-orchard:0.0')).toBe(true);
    expect(t.outbound.sent).toHaveLength(1);
    expect(t.outbound.sent[0]?.text).toContain('📌 *Mission · birch · orchard*');
    expect(t.outbound.sent[0]?.text).not.toContain('Fix the 5 Orchard issues');
    expect(t.outbound.sent[0]?.text).toContain('⏳ Working · since');
    expect(t.outbound.sent[0]?.text).not.toContain('0 turns');
    t.db.prepare(`INSERT INTO events (id, host, session_id, type, ts, payload_json)
      VALUES ('p2', 'birch', 'birch:cc-orchard:0.0', 'prompt', '2026-10-10T10:00:30.000Z', '{"data":{"prompt_preview":"<task-notification> <task-id>b1</task-id>"}}')`).run();
    await t.missions.note(session(), '', 'Fix 5 Orchard bugs');
    expect(t.outbound.edits.at(-1)?.text).toContain('_Fix 5 Orchard bugs_');
    expect(t.outbound.pins).toEqual([]);

    t.clock.advance(60_000);
    await t.finishTurn('Issues 1-3 fixed.');
    expect(t.outbound.edits.at(-1)?.msgId).toBe('fake-wa-1');
    expect(t.outbound.edits.at(-1)?.text).toContain('💤 Paused after 1 turn');
    expect(t.outbound.edits.at(-1)?.text).not.toContain('Issues 1-3 fixed.');
    expect(t.outbound.sent).toHaveLength(1);

    t.clock.advance(MISSION_SETTLE_MS + 1000);
    await t.missions.tick();
    await t.settle();
    expect(t.missions.isOpen('birch:cc-orchard:0.0')).toBe(false);
    expect(t.outbound.pins.at(-1)).toEqual({ msgId: 'fake-wa-1', on: false });
    expect(t.outbound.sent).toHaveLength(1);
    expect(t.results.sent).toHaveLength(1);
    expect(t.results.sent[0]?.text).toContain('✅ *Mission done · birch · orchard*');
    expect(t.results.sent[0]?.text).toContain('Finished. Ask me for the details.');
    expect(t.results.sent[0]?.text).not.toContain('Issues 1-3 fixed.');
    expect(t.results.sent[0]?.text).not.toContain('Reply to this message');
    expect(t.results.sent[0]?.link).toEqual({ kind: 'session', refId: 'birch:cc-orchard:0.0' });
    t.missions.stop();
  });

  it('replaces the status message after the 15-minute edit window (old one unpinned and deleted)', async () => {
    const t = setup();
    t.bus.emit('session.updated', session());
    await t.settle();
    t.clock.advance(MISSION_EDIT_WINDOW_MS + 1000);
    await t.finishTurn('Still going.');
    expect(t.outbound.sent).toHaveLength(2);
    expect(t.outbound.pins).toEqual([{ msgId: 'fake-wa-1', on: false }]);
    expect(t.outbound.revokes).toEqual(['fake-wa-1']);
    t.missions.stop();
  });

  it('does not track a local terminal turn, and Luady-managed missions wait for mission_done', async () => {
    const local = setup(0);
    local.bus.emit('session.updated', session());
    await local.settle();
    expect(local.missions.isOpen('birch:cc-orchard:0.0')).toBe(false);
    local.missions.manage('birch:cc-orchard:0.0');
    local.bus.emit('session.updated', session());
    await local.settle();
    expect(local.missions.isManaged('birch:cc-orchard:0.0')).toBe(true);
    await local.finishTurn('Done with part 1.');
    local.clock.advance(MISSION_SETTLE_MS / 2);
    await local.missions.tick();
    expect(local.missions.isOpen('birch:cc-orchard:0.0')).toBe(true);
    await local.missions.note(session({ state: 'idle' }), 'Testing sign-in now.');
    // 30 min in, the 15-min edit window is over: the note arrives as a fresh status.
    expect(local.outbound.sent.at(-1)?.text).toContain('🗒 Testing sign-in now.');
    await expect(local.missions.finish(session({ state: 'idle' }), 'All 5 issues fixed and tested.')).resolves.toBe(true);
    expect(local.results.sent.map((s) => s.text)).toEqual([expect.stringContaining('All 5 issues fixed and tested.')]);
    expect(local.outbound.sent.some((s) => s.text.includes('All 5 issues fixed and tested.'))).toBe(false);
    expect(local.missions.isOpen('birch:cc-orchard:0.0')).toBe(false);
    local.missions.stop();
  });

  it('stays silent about done while muted, and closes quietly when the session ends', async () => {
    const t = setup(1, { mute_until: '2026-10-10T12:00:00.000Z' });
    t.bus.emit('session.updated', session());
    await t.settle();
    t.bus.emit('session.updated', session({ state: 'ended' }));
    await t.settle();
    expect(t.missions.isOpen('birch:cc-orchard:0.0')).toBe(false);
    expect(t.outbound.sent.filter((s) => s.text.includes('Mission done'))).toEqual([]);
    expect(t.results.sent).toEqual([]);
    expect(t.outbound.pins.at(-1)).toEqual({ msgId: 'fake-wa-1', on: false });
    await t.missions.finish(session({ state: 'idle' }), 'Done while muted.');
    expect(t.results.sent).toEqual([]);
    t.missions.stop();
  });

  it('finish() without an open mission still sends one done message, as a result', async () => {
    const t = setup();
    await expect(t.missions.finish(session({ state: 'idle' }), 'Shipped the fix.')).resolves.toBe(false);
    expect(t.results.sent.map((s) => s.text)).toEqual([expect.stringContaining('Shipped the fix.')]);
    expect(t.outbound.sent).toEqual([]);
    t.missions.stop();
  });

  it('while the website is on the status is not written (null back): no id is kept and the next push tries again', async () => {
    const t = setup();
    t.outbound.up = false;
    t.bus.emit('session.updated', session());
    await t.settle();
    expect(t.outbound.sent).toHaveLength(1);
    expect(t.statusRow()).toEqual({ chat_msg_id: null, sent_at: null });
    t.clock.advance(60_000);
    await t.finishTurn('Part 1 done.');
    expect(t.outbound.sent).toHaveLength(2);
    expect(t.outbound.edits).toEqual([]);
    t.outbound.up = true;
    await t.missions.note(session({ state: 'idle' }), 'Testing now.');
    expect(t.outbound.sent).toHaveLength(3);
    expect(t.statusRow()).toEqual({ chat_msg_id: 'fake-wa-1', sent_at: expect.any(String) });
    t.missions.stop();
  });

  it('retires the old pinned board on its 30-second tick, retrying while the chat is down, then never again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const t = setup();
      t.db.prepare("INSERT INTO board (id, chat_msg_id, sent_at, shown) VALUES (1, 'wamid.BOARD', ?, 'x')").run(T0);
      let checks = 0;
      const isUp = t.outbound.isUp;
      t.outbound.isUp = () => {
        checks += 1;
        return isUp();
      };
      t.outbound.up = false;
      vi.advanceTimersByTime(2 * MISSION_TICK_MS);
      expect(checks).toBe(2);
      t.outbound.up = true;
      vi.advanceTimersByTime(MISSION_TICK_MS);
      expect(checks).toBe(3);
      expect(t.outbound.revokes).toEqual(['wamid.BOARD']);
      vi.advanceTimersByTime(MISSION_TICK_MS);
      expect(checks).toBe(3);
      expect(t.outbound.sent).toEqual([]);
      t.missions.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
