import { Card } from '../../ui/Card.js';
import { RoomsSection } from './RoomsSection.js';

/** The office's rooms: one per server, this computer, or a group of projects; as many as you like. */
export function RoomsSettings() {
  return (
    <Card title="Rooms" subtitle="Each room on the map holds the sessions of one server, of this computer, or of the projects you name.">
      <RoomsSection />
    </Card>
  );
}
