import { LIMITS, type WinDTO } from '@luady/shared';
import { useCallback, type CSSProperties } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError } from '../../../../api/errors.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { useOfficeNav } from '../../give/GiveContext.js';
import { teamStyle } from '../../model/team-style.js';
import { useLoaded } from '../library/useLoaded.js';
import { clockText } from '../schedule/owner-time.js';
import { linkLabel, officeCounts, tiltOf, weekLine, winsByDay } from './wins-model.js';
import '../../hud/kit.css';
import './wins.css';

export interface WinsModalProps {
  readonly onClose: () => void;
}

/** The wins wall: what shipped in the last 7 days as photos pinned to a board. No points, no ranking. */
export function WinsModal(_props: WinsModalProps) {
  const api = useApi();
  const lookup = useRooms();
  const loaded = useLoaded(useCallback(() => api.wins(LIMITS.winsDaysDefault), [api]), 'wins');
  const now = Date.now();

  if (loaded.state.kind === 'loading') return <div className="wins" data-testid="wins-modal"><p className="wins__note" role="status">Pinning up the week…</p></div>;
  if (loaded.state.kind === 'failed') {
    const old = isApiError(loaded.state.error) && (loaded.state.error.status === 404 || loaded.state.error.status === 501);
    return (
      <div className="wins" data-testid="wins-modal">
        <p className="wins__note" role="alert">{old ? 'The wins wall needs the next hub update.' : 'The wins could not load.'}</p>
        {old ? null : <button type="button" className="btn btn--secondary btn--sm" onClick={loaded.reload}>Try again</button>}
      </div>
    );
  }
  const { items, byServer } = loaded.state.value;
  const days = winsByDay(items, now);
  return (
    <div className="wins" data-testid="wins-modal">
      <header className="wins__head">
        <h3 className="agency-title">{weekLine(items.length)}</h3>
        <ul className="wins__offices" aria-label="This week per office">
          {officeCounts(byServer, lookup).map((office) => (
            <li key={office.server} className="agency-tag" style={teamStyle(office.palette)}>{office.name} · {office.count}</li>
          ))}
        </ul>
      </header>
      {days.length === 0 ? (
        <div className="agency-empty">
          <p className="agency-empty__title">The wall is empty</p>
          <p className="agency-empty__body">Cards marked done show up here as photos for a week. Run a card from the board to get the first one.</p>
        </div>
      ) : days.map((day) => (
        <section key={day.key} className="wins__day" aria-label={day.label}>
          <h4 className="wins__day-name agency-pixel">{day.label}</h4>
          <ul className="wins__photos">
            {day.items.map((item) => <li key={item.id}><Photo win={item} /></li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Photo({ win }: { win: WinDTO }) {
  const nav = useOfficeNav();
  const lookup = useRooms();
  const room = win.server === null ? null : { short: lookup.room(win.server)?.short ?? lookup.hostLabel(win.server), name: lookup.hostLabel(win.server) };
  const style = { ...(win.server === null ? {} : teamStyle(lookup.roomPalette(win.server))), '--tilt': `${String(tiltOf(win.id))}deg` };
  const picture = (
    <>
      <span className="wins-photo__picture" aria-hidden="true">
        <span className="wins-photo__place agency-pixel">{win.project ?? room?.short ?? 'Done'}</span>
        <span className="wins-photo__check">✓</span>
      </span>
      <span className="wins-photo__title" dir="auto">{win.title}</span>
    </>
  );
  return (
    <article className="wins-photo agency-paper" style={style as CSSProperties} aria-label={win.title}>
      <span className="wins-photo__tape" aria-hidden="true" />
      {nav === null ? <div className="wins-photo__open">{picture}</div> : (
        <button type="button" className="wins-photo__open" onClick={() => nav.openModal({ kind: 'board', itemId: win.id })}>{picture}</button>
      )}
      {win.result === null ? null : <p className="wins-photo__result" dir="auto">{win.result}</p>}
      <p className="wins-photo__when">{room?.name ?? 'No office'} · {clockText(Date.parse(win.doneAt))}</p>
      {win.links.length === 0 ? null : (
        <ul className="wins-photo__links">
          {win.links.map((url) => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{linkLabel(url)}</a></li>)}
        </ul>
      )}
    </article>
  );
}
