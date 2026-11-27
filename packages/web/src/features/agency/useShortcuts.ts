import { useEffect, useRef, type Dispatch, type RefObject } from 'react';
import type { AgencyUiAction } from './model/ui-state.js';

/**
 * What a key does on the office page; null for keys the office does not use. '/' is handled separately. 0 is the whole
 * office; 1-9 follow the map's order (slot 0, slot 1, HQ, then slots 2 to 7), so HQ is always 3 and the classic four
 * keep their keys. A key on an empty slot does nothing; rooms past the eighth are in the Rooms menu.
 */
export function shortcutAction(key: string, order: readonly string[], empty: ReadonlySet<string> = NO_EMPTY): AgencyUiAction | null {
  if (key === 'Escape') return { type: 'close' };
  if (key === '0') return { type: 'focus', focus: { kind: 'all' } };
  if (/^[1-9]$/.test(key)) {
    const room = order[Number(key) - 1];
    return room === undefined || empty.has(room) ? null : { type: 'focus', focus: { kind: 'room', room } };
  }
  return null;
}

const NO_EMPTY: ReadonlySet<string> = new Set();

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement;
}

/** A PIN prompt or another modal dialog owns the keyboard while it is open. */
const modalOpen = (): boolean => document.querySelector('[aria-modal="true"]') !== null;

/**
 * Esc closes, 1–9 jump to the rooms in map order, 0 shows the whole office, / goes to the chat line.
 * Ignored while typing, with a modifier key held, or while a modal dialog is open.
 */
export function useShortcuts(
  order: readonly string[], dispatch: Dispatch<AgencyUiAction>, chatRef: RefObject<HTMLInputElement | null>,
  empty: ReadonlySet<string> = NO_EMPTY,
): void {
  const orderRef = useRef({ order, empty });
  useEffect(() => {
    orderRef.current = { order, empty };
  }, [order, empty]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target) || modalOpen()) return;
      if (event.key === '/') {
        event.preventDefault();
        chatRef.current?.focus();
        return;
      }
      const action = shortcutAction(event.key, orderRef.current.order, orderRef.current.empty);
      if (action === null) return;
      event.preventDefault();
      dispatch(action);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [chatRef, dispatch]);
}
