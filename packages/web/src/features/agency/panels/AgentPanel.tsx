import { MUTE_PALETTE, type ActorView, type AgencySnapshot } from '@luady/office';
import type { SessionDTO } from '@luady/shared';
import { Link } from 'react-router';
import { questionFor } from '../../../state/selectors.js';
import { useStore } from '../../../state/store.js';
import { Banner } from '../../../ui/Banner.js';
import { Spinner } from '../../../ui/Spinner.js';
import { PermissionCard } from '../../inbox/PermissionCard.js';
import { QuestionCard } from '../../inbox/QuestionCard.js';
import { Composer } from '../../sessions/Composer.js';
import { SessionControls } from '../../sessions/SessionControls.js';
import { Transcript } from '../../sessions/Transcript.js';
import { useTranscript } from '../../sessions/useTranscript.js';
import { useCompact } from '../hud/useCompact.js';
import { useSessionDetail } from '../model/useSessionDetail.js';
import { stateWords } from '../model/words.js';
import { CurrentStep } from './agent/CurrentStep.js';
import { Helpers } from './agent/Helpers.js';
import { Meters } from './agent/Meters.js';
import { PlanList } from './agent/PlanList.js';
import { StepList } from './agent/StepList.js';
import { PanelHead } from './PanelHead.js';
import '../../inbox/inbox.css';
import '../../sessions/session-view.css';
import './agent/agent.css';

const STATE_CLASS: Readonly<Record<string, string>> = {
  working: 'agency-pill--work', waiting_question: 'agency-pill--ask', waiting_permission: 'agency-pill--ask',
  error: 'agency-pill--error', starting: 'agency-pill--start',
};

/** The header pill: "paused" while the owner holds a working or idle agent (a red state still shows as it is). */
function pillOf(session: SessionDTO, paused: boolean): { words: string; className: string } {
  if (paused && (session.state === 'working' || session.state === 'idle')) return { words: 'paused', className: 'agency-pill--paused' };
  return { words: stateWords(session.state), className: STATE_CLASS[session.state] ?? '' };
}

/** From 60% context in use: how full it is and "Compact now". */
function CompactOffer({ session }: { session: SessionDTO }) {
  const { offer, pct, compact } = useCompact(session);
  if (!offer) return null;
  return (
    <div className={pct !== null && pct >= 85 ? 'agency-compact agency-compact--red' : 'agency-compact'} data-testid="compact-offer">
      <p className="agency-compact__text">Context {pct}% full. Compacting frees room so the session can keep going.</p>
      <button type="button" className="btn btn--secondary agency-compact__btn" onClick={() => void compact()}>Compact now</button>
    </div>
  );
}

/** Mounted only while the panel is open, so the transcript subscription lives exactly that long. */
function AgentView({ session, actor }: { session: SessionDTO; actor: ActorView }) {
  const { state } = useStore();
  const transcript = useTranscript(session.id);
  const detail = useSessionDetail(session.id);
  const pending = questionFor(state.questions, session);
  const pill = pillOf(session, state.activity[session.id]?.paused === true);
  const disabledReason = session.state === 'ended'
    ? 'This session has ended.'
    : session.pendingQid ? 'Answer the pending question first.' : null;

  return (
    <>
      <PanelHead title={session.displayName} palette={actor.look.palette}>
        <span className={`agency-pill ${pill.className}`}>{pill.words}</span>
        <span dir="auto">{[session.project, `on ${session.host}`].filter(Boolean).join(' · ')}</span>
      </PanelHead>
      <div className="agency-panel__body agency-agent">
        {/* A waiting answer card comes first: on a phone sheet its buttons are in view without scrolling. */}
        {pending ? (
          <div className="agency-agent__pending">
            {pending.kind === 'permission' ? <PermissionCard question={pending} /> : <QuestionCard question={pending} />}
          </div>
        ) : null}
        <CurrentStep session={session} detail={detail} />
        <SessionControls session={session} />
        <CompactOffer session={session} />
        <Meters session={session} detail={detail} />
        <PlanList todos={detail?.todos ?? []} />
        <Helpers helpers={detail?.helpers ?? []} />
        <StepList steps={detail?.steps ?? []} />
        {transcript.error ? <Banner tone="error">{transcript.error}</Banner> : null}
        {transcript.loading ? (
          <div className="transcript transcript--loading"><Spinner size="lg" label="Loading the transcript" /></div>
        ) : (
          <Transcript items={transcript.items} hasOlder={transcript.hasOlder} loadingOlder={transcript.loadingOlder}
            onLoadOlder={transcript.loadOlder} />
        )}
        <Composer session={session} disabledReason={disabledReason} />
        <Link className="agency-panel__link" to={`/sessions/${encodeURIComponent(session.id)}`}>Open full page</Link>
      </div>
    </>
  );
}

/** One agent: its session view (question card, controls, transcript, message box) in the room's colours. */
export function AgentPanel({ snapshot, actorId }: { snapshot: AgencySnapshot; actorId: string }) {
  const { state } = useStore();
  const actor = snapshot.actors[actorId];
  const session = state.sessions.find((candidate) => candidate.id === actorId);
  if (actor === undefined || session === undefined) {
    return (
      <>
        <PanelHead title="Agent" palette={MUTE_PALETTE} />
        <div className="agency-panel__body"><p className="agency-panel__note">This agent has left the office.</p></div>
      </>
    );
  }
  return <AgentView key={session.id} session={session} actor={actor} />;
}
