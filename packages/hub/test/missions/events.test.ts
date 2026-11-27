import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, MissionDTOSchema, type SessionDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { HubEvents, SessionService } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { MISSION_SETTLE_MS, createMissionService } from '../../src/missions/service.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

const T0 = '2026-10-10T10:00:00.000Z';
const SID = 'birch:cc-orchard:0.0';

function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: SID, host: 'birch', target: 'cc-orchard:0.0', claudeSessionId: null, cwd: '/home/dev/projects/orchard', project: 'orchard',
    displayName: 'orchard', state: 'working', origin: 'manager', registered: true, lastEventAt: null, turnStartedAt: null, pendingQid: null,
    unexpectedEnd: false, ...over,
  };
}

function setup() {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock(T0);
  const missions = createMissionService({
    db, bus, clock, log: silentLogger(), outbound: createFakeOutbound(), results: createFakeOutbound(),
    settings: { get: () => DEFAULT_SETTINGS, update: vi.fn() }, sessions: { list: () => [] } as unknown as SessionService,
  });
  const updated: Array<HubEvents['mission.updated']> = [];
  const removed: Array<HubEvents['mission.removed']> = [];
  bus.on('mission.updated', (mission) => updated.push(mission));
  bus.on('mission.removed', (event) => removed.push(event));
  missions.start();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return { bus, clock, missions, updated, removed, settle };
}

describe('missions on the website', () => {
  it('mission.updated on open, phase change, note, title and each turn; views for GET /api/missions', async () => {
    const t = setup();
    t.bus.emit('session.updated', session());
    await t.settle();
    await t.missions.note(session(), 'Issues 1-3 fixed', 'Fix Orchard issues');
    t.bus.emit('session.updated', session({ state: 'waiting_question' }));
    t.bus.emit('turn.finished', { session: session({ state: 'idle' }), durationSec: 5, remote: false, lastMessage: 'x'.repeat(2000), replay: false });
    await t.settle();
    expect(t.updated.map((mission) => [mission.phase, mission.turns, mission.title, mission.note])).toEqual([
      ['working', 0, '', null],
      ['working', 0, 'Fix Orchard issues', 'Issues 1-3 fixed'],
      ['waiting', 0, 'Fix Orchard issues', 'Issues 1-3 fixed'],
      ['idle', 1, 'Fix Orchard issues', 'Issues 1-3 fixed'],
    ]);
    expect(t.updated.every((mission) => MissionDTOSchema.safeParse(mission).success)).toBe(true);
    expect(t.updated.at(-1)?.lastText).toHaveLength(1200);
    expect(t.missions.views()).toEqual([t.updated.at(-1)]);
    expect(t.missions.view(SID)).toEqual(t.updated.at(-1));
    expect(t.missions.view('nope')).toBeNull();
  });

  it('mission.removed: done with Luady\'s summary, done by the idle timer without one, ended', async () => {
    const t = setup();
    t.bus.emit('session.updated', session());
    await t.settle();
    await t.missions.finish(session({ state: 'idle' }), 'All fixed.');
    expect(t.removed).toEqual([{ sessionId: SID, outcome: 'done', summary: 'All fixed.' }]);
    expect(t.missions.views()).toEqual([]);

    t.bus.emit('session.updated', session());
    t.bus.emit('turn.finished', { session: session({ state: 'idle' }), durationSec: 5, remote: false, lastMessage: 'ok', replay: false });
    await t.settle();
    t.clock.advance(MISSION_SETTLE_MS + 1);
    await t.missions.tick();
    expect(t.removed.at(-1)).toEqual({ sessionId: SID, outcome: 'done', summary: null });

    t.bus.emit('session.updated', session());
    await t.settle();
    t.bus.emit('session.updated', session({ state: 'ended' }));
    await t.settle();
    expect(t.removed.at(-1)).toEqual({ sessionId: SID, outcome: 'ended', summary: null });
  });

  it('mission_done on a session with no open mission still tells the board', async () => {
    const t = setup();
    await t.missions.finish(session({ state: 'idle' }), 'Shipped.');
    expect(t.removed).toEqual([{ sessionId: SID, outcome: 'done', summary: 'Shipped.' }]);
  });
});
