import type { OfficeMap } from '@luady/office';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StageView } from '../stage-types.js';
import { NO_VIEW, nextLabelView, type LabelView } from './view-rooms.js';

/**
 * What the HUD labels (model/view-rooms.ts), following the stage's `onView`. The stage reports every frame while the
 * view moves; React re-renders only when the set of labelled rooms changes, never per frame.
 */
export function useLabelView(map: OfficeMap): { readonly view: LabelView; readonly onView: (view: StageView) => void } {
  const [labels, setLabels] = useState<LabelView>(NO_VIEW);
  const last = useRef<StageView | null>(null);
  const mapRef = useRef(map);
  const onView = useCallback((view: StageView) => {
    last.current = view;
    setLabels((previous) => nextLabelView(previous, mapRef.current, view));
  }, []);
  useEffect(() => {
    // A new map (rooms added, moved or removed) relabels the last view at once.
    mapRef.current = map;
    setLabels((previous) => nextLabelView(previous, map, last.current));
  }, [map]);
  return { view: labels, onView };
}
