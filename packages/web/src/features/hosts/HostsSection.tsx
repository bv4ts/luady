import { isLocalHost, type HostDTO } from '@luady/shared';
import { useState } from 'react';
import { useStore } from '../../state/store.js';
import { Badge } from '../../ui/Badge.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { Spinner } from '../../ui/Spinner.js';
import type { Tone } from '../../ui/tones.js';
import { AddServerFlow } from './AddServerFlow.js';
import { EditHostDialog } from './EditHostDialog.js';
import { hostStateText, resumeStep } from './flow-state.js';
import { CheckStep, KitStep } from './kit-steps.js';
import { LocalHostForm } from './LocalHostForm.js';
import { RemoveHostDialog } from './RemoveHostDialog.js';
import { useHostList } from './store.js';
import { useGrants, type Grants } from './useGrants.js';
import './hosts.css';

export interface HostsSectionProps {
  /** The setup wizard's short form: the list and the two "add" buttons only. */
  compact?: boolean;
}

type Dialog =
  | { kind: 'add' }
  | { kind: 'local' }
  | { kind: 'continue'; host: HostDTO }
  | { kind: 'check'; host: HostDTO }
  | { kind: 'kit'; host: HostDTO; mode: 'install' | 'uninstall' }
  | { kind: 'edit'; host: HostDTO }
  | { kind: 'remove'; host: HostDTO };

function stateTone(host: HostDTO): Tone {
  if (host.state === 'draft') return 'waiting';
  if (host.lastError === 'auth' || host.lastError === 'hostkey' || host.link === 'offline') return 'error';
  return host.link === 'online' ? 'idle' : 'starting';
}

function HostRow({ host, done, compact, open }: { host: HostDTO; done: boolean; compact: boolean; open: (dialog: Dialog) => void }) {
  const local = host.kind === 'local';
  const config = host.source === 'config';
  const name = local ? 'This computer' : host.id;
  return (
    <li className="host-row" data-testid={`host-row-${host.id}`}>
      <div className="host-row__main">
        <span className="host-row__name">{name}</span>
        <span className="host-row__where text-muted mono">{local ? host.projectsRoot ?? '' : `${host.user}@${host.host}:${host.port}`}</span>
        <span className="host-row__facts">
          <Badge tone={stateTone(host)}>{hostStateText(host)}</Badge>
          <span className="text-muted">{host.kitVersion === null ? 'no kit' : `kit ${host.kitVersion}`}</span>
          {config ? <span className="text-muted">from config.json</span> : null}
        </span>
      </div>
      <div className="host-row__actions">
        {!done && !config ? <Button size="sm" variant="primary" onClick={() => open({ kind: 'continue', host })}>Continue setup</Button> : null}
        {!compact && host.state === 'pinned' ? <Button size="sm" onClick={() => open({ kind: 'check', host })}>Check</Button> : null}
        {/* A server from config.json has no "Continue setup": the short list offers its kit too. */}
        {host.state === 'pinned' && (!compact || config) ? (
          <Button size="sm" onClick={() => open({ kind: 'kit', host, mode: 'install' })}>{host.kitVersion === null ? 'Install kit' : 'Update kit'}</Button>
        ) : null}
        {!compact && host.state === 'pinned' && host.kitVersion !== null ? (
          <Button size="sm" variant="ghost" onClick={() => open({ kind: 'kit', host, mode: 'uninstall' })}>Remove kit</Button>
        ) : null}
        {!compact && !config ? <Button size="sm" variant="ghost" onClick={() => open({ kind: 'edit', host })}>Edit</Button> : null}
        {!compact && !config ? <Button size="sm" variant="danger" onClick={() => open({ kind: 'remove', host })}>Remove</Button> : null}
      </div>
      {config && !compact ? <p className="host-row__note text-muted">Its address and folders come from config.json; change or remove it there.</p> : null}
    </li>
  );
}

function ActionDialog({ dialog, grants, close }: { dialog: Exclude<Dialog, { kind: 'add' | 'local' | 'continue' | 'edit' | 'remove' }>; grants: Grants; close: () => void }) {
  const title = dialog.kind === 'check' ? `Check ${dialog.host.id}` : `${dialog.mode === 'uninstall' ? 'Remove' : 'Install'} the kit`;
  return (
    <Modal open title={title} onClose={close}>
      {dialog.kind === 'check'
        ? <CheckStep host={dialog.host} grants={grants} onNext={close} />
        : <KitStep host={dialog.host} grants={grants} onNext={close} mode={dialog.mode} fresh />}
    </Modal>
  );
}

function DialogView({ dialog, grants, close, refresh }: { dialog: Dialog; grants: Grants; close: () => void; refresh: () => void }) {
  switch (dialog.kind) {
    case 'add':
      return <Modal open title="Add a server" onClose={close}><AddServerFlow mode="settings" onDone={close} onCancel={close} /></Modal>;
    case 'local':
      return <Modal open title="Add this computer" onClose={close}><LocalHostForm onDone={close} /></Modal>;
    case 'continue':
      return (
        <Modal open title={dialog.host.kind === 'local' ? 'Set up this computer' : `Set up ${dialog.host.id}`} onClose={close}>
          {dialog.host.kind === 'local' ? <LocalHostForm onDone={close} /> : <AddServerFlow mode="settings" resume={dialog.host.id} onDone={close} onCancel={close} />}
        </Modal>
      );
    case 'edit':
      return <EditHostDialog host={dialog.host} onClose={close} />;
    case 'remove':
      return <RemoveHostDialog host={dialog.host} onClose={close} onRemoved={refresh} />;
    default:
      return <ActionDialog dialog={dialog} grants={grants} close={close} />;
  }
}

/** The hosts list: state, link, kit and source, with each host's actions; config rows stay read-only. */
export function HostsSection({ compact = false }: HostsSectionProps) {
  const { state } = useStore();
  const list = useHostList();
  const grants = useGrants();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const hosts = list.hosts;
  const hasLocal = hosts?.some((host) => isLocalHost(host.id)) ?? true;
  return (
    <div className="hosts-section stack" data-testid="hosts-section">
      {list.error !== null ? <Banner tone="error">{list.error}</Banner> : null}
      {hosts === null && list.error === null ? <Spinner /> : null}
      {hosts !== null && hosts.length === 0 ? <p className="text-muted">No servers yet. Add one, or this computer.</p> : null}
      {hosts !== null && hosts.length > 0 ? (
        <ul className="host-list">
          {hosts.map((host) => (
            <HostRow key={host.id} host={host} compact={compact} open={setDialog} done={host.kind === 'local' ? host.kitVersion !== null : resumeStep(host, state.rooms) === 'done'} />
          ))}
        </ul>
      ) : null}
      <div className="row">
        <Button icon="plus" variant="primary" onClick={() => setDialog({ kind: 'add' })}>Add a server</Button>
        {hasLocal ? null : <Button icon="plus" onClick={() => setDialog({ kind: 'local' })}>Add this computer</Button>}
      </div>
      {dialog !== null ? <DialogView dialog={dialog} grants={grants} close={() => { setDialog(null); void list.refresh(); }} refresh={() => void list.refresh()} /> : null}
    </div>
  );
}
