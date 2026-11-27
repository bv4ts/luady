import { useEffect, useRef } from 'react';
import { useStore } from './store.js';

/** The events that prove the owner is at this tab. Visibility alone never counts as a touch. */
const TOUCH_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

const isVisible = (): boolean => document.visibilityState === 'visible';

/**
 * Tells the hub, truthfully, whether the owner is here: the tab's visibility on mount and on every change,
 * and a touch for each real pointer, key, wheel or touch event in a visible tab, and for the window gaining focus.
 * Opening the page counts once when the tab is visible and focused ("the website is on"); a restored or background
 * tab is neither. The socket client sends that touch right after its first hello, throttles touches to one a minute
 * and resends only the visibility after a reconnect. Never from a timer.
 */
export function usePresenceReporter(): void {
  const { live } = useStore();
  const opened = useRef(false);
  useEffect(() => {
    const report = (): void => live.setVisible(isVisible());
    const touch = (): void => {
      if (isVisible()) live.touch();
    };
    report();
    if (!opened.current && isVisible() && document.hasFocus()) live.touch();
    opened.current = true;
    document.addEventListener('visibilitychange', report);
    // Not captured: only the window's own focus (the owner came back to it), never an element the page focused.
    window.addEventListener('focus', touch);
    for (const name of TOUCH_EVENTS) window.addEventListener(name, touch, { passive: true, capture: true });
    return () => {
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', touch);
      for (const name of TOUCH_EVENTS) window.removeEventListener(name, touch, { capture: true });
    };
  }, [live]);
}

/** Mounted once inside the store, so the classic pages count as presence too. */
export function PresenceReporter(): null {
  usePresenceReporter();
  return null;
}
