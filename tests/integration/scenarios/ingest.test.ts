import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { syncStream, waitForLog, waitForSession } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';

const TARGET = 'cc-alpha:0.0';
const ID = `cedar:${TARGET}`;
const TYPED = 'hello from the owner terminal';

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

describe('event ingestion', () => {
  it('turns an owner-typed turn into session state, events, messages and a finished signal', async () => {
    const updates = hub.record('session.updated');
    const finished = hub.record('turn.finished');
    await server.startClaude('alpha', '/home/dev/projects/alpha');
    const start = await waitForLog(server, (e) => e.kind === 'start' && e.target === TARGET, 'fake-claude start');
    const idle = await waitForSession(hub, ID, (s) => s.state === 'idle' && s.claudeSessionId === start.sid, 'registered idle session');
    expect(idle).toMatchObject({
      host: 'cedar', target: TARGET, registered: true, cwd: '/home/dev/projects/alpha',
      project: 'alpha', displayName: 'alpha', origin: 'owner',
    });

    await server.typeInto(TARGET, TYPED);
    await waitForLog(server, (e) => e.kind === 'received' && e.text === TYPED, 'typed prompt');
    const turn = await waitFor(() => finished.find((f) => f.session.id === ID), { what: 'turn.finished' });
    expect(turn.remote).toBe(false);
    expect(turn.lastMessage).toContain(TYPED);
    expect(updates.filter((u) => u.id === ID).map((u) => u.state)).toContain('working');
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle after Stop');

    const mine = hub.spool.filter((r) => r.event.session_id === start.sid);
    expect(mine.map((r) => r.event.event)).toEqual(expect.arrayContaining(['session_start', 'prompt', 'stop']));
    const ids = mine.map((r) => r.event.id);
    const stored = hub.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number };
    expect(stored.n).toBe(ids.length);

    const rows = hub.db.prepare('SELECT role, text FROM messages WHERE thread = ?').all(`session:${ID}`) as Array<{ role: string; text: string }>;
    expect(rows.some((r) => r.role === 'user' && r.text.includes(TYPED))).toBe(true);
    expect(rows.some((r) => r.role === 'assistant' && r.text.includes(TYPED))).toBe(true);
  });

  it('keeps the foreign UserPromptSubmit hook working next to the kit hooks', async () => {
    const lines = Number((await server.execOk('dev', 'wc -l < "$HOME/.fake-claude/skills-first.log"')).trim());
    expect(lines).toBeGreaterThanOrEqual(1);
    type Settings = { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const settings = JSON.parse(await server.execOk('dev', 'cat "$HOME/.claude/settings.json"')) as Settings;
    const commands = settings.hooks.UserPromptSubmit?.flatMap((group) => group.hooks.map((h) => h.command)) ?? [];
    // The foreign hook is kept; the kit dispatcher is registered behind the guarded wrapper (kit 2).
    expect(commands).toContain('~/.claude/hooks/skills-first.sh');
    expect(commands.some((command) => command.includes('/.luady/hooks/luady_hook.py'))).toBe(true);
  });
});
