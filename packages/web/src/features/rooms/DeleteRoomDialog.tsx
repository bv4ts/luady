import type { RoomDTO } from '@luady/shared';
import { useEffect, useId, useState } from 'react';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { SelectField } from '../../ui/Field.js';
import type { RoomProblem } from './room-errors.js';
import { useRoomActions } from './useRoomActions.js';
import { useRooms } from './useRooms.js';

/** Where a removed room's things go by default: its server's own room for a project room, else the first other room. */
export function defaultTarget(room: RoomDTO, rooms: readonly RoomDTO[]): string | null {
  const others = rooms.filter((other) => other.id !== room.id).toSorted((a, b) => a.position - b.position);
  const home = room.kind === 'project' && room.host !== null
    ? others.find((other) => other.kind !== 'project' && other.host === room.host)
    : undefined;
  return (home ?? others[0])?.id ?? null;
}

function Choice({ name, value, current, onPick, children }: {
  name: string; value: string; current: string; onPick: (value: string) => void; children: string;
}) {
  return (
    <label className="room-choice">
      <input type="radio" name={name} value={value} checked={current === value} onChange={() => onPick(value)} />
      <span>{children}</span>
    </label>
  );
}

/**
 * Removing a room: its links move to another room
 * or are deleted; its Jira board moves to another room or is disconnected, which needs the PIN. Sessions are never
 * stopped: they move to another room of their server, or to "Not on the map".
 */
export function DeleteRoomDialog({ room, onDone, onCancel }: { room: RoomDTO; onDone: () => void; onCancel: () => void }) {
  const lookup = useRooms();
  const actions = useRoomActions();
  const others = lookup.list.filter((other) => other.id !== room.id);
  // The defaults follow the rooms only until they are known (the room itself is listed); then they are fixed, and only
  // the owner changes them. A target that leaves the office meanwhile is cleared, never swapped for another.
  const known = lookup.list.some((other) => other.id === room.id);
  const [chosenTo, setTo] = useState<string | null>(null);
  const [chosenLinks, setLinks] = useState<'move' | 'delete' | null>(null);
  const [chosenJira, setJira] = useState<'move' | 'disconnect' | null>(null);
  useEffect(() => {
    if (!known) return;
    setTo((current) => current ?? defaultTarget(room, lookup.list) ?? '');
    setLinks((current) => current ?? (others.length > 0 ? 'move' : 'delete'));
    setJira((current) => current ?? (others.length > 0 ? 'move' : 'disconnect'));
    // Fixed once, when the rooms are first known.
  }, [known]);
  const wanted = chosenTo ?? defaultTarget(room, lookup.list) ?? '';
  const to = others.some((other) => other.id === wanted) ? wanted : '';
  const links = chosenLinks ?? (others.length > 0 ? 'move' : 'delete');
  const jira = chosenJira ?? (others.length > 0 ? 'move' : 'disconnect');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RoomProblem | null>(null);
  const moves = links === 'move' || jira === 'move';
  const missingTarget = moves && others.length > 0 && to === '';
  const titleId = useId();

  async function remove() {
    setBusy(true);
    setProblem(null);
    const result = await actions.remove(room.id, { links, jira, ...(moves && to !== '' ? { to } : {}) });
    setBusy(false);
    if (result.ok) onDone();
    else setProblem(result.problem);
  }

  return (
    <section className="room-delete stack" aria-labelledby={titleId} data-testid="room-delete">
      <h3 id={titleId} className="section-title">Remove {room.name}?</h3>
      <p className="text-muted">Its sessions keep running: they move to another room of their server, or to “Not on the map”.</p>
      <fieldset className="room-delete__part">
        <legend className="field__label">Its links (if it has any)</legend>
        {others.length > 0 ? <Choice name={`${titleId}-links`} value="move" current={links} onPick={() => setLinks('move')}>Move them to another room</Choice> : null}
        <Choice name={`${titleId}-links`} value="delete" current={links} onPick={() => setLinks('delete')}>Delete them</Choice>
      </fieldset>
      <fieldset className="room-delete__part">
        <legend className="field__label">Its Jira board (if one is connected)</legend>
        {others.length > 0 ? <Choice name={`${titleId}-jira`} value="move" current={jira} onPick={() => setJira('move')}>Move it to another room</Choice> : null}
        <Choice name={`${titleId}-jira`} value="disconnect" current={jira} onPick={() => setJira('disconnect')}>Disconnect it (asks for your PIN)</Choice>
      </fieldset>
      {moves && others.length > 0 ? (
        <SelectField label="Move them to" value={to} onChange={(event) => setTo(event.target.value)}
          error={missingTarget ? 'Pick the room that should get them.' : undefined}
          options={[...(to === '' ? [{ value: '', label: 'Pick a room' }] : []), ...others.map((other) => ({ value: other.id, label: other.name }))]} />
      ) : null}
      {problem === null ? null : <Banner tone="error">{problem.text}</Banner>}
      <div className="room-editor__actions">
        <Button variant="danger" icon="trash" busy={busy} disabled={missingTarget} onClick={() => void remove()}>Remove the room</Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Keep it</Button>
      </div>
    </section>
  );
}
