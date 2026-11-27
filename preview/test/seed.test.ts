import { NAME_RE, ServerDTOSchema, SpoolEventSchema, TailLineSchema, type ServerDTO, type SpoolEvent } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../packages/hub/dist/core/bus.js';
import { createPreviewFleet, type PreviewFleet } from '../fake-fleet.ts';
import { applySeed, SEED } from '../seed.ts';

const NOW = new Date('2026-11-14T08:00:00.000Z');
const fleetAt = (): PreviewFleet => createPreviewFleet({ clock: () => NOW });

function eventsOf(fleet: PreviewFleet, host: 'cedar' | 'birch'): SpoolEvent[] {
  const events: SpoolEvent[] = [];
  fleet.tailEvents(host, 'end', (line) => {
    const tail = TailLineSchema.parse(JSON.parse(line));
    if (!('heartbeat' in tail)) events.push(SpoolEventSchema.parse(tail.event));
  });
  return events;
}

describe('SEED', () => {
  it('spreads the sessions over the demo hosts: one busy, two quieter, the local sandbox', () => {
    const counts = SEED.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.host]: (acc[s.host] ?? 0) + 1 }), {});
    expect(counts).toEqual({ cedar: 4, birch: 14, ash: 5, local: 2 });
  });

  it('uses unique, valid session names per host', () => {
    for (const host of ['cedar', 'birch', 'ash', 'local']) {
      const names = SEED.filter((s) => s.host === host).map((s) => s.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.every((name) => NAME_RE.test(name))).toBe(true);
    }
  });

  it('has exactly one question, one permission and one error, all on birch', () => {
    const special = SEED.filter((s) => s.state !== 'idle' && s.state !== 'working').map((s) => `${s.host}/${s.name} ${s.state}`);
    expect(special.sort()).toEqual(['birch/jira-1105 question', 'birch/push-notifs error', 'birch/qa-regression permission']);
  });
});

describe('applySeed', () => {
  it('opens a pane per session and leaves the two seeded cards pending', async () => {
    const fleet = fleetAt();
    applySeed(fleet);
    expect(fleet.kit('birch').panes()).toHaveLength(14);
    expect(fleet.kit('cedar').panes()).toHaveLength(4);
    expect((await fleet.client('birch').pending()).pending.map((p) => p.kind).sort()).toEqual(['permission', 'question']);
  });

  it('dates events by minutes quiet so most are not fresh news', () => {
    const fleet = fleetAt();
    const events = eventsOf(fleet, 'birch');
    applySeed(fleet);
    const forPane = (target: string) => events.filter((e) => e.tmux === target).map((e) => `${e.event}@${e.ts}`);
    expect(forPane('cc-jira-1105:0.0')).toEqual([
      'session_start@2026-11-14T07:48:00.000Z', 'prompt@2026-11-14T07:49:00.000Z', 'question@2026-11-14T07:49:00.000Z',
    ]);
    expect(forPane('cc-push-notifs:0.0').at(-1)).toBe('stop_failure@2026-11-14T07:49:00.000Z');
    expect(forPane('cc-dev_orchard:0.0')).toEqual(['session_start@2026-11-14T07:55:00.000Z']);
  });

  it('gives every session a short transcript', async () => {
    const fleet = fleetAt();
    applySeed(fleet);
    const pane = fleet.kit('ash').panes()[0]!;
    const chunk = await fleet.client('ash').transcript(pane.sid, { tail: 65536 });
    expect(chunk.data.trim().split('\n')).toHaveLength(2);
  });
});

describe('createPreviewFleet', () => {
  it('lists four online servers in the real DTO format', () => {
    const servers = fleetAt().servers();
    expect(servers.map((s) => s.name)).toEqual(['cedar', 'birch', 'ash', 'local']);
    for (const server of servers) {
      expect(ServerDTOSchema.parse(server)).toEqual(server);
      expect(server).toMatchObject({ status: 'online', host: `${server.name}.preview.invalid`, kitVersion: '2.1.0' });
    }
    expect(servers.find((s) => s.name === 'birch')?.sysinfo?.mem_avail_kb).toBeLessThan(1_500_000);
  });

  it('changes a status and tells the bus once it is bound', () => {
    const fleet = fleetAt();
    fleet.setStatus('cedar', 'offline');
    const bus = createBus(() => undefined);
    const seen: ServerDTO[] = [];
    bus.on('server.updated', (server) => seen.push(server));
    fleet.bindBus(bus);
    fleet.setStatus('ash', 'offline');
    const ash = fleet.servers().find((s) => s.name === 'ash');
    expect(ash?.status).toBe('offline');
    expect(seen).toEqual([ash]);
  });

  it('streams kit lines through tailEvents until stopped', async () => {
    const fleet = fleetAt();
    const lines: string[] = [];
    const handle = fleet.tailEvents('cedar', 'end', (line) => lines.push(line));
    fleet.kit('cedar').emit('stop_failure', null, { error: 'x' });
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    handle.stop();
    await handle.done;
    fleet.kit('cedar').emit('stop_failure', null, { error: 'y' });
    expect(lines).toHaveLength(1);
  });

  it('has no terminals', async () => {
    await expect(fleetAt().openShell('cedar', { cols: 80, rows: 24 })).rejects.toThrow('The preview has no terminals');
  });
});
