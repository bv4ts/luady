import { MUTE_PALETTE } from '@luady/office';
import { managerName, ownerFormat, type OfficeRef, type RecapDTO, type RecapLine } from '@luady/shared';
import { useState, type SyntheticEvent } from 'react';
import { BrandMark } from '../../../ui/BrandMark.js';
import { useRooms } from '../../rooms/useRooms.js';
import { ownerDaysBetween } from '../drawers/board/when.js';
import { recapCounts, recapSections, type RecapSection } from '../model/last-here.js';
import { teamStyle } from '../model/team-style.js';
import { formatClock } from './Clock.js';
import './welcome-back.css';

/** A section shows this many lines until "Show all". */
export const RECAP_LINES_SHOWN = 4;
/** "Nov 12" in the owner's zone. */
const RECAP_DAY = ownerFormat('en-US', { month: 'short', day: 'numeric' });

const keepInside = (event: SyntheticEvent) => event.stopPropagation();

/** "2:10 PM", or "Yesterday, 6:40 PM", or "Nov 12, 6:40 PM" (owner time, by the owner's calendar days). */
export function sinceWords(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const days = ownerDaysBetween(now, at);
  if (days <= 0) return formatClock(at);
  if (days === 1) return `Yesterday, ${formatClock(at)}`;
  const date = RECAP_DAY.format(at);
  return `${date}, ${formatClock(at)}`;
}

function Line({ line, onOpen }: { line: RecapLine; onOpen: (ref: OfficeRef) => void }) {
  const { roomPalette } = useRooms();
  const palette = line.server === null ? MUTE_PALETTE : roomPalette(line.server);
  const body = (
    <>
      <span className="welcome__dot" aria-hidden="true" />
      <span className="welcome__text" dir="auto">{line.text}</span>
      <time className="welcome__time" dateTime={line.at}>{sinceWords(line.at, Date.now())}</time>
    </>
  );
  const ref = line.ref;
  return (
    <li style={teamStyle(palette)}>
      {ref === null ? <span className="welcome__line">{body}</span> : (
        <button type="button" className="welcome__line welcome__line--open" onClick={() => onOpen(ref)}>{body}</button>
      )}
    </li>
  );
}

function Section({ section, onOpen }: { section: RecapSection; onOpen: (ref: OfficeRef) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? section.lines : section.lines.slice(0, RECAP_LINES_SHOWN);
  const more = section.lines.length - shown.length;
  return (
    <section className={`welcome__section welcome__section--${section.key}`} aria-label={section.title}>
      <h3 className="welcome__title">{section.title}</h3>
      <ul className="welcome__lines">
        {shown.map((line, index) => <Line key={`${line.at}:${index}`} line={line} onOpen={onOpen} />)}
      </ul>
      {more > 0 ? <button type="button" className="welcome__more" onClick={() => setAll(true)}>Show {more} more</button> : null}
    </section>
  );
}

/**
 * Luady's welcome-back card: what needs the owner, what went wrong, what finished and the new meeting
 * notes since they were last here, and the counts. Each line opens its thing; "Got it" closes the card. It takes no
 * focus (the chat line keeps it) and the page hides it while a pop-up is open.
 */
export function WelcomeBack({ recap, onOpen, onClose }: { recap: RecapDTO; onOpen: (ref: OfficeRef) => void; onClose: () => void }) {
  const sections = recapSections(recap);
  const counts = recapCounts(recap);
  return (
    <aside className="welcome" role="region" aria-label="Welcome back" data-testid="welcome-back"
      onPointerDown={keepInside} onPointerUp={keepInside} onWheel={keepInside} onTouchStart={keepInside} onTouchEnd={keepInside}>
      <header className="welcome__head">
        <BrandMark size={26} />
        <p className="welcome__hello">
          <span className="welcome__name">Welcome back</span>
          <span className="welcome__since">Since {sinceWords(recap.since, Date.now())}, from {managerName()}</span>
        </p>
      </header>
      <div className="welcome__body">
        {sections.map((section) => <Section key={section.key} section={section} onOpen={onOpen} />)}
        {counts === '' ? null : <p className="welcome__counts">{counts}</p>}
      </div>
      <footer className="welcome__foot">
        <button type="button" className="welcome__ok" onClick={onClose}>Got it</button>
      </footer>
    </aside>
  );
}
