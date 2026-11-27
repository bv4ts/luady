import type { JiraBoardDTO, JiraSiteDTO, JiraView } from '@luady/shared';
import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { useStore } from '../../../../state/store.js';
import { Icon } from '../../../../ui/Icon.js';
import { formatClock } from '../../hud/Clock.js';
import { whenText } from '../account-text.js';
import { useLoaded } from '../library/useLoaded.js';
import { boardColumns, boardSummary, fellBack, jiraErrorText, notConnected, signInRefused, VIEW_LABELS, VIEWS } from './jira-model.js';
import { TicketCard } from './TicketCard.js';
import { TicketDetail } from './TicketDetail.js';

export interface JiraBoardProps {
  readonly server: string;
  readonly site: JiraSiteDTO;
  readonly issueKey?: string;
  /** The hub answered `jira_not_connected`: the connection is gone. */
  readonly onNotConnected: () => void;
  readonly onReconnect: () => void;
}

/** The board: three views, status columns, the sprint, Refresh and the time of the last fetch. */
export function JiraBoard({ server, site, issueKey, onNotConnected, onReconnect }: JiraBoardProps) {
  const api = useApi();
  const version = useStore().state.jiraVersion;
  const [view, setView] = useState<JiraView>('sprint');
  const [open, setOpen] = useState<string | null>(issueKey ?? null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const board = useLoaded(useCallback(() => api.jiraBoard(server, view), [api, server, view]), `${server}\n${view}`, version);

  const failed = board.state.kind === 'failed' ? board.state.error : null;
  useEffect(() => {
    if (failed !== null && notConnected(failed)) onNotConnected();
  }, [failed, onNotConnected]);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      board.set(await api.jiraBoard(server, view, true));
    } catch (err) {
      if (notConnected(err)) onNotConnected();
      else setRefreshError(jiraErrorText(err));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className={`jira-board${open === null ? '' : ' jira-board--open'}`}>
      <div className="jira-board__main">
        <div className="jira-board__bar">
          <div className="jira-views" role="tablist" aria-label="Which tickets">
            {VIEWS.map((item) => (
              <button key={item} type="button" role="tab" className="jira-view" aria-selected={view === item} onClick={() => setView(item)}>
                {VIEW_LABELS[item]}
              </button>
            ))}
          </div>
          <div className="jira-board__fetch">
            {board.state.kind === 'ready' ? <span className="jira__quiet">Fetched {formatClock(Date.parse(board.state.value.fetchedAt))}</span> : null}
            <button type="button" className="jira-btn" disabled={refreshing} onClick={() => void refresh()}>
              <Icon name="restart" /> {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        {site.lastError === null ? null : (
          <div className="jira-refused" role="alert">
            <p>{site.lastError}</p>
            <button type="button" className="jira-btn jira-btn--primary" onClick={onReconnect}>Sign in again</button>
          </div>
        )}
        {refreshError === null ? null : <p className="jira-form__failure" role="alert">{refreshError}</p>}
        {board.state.kind === 'loading' ? <p className="jira__quiet" role="status">Asking Jira for your tickets…</p> : null}
        {failed !== null && !notConnected(failed) ? (
          <div className="jira-refused" role="alert">
            <p>{jiraErrorText(failed)}</p>
            <div className="jira-form__row">
              <button type="button" className={signInRefused(failed) ? 'jira-btn jira-btn--quiet' : 'jira-btn'} onClick={board.reload}>Try again</button>
              <button type="button" className={signInRefused(failed) ? 'jira-btn jira-btn--primary' : 'jira-btn jira-btn--quiet'} onClick={onReconnect}>Sign in again</button>
            </div>
          </div>
        ) : null}
        {board.state.kind === 'ready' ? (
          <Columns board={board.state.value} asked={view} server={server} open={open} onOpen={setOpen} />
        ) : null}
      </div>
      {open === null ? null : (
        <TicketDetail server={server} issueKey={open} onClose={() => setOpen(null)} onChanged={board.reload} onNotConnected={onNotConnected} onReconnect={onReconnect} />
      )}
    </div>
  );
}

function Columns({ board, asked, server, open, onOpen }: {
  board: JiraBoardDTO; asked: JiraView; server: string; open: string | null; onOpen: (key: string) => void;
}) {
  const columns = boardColumns(board);
  return (
    <>
      <p className="jira-sprint">
        {board.sprint === null ? <span>No open sprint</span> : (
          <>
            <span className="jira-sprint__name" dir="auto">{board.sprint.name}</span>
            {board.sprint.endsAt === null ? null : <span> · ends {whenText(board.sprint.endsAt, new Date())}</span>}
          </>
        )}
        <span className="jira-sprint__count"> · {boardSummary(board.issues)}</span>
      </p>
      {fellBack(asked, board) ? <p className="jira__quiet">Nothing of yours in an open sprint, so this shows all your open tickets.</p> : null}
      {board.issues.length === 0 ? (
        <p className="jira-empty">
          {board.view === 'attention' ? 'Nothing needs your attention right now.' : 'No open tickets are assigned to you. Enjoy the quiet.'}
        </p>
      ) : (
        <div className="jira-columns" aria-label="Status columns">
          {columns.map((column) => (
            <section key={column.name} className={`jira-col jira-col--${column.category}`} aria-label={column.name}>
              <h3 className="jira-col__head">
                <span className="jira-col__name" dir="auto">{column.name}</span>
                <span className="jira-col__count">{column.issues.length}</span>
              </h3>
              <ul className="jira-col__list">
                {column.issues.map((issue) => (
                  <li key={issue.key}><TicketCard issue={issue} server={server} selected={open === issue.key} onOpen={() => onOpen(issue.key)} /></li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {board.issues.length === 0 ? null : (
        <p className="jira-hint">Open a ticket to read it, change it or start building. Drag one by its handle onto a character or a room to hand it over.</p>
      )}
    </>
  );
}
