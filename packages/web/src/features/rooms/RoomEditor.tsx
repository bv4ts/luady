import type { RoomDTO, RoomKind } from '@luady/shared';
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { hostChoices, type HostChoice } from '../../state/rooms.js';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { SelectField, TextField } from '../../ui/Field.js';
import { ColourPicker } from './ColourPicker.js';
import { CreaturePicker, CreaturePreview } from './CreaturePicker.js';
import { MatchRows, PreviewLines } from './MatchRows.js';
import type { RoomProblem } from './room-errors.js';
import {
  createBody, editRoomForm, hostsFor, isNoChange, isValid, nameForHost, newRoomForm, savedColour, updateBody, validateRoomForm,
  type RoomForm,
} from './room-form.js';
import { useRoomActions } from './useRoomActions.js';
import { useRoomPreview } from './useRoomPreview.js';
import { useRooms } from './useRooms.js';
import './rooms.css';

/** Where Settings lists the servers (the add-server flow lives there). */
export const ADD_SERVER_LINK = '/settings';

export interface RoomEditorProps {
  /** The room to edit; absent = a new room. */
  readonly room?: RoomDTO;
  /** A new room's slot (a "+ Add room" plaque); absent = the lowest free slot. */
  readonly position?: number;
  /** A new room's kind and host to start with. */
  readonly kind?: RoomKind;
  readonly host?: string;
  readonly onDone: (room: RoomDTO) => void;
  readonly onCancel: () => void;
  /** Shown beside Save in edit mode (the remove button). */
  readonly extraActions?: ReactNode;
}

const KIND_WORDS: Readonly<Record<RoomKind, { label: string; hint: string }>> = Object.freeze({
  server: { label: 'A server', hint: 'Every session on that server sits here.' },
  local: { label: 'This computer', hint: 'Sessions on the computer the hub runs on sit here.' },
  project: { label: 'A project', hint: 'Sessions in the projects you name sit here, on one server or any.' },
});

function KindPicker({ value, kinds, onChange }: { value: RoomKind; kinds: readonly RoomKind[]; onChange: (kind: RoomKind) => void }) {
  // Each editor's own radio group: two editors on one page never share one.
  const group = useId();
  return (
    <fieldset className="room-kinds">
      <legend className="field__label">What is this room for?</legend>
      <div className="room-kinds__list">
        {kinds.map((kind) => (
          <label key={kind} className="room-kinds__item">
            <input type="radio" name={`${group}-kind`} value={kind} checked={value === kind} onChange={() => onChange(kind)} />
            <span><b>{KIND_WORDS[kind].label}</b><small>{KIND_WORDS[kind].hint}</small></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function HostPicker({ form, hosts, choices, label, error, onChange }: {
  form: RoomForm; hosts: readonly HostChoice[]; choices: readonly HostChoice[]; label: (host: string) => string; error: string | undefined;
  onChange: (host: string) => void;
}) {
  const current = form.host !== '' && !choices.some((h) => h.id === form.host) ? [{ value: form.host, label: label(form.host) }] : [];
  const options = [
    ...(form.kind === 'project' ? [{ value: '', label: 'Any server' }] : []),
    ...current,
    ...choices.map((host) => ({ value: host.id, label: label(host.id) })),
  ];
  const none = form.kind !== 'project' && choices.length === 0 && form.host === '';
  return (
    <div className="room-host">
      {none ? null : (
        <SelectField label={form.kind === 'local' ? 'Computer' : 'Server'} value={form.host} options={options} error={error}
          onChange={(event) => onChange(event.target.value)} />
      )}
      {none ? <p className="field__error" role="alert">{error}</p> : null}
      <p className="field__hint">
        {hosts.length === 0 ? 'No server is set up yet. ' : 'Not in the list? '}
        <Link to={ADD_SERVER_LINK}>Add a server in Settings → Servers</Link>
      </p>
    </div>
  );
}

function useEditorState(props: RoomEditorProps) {
  const { state } = useStore();
  const { hosts: hostList, servers, rooms } = state;
  const hosts = useMemo(() => hostChoices({ hosts: hostList, servers }), [hostList, servers]);
  const fresh = useCallback(() => newRoomForm(rooms, hosts, {
    ...(props.kind === undefined ? {} : { kind: props.kind }), ...(props.host === undefined ? {} : { host: props.host }),
  }), [rooms, hosts, props.kind, props.host]);
  const [form, setFormState] = useState<RoomForm>(() => (props.room === undefined ? fresh() : editRoomForm(props.room)));
  // A new room's form follows the hosts and rooms that arrive (a page opened before the overview) only until it shows
  // a host; from then on it changes only when the owner changes it, so Add sends exactly what is on screen.
  const [settled, setSettled] = useState(() => props.room !== undefined || form.host !== '');
  useEffect(() => {
    if (settled) return;
    const seed = fresh();
    setFormState(seed);
    if (seed.host !== '') setSettled(true);
  }, [settled, fresh]);
  const setForm = useCallback((update: (current: RoomForm) => RoomForm) => {
    setSettled(true);
    setFormState(update);
  }, []);
  const [nameTouched, setNameTouched] = useState(props.room !== undefined);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<RoomProblem | null>(null);
  const [busy, setBusy] = useState(false);
  return {
    state, hosts, form, setForm, reset: (next: RoomForm) => setFormState(next), nameTouched, setNameTouched, tried, setTried, problem, setProblem, busy, setBusy,
  };
}

/**
 * Adds or edits a room: what it is for, its server, its name, then (folded away for a new room) the
 * projects it holds, its colour and its creature. A new room is ready to save as it opens: the first free server, a
 * name from it, the next colour and creature; it lands in the lowest free slot unless a plaque chose one.
 */
export function RoomEditor(props: RoomEditorProps) {
  const { room, position, onDone, onCancel, extraActions } = props;
  const s = useEditorState(props);
  const { form, setForm, hosts, state } = s;
  const lookup = useRooms();
  const actions = useRoomActions();
  const self = room?.id ?? null;
  const errors = validateRoomForm(form, { rooms: state.rooms, hosts, self });
  const shown = s.tried ? errors : { fields: {}, rows: errors.rows.map(() => null) };
  const choices = hostsFor(form.kind, hosts, state.rooms, self);
  const kinds: RoomKind[] = ['server', ...(hosts.some((h) => h.local) || form.kind === 'local' ? ['local' as const] : []), 'project'];
  const preview = useRoomPreview({ kind: form.kind, host: form.host, match: form.match, id: self, enabled: true });
  const formId = useId();

  const change = (next: Partial<RoomForm>) => setForm((current) => ({ ...current, ...next }));
  const pickHost = (host: string) => change({ host, ...(s.nameTouched ? {} : { name: nameForHost(hosts.find((h) => h.id === host)) }) });
  const pickKind = (kind: RoomKind) => {
    const first = hostsFor(kind, hosts, state.rooms, self)[0];
    const host = kind === 'project' ? form.host : (choices.some((h) => h.id === form.host) && kind === form.kind ? form.host : first?.id ?? '');
    change({ kind, host, ...(s.nameTouched ? {} : { name: kind === 'project' ? '' : nameForHost(hosts.find((h) => h.id === host)) }) });
  };

  async function save() {
    s.setTried(true);
    if (!isValid(errors)) return;
    s.setBusy(true);
    s.setProblem(null);
    const result = room === undefined ? await actions.create(createBody(form, position)) : await saveEdit(room);
    s.setBusy(false);
    if (result === null) return;
    if (result.ok) onDone(result.value.room);
    else s.setProblem(result.problem);
  }

  async function saveEdit(given: RoomDTO) {
    // The newest copy the store has (a reload after a stale write brings it): its updatedAt is the one to send.
    const current = state.rooms.find((r) => r.id === given.id) ?? given;
    const body = updateBody(form, current);
    if (isNoChange(body)) {
      onDone(current);
      return null;
    }
    return actions.update(current.id, body);
  }

  const reload = async () => {
    const result = await actions.refresh();
    const list = result.ok ? result.value : state.rooms;
    const latest = list.find((r) => r.id === self);
    if (latest === undefined) {
      s.setProblem({ text: 'This room is gone: it was removed on another screen.', stale: false });
      return;
    }
    s.reset(editRoomForm(latest));
    s.setProblem(null);
  };
  const look = savedColour(form)?.hex ?? '#6c7689';

  return (
    <form id={formId} className="room-editor stack" noValidate data-testid="room-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {room?.hostState === 'removed' ? (
        <Banner tone="warn">Its server was removed. You can still rename this room, recolour it, give it another server, or remove it.</Banner>
      ) : null}
      <KindPicker value={form.kind} kinds={kinds} onChange={pickKind} />
      <HostPicker form={form} hosts={hosts} choices={choices} label={lookup.hostLabel} error={shown.fields.host} onChange={pickHost} />
      <TextField label="Name" value={form.name} maxLength={60} error={shown.fields.name} autoComplete="off"
        onChange={(event) => { s.setNameTouched(true); change({ name: event.target.value }); }} />
      {form.kind === 'project' ? (
        <MatchRows value={form.match} errors={s.tried ? errors.rows : errors.rows.map(() => null)} required onChange={(match) => change({ match })} />
      ) : null}
      {form.kind === 'project' ? <p className="field__error" role={shown.fields.match ? 'alert' : undefined}>{shown.fields.match ?? ''}</p> : null}
      <PreviewLines preview={preview} sessions={state.sessions} lookup={lookup} host={form.host} />
      <details className="room-more" open={room !== undefined}>
        <summary>
          <span className="room-more__look"><CreaturePreview species={form.species} colour={look} size={32} /></span>
          {room === undefined ? 'Colour, creature and more (optional)' : 'Colour, creature and more'}
        </summary>
        <div className="stack">
          <ColourPicker value={form.colour} rooms={state.rooms} self={self} onChange={(colour) => change({ colour })} />
          {shown.fields.colour ? <p className="field__error" role="alert">{shown.fields.colour}</p> : null}
          <CreaturePicker value={form.species} colour={look} onChange={(species) => change({ species })} />
          <TextField label="Short name (optional)" hint="Shown on the room chips; the name is used when this is empty." value={form.short}
            maxLength={20} error={shown.fields.short} autoComplete="off" onChange={(event) => change({ short: event.target.value })} />
          {form.kind === 'project' ? null : (
            <MatchRows value={form.match} errors={s.tried ? errors.rows : errors.rows.map(() => null)} required={false} onChange={(match) => change({ match })} />
          )}
        </div>
      </details>
      {s.problem === null ? null : (
        <Banner tone="error" action={s.problem.stale ? <Button size="sm" onClick={() => void reload()}>Load the newest version</Button> : undefined}>
          {s.problem.text}
        </Banner>
      )}
      <div className="room-editor__actions">
        <Button type="submit" variant="primary" busy={s.busy}>{room === undefined ? 'Add the room' : 'Save'}</Button>
        <Button variant="ghost" onClick={onCancel} disabled={s.busy}>Cancel</Button>
        {extraActions}
      </div>
    </form>
  );
}
