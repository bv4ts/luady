import { useEffect, type Dispatch } from 'react';
import type { AgencyUiAction } from '../model/ui-state.js';

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement);

/** "?" opens Help (the robot's page), like the robot in HQ; not while typing or while a modal dialog is open. */
export function useHelpKey(dispatch: Dispatch<AgencyUiAction>): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '?' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      dispatch({ type: 'modal', modal: { kind: 'help' } });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dispatch]);
}
