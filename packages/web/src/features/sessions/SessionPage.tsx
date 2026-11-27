import type { SessionDTO } from '@luady/shared';
import { Link, useParams } from 'react-router';
import { decodeParam } from '../../lib/params.js';
import { questionFor } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { StateBadge } from '../../ui/Badge.js';
import { Banner } from '../../ui/Banner.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Icon } from '../../ui/Icon.js';
import { Spinner } from '../../ui/Spinner.js';
import { PermissionCard } from '../inbox/PermissionCard.js';
import { QuestionCard } from '../inbox/QuestionCard.js';
import { useRooms } from '../rooms/useRooms.js';
import { Composer } from './Composer.js';
import { SessionControls } from './SessionControls.js';
import { Transcript } from './Transcript.js';
import { useTranscript } from './useTranscript.js';
import '../inbox/inbox.css';
import './session-view.css';

function SessionView({ session }: { session: SessionDTO }) {
  const { state } = useStore();
  const { hostLabel } = useRooms();
  const transcript = useTranscript(session.id);
  const pending = questionFor(state.questions, session);
  const disabledReason = session.state === 'ended'
    ? 'This session has ended.'
    : session.pendingQid ? 'Answer the pending question first.' : null;

  return (
    <div className="session-view">
      <header className="session-view__head">
        <Link to="/sessions" className="btn btn--ghost btn--icon btn--sm" aria-label="Back to sessions"><Icon name="back" /></Link>
        <div className="session-view__title">
          <h1 dir="auto">{session.displayName}</h1>
          <p className="mono text-subtle">{hostLabel(session.host)} · {session.cwd ?? session.target}</p>
        </div>
        <StateBadge state={session.state} />
      </header>
      <SessionControls session={session} />
      {pending ? (
        <div className="session-view__pending">
          {pending.kind === 'permission' ? <PermissionCard question={pending} /> : <QuestionCard question={pending} />}
        </div>
      ) : null}
      {transcript.error ? <Banner tone="error">{transcript.error}</Banner> : null}
      {transcript.loading ? (
        <div className="transcript transcript--loading"><Spinner size="lg" label="Loading the transcript" /></div>
      ) : (
        <Transcript items={transcript.items} hasOlder={transcript.hasOlder} loadingOlder={transcript.loadingOlder}
          onLoadOlder={transcript.loadOlder} />
      )}
      <Composer session={session} disabledReason={disabledReason} />
    </div>
  );
}

export function SessionPage() {
  const { id = '' } = useParams();
  const sessionId = decodeParam(id);
  const { state } = useStore();
  const session = state.sessions.find((candidate) => candidate.id === sessionId);

  if (!state.loaded) return <div className="page page-loading"><Spinner size="lg" label="Loading the session" /></div>;
  if (!session) {
    return (
      <div className="page">
        <EmptyState icon="sessions" title="Session not found" body="It may have ended and been removed."
          action={<Link className="btn btn--secondary" to="/sessions">All sessions</Link>} />
      </div>
    );
  }
  return <SessionView key={session.id} session={session} />;
}
