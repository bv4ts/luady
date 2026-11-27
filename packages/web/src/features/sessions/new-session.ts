import { CreateSessionBodySchema, NAME_RE, isUnderRoot } from '@luady/shared';
import type { CreateSessionBody } from '../../api/client.js';

export const PROMPT_MAX = 20_000;

export interface NewSessionForm {
  readonly server: string;
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
}

export type NewSessionErrors = Partial<Record<keyof NewSessionForm, string>>;
export type NewSessionResult = { ok: true; body: CreateSessionBody } | { ok: false; errors: NewSessionErrors };

export function normalizeFolder(path: string): string {
  const trimmed = path.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
}

export function suggestName(cwd: string): string {
  const base = normalizeFolder(cwd).split('/').filter(Boolean).at(-1) ?? '';
  return base.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
}

/** The folder field's hint: inside the host's projects folder, or plainly a full path when the hub did not say one. */
export function folderHint(root: string | null): string {
  return root === null ? 'The full path of a project folder on this server.' : `Must be inside ${root}.`;
}

/**
 * The folder must be a plain absolute path; with the host's projects folder known, a project folder inside it (luady-ctl
 * start refuses the projects folder itself). Without one the hub checks the folder against the host's own root.
 */
function folderError(cwd: string, root: string | null): string | null {
  if (cwd.split('/').some((part) => part === '..' || part === '.')) return 'Use a plain path without "." or ".." parts.';
  if (root === null) return cwd.startsWith('/') ? null : 'Type the full path of the folder, starting with /.';
  if (!isUnderRoot(cwd, root)) return `Pick a folder inside ${root}.`;
  if (normalizeFolder(cwd) === normalizeFolder(root)) return `Pick a project folder inside ${root}, not the folder itself.`;
  return null;
}

/**
 * `root`: the chosen host's projects folder (ServerDTO.projectsRoot); null (the default) when it is not known, and the
 * hub checks the folder against the host's own root.
 */
export function validateNewSession(form: NewSessionForm, root: string | null = null): NewSessionResult {
  const cwd = normalizeFolder(form.cwd);
  const name = form.name.trim();
  const cwdError = folderError(cwd, root);
  const errors: NewSessionErrors = {
    ...(form.server === '' ? { server: 'Choose a server.' } : {}),
    ...(cwdError ? { cwd: cwdError } : {}),
    ...(name !== '' && !NAME_RE.test(name) ? { name: 'Use letters, digits, ".", "_" or "-" (up to 64).' } : {}),
    ...(form.prompt.length > PROMPT_MAX ? { prompt: 'Keep the first prompt under 20,000 characters.' } : {}),
  };
  if (form.server === '' || Object.keys(errors).length > 0) return { ok: false, errors };
  const body: CreateSessionBody = {
    server: form.server, cwd, ...(name ? { name } : {}), ...(form.prompt.trim() ? { prompt: form.prompt } : {}),
  };
  const parsed = CreateSessionBodySchema.safeParse(body);
  return parsed.success ? { ok: true, body } : { ok: false, errors: { cwd: parsed.error.issues[0]?.message ?? 'These session details are not valid.' } };
}
