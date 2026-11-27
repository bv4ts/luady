import { ActionStatusSchema, type ActionDTO, type ActionStatus, managerName } from '@luady/shared';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { channelLabel } from '../../lib/channels.js';
import { ownerDateTime, truncate } from '../../lib/format.js';
import { Badge } from '../../ui/Badge.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { SelectField } from '../../ui/Field.js';
import { Spinner } from '../../ui/Spinner.js';
import { actionTone } from '../../ui/tones.js';

const FILTERS = [
  { value: '', label: 'All statuses' },
  ...ActionStatusSchema.options.map((status) => ({ value: status, label: status.replace('_', ' ') })),
];

function parseStatus(value: string): ActionStatus | '' {
  const parsed = ActionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : '';
}

function AuditRow({ action }: { action: ActionDTO }) {
  return (
    <tr>
      <td className="mono">{ownerDateTime(action.createdAt)}</td>
      <td>
        <span className="mono">#{action.id}</span> {action.summary}
        <br /><span className="text-subtle">{action.kind} · tier {action.tier}</span>
      </td>
      <td>{action.actor} · {channelLabel(action.channel)}</td>
      <td><Badge tone={actionTone(action.status)}>{action.status.replace('_', ' ')}</Badge></td>
      <td className="audit__result">{truncate(action.error ?? action.result ?? '—', 160)}</td>
    </tr>
  );
}

export function AuditLog() {
  const api = useApi();
  const [status, setStatus] = useState<ActionStatus | ''>('');
  const [rows, setRows] = useState<readonly ActionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    api.actions(status ? { status, limit: 100 } : { limit: 100 }).then(
      (list) => { if (!cancelled) setRows(list); },
      (err: unknown) => { if (!cancelled) setError(userMessage(err)); },
    );
    return () => {
      cancelled = true;
    };
  }, [api, status, reloads]);

  return (
    <Card title="Audit log" subtitle={`Every action from the website, the chat and ${managerName()}, newest first.`}
      actions={<Button variant="ghost" size="sm" icon="restart" onClick={() => setReloads((n) => n + 1)}>Reload</Button>}>
      <SelectField label="Status" value={status} options={FILTERS} onChange={(event) => setStatus(parseStatus(event.target.value))} />
      {error ? <Banner tone="error">{error}</Banner> : null}
      {rows === null && !error ? <Spinner label="Loading the audit log" /> : null}
      {rows?.length === 0 ? <p className="text-muted">No actions yet.</p> : null}
      {rows && rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th scope="col">When</th><th scope="col">Action</th><th scope="col">Who</th><th scope="col">Status</th><th scope="col">Result</th></tr>
            </thead>
            <tbody>{rows.map((action) => <AuditRow key={action.id} action={action} />)}</tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}
