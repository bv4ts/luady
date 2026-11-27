import { byOldest } from '../../state/selectors.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Spinner } from '../../ui/Spinner.js';
import { ConfirmationCard } from './ConfirmationCard.js';
import { HealthStrip } from './HealthStrip.js';
import { PermissionCard } from './PermissionCard.js';
import { QuestionCard } from './QuestionCard.js';
import './inbox.css';
import { managerName } from '@luady/shared';

export function InboxPage() {
  const { state, refresh } = useStore();
  const questions = byOldest(state.questions);
  const confirmations = byOldest(state.actions);
  const total = questions.length + confirmations.length;
  const summary = !state.loaded ? 'Loading…' : total === 0 ? 'Nothing needs you right now.' : `${total} ${total === 1 ? 'item needs' : 'items need'} you`;

  return (
    <div className="page inbox">
      <header className="page-header">
        <div className="page-header__text">
          <h1>Inbox</h1>
          <p className="page-header__sub">{summary}</p>
        </div>
        <Button variant="ghost" size="sm" icon="restart" onClick={() => void refresh()}>Refresh</Button>
      </header>
      <HealthStrip servers={state.servers} />
      {!state.loaded ? <div className="page-loading"><Spinner size="lg" label="Loading the inbox" /></div> : null}
      {state.loaded && total === 0 ? (
        <EmptyState icon="check" title="All clear"
          body={`Questions, permission requests and confirmations from your sessions and ${managerName()} appear here the moment they happen.`} />
      ) : null}
      {questions.length > 0 ? (
        <section className="stack" aria-labelledby="inbox-questions">
          <h2 id="inbox-questions" className="section-title">Waiting for your answer</h2>
          {questions.map((q) => (q.kind === 'permission' ? <PermissionCard key={q.qid} question={q} /> : <QuestionCard key={q.qid} question={q} />))}
        </section>
      ) : null}
      {confirmations.length > 0 ? (
        <section className="stack" aria-labelledby="inbox-confirmations">
          <h2 id="inbox-confirmations" className="section-title">{managerName()} wants your OK</h2>
          {confirmations.map((action) => <ConfirmationCard key={action.id} action={action} />)}
        </section>
      ) : null}
    </div>
  );
}
