import type { ActionDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { usePin } from '../../pin/PinProvider.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { TextField } from '../../ui/Field.js';
import { ActionResult } from './ActionResult.js';

const PACKAGE_RE = /^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,127}$/;

/** Claude Code's skills folder in the host's home; `~` (the shell's home) while the hub has not reported it. */
export function skillsDir(homeDir: string | null): string {
  return `${homeDir === null ? '~' : homeDir.replace(/\/+$/, '')}/.claude/skills`;
}

/** Exec through the 0/1 route: read-only commands run directly, others get the PIN modal on 428. */
function useSkillExec(server: string) {
  const api = useApi();
  const { runPinned } = usePin();
  const [busy, setBusy] = useState<'list' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionDTO | null>(null);

  const exec = useCallback(async (kind: 'list' | 'install', command: string, title: string) => {
    setBusy(kind);
    setError(null);
    try {
      const action = await runPinned((pin) => api.exec(server, { command, ...(pin ? { pin } : {}) }), { require: false, title, detail: command });
      if (action) setResult(action);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(null);
    }
  }, [api, runPinned, server]);

  return { exec, busy, error, setError, result };
}

/** `homeDir`: the host's home folder (its skills live in `.claude/skills` there); null while the hub has not reported it. */
export function SkillsPanel({ server, homeDir, label = server }: { server: string; homeDir: string | null; label?: string }) {
  const { exec, busy, error, setError, result } = useSkillExec(server);
  const [pkg, setPkg] = useState('');
  const dir = skillsDir(homeDir);

  function install() {
    const name = pkg.trim();
    if (!PACKAGE_RE.test(name)) {
      setError('Use a package name like owner/repo or @scope/skill.');
      return;
    }
    void exec('install', `npx -y skills add ${name} -g -y`, `Install ${name} on ${label}`);
  }

  const hint = 'Runs npx -y skills add with your package and asks for your PIN. It needs Node.js on the server.';

  return (
    <Card title="Skills" subtitle={`Claude Code skills in ${dir}.`}>
      <div className="row">
        <Button size="sm" variant="secondary" icon="book" busy={busy === 'list'}
          onClick={() => void exec('list', `ls -1 ${dir}`, `List skills on ${label}`)}>List skills</Button>
      </div>
      <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); install(); }}>
        <TextField label="Install a skill" className="input--mono" placeholder="owner/repo" value={pkg} hint={hint}
          autoCapitalize="off" spellCheck={false} onChange={(event) => setPkg(event.target.value)} />
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="row"><Button type="submit" size="sm" variant="primary" icon="plus" busy={busy === 'install'}>Install</Button></div>
      </form>
      {result ? <ActionResult action={result} label="Skills result" /> : null}
    </Card>
  );
}
