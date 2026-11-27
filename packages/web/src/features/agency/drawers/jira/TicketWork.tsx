import { LIMITS, type DelegateWhat, type JiraIssueDetailDTO } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError, userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { useGive } from '../../give/GiveContext.js';
import { ticketCardTitle } from './jira-model.js';

/** What the card made from a ticket carries: its description, cut to the card's details limit. */
export const ticketDetails = (issue: Pick<JiraIssueDetailDTO, 'descriptionMd'>): string => issue.descriptionMd.slice(0, LIMITS.boardDetailsMax);

/** From ticket to work: Start building, Give to…, Add to board, or drag it onto a character or a room. */
export function TicketWork({ issue, server }: { issue: JiraIssueDetailDTO; server: string }) {
  const api = useApi();
  const { toast } = useStore();
  const { give, openPicker, startDrag } = useGive();
  const [adding, setAdding] = useState(false);
  // `server` is the room key of the Jira site; a card names the host its work runs on, the room's host when it has one.
  const host = useRooms().room(server)?.host ?? null;
  const what: readonly DelegateWhat[] = [{ kind: 'jira', server, key: issue.key }];

  async function addToBoard() {
    setAdding(true);
    try {
      const card = await api.createCard({
        title: ticketCardTitle(issue), details: ticketDetails(issue), ...(host === null ? {} : { server: host }), source: 'jira',
        sourceRef: `${server}:${issue.key}`,
      });
      toast('success', `${issue.key} is on the board as #${String(card.id)}.`);
    } catch (err) {
      toast('error', isApiError(err) && (err.status === 404 || err.status === 501) ? 'The board needs the next hub update.' : userMessage(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="jira-work" role="group" aria-label="Send to work">
      <button type="button" className="jira-btn jira-btn--build" onClick={() => give(what, issue.key)}>Start building</button>
      <button type="button" className="jira-btn" aria-haspopup="dialog" onClick={() => openPicker(what, issue.key)}>Give to…</button>
      <button type="button" className="jira-btn" disabled={adding} onClick={() => void addToBoard()}>{adding ? 'Adding…' : 'Add to board'}</button>
      <button type="button" className="jira-btn jira-btn--quiet jira-work__drag" aria-label={`Drag ${issue.key} to a session or a room`}
        onPointerDown={(event) => startDrag(what, issue.key, event)}>
        <span aria-hidden="true">⠿</span> Drag to a session
      </button>
    </div>
  );
}
