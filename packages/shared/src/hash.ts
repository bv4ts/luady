import { createHash } from 'node:crypto';

/** Must match server-kit: text.replace('\r\n','\n').strip(' \t\n\r\f\v') then sha256 of UTF-8. */
export function normalizeForHash(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
}

export function promptHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}
