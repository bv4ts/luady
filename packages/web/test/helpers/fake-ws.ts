import type { WsServerMessage } from '@luady/shared';
import { act } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import type { WsClient, WsHandlers, WsStatus } from '../../src/api/ws.js';

export interface FakeWs {
  readonly factory: (handlers: WsHandlers) => WsClient;
  readonly client: { [K in keyof WsClient]: Mock<WsClient[K]> };
  readonly subscriptions: Map<string, number>;
  /** Live `subscribeSteps` counts per session. */
  readonly stepSubscriptions: Map<string, number>;
  /** Live `subscribeHost` counts per host. */
  readonly hostSubscriptions: Map<string, number>;
  emit(message: WsServerMessage): void;
  setStatus(status: WsStatus, epoch: number): void;
  expire(): void;
}

/** A reference-counted subscribe that records live counts in `into`, like the real client. */
function counted(into: Map<string, number>) {
  return (sessionId: string): (() => void) => {
    into.set(sessionId, (into.get(sessionId) ?? 0) + 1);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const left = (into.get(sessionId) ?? 1) - 1;
      if (left > 0) into.set(sessionId, left);
      else into.delete(sessionId);
    };
  };
}

export function createFakeWs(): FakeWs {
  let handlers: WsHandlers | null = null;
  const subscriptions = new Map<string, number>();
  const stepSubscriptions = new Map<string, number>();
  const hostSubscriptions = new Map<string, number>();
  const hostReleases = new Map<string, Array<() => void>>();
  let listeners: Array<{ type: string; handler: (message: WsServerMessage) => void }> = [];
  const subscribeHost = (host: string): (() => void) => {
    const release = counted(hostSubscriptions)(host);
    hostReleases.set(host, [...(hostReleases.get(host) ?? []), release]);
    return release;
  };
  const client = {
    start: vi.fn<WsClient['start']>(),
    stop: vi.fn<WsClient['stop']>(),
    reconnectNow: vi.fn<WsClient['reconnectNow']>(),
    status: vi.fn<WsClient['status']>(() => 'open'),
    epoch: vi.fn<WsClient['epoch']>(() => 1),
    subscribeTranscript: vi.fn<WsClient['subscribeTranscript']>(counted(subscriptions)),
    subscribeSteps: vi.fn<WsClient['subscribeSteps']>(counted(stepSubscriptions)),
    setVisible: vi.fn<WsClient['setVisible']>(),
    touch: vi.fn<WsClient['touch']>(),
    ackNotices: vi.fn<WsClient['ackNotices']>(),
    subscribeHost: vi.fn<WsClient['subscribeHost']>(subscribeHost),
    unsubscribeHost: vi.fn<WsClient['unsubscribeHost']>((host) => {
      const [release, ...rest] = hostReleases.get(host) ?? [];
      hostReleases.set(host, rest);
      release?.();
    }),
    on: vi.fn<WsClient['on']>(((type: string, handler: (message: WsServerMessage) => void) => {
      const entry = { type, handler };
      listeners = [...listeners, entry];
      return () => {
        listeners = listeners.filter((one) => one !== entry);
      };
    }) as WsClient['on']),
  };
  const need = (): WsHandlers => {
    if (!handlers) throw new Error('FakeWs: the provider has not created its client');
    return handlers;
  };
  return {
    factory: (next) => {
      handlers = next;
      return client;
    },
    client,
    subscriptions,
    stepSubscriptions,
    hostSubscriptions,
    emit: (message) => {
      act(() => {
        need().onMessage(message);
        for (const listener of listeners) if (listener.type === message.type) listener.handler(message);
      });
    },
    setStatus: (status, epoch) => {
      act(() => {
        need().onStatus?.(status, { epoch, attempt: 0 });
      });
    },
    expire: () => {
      act(() => {
        need().onAuthExpired?.();
      });
    },
  };
}
