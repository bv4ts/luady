import { describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createBus', () => {
  it('delivers a payload to every listener of that event only, in subscription order', () => {
    const bus = createBus();
    const seen: string[] = [];
    bus.on('session.removed', (p) => seen.push(`a:${p.id}`));
    bus.on('session.removed', (p) => seen.push(`b:${p.id}`));
    bus.on('manager.status', () => seen.push('wrong event'));
    bus.emit('session.removed', { id: 'cedar:cc-x:0.0' });
    expect(seen).toEqual(['a:cedar:cc-x:0.0', 'b:cedar:cc-x:0.0']);
  });

  it('keeps delivering when a listener throws and reports the error with the event name', () => {
    const errors: Array<{ err: unknown; event: string }> = [];
    const bus = createBus((err, event) => errors.push({ err, event }));
    const seen: string[] = [];
    bus.on('session.removed', () => {
      throw new Error('boom');
    });
    bus.on('session.removed', (p) => seen.push(p.id));
    bus.emit('session.removed', { id: 'cedar:cc-x:0.0' });
    expect(seen).toEqual(['cedar:cc-x:0.0']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toBe('session.removed');
    expect((errors[0]?.err as Error).message).toBe('boom');
  });

  it('reports a rejecting async listener to onError instead of leaving it unhandled', async () => {
    const errors: string[] = [];
    const bus = createBus((err, event) => errors.push(`${event}:${(err as Error).message}`));
    bus.on('session.removed', async () => {
      throw new Error('async boom');
    });
    bus.emit('session.removed', { id: 'cedar:cc-x:0.0' });
    await flush();
    expect(errors).toEqual(['session.removed:async boom']);
  });

  it('stops delivery after unsubscribe, and unsubscribing twice is harmless', () => {
    const bus = createBus();
    const seen: string[] = [];
    const off = bus.on('session.removed', (p) => seen.push(p.id));
    bus.emit('session.removed', { id: 'one' });
    off();
    off();
    bus.emit('session.removed', { id: 'two' });
    expect(seen).toEqual(['one']);
  });

  it('treats each registration separately when the same function is added twice', () => {
    const bus = createBus();
    const seen: string[] = [];
    const listener = (p: { id: string }): void => {
      seen.push(p.id);
    };
    const offFirst = bus.on('session.removed', listener);
    bus.on('session.removed', listener);
    bus.emit('session.removed', { id: 'x' });
    offFirst();
    bus.emit('session.removed', { id: 'y' });
    expect(seen).toEqual(['x', 'x', 'y']);
  });

  it('applies subscriptions changed during an emit from the next emit on', () => {
    const bus = createBus();
    const seen: string[] = [];
    let offB: () => void = () => undefined;
    bus.on('session.removed', (p) => {
      seen.push(`a:${p.id}`);
      offB();
      bus.on('session.removed', (q) => seen.push(`c:${q.id}`));
    });
    offB = bus.on('session.removed', (p) => seen.push(`b:${p.id}`));
    bus.emit('session.removed', { id: '1' });
    bus.emit('session.removed', { id: '2' });
    expect(seen).toEqual(['a:1', 'b:1', 'a:2', 'c:2']);
  });

  it('logs to console.error when no onError is given', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const bus = createBus();
      bus.on('session.removed', () => {
        throw new Error('unseen');
      });
      bus.emit('session.removed', { id: 'x' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]?.[0])).toContain('session.removed');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to console.error when onError itself throws, and still runs the other listeners', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const bus = createBus(() => {
        throw new Error('handler broke');
      });
      const seen: string[] = [];
      bus.on('session.removed', () => {
        throw new Error('listener broke');
      });
      bus.on('session.removed', (p) => seen.push(p.id));
      bus.emit('session.removed', { id: 'x' });
      expect(seen).toEqual(['x']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0]?.[1] as Error).message).toBe('handler broke');
      expect((spy.mock.calls[0]?.[2] as Error).message).toBe('listener broke');
    } finally {
      spy.mockRestore();
    }
  });
});
