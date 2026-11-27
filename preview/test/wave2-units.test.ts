import { describe, expect, it } from 'vitest';
import { createPreviewFleet } from '../fake-fleet.ts';
import { createPreviewClock, limitsAt, seedHistory } from '../history-seed.ts';
import { createPageHook, injectHook, pageScript, parseHhmm, PAGE_HOOK_PATH } from '../page-hook.ts';
import { createRunner } from '../scenarios.ts';
import { ownerAt, nextOwnerIso } from '../seed-wave2.ts';
import type { Wave2Controls } from '../wave2-scenarios.ts';

const NOW = new Date('2026-11-15T21:30:00.000Z'); // 1:30 AM on the 16th in owner time

describe('owner times for the seed', () => {
  it('places a time on an owner day, across the UTC date line', () => {
    expect(ownerAt(NOW, 0, 9, 0).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(ownerAt(NOW, 1, 15, 40).toISOString()).toBe('2026-11-15T11:40:00.000Z');
    expect(ownerAt(NOW, -1, 9, 0).toISOString()).toBe('2026-11-17T05:00:00.000Z');
  });

  it('a one-off schedule is the next such time, with the owner offset', () => {
    expect(nextOwnerIso(NOW, 9, 0)).toBe('2026-11-16T09:00:00+04:00');
    expect(nextOwnerIso(new Date('2026-11-16T06:00:00.000Z'), 9, 0)).toBe('2026-11-17T09:00:00+04:00');
  });

  it('follows a zone with summer time too, the one the demo stores from the machine', () => {
    expect(ownerAt(new Date('2026-07-01T12:00:00.000Z'), 0, 9, 0, 'America/Chicago').toISOString()).toBe('2026-07-01T14:00:00.000Z');
    expect(ownerAt(new Date('2026-01-15T12:00:00.000Z'), 0, 9, 0, 'America/Chicago').toISOString()).toBe('2026-01-15T15:00:00.000Z');
    expect(nextOwnerIso(new Date('2026-07-01T20:00:00.000Z'), 9, 0, 'America/Chicago')).toBe('2026-07-02T09:00:00-05:00');
  });
});

describe('the fleet history seed', () => {
  it('winds the clock back a day, samples once a minute and reads limits every quarter hour, then puts it back', async () => {
    let base = NOW.getTime();
    const clock = createPreviewClock(() => base);
    const sampledAt: number[] = [];
    const reads: number[] = [];
    const recorded: string[] = [];
    await seedHistory({
      clock,
      sample: () => sampledAt.push(clock.now().getTime()),
      readAccounts: async () => {
        reads.push(clock.now().getTime());
      },
      recordLimits: (host, _reading, at) => recorded.push(`${host}@${at}`),
    }, 2);
    expect(sampledAt).toHaveLength(121);
    expect(sampledAt[0]).toBe(NOW.getTime() - 2 * 3_600_000);
    expect(sampledAt.at(-1)).toBe(NOW.getTime());
    expect(reads).toHaveLength(9);
    expect(recorded).toHaveLength(9 * 4);
    base += 1;
    expect(clock.now().getTime()).toBe(NOW.getTime() + 1);
  });

  it('the fake fleet moves with the time, and local reports no disk size (an older kit)', () => {
    let at = NOW;
    const fleet = createPreviewFleet({ clock: () => at });
    const load = () => fleet.servers().find((s) => s.name === 'birch')?.sysinfo?.load1;
    const first = load();
    at = new Date(NOW.getTime() + 6 * 3_600_000);
    expect(load()).not.toBe(first);
    expect(fleet.servers().find((s) => s.name === 'local')?.sysinfo?.disk_total_kb).toBeUndefined();
    expect(fleet.servers().find((s) => s.name === 'cedar')?.sysinfo?.disk_total_kb).toBeGreaterThan(0);
  });

  it('limits stay percentages with reset times after the reading', () => {
    for (let h = 0; h < 48; h += 1) {
      const at = new Date(NOW.getTime() + h * 3_600_000);
      const { fiveHour, sevenDay } = limitsAt('birch', at);
      expect(fiveHour.usedPct).toBeGreaterThanOrEqual(0);
      expect(fiveHour.usedPct).toBeLessThanOrEqual(100);
      expect(sevenDay.usedPct).toBeLessThanOrEqual(100);
      expect(Date.parse(fiveHour.resetsAt)).toBeGreaterThan(at.getTime());
    }
  });
});

describe('the page hook', () => {
  it('loads before the site\'s own scripts, once', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/assets/i.js"></script></head></html>';
    const once = injectHook(html);
    expect(once.indexOf(PAGE_HOOK_PATH)).toBeLessThan(once.indexOf('/assets/i.js'));
    expect(injectHook(once)).toBe(once);
  });

  it('fixes the clock at an owner time and pretends an away once', () => {
    const hook = createPageHook({ clock: () => NOW });
    expect(hook.setClock('19:30')?.toISOString()).toBe('2026-11-16T15:30:00.000Z');
    hook.setAway(120);
    const first = hook.script();
    expect(first).toContain(`__LUADY_CLOCK__ = ${Date.parse('2026-11-16T15:30:00.000Z')}`);
    expect(first).toContain(`"hub.lastHere", "${NOW.getTime() - 120 * 60_000}"`);
    expect(hook.script()).not.toContain('hub.lastHere');
    expect(hook.setClock(null)).toBeNull();
    expect(hook.script()).not.toContain('__LUADY_CLOCK__');
    expect(() => hook.setClock('25:00')).toThrow(/usage: clock/);
    expect(() => hook.setAway(10)).toThrow(/usage: away/);
  });

  it('reads HH:MM and writes plain script', () => {
    expect(parseHhmm('6:05')).toEqual({ hh: 6, mm: 5 });
    expect(parseHhmm('noon')).toBeNull();
    expect(pageScript(null, null)).not.toContain('try');
  });
});

describe('drive verbs for the welcome-back card, day and night and reminders', () => {
  function runner() {
    const calls: string[] = [];
    const controls: Wave2Controls = {
      away: (m) => void calls.push(`away ${m}`),
      clock: (hhmm) => {
        calls.push(`clock ${hhmm}`);
        return hhmm === null ? null : NOW;
      },
      remind: async () => void calls.push('remind'),
      snooze: async (m, t) => (calls.push(`snooze ${m} ${t}`), 7),
      due: async (m, t) => (calls.push(`due ${m} ${t}`), 8),
      forgetLimits: (host, at) => void calls.push(`forget ${host} ${at < new Date(Date.now() - 4_000)}`),
    };
    const fleet = createPreviewFleet({ clock: () => NOW });
    fleet.kit('birch').addPane('app-backend', '/srv/app-backend');
    return { calls, run: createRunner(fleet, async () => undefined, null, null, controls) };
  }

  it('pass their arguments to the hub', async () => {
    const { calls, run } = runner();
    await run('away', []);
    await run('away', ['90']);
    await run('light', ['dusk']);
    await run('clock', ['off']);
    expect(await run('snooze', ['0.5', 'Call', 'the', 'bank'])).toMatch(/#7/);
    expect(await run('due', ['2', 'Send', 'it'])).toMatch(/#8/);
    await run('remind', []);
    expect(calls).toEqual(['away 180', 'away 90', 'clock 18:05', 'clock null', 'snooze 0.5 Call the bank', 'due 2 Send it', 'remind']);
  });

  it('no-limits starts the host over, as after a sign-in to another plan (its seeded limits history is kept)', async () => {
    const { calls, run } = runner();
    expect(await run('no-limits', ['birch'])).toMatch(/does not report/);
    // Stamped before the oldest of its five readings (4 seconds old), so all five count.
    expect(calls).toEqual(['forget birch true']);
  });

  it('refuse what they cannot use', async () => {
    const { run } = runner();
    await expect(run('light', ['noon'])).rejects.toThrow(/usage: light/);
    await expect(run('snooze', ['soon', 'x'])).rejects.toThrow(/usage: snooze/);
    await expect(run('due', ['5'])).rejects.toThrow(/usage: due/);
    await expect(createRunner(createPreviewFleet({ clock: () => NOW }))('remind', [])).rejects.toThrow(/no hub/);
  });
});
