import type { Dispatch } from 'react';
import type { Badge } from '../model/hud-badges.js';
import type { AgencyUiAction, ModalKind, ModalState } from '../model/ui-state.js';
import { PixelIcon, type PixelIconName } from './PixelIcon.js';

interface ToolProps {
  readonly kind: ModalKind;
  readonly label: string;
  readonly icon: PixelIconName;
  readonly open: boolean;
  readonly onOpen: () => void;
  readonly badge?: Badge | null;
  readonly dot?: boolean;
  readonly dotWords?: string;
}

/** One top-bar button that opens a pop-up. Below laptop width it is its icon, with the name as a tooltip. */
function Tool({ kind, label, icon, open, onOpen, badge = null, dot = false, dotWords = '' }: ToolProps) {
  const extra = badge === null ? (dot ? `, ${dotWords}` : '') : `, ${badge.words}`;
  return (
    <button type="button" className="agency-tool" data-tool={kind} aria-pressed={open} aria-label={`${label}${extra}`} title={label}
      onClick={onOpen}>
      <PixelIcon name={icon} size={18} />
      <span className="agency-tool__label">{label}</span>
      {badge === null ? null : <span className={`agency-count agency-count--${badge.tone} agency-tool__badge`}>{badge.count}</span>}
      {badge === null && dot ? <span className="agency-tool__dot" aria-hidden="true" /> : null}
    </button>
  );
}

/**
 * Board (to do + needs you), Notes (a dot for new meeting notes), Library and Jira: the pop-ups that also open from
 * the fixtures on the map, here because small fixtures are hard to hit on a phone.
 */
export function HudTools({ modal, jiraRoom, board, newNotes, dispatch }: {
  /** The room the Jira button opens on; null while the office has no rooms (the pop-up then offers to add one). */
  modal: ModalState | null; jiraRoom: string | null; board: Badge | null; newNotes: number; dispatch: Dispatch<AgencyUiAction>;
}) {
  const open = (next: ModalState) => dispatch({ type: 'modal', modal: next });
  const is = (kind: ModalKind) => modal?.kind === kind;
  return (
    <div className="agency-tools" role="group" aria-label="Office tools">
      <Tool kind="board" label="Board" icon="board" open={is('board')} badge={board} onOpen={() => open({ kind: 'board' })} />
      <Tool kind="notes" label="Notes" icon="notes" open={is('notes')} dot={newNotes > 0} dotWords="new meeting notes"
        onOpen={() => open({ kind: 'notes' })} />
      <Tool kind="library" label="Library" icon="library" open={is('library')} onOpen={() => open({ kind: 'library' })} />
      <Tool kind="jira" label="Jira" icon="jira" open={is('jira')} onOpen={() => open(jiraRoom === null ? { kind: 'jira' } : { kind: 'jira', room: jiraRoom })} />
    </div>
  );
}
