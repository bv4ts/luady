import { managerName } from '@luady/shared';
import { Link } from 'react-router';
import { useStore } from '../../state/store.js';

/** Where the manager's switch lives (the General section of Settings). */
export const MANAGER_SWITCH_PATH = '/settings';

/**
 * True while the manager is switched off: a calm, normal state (a new install starts that way), never an
 * alarm. Messages to him are refused then (409 `manager_off`), so the chat inputs say so instead of sending.
 */
export function useManagerOff(): boolean {
  return useStore().state.luady?.state === 'off';
}

/** "<name> is off. Turn it on in Settings." with the link to the switch. */
export function ManagerOffHint({ className }: { className?: string }) {
  return (
    <p className={className} role="status" data-testid="manager-off">
      {managerName()} is off. <Link to={MANAGER_SWITCH_PATH}>Turn it on in Settings</Link>.
    </p>
  );
}
