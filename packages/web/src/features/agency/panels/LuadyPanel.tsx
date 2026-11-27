import { HQ_PALETTE, type AgencySnapshot } from '@luady/office';
import { managerName } from '@luady/shared';
import { Link } from 'react-router';
import { luadyWords } from '../model/words.js';
import { PanelHead } from './PanelHead.js';

/** Where the manager's switch is: Settings, General. */
export const MANAGER_SWITCH_LINK = '/settings';

function queueText(queued: number): string {
  if (queued === 0) return 'Nothing waiting';
  return queued === 1 ? '1 message waiting' : `${queued} messages waiting`;
}

/** Luady himself: how he is doing and how many messages wait for him; switched off, a calm line and the switch. */
export function LuadyPanel({ snapshot }: { snapshot: AgencySnapshot }) {
  const off = snapshot.luady.state === 'off';
  return (
    <>
      <PanelHead title={managerName()} palette={HQ_PALETTE}>Team leader</PanelHead>
      <div className="agency-panel__body">
        <dl className="kv agency-facts" aria-label={managerName()}>
          <dt>Status</dt>
          <dd>{luadyWords(snapshot.luady.state)}</dd>
          {off ? null : (
            <>
              <dt>Queue</dt>
              <dd>{queueText(snapshot.luady.queued)}</dd>
            </>
          )}
        </dl>
        {off ? (
          <p className="agency-panel__note">
            The manager is switched off. <Link to={MANAGER_SWITCH_LINK}>Turn it on in Settings</Link>
          </p>
        ) : <Link className="agency-panel__link" to="/manager">Open chat</Link>}
      </div>
    </>
  );
}
