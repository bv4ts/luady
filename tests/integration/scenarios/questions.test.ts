import type { QuestionDTO } from '@luady/shared';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startFakeServer, type FakeLogEntry, type FakeServer } from '../harness/docker.js';
import { startTestHub, type TestHub } from '../harness/hub.js';
import { EXTRAS_TEXT, QUESTION_TEXT, syncStream, waitForLog, waitForSession } from '../harness/scenario.js';
import { waitFor } from '../harness/wait.js';

const TARGET = 'cc-beta:0.0';
const ID = `cedar:${TARGET}`;

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

function pendingQuestion(): Promise<QuestionDTO> {
  return waitFor(() => hub.app.services.questions.pending().find((q) => q.sessionId === ID), { what: 'pending question' });
}

/** Runs `action`, then waits for the next fake-claude log entry of `kind` in this session. */
async function nextLog(kind: string, action: () => Promise<unknown>): Promise<FakeLogEntry> {
  const mine = async () => (await server.fakeLog()).filter((e) => e.sid === sid && e.kind === kind);
  const before = (await mine()).length;
  await action();
  return waitFor(async () => (await mine())[before], { timeoutMs: 45_000, what: `fake-claude ${kind}` });
}

describe('remote question answering', () => {
  it('answers a single-select question round trip; send and a second answer are refused', async () => {
    await server.typeInto(TARGET, '/ask');
    const q = await pendingQuestion();
    expect(q.questions.map((x) => x.question)).toEqual([QUESTION_TEXT]);
    expect(q.questions[0]?.options.map((o) => o.label)).toEqual(['Blue', 'Green']);
    await waitForSession(hub, ID, (s) => s.state === 'waiting_question' && s.pendingQid === q.qid, 'waiting_question');
    await expect(hub.app.services.sessions.send(ID, 'must not be typed', 'web')).rejects.toMatchObject({ code: 'question_pending' });

    const entry = await nextLog('answers', () => hub.app.services.questions.answer(q.qid, { [QUESTION_TEXT]: 'Blue' }, 'web'));
    expect(entry.answers).toEqual({ [QUESTION_TEXT]: 'Blue' });
    await waitFor(() => hub.app.services.questions.get(q.qid)?.state === 'answered', { what: 'question answered' });
    await waitForSession(hub, ID, (s) => s.state === 'idle' && s.pendingQid === null, 'idle after the answer');
    await expect(hub.app.services.questions.answer(q.qid, { [QUESTION_TEXT]: 'Green' }, 'web')).rejects.toMatchObject({ code: 'question_closed' });
    expect((await server.fakeLog()).some((e) => e.kind === 'received' && e.text === 'must not be typed')).toBe(false);
  });

  it('releases a question back to the terminal dialog', async () => {
    await server.typeInto(TARGET, '/ask');
    const q = await pendingQuestion();
    const entry = await nextLog('dialog', () => hub.app.services.questions.release(q.qid, 'web'));
    expect(entry.questions).toEqual([QUESTION_TEXT]);
    await waitFor(() => hub.app.services.questions.get(q.qid)?.state === 'released', { what: 'question released' });
  });

  it('passes multi-select labels and free text through verbatim', async () => {
    await server.typeInto(TARGET, '/ask2');
    const q = await pendingQuestion();
    expect(q.questions.map((x) => x.question)).toEqual([QUESTION_TEXT, EXTRAS_TEXT]);
    const answers = { [QUESTION_TEXT]: 'Something else: teal ✨', [EXTRAS_TEXT]: 'Tests, Docs' };
    const entry = await nextLog('answers', () => hub.app.services.questions.answer(q.qid, answers, 'test-channel'));
    expect(entry.answers).toEqual(answers);
    await waitFor(() => hub.app.services.questions.get(q.qid)?.state === 'answered', { what: 'question answered' });
  });
});
