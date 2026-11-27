import { buildSnapshot, type AgencySnapshot, type SeatMap, type SnapshotInput } from '@luady/office';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '../../../state/reducer.js';
import { pausedOf, toolsOf } from '../../../state/selectors.js';
import { useStore } from '../../../state/store.js';
import { sameData } from './same-data.js';
import { deviceStorage, loadSeats, saveSeats } from './seat-store.js';
import { contextOf, helpersOf, stepTimesOf } from './step-times.js';

/** The snapshot input with the rooms whose wall shows a Jira board (`SnapshotInput.jiraRooms`: Jira sites are keyed by room). */
export type AgencySnapshotInput = SnapshotInput;

export function snapshotInput(base: SnapshotInput, jiraRooms: readonly string[]): AgencySnapshotInput {
  return { ...base, jiraRooms };
}

const NO_JIRA: readonly string[] = Object.freeze([]);

/** How often the office re-reads the clock (idle agents doze off, silent ones get a "?"). */
export const SNAPSHOT_CLOCK_MS = 30_000;

function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(timer);
  }, [periodMs]);
  return now;
}

/** The previous value while the new one is structurally equal, so memoised consumers do not re-render. */
function useStableData<T>(value: T): T {
  const ref = useRef(value);
  const stable = sameData(ref.current, value) ? ref.current : value;
  useEffect(() => {
    ref.current = stable;
  }, [stable]);
  return stable;
}

function savedSeats(): SeatMap {
  const storage = deviceStorage();
  return storage === null ? {} : loadSeats(storage);
}

/** Bubbles, pause icons, step times, helpers and context use from the live activity slice; new objects only when it changes. */
function useLiveInputs(activity: AppState['activity']) {
  return useMemo(
    () => ({
      tools: toolsOf(activity), paused: pausedOf(activity), stepTimes: stepTimesOf(activity),
      helpers: helpersOf(activity), contextPct: contextOf(activity),
    }),
    [activity],
  );
}

/**
 * The office as data: rebuilt from the store when hub data or the clock changes, the same object otherwise.
 * `jiraRooms`: the rooms with a Jira board on their wall (drawers/jira/useJiraSites.ts).
 */
export function useAgencySnapshot(jiraRooms: readonly string[] = NO_JIRA): AgencySnapshot {
  const { loaded, servers, sessions, questions, luady, activity, rooms } = useStore().state;
  const now = useNow(SNAPSHOT_CLOCK_MS);
  const live = useLiveInputs(activity);
  // Desk numbers are fed back into the next build so nobody changes desks when others come and go.
  const [seats, setSeats] = useState<SeatMap>(savedSeats);
  // The rooms lay out the map; the stage is given the same list (stage-types.ts `rooms`).
  const built = useMemo(
    () => buildSnapshot(snapshotInput({ servers, rooms, sessions, questions, luady, now, previousSeats: seats, ...live }, jiraRooms)),
    [servers, rooms, sessions, questions, luady, now, seats, live, jiraRooms],
  );
  const snapshot = useStableData(built);

  useEffect(() => {
    // Before the first overview there are no sessions yet; remembering that would wipe the saved desks.
    if (!loaded || sameData(snapshot.seats, seats)) return;
    setSeats(snapshot.seats);
    const storage = deviceStorage();
    if (storage !== null) saveSeats(storage, snapshot.seats);
  }, [loaded, snapshot.seats, seats]);
  return snapshot;
}
