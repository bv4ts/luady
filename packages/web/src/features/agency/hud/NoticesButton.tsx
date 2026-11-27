import { useStore } from '../../../state/store.js';
import { openNotices } from '../../../state/selectors.js';
import { Icon } from '../../../ui/Icon.js';

/** Opens the notices list, with the number still open. Hidden while there is none at all (or the hub has none). */
export function NoticesButton({ onOpen }: { onOpen: () => void }) {
  const { state } = useStore();
  if (state.notices.length === 0) return null;
  const count = openNotices(state.notices).length;
  const label = count === 0 ? 'Notices' : count === 1 ? 'Notices, 1 new' : `Notices, ${count} new`;
  return (
    <button type="button" className="agency-notices" data-testid="notices-button" aria-label={label} title="Notices" onClick={onOpen}>
      <Icon name="bell" />
      {count === 0 ? null : <span className="agency-notices__count">{count}</span>}
    </button>
  );
}
