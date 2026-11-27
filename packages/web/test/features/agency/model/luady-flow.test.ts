import { describe, expect, it } from 'vitest';
import {
  ANSWER_MS, IDLE_FLOW, QUIET_GRACE_MS, WAIT_CAP_MS, flowWords, nextFlowChange, reduceLuadyFlow, type LuadyFlow, type LuadyFlowEvent,
} from '../../../../src/features/agency/model/luady-flow.js';

const run = (events: readonly LuadyFlowEvent[], from: LuadyFlow = IDLE_FLOW): LuadyFlow => events.reduce(reduceLuadyFlow, from);

describe("Luady's message flow", () => {
  it('sent: the owner writes and a "New message" pop shows', () => {
    const flow = run([{ type: 'send', now: 100, luady: 'running' }]);
    expect(flow).toEqual({ kind: 'sent', at: 100 });
    expect(flowWords(flow)).toBe('New message');
  });

  it('busy: when his turn starts the pop becomes the typing bubble', () => {
    const flow = run([{ type: 'send', now: 100, luady: 'running' }, { type: 'status', now: 400, luady: 'busy' }]);
    expect(flow).toEqual({ kind: 'typing', at: 400, quietSince: null });
    expect(flowWords(flow)).toBe('Luady is typing');
  });

  it('answered: his reply opens with the whole text for 45 seconds, then goes', () => {
    const flow = run([
      { type: 'send', now: 100, luady: 'running' }, { type: 'status', now: 400, luady: 'busy' }, { type: 'reply', now: 5_000, messageId: 'm9' },
    ]);
    expect(flow).toEqual({ kind: 'answer', messageId: 'm9', until: 5_000 + ANSWER_MS });
    expect(flowWords(flow)).toBeNull();
    expect(nextFlowChange(flow)).toBe(5_000 + ANSWER_MS);
    expect(reduceLuadyFlow(flow, { type: 'tick', now: 5_000 + ANSWER_MS - 1 })).toBe(flow);
    expect(reduceLuadyFlow(flow, { type: 'tick', now: 5_000 + ANSWER_MS })).toEqual(IDLE_FLOW);
  });

  it('a reply that comes before the busy status still shows (a fast answer)', () => {
    expect(run([{ type: 'send', now: 0, luady: 'running' }, { type: 'reply', now: 900, messageId: 'm1' }]).kind).toBe('answer');
  });

  it('closed: the owner closes the answer, or writes again', () => {
    const answer = run([{ type: 'reply', now: 0, messageId: 'm1' }]);
    expect(reduceLuadyFlow(answer, { type: 'close' })).toEqual(IDLE_FLOW);
    expect(reduceLuadyFlow(answer, { type: 'send', now: 10, luady: 'running' })).toEqual({ kind: 'sent', at: 10 });
    expect(reduceLuadyFlow(IDLE_FLOW, { type: 'close' })).toBe(IDLE_FLOW);
  });

  it('held: a message the hub keeps says he is signed out', () => {
    const flow = run([{ type: 'send', now: 0, luady: 'running' }, { type: 'held', now: 200 }]);
    expect(flow).toEqual({ kind: 'held', at: 200 });
    expect(flowWords(flow)).toBe('Luady is signed out. He gets it when he is back.');
    expect(reduceLuadyFlow(IDLE_FLOW, { type: 'held', now: 1 })).toBe(IDLE_FLOW);
  });

  it('down: writing while he is offline says so, and turns into the pop when he is back', () => {
    const flow = run([{ type: 'send', now: 0, luady: 'down' }]);
    expect(flowWords(flow)).toBe('Luady is offline right now. He gets it when he is back.');
    expect(reduceLuadyFlow(flow, { type: 'status', now: 50, luady: 'running' })).toEqual({ kind: 'sent', at: 0 });
    expect(reduceLuadyFlow(flow, { type: 'status', now: 50, luady: 'busy' }).kind).toBe('typing');
    expect(run([{ type: 'send', now: 0, luady: 'running' }, { type: 'status', now: 10, luady: 'down' }]).kind).toBe('down');
  });

  it('a turn that ends without an answer lets the typing bubble go after a short grace', () => {
    const typing = run([{ type: 'send', now: 0, luady: 'running' }, { type: 'status', now: 100, luady: 'busy' }, { type: 'status', now: 2_000, luady: 'running' }]);
    expect(typing).toEqual({ kind: 'typing', at: 100, quietSince: 2_000 });
    expect(nextFlowChange(typing)).toBe(2_000 + QUIET_GRACE_MS);
    expect(reduceLuadyFlow(typing, { type: 'tick', now: 2_000 + QUIET_GRACE_MS - 1 })).toBe(typing);
    expect(reduceLuadyFlow(typing, { type: 'tick', now: 2_000 + QUIET_GRACE_MS })).toEqual(IDLE_FLOW);
    expect(reduceLuadyFlow(typing, { type: 'status', now: 2_500, luady: 'busy' })).toEqual({ kind: 'typing', at: 100, quietSince: null });
  });

  it('a pop that never gets an answer goes after three minutes', () => {
    const sent = run([{ type: 'send', now: 0, luady: 'running' }]);
    expect(nextFlowChange(sent)).toBe(WAIT_CAP_MS);
    expect(reduceLuadyFlow(sent, { type: 'tick', now: WAIT_CAP_MS })).toEqual(IDLE_FLOW);
    expect(nextFlowChange(IDLE_FLOW)).toBeNull();
  });

  it('a busy status without a message of the owner shows nothing', () => {
    expect(reduceLuadyFlow(IDLE_FLOW, { type: 'status', now: 0, luady: 'busy' })).toBe(IDLE_FLOW);
  });

  it('switched off is quiet: no pop, no "offline" note, nothing waits for him', () => {
    // A send while he is off (the dock does not offer one) shows nothing.
    expect(run([{ type: 'send', now: 0, luady: 'off' }])).toEqual(IDLE_FLOW);
    // Switching him off clears whatever waited for him.
    for (const from of [{ kind: 'sent', at: 0 }, { kind: 'down', at: 0 }, { kind: 'held', at: 0 }, { kind: 'typing', at: 0, quietSince: null }] as const) {
      expect(reduceLuadyFlow(from, { type: 'status', now: 10, luady: 'off' })).toEqual(IDLE_FLOW);
    }
    // An answer already open stays until it expires.
    const answer: LuadyFlow = { kind: 'answer', messageId: 'm1', until: 5_000 };
    expect(reduceLuadyFlow(answer, { type: 'status', now: 10, luady: 'off' })).toBe(answer);
    expect(reduceLuadyFlow(IDLE_FLOW, { type: 'status', now: 10, luady: 'off' })).toBe(IDLE_FLOW);
  });
});
