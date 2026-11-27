/**
 * When the pixel scenes may move: only while they are on screen, only while the tab is visible, and never for people
 * who asked their system for less motion (they get still frames instead).
 */

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Calls `listener` when the reduced-motion preference changes; returns a function that stops listening. */
export function watchReducedMotion(listener: (reduced: boolean) => void): () => void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = () => listener(query.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

export interface Loop {
  /** Draws one frame now, even when paused (after a change the visitor made). */
  poke(): void;
  stop(): void;
}

/**
 * Calls `frame(now)` on animation frames while `element` is at least partly on screen and the page is visible, at most
 * `fps` times a second. Off screen or in a hidden tab it does nothing at all.
 */
export function runWhileVisible(element: Element, frame: (now: number) => void, fps = 30): Loop {
  let onScreen = false;
  let pageVisible = document.visibilityState === 'visible';
  let handle = 0;
  let last = 0;
  let stopped = false;
  const gap = 1000 / fps - 2;

  const tick = (now: number) => {
    handle = 0;
    if (stopped || !onScreen || !pageVisible) return;
    if (now - last >= gap) {
      last = now;
      frame(now);
    }
    handle = requestAnimationFrame(tick);
  };
  const resume = () => {
    if (handle === 0 && !stopped && onScreen && pageVisible) handle = requestAnimationFrame(tick);
  };
  const observer = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    resume();
  }, { rootMargin: '64px' });
  observer.observe(element);
  const onVisibility = () => {
    pageVisible = document.visibilityState === 'visible';
    resume();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return {
    poke: () => frame(performance.now()),
    stop: () => {
      stopped = true;
      if (handle !== 0) cancelAnimationFrame(handle);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
