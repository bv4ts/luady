import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { syncStream, typeInto, waitForActivity, waitForLog, waitForSession } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';

const TARGET = 'cc-alpha:0.0';
const ID = `cedar:${TARGET}`;
/** The recovery text the kit types on resume (pause.py). */
const RESUME_TEXT = 'The owner has lifted the pause. Continue from where you paused.';

let server: FakeServer;
let hub: TestHub;
let sid = '';

beforeAll(async () => {
  server = await startFakeServer(inject('luadyIt'));
  hub = await startTestHub({ env: inject('luadyIt'), server });
  await syncStream(hub, server);
  await server.startClaude('alpha', '/home/dev/projects/alpha');
  sid = String((await waitForLog(server, (e) => e.kind === 'start' && e.target === TARGET, 'fake-claude start')).sid);
  await waitForSession(hub, ID, (s) => s.state === 'idle', 'alpha idle');
});

afterAll(async () => {
  await hub?.stop();
  await server?.down();
});

const toolCount = async (): Promise<number> => (await server.fakeLog()).filter((e) => e.kind === 'tool' && e.sid === sid).length;

describe('activity: the whole chain from a fake session to the hub', () => {
  it('turns steps, a helper, meters, a pause with restart recovery and a risky permission into hub state', async () => {
    // --- steps land in the activity path, never in the events table or the session stream ---
    const updates = hub.record('session.updated');
    const before = updates.length;
    await typeInto(server, TARGET, '/steps 3');
    const afterSteps = await waitForActivity(
      hub, ID,
      (d) => d.steps.filter((s) => s.kind === 'run' && s.endedAt !== null).length === 3,
      'three closed run steps',
      60_000,
    );
    expect(afterSteps.steps.filter((s) => s.kind === 'run').map((s) => s.title)).toEqual(['echo step-1', 'echo step-2', 'echo step-3']);
    const stepRows = hub.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type IN ('tool_start', 'tool_end')").get() as { n: number };
    expect(stepRows.n).toBe(0);
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle after the steps turn');
    expect(updates.slice(before).filter((s) => s.id === ID).map((s) => s.state)).toEqual(['working', 'idle']);

    // --- a helper shows up for the length of the turn, then leaves ---
    await typeInto(server, TARGET, '/agent');
    await waitForActivity(hub, ID, (d) => d.helpers.length === 1, 'one helper');
    await waitForActivity(hub, ID, (d) => d.helpers.length === 0, 'the helper leaves');
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle after the agent turn');

    // --- a turn whose meters changed reaches the hub as a cedar meter (the status line forwards only on a change) ---
    const meters = hub.record('meters.updated');
    await server.execOk('dev', `printf '%s' '{"context":44,"five_hour":55,"seven_day":66}' > "$HOME/.fake-claude/status.json"`);
    await typeInto(server, TARGET, 'one plain turn');
    await waitForLog(server, (e) => e.kind === 'received' && e.sid === sid && e.text === 'one plain turn', 'the plain turn');
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle after the plain turn');
    await waitFor(() => meters.some((m) => m.host === 'cedar'), { what: 'a meters.updated for cedar' });

    // --- a pause stops a run early, a send is refused, and resume types the recovery text ---
    await hub.app.services.pauses.pause(ID);
    const ranBefore = await toolCount();
    await typeInto(server, TARGET, '/steps 6');
    const stopped = await waitForLog(server, (e) => e.kind === 'stopped' && e.sid === sid, 'the pause stops the run');
    expect(stopped.reason).toBe('Paused by the owner');
    const ran = (await toolCount()) - ranBefore;
    expect(ran).toBeGreaterThanOrEqual(1);
    expect(ran).toBeLessThan(6);
    await expect(hub.app.services.sessions.send(ID, 'x', 'web')).rejects.toMatchObject({ code: 'session_paused' });
    await hub.app.services.pauses.resume(ID);
    await waitForLog(server, (e) => e.kind === 'received' && e.sid === sid && typeof e.text === 'string' && e.text.startsWith('The owner has lifted the pause'), 'the resume recovery text');
    expect(RESUME_TEXT.startsWith('The owner has lifted the pause')).toBe(true);
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle after the resume turn');

    // --- a pause survives a hub restart: the new hub reads the kit's flag back within 30 s ---
    await hub.app.services.pauses.pause(ID);
    expect(hub.app.services.pauses.isPaused(ID)).toBe(true);
    const dir = hub.dir;
    await hub.stop({ keepDir: true });
    hub = await startTestHub({ env: inject('luadyIt'), server, dir });
    await waitFor(() => hub.app.services.pauses.isPaused(ID), { timeoutMs: 30_000, what: 'the pause read back from the kit after a restart' });
    await waitForSession(hub, ID, () => true, 'the session is known again after the restart');
    await hub.app.services.pauses.resume(ID);
    await waitFor(() => !hub.app.services.pauses.isPaused(ID), { what: 'the pause is cleared again' });

    // --- a risky permission: a command preview judged risky, allow-always, and no preview kept afterwards ---
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle before the permission');
    await typeInto(server, TARGET, '/perm Bash {"command":"git push --force origin main"}');
    const q = await waitFor(
      () => hub.app.services.questions.pending().find((x) => x.sessionId === ID && x.kind === 'permission'),
      { what: 'the pending permission' },
    );
    expect(q.permission?.preview?.kind).toBe('command');
    expect(q.permission?.risk?.level).toBe('risky');
    await hub.app.services.questions.answerPermission(q.qid, 'allow', undefined, 'web', { always: true });
    const applied = await waitForLog(server, (e) => e.kind === 'permission' && e.sid === sid, 'the permission decision is applied');
    expect(applied.behavior).toBe('allow');
    expect(applied.updated).toBe(true);
    const row = hub.db.prepare('SELECT payload_json FROM questions WHERE qid = ?').get(q.qid) as { payload_json: string };
    expect(row.payload_json).not.toContain('"preview"');
  });
});
