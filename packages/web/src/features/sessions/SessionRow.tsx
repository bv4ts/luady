import type { SessionDTO } from '@luady/shared';
import { Link } from 'react-router';
import { timeAgo } from '../../lib/format.js';
import { needsYou } from '../../state/selectors.js';
import { StateBadge } from '../../ui/Badge.js';
import { Icon } from '../../ui/Icon.js';

export function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

export function SessionRow({ session }: { session: SessionDTO }) {
  return (
    <li>
      <Link to={sessionPath(session.id)} className={needsYou(session) ? 'session-row session-row--urgent' : 'session-row'}
        data-testid="session-link" data-session-id={session.id}>
        <span className="session-row__main">
          <span className="session-row__name" dir="auto">{session.displayName}</span>
          <span className="session-row__path mono">{session.cwd ?? session.target}</span>
          <span className="session-row__chips">
            {session.origin === 'manager' ? <span className="chip">mission</span> : null}
            {session.unexpectedEnd ? <span className="chip">ended unexpectedly</span> : null}
            {!session.registered ? <span className="chip">not registered</span> : null}
          </span>
        </span>
        <span className="session-row__side">
          <StateBadge state={session.state} />
          <span className="text-subtle">{timeAgo(session.lastEventAt)}</span>
        </span>
        <Icon name="chevron" className="session-row__chevron" />
      </Link>
    </li>
  );
}
