import type { ReactNode } from 'react';
import { LANE_NAMES, type LaneId } from './lanes.js';
import { managerName } from '@luady/shared';

const EMPTY: Readonly<Record<LaneId, string>> = Object.freeze({
  todo: `Nothing to do yet. Add a card or send ${managerName()} a task.`,
  running: 'Nothing is running. Pick cards in To do and press Run.',
  needs: 'Nothing needs you right now.',
  done: 'Finished cards stay here for two weeks.',
});

/** One lane on the cork: a painted plaque with its name and count, the cards, and what to do when it is empty. */
export function Lane({ id, count, active, action, footer, quiet = false, children }: {
  id: LaneId; count: number; active: boolean; action?: ReactNode; footer?: ReactNode; quiet?: boolean; children: ReactNode;
}) {
  const headId = `board-lane-${id}`;
  return (
    <section className={active ? 'board-lane board-lane--active' : 'board-lane'} data-lane={id} aria-labelledby={headId}>
      <header className="board-lane__head">
        <h3 id={headId} className="board-plaque">
          <span>{LANE_NAMES[id]}</span>
          <span className="board-plaque__count" aria-label={`${String(count)} cards`}>{count}</span>
        </h3>
        {action}
      </header>
      <div className="board-lane__cards">
        {children}
        {count === 0 && !quiet ? <p className="board-lane__empty">{EMPTY[id]}</p> : null}
      </div>
      {footer}
    </section>
  );
}
