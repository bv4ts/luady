import { SpoolEventSchema, TailLineSchema, isActivityEventName, type HostId, type SpoolEvent } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { boardItemsIn, checklistTitles, type StepCControls } from '../board-scenarios.ts';
import { createPreviewFleet, type PreviewFleet, PREVIEW_HOSTS } from '../fake-fleet.ts';
import { createRunner, replyTo } from '../scenarios.ts';
import { applySeed } from '../seed.ts';

interface Seen { host: HostId; event: SpoolEvent }
const instant = async (): Promise<void> => undefined;

function seeded(stepC: StepCControls | null = null): { fleet: PreviewFleet; seen: Seen[]; run: ReturnType<typeof createRunner> } {
  const fleet = createPreviewFleet({ clock: () => new Date() });
  const seen: Seen[] = [];
  for (const host of PREVIEW_HOSTS) {
    fleet.tailEvents(host, 'end', (line) => {
      const tail = TailLineSchema.parse(JSON.parse(line));
      if ('heartbeat' in tail) return;
      const raw = tail.event as { event?: unknown };
      if (!isActivityEventName(raw.event)) seen.push({ host, event: SpoolEventSchema.parse(raw) });
    });
  }
  applySeed(fleet);
  const luady = fleet.kit('hq');
  luady.addPane('manager', '/home/luady/brain');
  seen.splice(0);
  return { fleet, seen, run: createRunner(fleet, instant, null, stepC) };
}

const events = (seen: readonly Seen[]): string[] => seen.map((s) => `${s.host} ${s.event.event}`);
const dataOf = (seen: readonly Seen[], kind: string): unknown[] => seen.filter((s) => s.event.event === kind).map((s) => s.event.data);

describe('drive verbs for speech, reports, chat, cards and Jira', () => {
  it('say: the session works a moment and finishes its turn with the message (a speech bubble)', async () => {
    const { seen, run } = seeded();
    expect(await run('say', ['birch/dev_orchard', 'The', 'fix', 'is', 'live.'])).toBe('birch/dev_orchard says: The fix is live.');
    expect(events(seen)).toEqual(['birch prompt', 'birch stop']);
    expect(dataOf(seen, 'stop')).toEqual([{ last_assistant_message: 'The fix is live.', truncated: false }]);
  });

  it('say refuses a session that waits for an answer', async () => {
    const { run } = seeded();
    await expect(run('say', ['birch/jira-1105', 'hi'])).rejects.toThrow(/waiting for an answer/);
  });

  it('report: one mid-turn report line', async () => {
    const { seen, run } = seeded();
    await run('report', ['birch/app-backend', '#12 done: fixed']);
    expect(seen.map((s) => s.event)).toEqual([expect.objectContaining({ event: 'report', data: { text: '#12 done: fixed' }, tmux: 'cc-app-backend:0.0' })]);
  });

  it('luady-say: Luady takes a turn (typing) and answers with the text', async () => {
    const { seen, run } = seeded();
    await run('luady-say', ['Morning!', 'Three', 'cards', 'are', 'done.']);
    expect(events(seen)).toEqual(['hq prompt', 'hq stop']);
    expect(dataOf(seen, 'stop')).toEqual([{ last_assistant_message: 'Morning! Three cards are done.', truncated: false }]);
  });

  it('card, jira-off and jira-on go to the hub; without one they say so', async () => {
    const calls: string[] = [];
    const { run } = seeded({
      addCard: async (title) => {
        calls.push(`card ${title}`);
        return 41;
      },
      jiraOff: async () => void calls.push('off'),
      jiraOn: async () => void calls.push('on'),
    });
    expect(await run('card', ['Buy', 'milk'])).toBe('Added card #41: Buy milk');
    await run('jira-off', []);
    await run('jira-on', []);
    expect(calls).toEqual(['card Buy milk', 'off', 'on']);
    await expect(seeded().run('card', ['x'])).rejects.toThrow(/no hub/);
    await expect(seeded().run('card', [])).rejects.toThrow(/usage: card/);
  });
});

describe('a session with linked cards', () => {
  const prompt = 'Objective: cards.\n1. #12 Fix the total\n2. #15 Add a test\n\nBoard items: #12, #15. Work through them in order.';

  it('reads the board items and their titles', () => {
    expect(boardItemsIn(prompt)).toEqual([12, 15]);
    expect(checklistTitles(prompt).get(15)).toBe('Add a test');
    expect(boardItemsIn('no cards here')).toEqual([]);
  });

  it('reports each card done, then finishes its turn', async () => {
    const { fleet, seen } = seeded();
    const kit = fleet.kit('birch');
    replyTo(kit, instant)('cc-dev_orchard:0.0', prompt);
    await new Promise((r) => setTimeout(r, 20));
    expect(events(seen)).toEqual(['birch prompt', 'birch report', 'birch report', 'birch stop']);
    expect(dataOf(seen, 'report')).toEqual([
      { text: '#12 done: Fix the total: changed and tested in the preview.' },
      { text: '#15 done: Add a test: changed and tested in the preview.' },
    ]);
  });
});
