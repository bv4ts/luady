import { LIMITS, type DelegateTo, managerName } from '@luady/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { OfficePortal } from '../OfficePortal.js';
import { teamStyle } from '../model/team-style.js';
import { GIVE_SEARCH_AFTER, filterGiveRooms, type GiveTarget, type GiveTargets } from './targets.js';

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled])';

/** Tab and Shift+Tab stay inside the picker. */
function trapTab(event: KeyboardEvent<HTMLElement>, root: HTMLElement): void {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  const first = nodes[0];
  const last = nodes.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function TargetRow({ target, busy, onChoose }: { target: GiveTarget; busy: boolean; onChoose: (to: DelegateTo) => void }) {
  return (
    <li>
      <button type="button" className="give-picker__target" style={teamStyle(target.palette)} disabled={busy || target.disabled}
        onClick={() => onChoose(target.to)} data-target={target.key}>
        <span className="give-picker__swatch" aria-hidden="true" />
        <span className="give-picker__words">
          <span className="give-picker__name" dir="auto">{target.title}</span>
          <span className="give-picker__detail" dir="auto">{target.detail}</span>
        </span>
      </button>
    </li>
  );
}

export interface GivePickerProps {
  readonly label: string;
  readonly targets: GiveTargets;
  readonly busy: boolean;
  readonly onChoose: (to: DelegateTo, note: string) => void;
  readonly onClose: () => void;
}

/**
 * "Give to…": everything a drag can do, by pressing. Luady's choice, a new session in any office, or one of
 * the live sessions by room. An optional note goes to Luady with the work.
 */
export function GivePicker({ label, targets, busy, onChoose, onClose }: GivePickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const searchable = targets.rooms.length > GIVE_SEARCH_AFTER;
  const rooms = searchable ? filterGiveRooms(targets.rooms, search) : targets.rooms;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('[data-target="auto"]')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Tab' && ref.current !== null) {
      trapTab(event, ref.current);
    }
  };

  const choose = (to: DelegateTo) => onChoose(to, note.trim());

  return (
    <OfficePortal>
      <div className="give-picker" data-testid="give-picker" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <div ref={ref} className="give-picker__sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
          <header className="give-picker__head">
            <h2 id={titleId} className="give-picker__title" dir="auto">Give {label} to…</h2>
            <button type="button" className="give-picker__close" onClick={onClose}>Cancel</button>
          </header>
          <div className="give-picker__body">
            <label className="give-picker__note">
              <span>Note for {managerName()} (optional)</span>
              <textarea value={note} maxLength={LIMITS.delegateNoteMax} rows={2} dir="auto"
                placeholder="Anything he should know, like the order or a deadline"
                onChange={(event) => setNote(event.target.value)} />
            </label>
            <ul className="give-picker__list">
              <TargetRow target={targets.auto} busy={busy} onChoose={choose} />
            </ul>
            {searchable ? (
              <label className="give-picker__search">
                <span>Find a server or session</span>
                <input type="search" value={search} dir="auto" placeholder="Server, room or session name" data-testid="give-search"
                  onChange={(event) => setSearch(event.target.value)} />
              </label>
            ) : null}
            {searchable && rooms.length === 0 ? <p className="give-picker__none" role="status">Nothing matches. Try another name.</p> : null}
            {rooms.map((room) => (
              <section key={room.server} className="give-picker__room" style={teamStyle(room.palette)} aria-label={room.name}>
                <h3 className="give-picker__room-name">{room.name}</h3>
                <ul className="give-picker__list">
                  <TargetRow target={room.newSession} busy={busy} onChoose={choose} />
                  {room.sessions.map((target) => <TargetRow key={target.key} target={target} busy={busy} onChoose={choose} />)}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>
    </OfficePortal>
  );
}
