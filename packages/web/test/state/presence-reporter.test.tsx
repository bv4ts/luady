import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/api/context.js';
import { StoreProvider } from '../../src/state/store.js';
import { PresenceReporter, usePresenceReporter } from '../../src/state/usePresenceReporter.js';
import { overview } from '../fixtures.js';
import { fakeApi } from '../helpers/fake-api.js';
import { createFakeWs } from '../helpers/fake-ws.js';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function Reporter() {
  usePresenceReporter();
  return null;
}

function mount(ui = <Reporter />) {
  const ws = createFakeWs();
  const view = render(
    <ApiProvider api={fakeApi({ overview: async () => overview() })}>
      <StoreProvider createWs={ws.factory} onAuthLost={vi.fn()}>{ui}</StoreProvider>
    </ApiProvider>,
  );
  return { ws, view };
}

afterEach(() => {
  Reflect.deleteProperty(document, 'visibilityState');
  vi.restoreAllMocks();
});

describe('usePresenceReporter', () => {
  it('opening the page in a visible, focused tab counts as being there: one touch, right after the hello', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { ws } = mount();
    expect(ws.client.setVisible).toHaveBeenCalledWith(true);
    expect(ws.client.touch).toHaveBeenCalledTimes(1);
    expect(ws.client.setVisible.mock.invocationCallOrder[0]).toBeLessThan(ws.client.touch.mock.invocationCallOrder[0] ?? 0);
  });

  it('a visible tab without focus (a restored or background window) is not a touch on load', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { ws } = mount();
    expect(ws.client.setVisible).toHaveBeenCalledWith(true);
    expect(ws.client.touch).not.toHaveBeenCalled();
    fireEvent.pointerDown(window);
    expect(ws.client.touch).toHaveBeenCalledTimes(1);
  });

  it('the tab gaining focus later counts as a touch, with no other input', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { ws } = mount();
    fireEvent.focus(window);
    expect(ws.client.touch).toHaveBeenCalledTimes(1);
  });

  it('a reconnect is never a touch, and nothing comes from a timer', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const { ws } = mount();
      ws.client.touch.mockClear();
      act(() => {
        ws.setStatus('open', 1);
        ws.setStatus('reconnecting', 1);
        ws.setStatus('open', 2);
        vi.advanceTimersByTime(10 * 60_000);
      });
      expect(ws.client.touch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tab opened hidden says so and is not a touch', () => {
    setVisibility('hidden');
    const { ws } = mount();
    expect(ws.client.setVisible).toHaveBeenCalledWith(false);
    expect(ws.client.touch).not.toHaveBeenCalled();
  });

  it('follows visibility changes and real interaction', () => {
    const { ws } = mount(<PresenceReporter />);
    setVisibility('hidden');
    expect(ws.client.setVisible).toHaveBeenLastCalledWith(false);
    setVisibility('visible');
    expect(ws.client.setVisible).toHaveBeenLastCalledWith(true);
    ws.client.touch.mockClear();
    fireEvent.keyDown(window, { key: 'a' });
    fireEvent.pointerDown(window);
    fireEvent.wheel(window);
    fireEvent.touchStart(window);
    expect(ws.client.touch).toHaveBeenCalledTimes(4);
  });

  it('a hidden tab never touches, even on an event', () => {
    const { ws } = mount();
    setVisibility('hidden');
    ws.client.touch.mockClear();
    fireEvent.keyDown(window, { key: 'a' });
    expect(ws.client.touch).not.toHaveBeenCalled();
  });

  it('does nothing after unmount', () => {
    const { ws, view } = mount();
    view.unmount();
    ws.client.setVisible.mockClear();
    ws.client.touch.mockClear();
    setVisibility('hidden');
    fireEvent.keyDown(window, { key: 'a' });
    expect(ws.client.setVisible).not.toHaveBeenCalled();
    expect(ws.client.touch).not.toHaveBeenCalled();
  });
});
