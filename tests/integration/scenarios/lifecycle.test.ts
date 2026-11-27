import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { shq } from '../harness/proc.js';
import { syncStream, waitForLog, waitForSession } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';

const LIFE = 'cedar:cc-it-life:0.0';
const DEL = 'cedar:cc-it-del:0.0';
const FIRST_PROMPT = 'first task for the lifecycle test';

let server: FakeServer;
let hub: TestHub;
let lifeSid = '';

beforeAll(async () => {
  server = await startFakeServer(inject('luadyIt'));
  hub = await startTestHub({ env: inject('luadyIt'), server });
  await syncStream(hub, server);
});

afterAll(async () => {
  await hub?.stop();
  await server?.down();
});

describe('session lifecycle', () => {
  it('starts in an untrusted project dir: trust dialog accepted, first prompt delivered', async () => {
    const created = await hub.app.services.sessions.start({ server: 'cedar', cwd: '/home/dev/projects/fresh', prompt: FIRST_PROMPT, name: 'it-life', origin: 'owner' });
    expect(created.id).toBe(LIFE);
    await waitForLog(server, (e) => e.kind === 'trust' && e.cwd === '/home/dev/projects/fresh', 'trust dialog accepted by luady-ctl start');
    const start = await waitForLog(server, (e) => e.kind === 'start' && e.target === 'cc-it-life:0.0', 'fake-claude start');
    lifeSid = String(start.sid);
    expect(start.argv).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    await waitForLog(server, (e) => e.kind === 'received' && e.sid === lifeSid && e.text === FIRST_PROMPT, 'first prompt');
    await waitForSession(hub, LIFE, (s) => s.state === 'idle' && s.claudeSessionId === lifeSid, 'idle after the first turn');
  });

  it('restarts with --resume and keeps the same Claude session id', async () => {
    await hub.app.services.sessions.restart(LIFE);
    const resumed = await waitForLog(server, (e) => e.kind === 'start' && e.sid === lifeSid && e.source === 'resume', 'resumed fake-claude');
    expect(resumed.argv).toEqual(expect.arrayContaining(['--resume', lifeSid]));
    await waitForSession(hub, LIFE, (s) => s.state === 'idle' && s.claudeSessionId === lifeSid, 'idle after restart');
  });

  it('stops gracefully: /exit, SessionEnd, pane gone, ended without the unexpected flag', async () => {
    await hub.app.services.sessions.stop(LIFE, false);
    await waitForLog(server, (e) => e.kind === 'exit' && e.sid === lifeSid && e.reason === 'prompt_input_exit', 'graceful exit');
    const ended = await waitForSession(hub, LIFE, (s) => s.state === 'ended', 'ended');
    expect(ended.unexpectedEnd).toBe(false);
    expect(await server.hasTmuxSession('cc-it-life')).toBe(false);
  });

  it('deletes a live session: pane stopped, transcript moved to the kit trash', async () => {
    await hub.app.services.sessions.start({ server: 'cedar', cwd: '/home/dev/projects/alpha', prompt: 'a turn to delete', name: 'it-del', origin: 'owner' });
    const sid = String((await waitForLog(server, (e) => e.kind === 'start' && e.target === 'cc-it-del:0.0', 'it-del start')).sid);
    await waitForSession(hub, DEL, (s) => s.state === 'idle' && s.claudeSessionId === sid, 'it-del idle');
    const transcript = `/home/dev/.claude/projects/-home-dev-projects-alpha/${sid}.jsonl`;
    await server.execOk('dev', `test -s ${shq(transcript)}`);

    await hub.app.services.sessions.remove(DEL);
    expect(await server.hasTmuxSession('cc-it-del')).toBe(false);
    expect((await server.exec('dev', `test -e ${shq(transcript)}`)).code).not.toBe(0);
    const trash = await server.execOk('dev', 'ls -1 "$HOME/.luady/trash"');
    expect(trash.split('\n').some((name) => name.endsWith(`-${sid}.jsonl`))).toBe(true);
    await waitFor(() => {
      const session = hub.app.services.sessions.get(DEL);
      return session === undefined || session.state === 'ended';
    }, { what: 'deleted session gone or ended' });
  });
});
