import { LIMITS, type BoardItemDTO, type UpdateBoardItemBody } from '@luady/shared';
import { useState } from 'react';
import { Markdown } from '../../../../markdown/Markdown.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { isOffice, useOfficeOptions } from '../office-options.js';
import type { CardActions, ProjectsByServer } from './useBoard.js';

/** What the edit form changes; nothing when the owner changed nothing. Null with an error text when it is not valid. */
export function editBody(card: Pick<BoardItemDTO, 'title' | 'details'>, title: string, details: string): UpdateBoardItemBody | string {
  const nextTitle = title.trim();
  if (nextTitle === '') return 'A card needs a title.';
  if (nextTitle.length > LIMITS.boardTitleMax) return `Keep the title under ${String(LIMITS.boardTitleMax)} characters.`;
  const nextDetails = details.trim();
  return {
    ...(nextTitle === card.title ? {} : { title: nextTitle }),
    ...(nextDetails === card.details.trim() ? {} : { details: nextDetails }),
  };
}

/** Title and details, read and edit. */
export function CardText({ card, actions }: { card: BoardItemDTO; actions: CardActions }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [details, setDetails] = useState(card.details);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setTitle(card.title);
    setDetails(card.details);
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    const body = editBody(card, title, details);
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    if (Object.keys(body).length === 0 || await actions.update(body, 'Card saved.')) setEditing(false);
  };

  if (!editing) {
    return (
      <div className="card-sheet__text">
        <h3 className="card-sheet__title" dir="auto">{card.title}</h3>
        {card.details.trim() === '' ? <p className="card-sheet__quiet">No details yet.</p> : <Markdown source={card.details} className="card-sheet__details" />}
        <button type="button" className="paper-btn paper-btn--small" onClick={start}>Edit</button>
      </div>
    );
  }
  return (
    <div className="card-sheet__text">
      <input className="paper-input paper-input--title" aria-label="Title" dir="auto" maxLength={LIMITS.boardTitleMax} value={title}
        onChange={(event) => setTitle(event.target.value)} />
      <textarea className="paper-input" aria-label="Details" dir="auto" rows={8} maxLength={LIMITS.boardDetailsMax} value={details}
        placeholder="Details (Markdown)" onChange={(event) => setDetails(event.target.value)} />
      {error === null ? null : <p className="paper-card__error" role="alert">{error}</p>}
      <div className="paper-card__buttons">
        <button type="button" className="paper-btn" onClick={() => setEditing(false)}>Cancel</button>
        <button type="button" className="paper-btn paper-btn--ink" disabled={actions.busy} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}

const projectKey = (server: string, name: string): string => `${server}/${name}`;

/** Office and project pickers: picking a project sets its office too; another office drops a project it does not have. */
export function CardPlace({ card, projects, actions }: { card: BoardItemDTO; projects: ProjectsByServer; actions: CardActions }) {
  const offices = useOfficeOptions();
  const { hostLabel } = useRooms();
  const current = card.project === null ? '' : projectKey(card.server ?? '', card.project);
  const listed = offices.some(({ host }) => (projects[host] ?? []).some((p) => projectKey(host, p.name) === current));

  const pickProject = (value: string) => {
    if (value === '') {
      void actions.update({ project: null });
      return;
    }
    const slash = value.indexOf('/');
    const server = value.slice(0, slash);
    const name = value.slice(slash + 1);
    void actions.update({ project: name, ...(isOffice(offices, server) ? { server } : {}) });
  };
  const pickOffice = (value: string) => {
    const server = isOffice(offices, value) ? value : null;
    const keeps = server !== null && card.project !== null && (projects[server] ?? []).some((p) => p.name === card.project);
    void actions.update({ server, ...(keeps || card.project === null ? {} : { project: null }) });
  };

  return (
    <div className="card-sheet__place">
      <label className="paper-field">
        <span>Office</span>
        <select className="paper-input paper-input--small" value={card.server ?? ''} disabled={actions.busy} onChange={(event) => pickOffice(event.target.value)}>
          <option value="">No office</option>
          {card.server !== null && !isOffice(offices, card.server) ? <option value={card.server}>{hostLabel(card.server)}</option> : null}
          {offices.map((office) => <option key={office.host} value={office.host}>{office.label}</option>)}
        </select>
      </label>
      <label className="paper-field">
        <span>Project</span>
        <select className="paper-input paper-input--small" value={current} disabled={actions.busy} onChange={(event) => pickProject(event.target.value)}>
          <option value="">No project</option>
          {current !== '' && !listed ? <option value={current}>{card.project}</option> : null}
          {offices.filter(({ host }) => (projects[host] ?? []).length > 0).map(({ host, label }) => (
            <optgroup key={host} label={label}>
              {(projects[host] ?? []).map((p) => <option key={p.path} value={projectKey(host, p.name)}>{p.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Today and High priority as two switches. */
export function CardFlags({ card, actions }: { card: BoardItemDTO; actions: CardActions }) {
  return (
    <div className="card-sheet__flags">
      <button type="button" className="paper-toggle" aria-pressed={card.today} disabled={actions.busy}
        onClick={() => void actions.update({ today: !card.today })}>Today</button>
      <button type="button" className="paper-toggle" aria-pressed={card.priority === 1} disabled={actions.busy}
        onClick={() => void actions.update({ priority: card.priority === 1 ? 0 : 1 })}>High priority</button>
    </div>
  );
}
