import { useStore } from '../../../state/store.js';
import { activityCounts, pillWords } from '../model/activity-list.js';

/**
 * "● 7 working · 4 helpers", pulsing while anything works, grey "All quiet" otherwise. Opens the Activity
 * pop-up. On a narrow bar only the dot and the number of working sessions show.
 */
export function ActivityPill({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const { state } = useStore();
  const counts = activityCounts(state.sessions, state.activity);
  const words = pillWords(counts);
  const busy = counts.working > 0;
  return (
    <button type="button" className={busy ? 'agency-activity agency-activity--busy' : 'agency-activity'} data-testid="activity-pill"
      aria-pressed={open} aria-label={`${words}. Show activity`} title="What the agents are doing" onClick={onOpen}>
      <span className="agency-activity__dot" aria-hidden="true" />
      <span className="agency-activity__long">{words}</span>
      <span className="agency-activity__short" aria-hidden="true">{busy ? counts.working : 'Quiet'}</span>
    </button>
  );
}
