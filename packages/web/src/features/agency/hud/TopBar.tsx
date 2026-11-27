import type { AgencySnapshot } from '@luady/office';
import type { Dispatch, ReactNode } from 'react';
import { Link } from 'react-router';
import { BrandMark } from '../../../ui/BrandMark.js';
import { Icon } from '../../../ui/Icon.js';
import type { AgencyUi, AgencyUiAction } from '../model/ui-state.js';
import { CLASSIC_PATH } from '../office-notice.js';
import { Clock } from './Clock.js';
import { NeedsBell } from './NeedsBell.js';
import { RoomChips } from './RoomChips.js';

/**
 * The office's top bar. `tools`: the pop-up buttons (Board, Notes, Library, Jira); `pill`: the activity pill;
 * `extras`: the live parts (notices, energy bar, updates pill), after the bell; each hides itself without data.
 * On a phone the brand, the pill and the bell share the first row; the tools and the room chips the second.
 */
export function TopBar({ snapshot, ui, dispatch, live, tools = null, pill = null, extras = null }: {
  snapshot: AgencySnapshot; ui: AgencyUi; dispatch: Dispatch<AgencyUiAction>; live: boolean;
  tools?: ReactNode; pill?: ReactNode; extras?: ReactNode;
}) {
  return (
    <header className="agency-top">
      <span className="agency-brand">
        <BrandMark size={28} />
        <span className="agency-brand__name">Luady</span>
        <span className={live ? 'dot dot--on' : 'dot'} role="img" aria-label={live ? 'Live' : 'Not connected'} />
      </span>
      <div className="agency-top__rooms">
        <RoomChips snapshot={snapshot} focus={ui.focus} dispatch={dispatch} />
      </div>
      {tools}
      {pill === null ? null : <div className="agency-top__pill">{pill}</div>}
      <div className="agency-top__end">
        <NeedsBell needs={snapshot.needs} dispatch={dispatch} />
        {extras}
        <Clock />
        <Link className="agency-classic" to={CLASSIC_PATH} data-testid="agency-classic-link" title="Classic view">
          <Icon name="inbox" />
          <span className="agency-classic__label">Classic view</span>
        </Link>
      </div>
    </header>
  );
}
