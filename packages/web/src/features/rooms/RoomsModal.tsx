import type { RoomDTO } from '@luady/shared';
import { RoomsManager, type RoomsView } from './RoomsManager.js';
import './rooms.css';

/** Which view the office's Rooms pop-up opens on: a room's editor, a new room for a spot, or the list. */
export function roomsView(room: string | undefined, position: number | undefined, add = false): RoomsView {
  if (room !== undefined) return { kind: 'edit', id: room };
  if (position !== undefined) return { kind: 'add', position };
  return add ? { kind: 'add' } : { kind: 'list' };
}

/**
 * The office's Rooms pop-up: the rooms list, or straight into an editor. An editor opened from the map closes the
 * pop-up when it is done and shows the room on the map.
 */
export function RoomsModal({ room, position, add, onClose, onShowRoom }: {
  room?: string; position?: number; add?: boolean; onClose: () => void; onShowRoom: (room: string) => void;
}) {
  const finish = (saved: RoomDTO | null) => {
    onClose();
    if (saved !== null) onShowRoom(saved.id);
  };
  return (
    <div className="rooms-paper">
      <RoomsManager initial={roomsView(room, position, add)} onFinish={finish} />
    </div>
  );
}
