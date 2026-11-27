import type { AgencySnapshot } from '@luady/office';
import { useEffect, useState } from 'react';
import type { Feed } from '../model/feed.js';
import { fixtureTip, type MapBadge } from '../model/map-labels.js';
import { luadyWords, stateWords } from '../model/words.js';
import { LUADY_ACTOR_ID, type StageEvent } from '../stage-types.js';
import { managerName } from '@luady/shared';

interface Hover {
  /** An actor id, or a fixture id when `fixture`. */
  readonly id: string;
  readonly fixture: boolean;
  readonly x: number;
  readonly y: number;
}

/** "name · state · project" for an agent, "Luady · ready" for Luady; null for an id that is not on the map. */
function tipText(snapshot: AgencySnapshot, id: string): string | null {
  if (id === LUADY_ACTOR_ID) return `${managerName()} · ${luadyWords(snapshot.luady.state)}`;
  const actor = snapshot.actors[id];
  if (actor === undefined) return null;
  return [actor.name, stateWords(actor.state), actor.project].filter((part): part is string => part !== null && part !== '').join(' · ');
}

const NO_BADGES: Readonly<Record<string, MapBadge>> = Object.freeze({});

/**
 * Desktop hover label: a character's name and state, or a fixture's name and badge ("Board · 5 to do, 1 needs you").
 * Hover events arrive through a feed so only this component re-renders while the mouse moves.
 */
export function HoverTip({ snapshot, feed, badges = NO_BADGES, suppressed = false }: {
  snapshot: AgencySnapshot; feed: Feed<StageEvent>; badges?: Readonly<Record<string, MapBadge>>; suppressed?: boolean;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => feed.subscribe((event) => {
    if (event.type !== 'hover') return;
    if (event.id !== null) setHover({ id: event.id, fixture: false, x: event.x, y: event.y });
    else if (event.fixture !== null) setHover({ id: event.fixture, fixture: true, x: event.x, y: event.y });
    else setHover(null);
  }), [feed]);

  const text = hover === null || suppressed ? null : hover.fixture ? fixtureTip(snapshot, badges, hover.id) : tipText(snapshot, hover.id);
  if (hover === null || text === null) return null;
  return (
    <div className="agency-tip" role="tooltip"
      style={{ transform: `translate3d(${Math.round(Math.max(8, hover.x + 14))}px, ${Math.round(Math.max(8, hover.y - 34))}px, 0px)` }}>
      {text}
    </div>
  );
}
