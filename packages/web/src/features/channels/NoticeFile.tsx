import type { NoticeFile as NoticeFileDTO } from '@luady/shared';
import { useState } from 'react';
import type { ChannelsApi } from '../../api/channels.js';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { Button } from '../../ui/Button.js';

/** The most this page holds in memory to save a file; a bigger one is not fetched here. */
export const NOTICE_FILE_MEMORY_MAX_BYTES = 100 * 1_048_576;

export function fileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * A file the hub kept for the owner while no chat channel was up. The download carries the page key,
 * so it is fetched here and saved through a temporary object URL; the hub always answers it as an attachment. The
 * bytes are rewrapped as `application/octet-stream`, so the browser saves them and never renders them, and a file
 * over NOTICE_FILE_MEMORY_MAX_BYTES is not fetched at all.
 */
export function NoticeFile({ file, api }: { file: NoticeFileDTO; api?: ChannelsApi }) {
  const client = useApi();
  const channels = api ?? client.channels;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooBig = file.size > NOTICE_FILE_MEMORY_MAX_BYTES;

  async function download(): Promise<void> {
    if (tooBig) return;
    setBusy(true);
    setError(null);
    try {
      const fetched = await channels.download(file);
      if (fetched.size > NOTICE_FILE_MEMORY_MAX_BYTES) throw new Error(`The file is bigger than ${fileSize(NOTICE_FILE_MEMORY_MAX_BYTES)}.`);
      const url = URL.createObjectURL(new Blob([fetched], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (tooBig) {
    return (
      <span className="notice-file text-subtle">
        {`${file.name} (${fileSize(file.size)}) is too big to save from this page. It stays in the hub's outbox folder for 30 days.`}
      </span>
    );
  }

  return (
    <span className="notice-file">
      <Button size="sm" icon="file" busy={busy} onClick={() => void download()}>
        {`${file.name} (${fileSize(file.size)})`}
      </Button>
      {error === null ? null : <span className="form-error" role="alert">{error}</span>}
    </span>
  );
}
