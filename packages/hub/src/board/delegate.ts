import { randomBytes } from 'node:crypto';
import {
  LIMITS, isSelfHost, type BoardItemDTO, type DelegateBody, type DelegateResultDTO, type DelegateWhat, type JiraIssueDetailDTO, type NoteDTO, managerName,
} from '@luady/shared';
import type {
  BoardAddInput, DelegateOptions, JiraService, LuadyService, Logger, NotesService, ProjectsService, SessionService,
} from '../core/contracts.js';
import { NotFoundError, RefusedError } from '../core/errors.js';
import { delegationEvent, type DelegateTarget } from './delegate-text.js';
import type { BoardCore } from './service.js';
import type { CardStore } from './store.js';
import { clipUnits, oneLine } from './text.js';

export interface DelegateDeps {
  core: BoardCore;
  store: CardStore;
  log: Logger;
  sessions: Pick<SessionService, 'findByRef'>;
  projects: Pick<ProjectsService, 'list'>;
  luady: Pick<LuadyService, 'postEvent' | 'postOwnerRequest' | 'status' | 'signedOut'>;
  jira: Pick<JiraService, 'issue'>;
  notes: Pick<NotesService, 'get'>;
}

export function newRunId(): string {
  return `r_${randomBytes(6).toString('hex')}`;
}

/** A ticket as a card: `ORC-123 summary`, its description as details. */
export function ticketCard(server: DelegateWhat & { kind: 'jira' }, issue: JiraIssueDetailDTO): BoardAddInput {
  return {
    title: clipUnits(oneLine(`${issue.key} ${issue.summary}`), LIMITS.boardTitleMax),
    details: clipUnits(issue.descriptionMd.trim(), LIMITS.boardDetailsMax),
    server: server.server,
    source: 'jira',
    sourceRef: `${server.server}:${issue.key}`,
  };
}

/** A note as a card: its title, and its text with the action items as details. */
export function noteCard(note: NoteDTO): BoardAddInput {
  const body = [note.summary.trim(), note.actionItems === null ? '' : `Action items:\n${note.actionItems.trim()}`].filter(Boolean).join('\n\n');
  return {
    title: clipUnits(oneLine(note.title) || 'Note', LIMITS.boardTitleMax),
    details: clipUnits(body, LIMITS.boardDetailsMax),
    project: note.project === null ? null : clipUnits(note.project, LIMITS.boardProjectMax),
    source: 'note',
    sourceRef: note.id,
  };
}

/** What the owner picked, fetched before any card changes so a missing ticket or note leaves the board as it was. */
type Picked = { kind: 'card'; id: number } | { kind: 'new'; input: BoardAddInput };

async function pick(what: DelegateWhat, deps: DelegateDeps): Promise<Picked> {
  switch (what.kind) {
    case 'todo':
      if (deps.store.get(what.id) === undefined) throw new NotFoundError(`No card #${what.id}`);
      return { kind: 'card', id: what.id };
    case 'jira': {
      const known = deps.store.bySource('jira', `${what.server}:${what.key}`);
      if (known !== undefined) return { kind: 'card', id: known.id };
      return { kind: 'new', input: ticketCard(what, await deps.jira.issue(what.server, what.key, { seen: false })) };
    }
    case 'note': {
      const known = deps.store.bySource('note', what.id);
      if (known !== undefined) return { kind: 'card', id: known.id };
      const note = await deps.notes.get(what.id);
      if (note === null) throw new NotFoundError(`No note ${what.id}`);
      return { kind: 'new', input: noteCard(note) };
    }
  }
}

function target(body: DelegateBody, deps: DelegateDeps): DelegateTarget {
  const to = body.to;
  if (to.kind === 'auto') return to;
  if (to.kind === 'server') return to;
  const session = deps.sessions.findByRef(to.id);
  if (session === undefined || isSelfHost(session.host) || session.origin === 'system') throw new NotFoundError(`No session ${to.id}`);
  if (session.state === 'ended') throw new RefusedError(`${session.displayName} has ended. Pick another session or an office.`);
  return { kind: 'session', session };
}

/** `sent`: Luady is free and the event reaches him now; otherwise it waits in his queue (busy, down or signed out). */
function luadyAnswer(luady: Pick<LuadyService, 'status' | 'signedOut'>): DelegateResultDTO['manager'] {
  const status = luady.status();
  return luady.signedOut?.() !== true && status.state === 'running' && status.queued === 0 ? 'sent' : 'queued';
}

function queuedNote(to: DelegateTarget, runId: string): string {
  switch (to.kind) {
    case 'auto':
      return `Run ${runId}: sent to ${managerName()} to plan.`;
    case 'session':
      return `Run ${runId}: given to ${to.session.host} · ${to.session.displayName}.`;
    case 'server':
      return `Run ${runId}: given to a new session in ${to.server}.`;
  }
}

/**
 * Run and Give to…: tickets and notes become cards, every card goes `queued`, Luady gets one event. Asked by the owner
 * on the website (`ownerOnWebsite`), that event is the owner's own request, so the turn it starts counts as theirs; from
 * anywhere else it is a plain Event.
 */
export async function delegate(body: DelegateBody, deps: DelegateDeps, opts: DelegateOptions = {}): Promise<DelegateResultDTO> {
  const to = target(body, deps);
  const picked = await Promise.all(body.what.map((what) => pick(what, deps)));
  const ids: number[] = [];
  for (const item of picked) {
    const id = item.kind === 'card' ? item.id : (await deps.core.add(item.input, 'owner')).id;
    if (!ids.includes(id)) ids.push(id);
  }
  const runId = newRunId();
  const manager = luadyAnswer(deps.luady);
  const note = queuedNote(to, runId);
  const items: BoardItemDTO[] = await deps.core.changeMany(ids.map((id) => ({ id, patch: { state: 'queued', runId, note } })), 'owner');
  const text = delegationEvent({
    runId, cards: items, target: to, projects: deps.projects.list(), ...(body.note === undefined ? {} : { note: body.note }),
  });
  const asOwner = opts.ownerOnWebsite === true ? deps.luady.postOwnerRequest : undefined;
  await (asOwner === undefined ? deps.luady.postEvent(text, 'Event') : asOwner(text));
  return { runId, items, manager };
}
