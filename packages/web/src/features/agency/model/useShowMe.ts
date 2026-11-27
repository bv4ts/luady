import { useCallback, useEffect, useRef, type Dispatch } from 'react';
import { showActions } from '../OpenModal.js';
import type { StageHandle, StageTarget } from '../stage-types.js';
import type { AgencyUiAction } from './ui-state.js';

/** How long Help's "Show me" keeps the outline on what it showed. */
export const SHOW_ME_MS = 4_000;
/** The outline starts once the camera has mostly arrived. */
export const SHOW_ME_DELAY_MS = 350;

/**
 * Help's "Show me": the pop-up closes, the camera goes to the fixture's room (or the character), and the stage
 * outlines it for a few seconds through its drop hint. Without a running stage only the camera part happens.
 */
export function useShowMe(stage: StageHandle | null, dispatch: Dispatch<AgencyUiAction>): (target: StageTarget) => void {
  const stageRef = useRef(stage);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  const clear = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);
  useEffect(() => () => {
    clear();
    stageRef.current?.setDropHint(null);
  }, [clear]);

  return useCallback((target: StageTarget) => {
    showActions(target).forEach(dispatch);
    clear();
    if (target.kind === 'actor') return;
    timers.current = [
      setTimeout(() => stageRef.current?.setDropHint(target), SHOW_ME_DELAY_MS),
      setTimeout(() => stageRef.current?.setDropHint(null), SHOW_ME_DELAY_MS + SHOW_ME_MS),
    ];
  }, [clear, dispatch]);
}
