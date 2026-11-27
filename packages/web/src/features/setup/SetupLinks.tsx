import { useState } from 'react';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Modal } from '../../ui/Modal.js';
import { SetupConnectBody } from './SetupConnect.js';
import { SetupExtrasBody } from './SetupExtras.js';
import { SetupRoomsBody } from './SetupRooms.js';
import './setup.css';

type Open = 'rooms' | 'connect' | 'extras';

const ROWS: ReadonlyArray<{ id: Open; title: string; line: string }> = [
  { id: 'rooms', title: 'Rooms', line: 'Add this computer or a server, and their rooms.' },
  { id: 'connect', title: 'Connect', line: "Each machine's kit and Claude sign-in." },
  { id: 'extras', title: 'Extras', line: 'The manager, the nightly jobs, chat channels and optional modules.' },
];

/**
 * Setup, again: every first-run step can be opened from Settings, with the same screens as the
 * wizard. Passkeys and the PIN are in Security, above. Opening a step here does not change the setup state.
 */
export function SetupLinks() {
  const [open, setOpen] = useState<Open | null>(null);
  const close = (): void => setOpen(null);
  return (
    <Card title="Setup" subtitle="The first-run steps, any time.">
      <ul className="setup-links" data-testid="setup-links">
        {ROWS.map((row) => (
          <li key={row.id} className="setup-links__row">
            <span className="setup-links__text"><strong>{row.title}</strong> <span className="text-muted">{row.line}</span></span>
            <Button size="sm" data-testid={`setup-link-${row.id}`} onClick={() => setOpen(row.id)}>Open</Button>
          </li>
        ))}
        <li className="setup-links__row text-muted">Passkeys and the PIN: see Security.</li>
      </ul>
      {open !== null ? (
        <Modal open title={ROWS.find((row) => row.id === open)?.title ?? 'Setup'} onClose={close}>
          {open === 'rooms' ? <SetupRoomsBody onNext={close} /> : null}
          {open === 'connect' ? <SetupConnectBody onNext={close} fromSettings /> : null}
          {open === 'extras' ? <SetupExtrasBody onNext={close} fromSettings /> : null}
        </Modal>
      ) : null}
    </Card>
  );
}
