import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { syncStream, waitForLog, waitForSession } from '../harness/scenario.js';
import { sleep, waitFor } from '../harness/wait.js';

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

describe('pane discovery and injection safety', () => {
  it('lists a Claude pane that never ran the hooks as unregistered, using the newest transcript as the best guess', async () => {
    const target = await server.startClaude('legacy', '/home/dev/projects/gamma', { FAKE_CLAUDE_NO_HOOKS: '1' });
    const start = await waitForLog(server, (e) => e.kind === 'start' && e.target === target, 'legacy fake-claude start');
    await server.typeInto(target, 'typed before the kit existed');
    await waitForLog(server, (e) => e.kind === 'received' && e.sid === start.sid, 'legacy prompt');
    const session = await waitForSession(hub, `cedar:${target}`, () => true, 'reconciliation lists the pane', 90_000);
    expect(session.registered).toBe(false);
    expect(session.claudeSessionId).toBe(start.sid);
    expect(hub.spool.some((r) => r.event.session_id === start.sid)).toBe(false);
  });

  it('never types into a pane that is not running Claude', async () => {
    await server.execOk('dev', 'tmux new-session -d -s cc-shell -c /home/dev/projects/gamma');
    const client = hub.app.services.fleet.client('cedar');
    const pane = await waitFor(async () => (await client.sessions()).sessions.find((p) => p.target === 'cc-shell:0.0'), { what: 'shell pane listed by luady-ctl' });
    expect(pane.is_claude).toBe(false);
    await expect(client.send('cc-shell:0.0', 'echo typed-into-shell')).rejects.toMatchObject({ code: 'refused' });
    expect(await server.execOk('dev', 'tmux capture-pane -p -t cc-shell:0.0')).not.toContain('typed-into-shell');
    await sleep(20_000); // longer than one 15 s reconciliation cycle
    expect(hub.app.services.sessions.get('cedar:cc-shell:0.0')).toBeUndefined();
  });
});
