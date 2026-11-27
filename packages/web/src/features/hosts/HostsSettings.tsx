import { Card } from '../../ui/Card.js';
import { HostsSection } from './HostsSection.js';

/** Servers and this computer: add, check, install the kit, edit and remove, all with the PIN. */
export function HostsSettings() {
  return (
    <Card title="Servers" subtitle="The machines whose sessions sit in the office.">
      <HostsSection />
    </Card>
  );
}
