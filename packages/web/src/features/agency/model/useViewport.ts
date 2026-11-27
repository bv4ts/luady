import { useEffect, useState } from 'react';
import type { Viewport } from '../panels/insets.js';

const read = (): Viewport => ({ width: window.innerWidth, height: window.innerHeight });

/** The window size in CSS pixels; the same object until it really changes. */
export function useViewport(): Viewport {
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize((prev) => {
      const next = read();
      return prev.width === next.width && prev.height === next.height ? prev : next;
    });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** True while a media query matches; false where matchMedia is missing (old browsers, jsdom). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
