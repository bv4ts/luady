import { describe, expect, it } from 'vitest';
import { folderHint, suggestName, validateNewSession } from '../../../src/features/sessions/new-session.js';

const ROOT = '/home/dev/projects';
const base = { server: 'cedar' as const, cwd: '/home/dev/projects/meadow-hr/', name: '', prompt: '' };

describe('validateNewSession', () => {
  it('builds the minimal body', () => {
    expect(validateNewSession(base, ROOT)).toEqual({ ok: true, body: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr' } });
    expect(validateNewSession({ ...base, name: ' hr-fix ', prompt: 'Fix login' }, ROOT))
      .toEqual({ ok: true, body: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', name: 'hr-fix', prompt: 'Fix login' } });
  });

  it('reports every invalid field', () => {
    const result = validateNewSession({ server: '', cwd: '/etc', name: 'bad name', prompt: 'x'.repeat(20_001) }, ROOT);
    expect(result).toEqual({
      ok: false,
      errors: {
        server: 'Choose a server.',
        cwd: 'Pick a folder inside /home/dev/projects.',
        name: 'Use letters, digits, ".", "_" or "-" (up to 64).',
        prompt: 'Keep the first prompt under 20,000 characters.',
      },
    });
    expect(validateNewSession({ ...base, cwd: '/home/dev/projects/../.ssh' }, ROOT))
      .toEqual({ ok: false, errors: { cwd: 'Use a plain path without "." or ".." parts.' } });
    expect(validateNewSession({ ...base, cwd: '/home/dev/projectsX' }, ROOT).ok).toBe(false);
    expect(validateNewSession({ ...base, cwd: '/home/dev/projects/' }, ROOT))
      .toEqual({ ok: false, errors: { cwd: 'Pick a project folder inside /home/dev/projects, not the folder itself.' } });
  });

  it('checks the folder against the chosen host\'s own projects folder', () => {
    const work = { ...base, server: 'mars', cwd: '/srv/work/api' };
    expect(validateNewSession(work, '/srv/work')).toEqual({ ok: true, body: { server: 'mars', cwd: '/srv/work/api' } });
    expect(validateNewSession({ ...work, cwd: '/home/dev/projects/api' }, '/srv/work'))
      .toEqual({ ok: false, errors: { cwd: 'Pick a folder inside /srv/work.' } });
  });

  it('without a known projects folder only asks for an absolute plain path (the hub checks the rest)', () => {
    expect(validateNewSession({ ...base, cwd: '/opt/code/api' }, null)).toEqual({ ok: true, body: { server: 'cedar', cwd: '/opt/code/api' } });
    expect(validateNewSession({ ...base, cwd: 'code/api' }, null))
      .toEqual({ ok: false, errors: { cwd: 'Type the full path of the folder, starting with /.' } });
    expect(validateNewSession({ ...base, cwd: '' }, null))
      .toEqual({ ok: false, errors: { cwd: 'Type the full path of the folder, starting with /.' } });
  });

  it('suggests a tmux-safe name from the folder', () => {
    expect(suggestName('/home/dev/projects/meadow hr/')).toBe('meadow-hr');
    expect(suggestName('')).toBe('');
  });

  it('words the folder hint from the root, or plainly without one', () => {
    expect(folderHint('/srv/work')).toBe('Must be inside /srv/work.');
    expect(folderHint(null)).toBe('The full path of a project folder on this server.');
  });
});
