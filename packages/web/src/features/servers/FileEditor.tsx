import type { CtlFileRead } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { describeAction } from '../../lib/actions.js';
import { basename, formatBytes } from '../../lib/format.js';
import { mustPin, usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { TextAreaField, TextField } from '../../ui/Field.js';

/** The Claude Code files worth one press, inside the host's home folder; none while the hub has not reported it. */
export function quickFiles(homeDir: string | null): readonly string[] {
  if (homeDir === null) return [];
  const home = homeDir.replace(/\/+$/, '');
  return [`${home}/.claude/settings.json`, `${home}/.claude/CLAUDE.md`];
}

const FILE_CONTENT_MAX = 500_000;

/** Stops edits that would break the file before the PIN is even requested. */
export function validateContent(path: string, content: string): string | null {
  if (content.length > FILE_CONTENT_MAX) return 'Files over 500,000 characters cannot be saved from here.';
  if (!path.endsWith('.json')) return null;
  try {
    JSON.parse(content);
    return null;
  } catch (err) {
    return `This is not valid JSON (${err instanceof Error ? err.message : 'parse error'}). Fix it before saving.`;
  }
}

/** Tier-1 write (PIN first). Resolves true when the hub wrote the file. */
function useSaveFile(server: string, label: string, path: string) {
  const api = useApi();
  const { toast } = useStore();
  const { runPinned } = usePin();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async (content: string): Promise<boolean> => {
    const problem = validateContent(path, content);
    if (problem) {
      setError(problem);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const action = await runPinned((pin) => api.writeFile(server, { path, content, pin: mustPin(pin) }),
        { require: true, title: `Save ${basename(path)} on ${label}`, detail: path });
      if (!action) return false;
      const outcome = describeAction(action);
      toast(outcome.kind, outcome.text);
      return action.status === 'done';
    } catch (err) {
      setError(userMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, label, path, runPinned, server, toast]);

  return { save, busy, error };
}

/** Remounted (via `key`) for every opened file, so the draft always starts from what was loaded. */
function FileContents({ server, label, file }: { server: string; label: string; file: CtlFileRead }) {
  const { save, busy, error } = useSaveFile(server, label, file.path);
  const [saved, setSaved] = useState(file.content);
  const [draft, setDraft] = useState(file.content);
  const dirty = draft !== saved;
  const size = saved === file.content ? file.size : new TextEncoder().encode(saved).length;

  async function submit() {
    if (await save(draft)) setSaved(draft);
  }

  return (
    <div className="stack">
      <p className="text-subtle mono">{file.path} · {formatBytes(size)}</p>
      {file.truncated ? <Banner tone="warn">Only the start of this file was loaded, so editing is off to keep the rest safe.</Banner> : null}
      <TextAreaField label={`Contents of ${basename(file.path)}`} className="textarea--mono file-editor__text" rows={16}
        value={draft} readOnly={file.truncated} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="row row--end">
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(saved)}>Revert</Button>
        <Button variant="primary" icon="lock" busy={busy} disabled={!dirty || file.truncated || busy}
          onClick={() => void submit()}>Save with PIN</Button>
      </div>
    </div>
  );
}

/**
 * Reads and saves text files on one host. `homeDir`: the host's home folder (ServerDTO.homeDir), for the quick files;
 * null while the hub has not reported it. `label`: the host as the owner knows it.
 */
export function FileEditor({ server, homeDir, label = server }: { server: string; homeDir: string | null; label?: string }) {
  const api = useApi();
  const quick = quickFiles(homeDir);
  const [path, setPath] = useState<string>(quick[0] ?? '');
  const [loaded, setLoaded] = useState<{ readonly file: CtlFileRead; readonly version: number } | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open(target: string) {
    const clean = target.trim();
    if (!clean.startsWith('/')) {
      setError(`Use an absolute path, for example ${quick[0] ?? '/etc/hostname'}.`);
      return;
    }
    setOpening(true);
    setError(null);
    try {
      const file = await api.readFile(server, clean);
      setLoaded((prev) => ({ file, version: (prev?.version ?? 0) + 1 }));
      setPath(file.path);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setOpening(false);
    }
  }

  return (
    <Card title="Files" subtitle="Read any text file. Saving needs your PIN.">
      <form className="stack" noValidate onSubmit={(event) => { event.preventDefault(); void open(path); }}>
        <TextField label="Path" className="input--mono" value={path} placeholder="/full/path/to/file" autoCapitalize="off" spellCheck={false}
          onChange={(event) => setPath(event.target.value)} />
        <div className="row">
          {quick.map((file) => (
            <Button key={file} size="sm" variant="ghost" icon="file" onClick={() => void open(file)}>{basename(file)}</Button>
          ))}
          <span className="spacer" />
          <Button type="submit" size="sm" variant="secondary" busy={opening}>Open</Button>
        </div>
      </form>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loaded ? <FileContents key={loaded.version} server={server} label={label} file={loaded.file} /> : null}
    </Card>
  );
}
