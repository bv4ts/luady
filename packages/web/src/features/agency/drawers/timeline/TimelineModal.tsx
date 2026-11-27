import type { TimelineItem } from '@luady/shared';
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { useRooms, type RoomLookup } from '../../../rooms/useRooms.js';
import { useOfficeNav, type OfficeNav } from '../../give/GiveContext.js';
import { teamStyle } from '../../model/team-style.js';
import { useLoaded } from '../library/useLoaded.js';
import { clockText } from '../schedule/owner-time.js';
import { KIND_LOOK, STRIP_ROWS, dayChoices, hourTicks, placeMarks, refTarget, rowText, stripRange, type RefTarget, type Shape } from './timeline-model.js';
import '../../hud/kit.css';
import './timeline.css';

export interface TimelineModalProps {
  readonly onClose: () => void;
}

const MINUTE_MS = 60_000;

/** The shape of a kind of event, drawn in the office colour (`currentColor`). */
export function ShapeGlyph({ shape }: { shape: Shape }) {
  const common = { fill: 'currentColor', stroke: 'var(--agency-ink-dark)', strokeWidth: 1.5 };
  return (
    <svg className="today-shape" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      {shape === 'circle' ? <circle cx="8" cy="8" r="6" {...common} /> : null}
      {shape === 'ring' ? <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="3" /> : null}
      {shape === 'square' ? <rect x="2.5" y="2.5" width="11" height="11" {...common} /> : null}
      {shape === 'diamond' ? <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" {...common} /> : null}
      {shape === 'up' ? <path d="M8 2 14.5 14H1.5Z" {...common} /> : null}
      {shape === 'down' ? <path d="M1.5 2h13L8 14Z" {...common} /> : null}
      {shape === 'bar' ? <rect x="5" y="1.5" width="6" height="13" {...common} /> : null}
      {shape === 'star' ? <path d="M8 1 10 6h5l-4 3.2L12.5 15 8 11.8 3.5 15 5 9.2 1 6h5Z" {...common} /> : null}
    </svg>
  );
}

function open(target: RefTarget, nav: OfficeNav | null): (() => void) | null {
  if (target === null || nav === null) return null;
  return target.kind === 'agent' ? () => nav.openAgent(target.sessionId) : () => nav.openModal(target.modal);
}

const itemStyle = (item: TimelineItem, lookup: RoomLookup): CSSProperties | undefined =>
  item.server === null ? undefined : teamStyle(lookup.roomPalette(item.server));

/** An item's office in a tag: its room's short name, else the host as the owner knows it. */
const itemTag = (server: string, lookup: RoomLookup): string => lookup.room(server)?.short ?? lookup.hostLabel(server);

/** The today strip: the day as a clock face unrolled from 6 AM to now, and the same events in words. */
export function TimelineModal(_props: TimelineModalProps) {
  const api = useApi();
  const { state } = useStore();
  const nav = useOfficeNav();
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const choices = dayChoices(now);
  const [day, setDay] = useState(choices.today);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      setTick((n) => n + 1);
    }, MINUTE_MS);
    return () => clearInterval(timer);
  }, []);
  const loaded = useLoaded(useCallback(() => api.timeline(day), [api, day]), day, day === choices.today ? tick : 0);

  return (
    <div className="today" data-testid="timeline-modal">
      <div className="today__days" role="group" aria-label="Which day">
        <button type="button" className="today__day" aria-pressed={day === choices.yesterday} onClick={() => setDay(choices.yesterday)}>Yesterday</button>
        <button type="button" className="today__day" aria-pressed={day === choices.today} onClick={() => setDay(choices.today)}>Today</button>
      </div>
      {loaded.state.kind === 'loading' ? <p className="today__note" role="status">Winding the clock…</p> : null}
      {loaded.state.kind === 'failed' ? (
        <p className="today__note" role="alert">
          {isApiError(loaded.state.error) && (loaded.state.error.status === 404 || loaded.state.error.status === 501)
            ? 'The today strip needs the next hub update.' : 'The day could not load.'}
        </p>
      ) : null}
      {loaded.state.kind === 'ready' ? (
        <Day items={loaded.state.value.items} day={day} now={now} isToday={day === choices.today}
          openOf={(item) => open(refTarget(item.ref, state.questions), nav)} />
      ) : null}
    </div>
  );
}

function Day({ items, day, now, isToday, openOf }: {
  items: readonly TimelineItem[]; day: string; now: number; isToday: boolean; openOf: (item: TimelineItem) => (() => void) | null;
}) {
  const lookup = useRooms();
  const range = stripRange(day, items, now);
  const marks = placeMarks(items, range);
  return (
    <>
      <div className="today__strip" role="group" aria-label={`The day from ${clockText(range.from)} to ${isToday ? 'now' : 'midnight'}`}>
        <div className="today__face">
          {hourTicks(range).map((tick) => (
            <span key={tick.label} className="today__tick" style={{ insetInlineStart: `${String(tick.at * 100)}%` }}>
              <span className="today__hour">{tick.label}</span>
            </span>
          ))}
          {marks.map(({ item, x, row }, index) => {
            const onOpen = openOf(item);
            const style = { ...itemStyle(item, lookup), insetInlineStart: `${String(x * 100)}%`, insetBlockStart: `${String(18 + row * (64 / STRIP_ROWS))}px` };
            const glyph = <ShapeGlyph shape={KIND_LOOK[item.kind].shape} />;
            return onOpen === null
              ? <span key={`${item.at}-${String(index)}`} className="today__mark" style={style} title={rowText(item)}>{glyph}</span>
              : <button key={`${item.at}-${String(index)}`} type="button" className="today__mark" style={style} title={rowText(item)} aria-label={rowText(item)} onClick={onOpen}>{glyph}</button>;
          })}
          {isToday ? <span className="today__now" aria-hidden="true"><span>now</span></span> : null}
        </div>
      </div>
      <ul className="today__legend" aria-label="What the shapes mean">
        {Object.entries(KIND_LOOK).map(([kind, look]) => <li key={kind}><ShapeGlyph shape={look.shape} /> {look.words}</li>)}
      </ul>
      {items.length === 0 ? (
        <div className="agency-empty">
          <p className="agency-empty__title">{isToday ? 'A quiet day so far' : 'Nothing happened that day'}</p>
          <p className="agency-empty__body">{isToday ? 'Sessions starting and finishing, questions and meetings show up here as they happen.' : 'Pick Today to see what is going on now.'}</p>
        </div>
      ) : (
        <ol className="today__list agency-scroll">
          {items.toReversed().map((item, index) => {
            const onOpen = openOf(item);
            const body = (
              <>
                <span className="today__time">{clockText(Date.parse(item.at))}</span>
                <span className="today__glyph" style={itemStyle(item, lookup)}><ShapeGlyph shape={KIND_LOOK[item.kind].shape} /></span>
                <span className="today__kind">{KIND_LOOK[item.kind].words}</span>
                <span className="today__label" dir="auto">{item.label}</span>
                {item.server === null ? null : <span className="agency-tag" style={itemStyle(item, lookup)}>{itemTag(item.server, lookup)}</span>}
              </>
            );
            return (
              <li key={`${item.at}-${String(index)}`}>
                {onOpen === null ? <div className="today__row">{body}</div> : <button type="button" className="today__row" onClick={onOpen}>{body}</button>}
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
