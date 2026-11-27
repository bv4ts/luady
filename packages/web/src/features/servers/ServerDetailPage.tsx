import { isHostId, type ActionDTO, type ServerDTO } from '@luady/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { Icon } from '../../ui/Icon.js';
import { Spinner } from '../../ui/Spinner.js';
import { useRooms } from '../rooms/useRooms.js';
import { ActionResult } from './ActionResult.js';
import { FileEditor } from './FileEditor.js';
import { RunCommand } from './RunCommand.js';
import { ServerCard } from './ServerCard.js';
import { SkillsPanel } from './SkillsPanel.js';
import './servers.css';

function ClaudeUpdate({ server, label }: { server: ServerDTO; label: string }) {
  const api = useApi();
  const { runPinned } = usePin();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionDTO | null>(null);
  const current = server.claudeVersion ?? 'unknown';

  async function update() {
    setBusy(true);
    setError(null);
    try {
      const action = await runPinned((pin) => api.updateClaude(server.name, { pin: mustPin(pin) }),
        { require: true, title: `Update Claude Code on ${label}`, detail: `Current version: ${current}` });
      if (action) setResult(action);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Claude Code" subtitle={`Installed: ${current}. Updating runs claude update on ${label}.`}>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="row"><Button variant="primary" icon="restart" busy={busy} onClick={() => void update()}>Update Claude Code</Button></div>
      {result ? <ActionResult action={result} label="Update result" /> : null}
    </Card>
  );
}

export function ServerDetailPage() {
  const { name = '' } = useParams();
  const { state } = useStore();
  const { hostLabel } = useRooms();
  const server = isHostId(name) ? state.servers.find((candidate) => candidate.name === name) : undefined;

  if (!state.loaded) return <div className="page page-loading"><Spinner size="lg" label="Loading the server" /></div>;
  if (!server) {
    return (
      <div className="page">
        <EmptyState icon="server" title="Server not found" body="This server is not in the hub's list. Pick one from all servers, or add it in Settings."
          action={<Link className="btn btn--secondary" to="/servers">All servers</Link>} />
      </div>
    );
  }
  const label = hostLabel(server.name);
  return (
    <div className="page">
      <header className="page-header">
        <div className="row">
          <Link to="/servers" className="btn btn--ghost btn--icon btn--sm" aria-label="Back to servers"><Icon name="back" /></Link>
          <h1 className={label === server.name ? 'mono' : undefined}>{label}</h1>
          {label === server.name ? null : <span className="mono text-subtle">{server.name}</span>}
        </div>
        {server.terminal ? (
          <Link to={`/terminal/${server.name}`} className="btn btn--secondary btn--sm"><Icon name="terminal" /><span className="btn__label">Open terminal</span></Link>
        ) : null}
      </header>
      <div className="server-detail">
        <ServerCard server={server} showLinks={false} />
        <RunCommand server={server.name} homeDir={server.homeDir} label={label} />
        <FileEditor server={server.name} homeDir={server.homeDir} label={label} />
        <SkillsPanel server={server.name} homeDir={server.homeDir} label={label} />
        <ClaudeUpdate server={server} label={label} />
      </div>
    </div>
  );
}
