import { describe, expect, it, vi } from 'vitest';
import { fleetStatusTool } from '../../src/tools/fleet-status.js';
import { createFakeToolContext, makeAction, makeQuestion, makeSession } from './fake-context.js';

describe('fleet_status', () => {
  it('summarizes servers, sessions by host, pending questions and pending actions', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.fleet.servers).mockReturnValue([
      {
        name: 'cedar',
        host: '192.0.2.13',
        status: 'online',
        lastSeenAt: '2026-10-09T11:59:00.000Z',
        claudeVersion: '2.1.295',
        kitVersion: '1.0.0',
        sysinfo: { load1: 0.42, load5: 0.3, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 12_897_485, uptime_s: 1000 },
      },
      { name: 'ash', host: '192.0.2.11', status: 'offline', lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null },
    ]);
    vi.mocked(ctx.sessions.list).mockReturnValue([
      makeSession({ state: 'working', lastEventAt: '2026-10-09T11:57:00.000Z' }),
      makeSession({ id: 'cedar:cc-meadow-share:0.0', target: 'cc-meadow-share:0.0', displayName: 'meadow-share', lastEventAt: null }),
      makeSession({ id: 'birch:cc-orchard:0.0', host: 'birch', target: 'cc-orchard:0.0', displayName: 'orchard', state: 'ended' }),
      makeSession({ id: 'hq:manager:0.0', host: 'hq', target: 'manager:0.0', displayName: 'manager', origin: 'system' }),
    ]);
    vi.mocked(ctx.questions.pending).mockReturnValue([
      makeQuestion(),
      makeQuestion({ qid: 'BBBBBBBB', kind: 'permission', questions: [], permission: { toolName: 'Bash', inputPreview: 'rm -rf build' } }),
    ]);
    vi.mocked(ctx.actions.pending).mockReturnValue([makeAction({ createdAt: '2026-10-09T11:55:00.000Z' })]);

    await expect(fleetStatusTool({}, ctx)).resolves.toBe(
      [
        'Servers:',
        '- cedar online · load 0.42 · disk 12.3 GB free',
        '- ash offline · load ? · disk ? GB free',
        // One block per server of the fleet (no fixed list): birch's only session has ended, so birch is not listed.
        'Sessions:',
        'cedar:',
        '  - meadow-hr · working · 3m ago',
        '  - meadow-share · idle · no activity yet',
        'ash: no sessions',
        'Pending questions:',
        '- #AAAAAAAA cedar · meadow-hr: Which database should I use?',
        '- #BBBBBBBB cedar · meadow-hr: wants to use Bash',
        'Pending actions:',
        '- A7 stop session cedar · meadow-hr — reason: done (requested 5m ago)',
      ].join('\n'),
    );
  });

  it('reports an empty fleet plainly', async () => {
    await expect(fleetStatusTool({}, createFakeToolContext())).resolves.toBe(
      [
        'Servers: none configured',
        'Sessions: none',
        'Pending questions: none',
        'Pending actions: none',
      ].join('\n'),
    );
  });

  it('lists a host no fixed list knew (mars), and a live session on a host the fleet no longer has', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.fleet.servers).mockReturnValue([
      { name: 'mars', host: '192.0.2.40', status: 'online', lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null },
    ]);
    vi.mocked(ctx.sessions.list).mockReturnValue([
      makeSession({ id: 'mars:cc-rover:0.0', host: 'mars', target: 'cc-rover:0.0', displayName: 'rover', lastEventAt: null }),
      makeSession({ id: 'cedar:cc-left:0.0', host: 'cedar', target: 'cc-left:0.0', displayName: 'left', lastEventAt: null }),
    ]);
    const text = await fleetStatusTool({}, ctx);
    expect(text).toContain('Sessions:\nmars:\n  - rover · idle · no activity yet\ncedar:\n  - left · idle · no activity yet');
  });

  it('rejects unexpected input', async () => {
    await expect(fleetStatusTool({ verbose: true }, createFakeToolContext())).rejects.toThrow('Invalid input for fleet_status');
  });
});
