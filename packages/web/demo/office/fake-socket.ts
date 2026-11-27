import type { NoticeDTO, WsClientMessage, WsServerMessage } from '@luady/shared';
import type { WsClient, WsHandlers } from '../../src/api/ws.js';
import { FOCUS_AGENT, iso, stepAt } from './data.js';
import { settleNotices, type FakeHub } from './fake-hub.js';

/** What the demo page sent "to the hub", for a look from the browser console or a test driver. */
export const sentFrames: WsClientMessage[] = [];

/** A notice the hub would create while the page is open. */
export function freshNotice(id: string, over: Partial<NoticeDTO> = {}): NoticeDTO {
  return {
    id, kind: 'result', text: 'The **payroll export** is done: ISO dates, 41 tests passing.', ref: { kind: 'session', id: FOCUS_AGENT },
    createdAt: iso(0), chatDueAt: iso(600_000), chatSentAt: null, settledAt: null, settledVia: null, ...over,
  };
}

/**
 * A socket that talks to the fake hub instead of a server: it says hello, forwards what the hub pushes, streams steps to
 * subscribed agents every few seconds and settles acknowledged notices. In `old` mode it sends none of the live-activity messages.
 */
export function createDemoWs(hub: FakeHub): (handlers: WsHandlers) => WsClient {
  return (handlers) => {
    let status: ReturnType<WsClient['status']> = 'idle';
    let steps: ReadonlySet<string> = new Set();
    let seen: readonly NoticeDTO[] = [];
    let tick = 0;
    let timers: ReadonlyArray<ReturnType<typeof setTimeout>> = [];
    const record = (frame: WsClientMessage): void => { sentFrames.push(frame); };
    const deliver = (message: WsServerMessage): void => {
      if (hub.old && message.type !== 'hello' && message.type !== 'session.updated' && message.type !== 'manager.message') return;
      if (message.type === 'notice.created' || message.type === 'notice.updated') seen = [...seen.filter((n) => n.id !== message.notice.id), message.notice];
      handlers.onMessage(message);
    };
    hub.onPush(deliver);

    const stream = (): void => {
      tick += 1;
      for (const id of steps) {
        if (id !== FOCUS_AGENT) continue;
        const index = 11 + Math.floor(tick / 2);
        const open = tick % 2 === 1;
        deliver({ type: 'steps.appended', sessionId: id, steps: [stepAt(index, open)], todos: null, helpers: null });
      }
    };

    return {
      start: () => {
        status = 'connecting';
        handlers.onStatus?.('connecting', { epoch: 0, attempt: 0 });
        const hello = setTimeout(() => {
          status = 'open';
          handlers.onMessage({ type: 'hello', now: iso(0) });
          handlers.onStatus?.('open', { epoch: 1, attempt: 0 });
        }, 200);
        timers = [hello, setInterval(stream, 3_000)];
      },
      stop: () => {
        status = 'stopped';
        timers.forEach((timer) => clearInterval(timer));
        timers = [];
      },
      reconnectNow: () => undefined,
      status: () => status,
      epoch: () => 1,
      subscribeTranscript: (sessionId) => {
        record({ type: 'subscribe.transcript', sessionId });
        return () => record({ type: 'unsubscribe.transcript', sessionId });
      },
      subscribeSteps: (sessionId) => {
        record({ type: 'subscribe.steps', sessionId });
        steps = new Set([...steps, sessionId]);
        return () => {
          record({ type: 'unsubscribe.steps', sessionId });
          steps = new Set([...steps].filter((id) => id !== sessionId));
        };
      },
      setVisible: (visible) => record({ type: 'presence.hello', visible }),
      touch: () => record({ type: 'presence.active' }),
      ackNotices: (ids) => {
        if (ids.length === 0) return;
        record({ type: 'notice.ack', ids: [...ids] });
        settleNotices(hub, () => seen, ids);
      },
      // The demo hub runs no host jobs, so it pushes nothing these follow.
      subscribeHost: (host) => {
        record({ type: 'subscribe.host', host });
        return () => record({ type: 'unsubscribe.host', host });
      },
      unsubscribeHost: (host) => record({ type: 'unsubscribe.host', host }),
      on: () => () => undefined,
    };
  };
}
