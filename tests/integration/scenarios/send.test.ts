import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { syncStream, waitForLog, waitForSession } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';

const TARGET = 'cc-beta:0.0';
const ID = `cedar:${TARGET}`;
const CASES: ReadonlyArray<readonly [string, string]> = [
  ['Arabic and emoji', 'مرحبا يا صديقي 👋🏽 — هل انتهيت من المهمة؟'],
  ['shell metacharacters', `quotes "double" 'single' \`tick\` $(whoami) $HOME; rm -rf / && echo pwned | cat > /tmp/x`],
  ['newlines and tabs', 'line one\nline two with trailing spaces   \n\tindented line three\n\n\nafter blank lines'],
  ['5,400 characters of mixed text', `${'سطر عربي طويل مع رموز ✓ ASCII tail 0123456789 '.repeat(120)}END`],
];

let server: FakeServer;
let hub: TestHub;
let sid = '';

beforeAll(async () => {
  server = await startFakeServer(inject('luadyIt'));
  hub = await startTestHub({ env: inject('luadyIt'), server });
  await syncStream(hub, server);
  await server.startClaude('beta', '/home/dev/projects/beta');
  sid = String((await waitForLog(server, (e) => e.kind === 'start' && e.target === TARGET, 'fake-claude start')).sid);
  await waitForSession(hub, ID, (s) => s.state === 'idle', 'beta idle');
});

afterAll(async () => {
  await hub?.stop();
  await server?.down();
});

describe('send', () => {
  it.each(CASES)('delivers %s byte-for-byte through luady-ctl send', async (_label, text) => {
    const received = async () => (await server.fakeLog()).filter((e) => e.sid === sid && e.kind === 'received');
    const before = (await received()).length;
    await hub.app.services.sessions.send(ID, text, 'web');
    const entry = await waitFor(async () => (await received())[before], { timeoutMs: 60_000, what: 'pasted text in fake-claude' });
    expect(entry.text).toBe(text);
    await waitForSession(hub, ID, (s) => s.state === 'idle', 'idle after the echo turn');
  });

  it('marks hub-injected turns as remote', async () => {
    const finished = hub.record('turn.finished');
    await hub.app.services.sessions.send(ID, 'remote turn marker', 'test-channel');
    const turn = await waitFor(() => finished.find((f) => f.session.id === ID && f.lastMessage.includes('remote turn marker')), { what: 'turn.finished' });
    expect(turn.remote).toBe(true);
  });
});
