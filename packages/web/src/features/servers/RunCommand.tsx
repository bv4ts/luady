import type { ActionDTO } from '@luady/shared';
import { useState } from 'react';
import type { ExecBody } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { usePin } from '../../pin/PinProvider.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { TextField } from '../../ui/Field.js';
import { ActionResult } from './ActionResult.js';

/** `homeDir`: the host's home folder, shown as the default working folder; null while the hub has not reported it. */
export function RunCommand({ server, homeDir, label = server }: { server: string; homeDir: string | null; label?: string }) {
  const api = useApi();
  const { runPinned } = usePin();
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionDTO | null>(null);

  async function run() {
    const text = command.trim();
    if (text === '') {
      setError('Type a command.');
      return;
    }
    const folder = cwd.trim();
    const body = (pin: string | undefined): ExecBody => ({ command: text, ...(folder ? { cwd: folder } : {}), ...(pin ? { pin } : {}) });
    setBusy(true);
    setError(null);
    try {
      const action = await runPinned((pin) => api.exec(server, body(pin)), { require: false, title: `Run on ${label}`, detail: text });
      if (action) setResult(action);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Run a command" subtitle="Read-only commands run at once. Anything that changes the server asks for your PIN.">
      <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void run(); }}>
        <TextField label="Command" className="input--mono" placeholder="df -h" value={command} maxLength={4000}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(event) => setCommand(event.target.value)} />
        <TextField label="Working folder (optional)" className="input--mono" placeholder={homeDir ?? 'the home folder'} value={cwd} maxLength={1024}
          autoCapitalize="off" spellCheck={false} onChange={(event) => setCwd(event.target.value)} />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="row"><Button type="submit" variant="primary" icon="play" busy={busy}>Run</Button></div>
      </form>
      {result ? <ActionResult action={result} label="Command result" /> : null}
    </Card>
  );
}
