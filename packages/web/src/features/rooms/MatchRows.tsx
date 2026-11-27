import { LIMITS, type ProjectMatch, type SessionDTO } from '@luady/shared';
import { useId } from 'react';
import { Button } from '../../ui/Button.js';
import type { RoomLookup } from './room-lookup.js';
import type { RoomPreview } from './useRoomPreview.js';

/** At most this many names in one preview line; the rest are counted. */
const PREVIEW_NAMES = 6;

function MatchRow({ match, error, index, onChange, onRemove }: {
  match: ProjectMatch; error: string | null; index: number; onChange: (next: ProjectMatch) => void; onRemove: () => void;
}) {
  const id = useId();
  const label = match.by === 'name' ? `Project name ${index + 1}` : `Folder ${index + 1}`;
  return (
    <li className="room-match">
      <select className="select room-match__by" aria-label={`Match ${index + 1} by`} value={match.by}
        onChange={(event) => onChange({ by: event.target.value === 'path' ? 'path' : 'name', glob: match.glob })}>
        <option value="name">Project name</option>
        <option value="path">Folder</option>
      </select>
      <input className="input input--mono room-match__glob" aria-label={label} value={match.glob} maxLength={LIMITS.roomGlobMax}
        placeholder={match.by === 'name' ? 'web-app or web-*' : '/home/dev/projects/web-app/**'} spellCheck={false} autoCapitalize="off"
        aria-invalid={error === null ? undefined : true} aria-describedby={error === null ? undefined : `${id}-error`}
        onChange={(event) => onChange({ by: match.by, glob: event.target.value })} />
      <Button size="sm" variant="ghost" icon="x" aria-label={`Remove match ${index + 1}`} onClick={onRemove} />
      {error === null ? null : <p className="field__error room-match__error" id={`${id}-error`} role="alert">{error}</p>}
    </li>
  );
}

const listed = (names: readonly string[]): string =>
  names.length <= PREVIEW_NAMES ? names.join(', ') : `${names.slice(0, PREVIEW_NAMES).join(', ')} and ${names.length - PREVIEW_NAMES} more`;

/** "host/name" from the hub as the owner reads it: the project name, with its office when it is not this room's host. */
const projectWords = (label: string, lookup: RoomLookup, host: string): string => {
  const at = label.indexOf('/');
  if (at === -1) return label;
  const on = label.slice(0, at);
  const name = label.slice(at + 1);
  return on === host ? name : `${name} (${lookup.hostLabel(on)})`;
};

/** What the room would take now, and which other rooms want the same projects. */
export function PreviewLines({ preview, sessions, lookup, host }: {
  preview: RoomPreview; sessions: readonly SessionDTO[]; lookup: RoomLookup; host: string;
}) {
  if (preview.state === 'idle' || preview.state === 'unavailable') return null;
  if (preview.state === 'loading') return <p className="room-note" role="status">Looking at what this room would hold…</p>;
  const { data } = preview;
  const names = data.sessions.map((id) => sessions.find((session) => session.id === id)?.displayName ?? 'a session');
  const projects = data.projects.map((label) => projectWords(label, lookup, host));
  return (
    <div className="room-preview" role="status" data-testid="room-preview">
      <p className="room-note">
        {names.length === 0 ? 'No live sessions would sit here right now.' : `${names.length === 1 ? '1 live session' : `${names.length} live sessions`} would sit here: ${listed(names)}.`}
        {projects.length === 0 ? '' : ` Projects it holds: ${listed(projects)}.`}
      </p>
      {data.overlaps.map((overlap) => (
        <p key={overlap.room} className="room-note room-note--warn">
          {`${lookup.roomName(overlap.room)} also matches ${listed(overlap.projects.map((label) => projectWords(label, lookup, host)))}. The more exact match wins.`}
        </p>
      ))}
    </div>
  );
}

/**
 * Which projects the room holds: project names or folders, with * and ?. A server room may leave them empty (it then
 * holds every project of its server that no project room takes).
 */
export function MatchRows({ value, errors, required, onChange }: {
  value: readonly ProjectMatch[]; errors: readonly (string | null)[]; required: boolean; onChange: (next: readonly ProjectMatch[]) => void;
}) {
  const set = (at: number, next: ProjectMatch) => onChange(value.map((m, i) => (i === at ? next : m)));
  return (
    <fieldset className="room-matches">
      <legend className="field__label">{required ? 'Projects it holds' : 'Projects it holds (optional)'}</legend>
      <p className="field__hint">
        {required
          ? 'Name the projects by name (web-*) or folder (/path/to/web/**). Sessions in those projects sit in this room.'
          : 'Leave this empty to hold every project of the server. Name projects here to mark the others as guests.'}
      </p>
      {value.length === 0 ? null : (
        <ul className="room-matches__list">
          {value.map((m, i) => (
            // Rows have no id of their own; the position is their identity while the form is open.
            <MatchRow key={i} match={m} index={i} error={errors[i] ?? null} onChange={(next) => set(i, next)}
              onRemove={() => onChange(value.filter((_, j) => j !== i))} />
          ))}
        </ul>
      )}
      {value.length >= LIMITS.roomMatchesMax ? <p className="field__hint">A room holds at most {LIMITS.roomMatchesMax} matches.</p> : (
        <Button size="sm" icon="plus" onClick={() => onChange([...value, { by: 'name', glob: '' }])}>Add a project</Button>
      )}
    </fieldset>
  );
}
