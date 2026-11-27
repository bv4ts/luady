import type { LinkDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { useRooms, type RoomLookup } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { useLoaded } from '../library/useLoaded.js';
import { LinkCardEditor, LinkForm } from './LinkEditor.js';
import { hostOf, officeLinks, shelfFull } from './links-model.js';
import '../../hud/kit.css';
import '../board/paper.css';
import './links.css';

export interface LinksModalProps {
  /** The office room whose shelf is shown. */
  readonly room: string;
  readonly onClose: () => void;
}

/**
 * The room whose shelf is shown: the room asked for (a host reads as its home room); for a key that names no room
 * (HQ, a lot) the first room; null while the office has no rooms. Links are kept per room.
 */
export const officeOfRoom = (room: string, lookup: RoomLookup): string | null => lookup.room(room)?.id ?? lookup.firstRoom();

/** The links shelf: a room's quick links as pinned cards; edit mode adds, renames, reorders, removes. */
export function LinksModal({ room }: LinksModalProps) {
  const lookup = useRooms();
  const server = officeOfRoom(room, lookup);
  if (server === null) {
    return (
      <div className="pins paper-scope" data-testid="links-modal">
        <p className="pins__note" role="status">Add a room first. Each room keeps its own shelf of links.</p>
      </div>
    );
  }
  return <RoomLinks key={server} server={server} />;
}

function RoomLinks({ server }: { server: string }) {
  const api = useApi();
  const { state } = useStore();
  const { roomName, roomPalette } = useRooms();
  const office = { name: roomName(server), palette: roomPalette(server) };
  const [editing, setEditing] = useState(false);
  const loaded = useLoaded(useCallback(() => api.links(), [api]), 'links', state.linksVersion);
  const shelf = loaded.state.kind === 'ready' ? officeLinks(loaded.state.value.items, server) : [];

  return (
    <div className="pins paper-scope" style={teamStyle(office.palette)} data-testid="links-modal">
      <header className="pins__head">
        <h3 className="pins__title agency-pixel">{office.name} links</h3>
        {loaded.state.kind === 'ready' ? (
          <button type="button" className="paper-btn paper-btn--small pins__edit" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        ) : null}
      </header>
      {loaded.state.kind === 'loading' ? <p className="pins__note" role="status">Reading the pin board…</p> : null}
      {loaded.state.kind === 'failed' ? (
        <p className="pins__note" role="alert">
          {isApiError(loaded.state.error) && (loaded.state.error.status === 404 || loaded.state.error.status === 501)
            ? 'The links shelf needs the next hub update.' : 'The links could not load.'}
        </p>
      ) : null}
      {loaded.state.kind === 'ready' ? (
        <>
          {shelf.length === 0 && !editing ? (
            <div className="pins__empty">
              <p className="pins__empty-title agency-pixel">No links yet</p>
              <p>Pin the pages you open every day for {office.name}: Jira, GitHub, staging, Figma, the store consoles.</p>
              <button type="button" className="paper-btn paper-btn--ink" onClick={() => setEditing(true)}>Add the first link</button>
            </div>
          ) : (
            <ul className="pins__board">
              {shelf.map((link, index) => (
                <li key={link.id}>
                  {editing ? (
                    <LinkCardEditor link={link} shelf={shelf} first={index === 0} last={index === shelf.length - 1} onChanged={loaded.reload} />
                  ) : <PinnedLink link={link} />}
                </li>
              ))}
            </ul>
          )}
          {editing ? (
            shelfFull(shelf) ? <p className="pins__note">This shelf is full (12 links). Remove one to add another.</p>
              : <LinkForm server={server} onAdded={loaded.reload} />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PinnedLink({ link }: { link: LinkDTO }) {
  return (
    <a className="pin-card" href={link.url} target="_blank" rel="noopener noreferrer">
      <span className="pin-card__pin" aria-hidden="true" />
      <span className="pin-card__label" dir="auto">{link.label}</span>
      <span className="pin-card__host">{hostOf(link.url)} ↗</span>
    </a>
  );
}
