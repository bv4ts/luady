import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@luady/shared';
import { NotFoundError, PinInvalidError, PinLockedError, QuestionClosedError } from '../../src/core/errors.js';
import { call, harnessFactory, QID, sampleAction, sampleQuestion } from './helpers.js';

const harness = harnessFactory();
const PIN = '123456';

describe('questions', () => {
  it('GET /api/questions returns the pending questions', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/questions?state=pending', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([sampleQuestion()]);
  });

  it('rejects a state other than pending with 400', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/questions?state=answered', undefined, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
  });

  it('answers a question with an answers map through the web channel', async () => {
    const h = await harness();
    const res = await call(h, 'POST', `/api/questions/${QID}/answer`, { answers: { 'Pick one': 'A' } }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.questions.answer).toHaveBeenCalledWith(QID, { 'Pick one': 'A' }, 'web');
    expect(res.json()).toMatchObject({ qid: QID, state: 'answered' });
  });

  it('answers a permission request with behavior and message', async () => {
    const h = await harness();
    const res = await call(
      h,
      'POST',
      `/api/questions/${QID}/answer`,
      { behavior: 'deny', message: 'not now' },
      { session: h.login() },
    );
    expect(res.statusCode).toBe(200);
    expect(h.deps.questions.answerPermission).toHaveBeenCalledWith(QID, 'deny', 'not now', 'web', { always: false });
    expect(h.deps.questions.answer).not.toHaveBeenCalled();
  });

  it('passes allow always to the service, and refuses always with deny before the service', async () => {
    const h = await harness();
    const session = h.login();
    const allow = await call(h, 'POST', `/api/questions/${QID}/answer`, { behavior: 'allow', always: true }, { session });
    expect(allow.statusCode).toBe(200);
    expect(h.deps.questions.answerPermission).toHaveBeenCalledWith(QID, 'allow', undefined, 'web', { always: true });
    const deny = await call(h, 'POST', `/api/questions/${QID}/answer`, { behavior: 'deny', always: true }, { session });
    expect(deny.statusCode).toBe(400);
    expect(h.deps.questions.answerPermission).toHaveBeenCalledTimes(1);
  });

  it('maps an already-resolved question to 409 question_closed', async () => {
    const h = await harness();
    vi.mocked(h.deps.questions.answer).mockRejectedValueOnce(
      new QuestionClosedError('answered', `#${QID} was already answered`),
    );
    const res = await call(h, 'POST', `/api/questions/${QID}/answer`, { answers: { 'Pick one': 'B' } }, { session: h.login() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'question_closed', message: `#${QID} was already answered` } });
  });

  it('releases a question back to the terminal', async () => {
    const h = await harness();
    const res = await call(h, 'POST', `/api/questions/${QID}/release`, {}, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.questions.release).toHaveBeenCalledWith(QID, 'web');
    expect(res.json()).toMatchObject({ state: 'released' });
  });

  it('rejects a malformed qid with 400', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/questions/abc/release', {}, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(h.deps.questions.release).not.toHaveBeenCalled();
  });
});

describe('actions', () => {
  it('lists the audit log with status and limit, ignoring an empty status', async () => {
    const h = await harness();
    const session = h.login();
    await call(h, 'GET', '/api/actions?status=&limit=20', undefined, { session });
    expect(h.deps.actions.list).toHaveBeenLastCalledWith({ limit: 20 });
    const res = await call(h, 'GET', '/api/actions?status=pending_confirmation', undefined, { session });
    expect(h.deps.actions.list).toHaveBeenLastCalledWith({ status: 'pending_confirmation', limit: 100 });
    expect(res.json()).toEqual([sampleAction()]);
  });

  it('opens the whole text of an action for the confirmation card; an unknown id is 404', async () => {
    const h = await harness();
    const session = h.login();
    const res = await call(h, 'GET', '/api/actions/A7/text', undefined, { session });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: 'the whole message' });
    expect((await call(h, 'GET', '/api/actions/A8/text', undefined, { session })).statusCode).toBe(404);
    expect((await call(h, 'GET', '/api/actions/A7/text')).statusCode).toBe(401);
  });

  it('confirms an action with the PIN from the body', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/actions/A7/confirm', { pin: PIN }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.actions.confirm).toHaveBeenCalledWith('A7', PIN, 'web');
    expect(res.json()).toMatchObject({ id: 'A7', status: 'done' });
  });

  it('maps a wrong PIN to 403 and a lockout to 423', async () => {
    const h = await harness();
    const session = h.login();
    vi.mocked(h.deps.actions.confirm)
      .mockRejectedValueOnce(new PinInvalidError(1))
      .mockRejectedValueOnce(new PinLockedError('2026-10-09T12:15:00.000Z'));
    const wrong = await call(h, 'POST', '/api/actions/A7/confirm', { pin: '000000' }, { session });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: { code: 'pin_invalid', message: 'Wrong PIN', remaining: 1 } });
    const locked = await call(h, 'POST', '/api/actions/A7/confirm', { pin: '000000' }, { session });
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toEqual({
      error: { code: 'pin_locked', message: 'PIN locked until 2026-10-09T12:15:00.000Z', until: '2026-10-09T12:15:00.000Z' },
    });
  });

  it('denies an action', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/actions/A7/deny', {}, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.actions.deny).toHaveBeenCalledWith('A7', 'web');
    expect(res.json()).toMatchObject({ id: 'A7', status: 'denied' });
  });

  it('maps an unknown action to 404 and a malformed id to 400', async () => {
    const h = await harness();
    const session = h.login();
    vi.mocked(h.deps.actions.confirm).mockRejectedValueOnce(new NotFoundError('Unknown action A9'));
    const res = await call(h, 'POST', '/api/actions/A9/confirm', { pin: PIN }, { session });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Unknown action A9' } });
    expect((await call(h, 'POST', '/api/actions/B7/deny', {}, { session })).statusCode).toBe(400);
  });

  it('rejects confirm without the CSRF header with 403', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/actions/A7/confirm', { pin: PIN }, { session: h.login(), csrf: null });
    expect(res.statusCode).toBe(403);
    expect(h.deps.actions.confirm).not.toHaveBeenCalled();
  });
});

describe('settings', () => {
  it('GET /api/settings returns the settings', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/settings', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(DEFAULT_SETTINGS);
  });

  it('PUT /api/settings applies a validated patch', async () => {
    const h = await harness();
    const res = await call(h, 'PUT', '/api/settings', { away: true, escalate_after_min: 15 }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.settings.update).toHaveBeenCalledWith({ away: true, escalate_after_min: 15 });
    expect(res.json()).toEqual({ ...DEFAULT_SETTINGS, away: true, escalate_after_min: 15 });
  });

  it('PUT /api/settings rejects unknown keys and out-of-range values with 400', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'PUT', '/api/settings', { bogus: 1 }, { session })).statusCode).toBe(400);
    expect((await call(h, 'PUT', '/api/settings', { escalate_after_min: 0 }, { session })).statusCode).toBe(400);
    expect(h.deps.settings.update).not.toHaveBeenCalled();
  });

  it('the built-in chat link routes are gone: a chat app is an add-on', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'GET', '/api/wa/status', undefined, { session })).statusCode).toBe(404);
    expect((await call(h, 'POST', '/api/wa/logout', { pin: PIN }, { session })).statusCode).toBe(404);
    expect((await call(h, 'POST', '/api/wa/passkey', { response: '{}' }, { session })).statusCode).toBe(404);
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });
});
