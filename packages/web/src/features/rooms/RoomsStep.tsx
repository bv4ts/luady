import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { useStore } from '../../state/store.js';
import { RoomsManager } from './RoomsManager.js';
import { useBulkRooms } from './useBulkRooms.js';
import './rooms.css';

export interface RoomsStepProps {
  onNext(): void;
}

/**
 * The setup wizard's rooms step: one press makes a room for every server that has none (this
 * computer included); the list below adds, edits and removes rooms one by one. Next goes on, with or without rooms.
 */
export function RoomsStep({ onNext }: RoomsStepProps) {
  const { state } = useStore();
  const bulk = useBulkRooms();
  const count = state.rooms.length;
  return (
    <section className="rooms-step stack" data-testid="rooms-step" aria-label="Rooms">
      <p>Each room on the map holds the sessions of one server, of this computer, or of projects you name. You can change them any time in Settings.</p>
      {bulk.waiting.length > 0 ? (
        <div className="room-editor__actions">
          <Button variant="primary" busy={bulk.busy} onClick={() => void bulk.createAll()}>
            {bulk.waiting.length === 1 && bulk.computer !== null ? 'Add this computer' : `Create a room for each server (${bulk.waiting.length})`}
          </Button>
        </div>
      ) : null}
      {bulk.problem === null ? null : <Banner tone="error">{bulk.problem.text}</Banner>}
      <RoomsManager />
      <div className="room-editor__actions">
        <Button variant={count > 0 ? 'primary' : 'secondary'} onClick={onNext}>{count > 0 ? 'Next' : 'Skip for now'}</Button>
      </div>
    </section>
  );
}
