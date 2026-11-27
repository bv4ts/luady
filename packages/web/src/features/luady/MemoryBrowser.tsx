import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import type { MemoryEntry, MemoryFile } from '../../api/schemas.js';
import { formatBytes } from '../../lib/format.js';
import { Markdown } from '../../markdown/Markdown.js';
import { Banner } from '../../ui/Banner.js';
import { Button } from '../../ui/Button.js';
import { Card } from '../../ui/Card.js';
import { Icon } from '../../ui/Icon.js';
import { Spinner } from '../../ui/Spinner.js';
import { managerName } from '@luady/shared';

function useMemoryFiles() {
  const api = useApi();
  const [files, setFiles] = useState<readonly MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<MemoryFile | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.memoryFiles().then(
      (result) => { if (!cancelled) setFiles(result.files.toSorted((a, b) => a.name.localeCompare(b.name))); },
      (err: unknown) => { if (!cancelled) setError(userMessage(err)); },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const openFile = useCallback(async (name: string) => {
    setOpening(name);
    setError(null);
    try {
      setOpen(await api.memoryFile(name));
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setOpening(null);
    }
  }, [api]);
  const close = useCallback(() => setOpen(null), []);

  return { files, error, open, opening, openFile, close };
}

function MemoryViewer({ file, onBack }: { file: MemoryFile; onBack: () => void }) {
  return (
    <article className="card memory-viewer" aria-label={file.name}>
      <header className="card__header">
        <Button variant="ghost" size="sm" icon="back" onClick={onBack}>All files</Button>
        <span className="mono text-subtle">{file.name}</span>
      </header>
      <Markdown source={file.content} />
    </article>
  );
}

export function MemoryBrowser() {
  const { files, error, open, opening, openFile, close } = useMemoryFiles();
  if (open) return <MemoryViewer file={open} onBack={close} />;
  return (
    <Card title="Memory" subtitle={`${managerName()}'s own notes, read-only. ${managerName()} keeps them up to date.`}>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {files === null && !error ? <Spinner label="Loading memory files" /> : null}
      {files?.length === 0 ? <p className="text-muted">No memory files yet.</p> : null}
      {files && files.length > 0 ? (
        <ul className="memory-list">
          {files.map((file) => (
            <li key={file.name}>
              <button type="button" className="memory-item" disabled={opening !== null} onClick={() => void openFile(file.name)}>
                <Icon name="book" />
                <span className="memory-item__name mono">{file.name}</span>
                <span className="text-subtle">{formatBytes(file.size)}</span>
                {opening === file.name ? <Spinner size="sm" /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
