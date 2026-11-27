import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the module at `metaUrl` is the file Node was started with (not imported by a test). */
export function isEntryFile(metaUrl: string): boolean {
  const started = process.argv[1];
  if (started === undefined) return false;
  const a = resolve(started);
  const b = fileURLToPath(metaUrl);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
