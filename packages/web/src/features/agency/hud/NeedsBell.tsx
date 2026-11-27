import type { Dispatch } from 'react';
import type { AgencyUiAction } from '../model/ui-state.js';

/** One red counter for everything waiting for the owner; each click shows the next one. */
export function NeedsBell({ needs, dispatch }: { needs: readonly string[]; dispatch: Dispatch<AgencyUiAction> }) {
  if (needs.length === 0) return null;
  const words = needs.length === 1 ? ' needs you' : ' need you';
  // On a phone only the number shows; the words stay for screen readers.
  return (
    <button type="button" className="agency-bell" title="Show the next one that needs you" aria-label={`${needs.length}${words}`}
      onClick={() => dispatch({ type: 'next-need', needs })}>{needs.length}<span className="agency-bell__words">{words}</span></button>
  );
}
