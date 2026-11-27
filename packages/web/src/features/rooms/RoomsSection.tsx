import { RoomsManager } from './RoomsManager.js';
import './rooms.css';

/** The rooms list and editor: Settings → Rooms shows it, and the office's Rooms menu opens it. */
export function RoomsSection() {
  return (
    <div data-testid="rooms-section">
      <RoomsManager />
    </div>
  );
}
