import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDTO } from '@luady/shared';
import type { Clock } from '../../src/core/contracts.js';
import { QuestionPendingError, SessionPausedError } from '../../src/core/errors.js';
import {
  createAutoResumer, isConnectionDrop, RESUME_DELAY_MS, RESUME_MAX, RESUME_TEXT, RESUME_WINDOW_MS,
} from '../../src/notify/resume.js';
import { silentLogger } from '../helpers/fakes.js';

const DROP = 'server_error — API Error: Connection lost mid-response. The response above may be incomplete.';
const clock: Clock = { now: () => new Date() };

function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 'ash:cc-harbor-new-home:0.0', host: 'ash', target: 'cc-harbor-new-home:0.0', claudeSessionId: 'c-1',
    cwd: '/home/dev/projects/harbor', project: 'harbor', displayName: 'harbor-new-home', state: 'error',
    origin: 'manager', registered: true, lastEventAt: null, turnStartedAt: null, pendingQid: null, unexpectedEnd: false, ...over,
  };
}

function setup(send = vi.fn(async () => undefined), isHeld?: (sessionId: string) => boolean) {
  const gaveUp: string[] = [];
  const resumer = createAutoResumer({
    sessions: { send }, clock, log: silentLogger(), onGiveUp: (s, error) => gaveUp.push(`${s.id}: ${error}`),
    ...(isHeld === undefined ? {} : { isHeld }),
  });
  return { resumer, send, gaveUp };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date('2026-10-29T08:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isConnectionDrop', () => {
  it('matches only dropped API streams, old and new wording', () => {
    expect(isConnectionDrop(DROP)).toBe(true);
    expect(isConnectionDrop('API Error: Connection closed mid-response')).toBe(true);
    expect(isConnectionDrop('server_error — API Error: Connection to the API was lost (ECONNRESET)')).toBe(true);
    expect(isConnectionDrop("rate_limit — You've hit your session limit · resets 5:20am")).toBe(false);
    expect(isConnectionDrop('API Error: 529 overloaded')).toBe(false);
  });
});

describe('createAutoResumer', () => {
  it('tells the session to carry on after a short pause', async () => {
    const t = setup();
    expect(t.resumer.tryResume(session(), DROP)).toBe(true);
    expect(t.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.send).toHaveBeenCalledWith('ash:cc-harbor-new-home:0.0', RESUME_TEXT, 'event');
    expect(t.gaveUp).toEqual([]);
  });

  it('leaves other failures and the brain to the usual path', () => {
    const t = setup();
    expect(t.resumer.tryResume(session(), 'API Error: 529 overloaded')).toBe(false);
    expect(t.resumer.tryResume(session({ id: 'hq:manager:0.0', host: 'hq', origin: 'system' }), DROP)).toBe(false);
  });

  it(`stops after ${RESUME_MAX} drops in the window, and starts over once the window has passed`, async () => {
    const t = setup();
    for (let i = 0; i < RESUME_MAX; i += 1) {
      expect(t.resumer.tryResume(session(), DROP)).toBe(true);
      await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    }
    expect(t.resumer.tryResume(session(), DROP)).toBe(false);
    expect(t.resumer.tryResume(session({ id: 'birch:cc-orchard:0.0', host: 'birch' }), DROP)).toBe(true);
    await vi.advanceTimersByTimeAsync(RESUME_WINDOW_MS);
    expect(t.resumer.tryResume(session(), DROP)).toBe(true);
  });

  it('hands the session to Luady when the carry-on cannot be sent', async () => {
    const t = setup(vi.fn(async () => { throw new QuestionPendingError('ABCDEFGH', 'waiting for an answer to #ABCDEFGH'); }));
    t.resumer.tryResume(session(), DROP);
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.gaveUp).toEqual([`ash:cc-harbor-new-home:0.0: ${DROP}`]);
  });

  it('a drop while a pause flag is set but not hit takes the usual path: the carry-on, then Luady when it is refused', async () => {
    const refused = vi.fn(async () => { throw new SessionPausedError('ash · harbor-new-home is paused. Resume it first.'); });
    const t = setup(refused, () => false);
    expect(t.resumer.tryResume(session(), DROP)).toBe(true);
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.gaveUp).toEqual([`ash:cc-harbor-new-home:0.0: ${DROP}`]);
  });

  it('a drop after the pause hit is held, and a release that typed nothing carries on', async () => {
    let held = true;
    const t = setup(vi.fn(async () => undefined), () => held);
    expect(t.resumer.tryResume(session(), DROP)).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.gaveUp).toEqual([]);
    held = false;
    t.resumer.release('ash:cc-harbor-new-home:0.0', false);
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.send).toHaveBeenCalledWith('ash:cc-harbor-new-home:0.0', RESUME_TEXT, 'event');
    t.resumer.release('ash:cc-harbor-new-home:0.0', false);
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('a release whose resume text was typed drops the held drop', async () => {
    let held = true;
    const t = setup(vi.fn(async () => undefined), () => held);
    t.resumer.tryResume(session(), DROP);
    held = false;
    t.resumer.release('ash:cc-harbor-new-home:0.0', true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.gaveUp).toEqual([]);
  });

  it('a pause that hits during the delay holds the carry-on until the release', async () => {
    let held = false;
    const t = setup(vi.fn(async () => undefined), () => held);
    expect(t.resumer.tryResume(session(), DROP)).toBe(true);
    held = true;
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.send).not.toHaveBeenCalled();
    held = false;
    t.resumer.release('ash:cc-harbor-new-home:0.0', false);
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels pending carry-ons', async () => {
    const t = setup();
    t.resumer.tryResume(session(), DROP);
    t.resumer.stop();
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS);
    expect(t.send).not.toHaveBeenCalled();
  });
});
