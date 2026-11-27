import { createServer } from 'node:net';
import { ActivitySpoolEventSchema, isActivityEventName, PermissionPreviewSchema, promptHash, SpoolEventSchema, TailLineSchema, type ActivitySpoolEvent, type HostId, type SpoolEvent } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { parseDriveArgs, drive } from '../drive.ts';
import { createPreviewFleet, type PreviewFleet, PREVIEW_HOSTS } from '../fake-fleet.ts';
import { createRunner, replyTo } from '../scenarios.ts';
import { applySeed } from '../seed.ts';

interface Seen { host: HostId; event: SpoolEvent | ActivitySpoolEvent }

/** Activity kinds parse with their own union, every other line with the spool union. */
function parseEvent(raw: unknown): SpoolEvent | ActivitySpoolEvent {
  const name = (raw as { event?: unknown }).event;
  return isActivityEventName(name) ? ActivitySpoolEventSchema.parse(raw) : SpoolEventSchema.parse(raw);
}

const instant = async (): Promise<void> => undefined;
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function seeded(): { fleet: PreviewFleet; seen: Seen[]; run: ReturnType<typeof createRunner> } {
  const fleet = createPreviewFleet({ clock: () => new Date() });
  const seen: Seen[] = [];
  for (const host of PREVIEW_HOSTS) {
    fleet.tailEvents(host, 'end', (line) => {
      const tail = TailLineSchema.parse(JSON.parse(line));
      if (!('heartbeat' in tail)) seen.push({ host, event: parseEvent(tail.event) });
    });
  }
  applySeed(fleet);
  seen.splice(0);
  return { fleet, seen, run: createRunner(fleet, instant) };
}

const kinds = (seen: readonly Seen[]): string[] => seen.map((s) => `${s.host} ${s.event.event} ${s.event.tmux}`);

describe('scenarios', () => {
  it('work: one prompt for that pane', async () => {
    const { seen, run } = seeded();
    expect(await run('work', ['birch/dev_orchard'])).toMatch(/dev_orchard/);
    expect(kinds(seen)).toEqual(['birch prompt cc-dev_orchard:0.0']);
  });

  it('finish: a stop with the default reply', async () => {
    const { seen, run } = seeded();
    await run('finish', ['birch/app-backend']);
    expect(seen.map((s) => s.event)).toEqual([
      expect.objectContaining({ event: 'stop', data: { last_assistant_message: 'Done. All tests pass.', truncated: false } }),
    ]);
  });

  it('ask and permit leave one more card pending', async () => {
    const { fleet, run } = seeded();
    await run('ask', ['cedar/meadow-vat']);
    await run('permit', ['cedar/fitness-demo', 'npm publish']);
    const pending = (await fleet.client('cedar').pending()).pending;
    expect(pending.map((p) => p.kind).sort()).toEqual(['permission', 'question']);
  });

  it('fail: a stop_failure', async () => {
    const { seen, run } = seeded();
    await run('fail', ['ash/harbor-api']);
    expect(seen.map((s) => s.event)).toEqual([expect.objectContaining({ event: 'stop_failure', data: { error: 'API Error: 500' } })]);
  });

  it('end: session_end, then the pane is gone for good', async () => {
    const { fleet, seen, run } = seeded();
    await run('end', ['cedar/meadow-share']);
    expect(kinds(seen)).toEqual(['cedar session_end cc-meadow-share:0.0']);
    expect(fleet.kit('cedar').pane('cc-meadow-share:0.0')).toBeUndefined();
    expect((await fleet.client('cedar').sessions()).sessions.map((p) => p.target)).not.toContain('cc-meadow-share:0.0');
  });

  it('start: a new pane walks in', async () => {
    const { fleet, seen, run } = seeded();
    await run('start', ['ash', 'newthing']);
    expect(kinds(seen)).toEqual(['ash session_start cc-newthing:0.0']);
    expect(fleet.kit('ash').pane('cc-newthing:0.0')?.cwd).toBe('/home/dev/projects/newthing');
  });

  it('offline and online flip a server', async () => {
    const { fleet, run } = seeded();
    await run('offline', ['ash']);
    expect(fleet.servers().find((s) => s.name === 'ash')?.status).toBe('offline');
    await run('online', ['ash']);
    expect(fleet.servers().find((s) => s.name === 'ash')?.status).toBe('online');
  });

  it('names the known sessions when a reference is wrong', async () => {
    const { run } = seeded();
    await expect(run('work', ['nope/none'])).rejects.toThrow(/unknown session "nope\/none"\. Known: cedar\/meadow-hr/);
    await expect(run('work', [])).rejects.toThrow(/Known:/);
  });

  it('refuses an unknown scenario', async () => {
    await expect(seeded().run('dance', [])).rejects.toThrow(/unknown scenario/);
  });

  it('demo: advances sessions on a timer and stops by itself', async () => {
    const { seen, run } = seeded();
    expect(await run('demo', ['8'])).toMatch(/2 steps/);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(await run('stop-demo', [])).toMatch(/No demo/);
  });

  it('demo: a session it sets working runs tool steps', async () => {
    const { seen, run } = seeded();
    await run('demo', ['4']);
    await settle();
    const started = seen.find((s) => s.event.event === 'prompt');
    expect(started).toBeDefined();
    expect(seen.some((s) => s.event.event === 'tool_start' && s.event.tmux === started?.event.tmux)).toBe(true);
  });
});

describe('replyTo', () => {
  it('answers a worker pane with a prompt, then a stop', async () => {
    const fleet = createPreviewFleet({ clock: () => new Date() });
    const lines: SpoolEvent[] = [];
    fleet.tailEvents('cedar', 'end', (line) => lines.push(SpoolEventSchema.parse(JSON.parse(line).event)));
    const kit = fleet.kit('cedar');
    const pane = kit.addPane('w', '/home/dev/projects/w');
    replyTo(kit, instant)(pane.target, 'hello there');
    await settle();
    expect(lines).toEqual([
      expect.objectContaining({ event: 'prompt', data: { prompt_sha256: promptHash('hello there'), prompt_preview: 'hello there' } }),
      expect.objectContaining({ event: 'stop', data: { last_assistant_message: 'Preview reply to: hello there', truncated: false } }),
    ]);
  });

  it('answers as Luady on the brain host and leaves a waiting pane alone', async () => {
    const fleet = createPreviewFleet({ clock: () => new Date() });
    const lines: SpoolEvent[] = [];
    fleet.tailEvents('hq', 'end', (line) => lines.push(SpoolEventSchema.parse(JSON.parse(line).event)));
    const kit = fleet.kit('hq');
    const pane = kit.addPane('manager', '/brain');
    replyTo(kit, instant)(pane.target, '[Web · now] hi');
    await settle();
    expect(lines.at(-1)).toMatchObject({ event: 'stop', data: { last_assistant_message: 'Preview Luady: got it.' } });
    kit.ask(pane.target, [{ question: 'Which?', options: [] }]);
    const before = lines.length;
    replyTo(kit, instant)(pane.target, 'again');
    await settle();
    expect(lines).toHaveLength(before);
  });
});

describe('drive', () => {
  it('reads the scenario, its arguments and --port', () => {
    expect(parseDriveArgs(['ask', 'cedar/meadow-vat', '--port', '7421'])).toEqual({ scenario: 'ask', args: ['cedar/meadow-vat'], port: 7421 });
    expect(parseDriveArgs(['demo'])).toEqual({ scenario: 'demo', args: [], port: 7420 });
    expect(parseDriveArgs([])).toMatch(/Usage/);
    expect(parseDriveArgs(['demo', '--port', 'x'])).toMatch(/--port/);
  });

  it('says how to start the preview when nothing answers', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
      });
    });
    const errors: string[] = [];
    const code = await drive(['work', 'cedar/x', '--port', String(port)], { log: () => undefined, error: (text) => errors.push(text) });
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Is the preview running? Start it with: npm run preview');
  });
});

describe('activity scenarios', () => {
  const names = (seen: readonly Seen[]): string[] => seen.map((s) => s.event.event);

  it('steps: six tool pairs with realistic tools, an edit with line counts and a to-do list whose first item completes', async () => {
    const { seen, run } = seeded();
    expect(await run('steps', ['birch/app-backend'])).toMatch(/6 steps/);
    expect(names(seen)).toEqual(Array.from({ length: 6 }, () => ['tool_start', 'tool_end']).flat());
    const ends = seen.flatMap((s) => (s.event.event === 'tool_end' ? [s.event.data] : []));
    expect(ends.map((data) => `${data.tool} ${data.title}`)).toEqual([
      'TodoWrite 4 items', 'Read src/app.ts', 'Grep "TODO"', 'Edit src/app.ts', 'Bash npm test', 'TodoWrite 4 items',
    ]);
    expect(ends[3]).toMatchObject({ added: 12, removed: 3, ok: true });
    expect(ends[0]?.todos).toHaveLength(4);
    expect(ends[0]?.todos?.[0]?.status).toBe('in_progress');
    expect(ends[5]?.todos?.[0]?.status).toBe('completed');
    const starts = seen.flatMap((s) => (s.event.event === 'tool_start' ? [s.event.data.tool_use_id] : []));
    expect(starts).toEqual(ends.map((data) => data.tool_use_id));
    expect(new Set(starts).size).toBe(6);
    expect(seen.every((s) => s.event.tmux === 'cc-app-backend:0.0')).toBe(true);
  });

  it('steps takes a count', async () => {
    const { seen, run } = seeded();
    await run('steps', ['birch/app-backend', '9']);
    expect(names(seen).filter((name) => name === 'tool_end')).toHaveLength(9);
    await expect(run('steps', ['birch/app-backend', '0'])).rejects.toThrow(/usage: steps/);
  });

  it('steps on a paused pane: exactly one more pair, then paused, and no Stop', async () => {
    const { fleet, seen, run } = seeded();
    await fleet.client('birch').pause('cc-app-backend:0.0');
    expect(await run('steps', ['birch/app-backend'])).toMatch(/paused/);
    expect(names(seen)).toEqual(['tool_start', 'tool_end', 'paused']);
    expect(await fleet.client('birch').resume('cc-app-backend:0.0')).toEqual({ ok: true, was_hit: true, sent: true });
  });

  it('helper: a helper starts, runs three steps of its own and stops', async () => {
    const { seen, run } = seeded();
    await run('helper', ['cedar/meadow-vat']);
    expect(names(seen)).toEqual(['subagent_start', 'tool_start', 'tool_end', 'tool_start', 'tool_end', 'tool_start', 'tool_end', 'subagent_stop']);
    const agentIds = new Set(seen.map((s) => ('agent_id' in s.event.data ? s.event.data.agent_id : null)));
    expect(agentIds.size).toBe(1);
    expect([...agentIds][0]).toMatch(/^agent-/);
  });

  it('meters: context and both windows; a missing window is null, never 0', async () => {
    const { seen, run } = seeded();
    await run('meters', ['cedar/meadow-hr', '41.6', '62', '15']);
    const first = seen[0]?.event;
    expect(first?.event).toBe('meters');
    if (first?.event !== 'meters') throw new Error('no meters');
    expect(first.data).toMatchObject({ context_pct: 41.6, five_hour: { used_pct: 62 }, seven_day: { used_pct: 15 } });
    const resets = Date.parse(first.data.five_hour?.resets_at ?? '') - Date.parse(first.ts);
    expect(Math.round(resets / 3_600_000)).toBe(2);
    await run('meters', ['cedar/meadow-hr', '12']);
    expect(seen[1]?.event).toMatchObject({ event: 'meters', data: { context_pct: 12, five_hour: null, seven_day: null } });
    await expect(run('meters', ['cedar/meadow-hr', '120'])).rejects.toThrow(/usage: meters/);
  });

  it('limits: one meter reading on the host\'s first pane with both windows, resetting in 2 hours and 3 days', async () => {
    const { seen, run } = seeded();
    expect(await run('limits', ['cedar', '62', '41'])).toMatch(/cedar/);
    expect(seen).toHaveLength(1);
    const first = seen[0]?.event;
    if (first?.event !== 'meters') throw new Error('no meters');
    expect(first.tmux).toBe('cc-meadow-hr:0.0');
    expect(first.data).toMatchObject({ five_hour: { used_pct: 62 }, seven_day: { used_pct: 41 } });
    const hours = (iso: string | undefined): number => Math.round((Date.parse(iso ?? '') - Date.parse(first.ts)) / 3_600_000);
    expect(hours(first.data.five_hour?.resets_at)).toBe(2);
    expect(hours(first.data.seven_day?.resets_at)).toBe(72);
    await expect(run('limits', ['cedar', '62'])).rejects.toThrow(/usage: limits/);
    await expect(run('limits', ['mars', '1', '2'])).rejects.toThrow(/usage: limits/);
  });

  it('no-limits: five meter readings without any limit window', async () => {
    const { seen, run } = seeded();
    await run('no-limits', ['birch']);
    expect(seen.map((s) => s.event)).toEqual(Array.from({ length: 5 }, () => expect.objectContaining({
      event: 'meters', tmux: 'cc-app-backend:0.0', data: expect.objectContaining({ five_hour: null, seven_day: null }),
    })));
  });

  it('signout: the host is signed out at the terminal; the hub sees it at its next check', async () => {
    const { fleet, run } = seeded();
    expect(await run('signout', ['ash'])).toMatch(/ash is signed out/);
    expect(await fleet.client('ash').authStatus()).toMatchObject({ logged_in: false });
    expect(await fleet.client('cedar').authStatus()).toMatchObject({ logged_in: true });
    await expect(run('signout', ['mars'])).rejects.toThrow(/usage: signout/);
  });

  it('permit-edit: a permission with an edit preview of three changed lines that offers allow-always', async () => {
    const { fleet, seen, run } = seeded();
    expect(await run('permit-edit', ['ash/harbor-api'])).toMatch(/asks permission #/);
    const permission = seen.find((s) => s.event.event === 'permission')?.event;
    if (permission?.event !== 'permission') throw new Error('no permission');
    const preview = PermissionPreviewSchema.parse(permission.data.preview);
    expect(preview).toMatchObject({ tool: 'Edit', kind: 'edit', truncated: false });
    expect(preview.always).not.toBeNull();
    const changed = preview.edits.flatMap((edit) => {
      const before = edit.old.split('\n');
      return edit.new.split('\n').filter((line, i) => line !== before[i]);
    });
    expect(changed).toHaveLength(3);
    expect((await fleet.client('ash').pending()).pending.map((p) => p.kind)).toContain('permission');
  });

  it('permit-command: a kit-2 command preview with the folder it runs in, offering allow-always', async () => {
    const { seen, run } = seeded();
    expect(await run('permit-command', ['cedar/meadow-share'])).toMatch(/asks permission #\w+ to run npm test/);
    const permission = seen.find((s) => s.event.event === 'permission')?.event;
    if (permission?.event !== 'permission') throw new Error('no permission');
    const preview = PermissionPreviewSchema.parse(permission.data.preview);
    expect(preview).toMatchObject({
      tool: 'Bash', kind: 'command', command: 'npm test -- --run', cwd: '/home/dev/projects/meadow-share', edits: [], truncated: false,
    });
    expect(preview.always?.label).toMatch(/npm test/);
    expect(permission.data.input_preview).toBe('npm test -- --run');
  });

  it('permit-command with a command of its own: a risky one offers no allow-always', async () => {
    const { seen, run } = seeded();
    await run('permit-command', ['cedar/meadow-share', 'git push --force origin main']);
    const permission = seen.find((s) => s.event.event === 'permission')?.event;
    if (permission?.event !== 'permission') throw new Error('no permission');
    expect(PermissionPreviewSchema.parse(permission.data.preview)).toMatchObject({ command: 'git push --force origin main', always: null });
  });
});

describe('results', () => {
  it('posts that many events to Luady, one at a time, so each of his replies is a result', async () => {
    const fleet = createPreviewFleet({ clock: () => new Date() });
    applySeed(fleet);
    const posted: string[] = [];
    const run = createRunner(fleet, instant, { postEvent: async (text) => { posted.push(text); } });
    expect(await run('results', ['3'])).toMatch(/3 events/);
    expect(posted).toHaveLength(3);
    expect(new Set(posted).size).toBe(3);
    await expect(run('results', ['0'])).rejects.toThrow(/usage: results/);
  });

  it('says so when the preview has no Luady to post to', async () => {
    const fleet = createPreviewFleet({ clock: () => new Date() });
    await expect(createRunner(fleet, instant)('results', ['1'])).rejects.toThrow(/Luady/);
  });
});

