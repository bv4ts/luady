import { ValidationError } from '../core/errors.js';

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(value: string): string {
  const first = value.at(0);
  if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a systemd-style env file: one KEY=VALUE per line, `#` comment lines and blank lines.
 * Values are literal (no shell expansion, no escapes, no inline comments); one pair of matching
 * surrounding quotes is removed. Error messages never echo line contents, which may be secrets.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries = lines.flatMap((raw, index): Array<[string, string]> => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return [];
    const match = LINE_RE.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key === undefined || value === undefined) {
      throw new ValidationError(`secrets file line ${index + 1}: expected KEY=VALUE`);
    }
    return [[key, unquote(value.trim())]];
  });
  return Object.fromEntries(entries);
}
