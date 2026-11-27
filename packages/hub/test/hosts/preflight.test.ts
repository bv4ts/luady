import { describe, expect, it } from 'vitest';
import { localReport, parsePreflight, readPreflightLines } from '../../src/hosts/preflight.js';

/** A healthy Ubuntu server's preflight output. */
const GOOD: Record<string, string> = {
  os: 'Linux', home: '/home/dev', user: 'dev', python: '3.12', tmux: 'tmux 3.4', tar: 'yes', mktemp: 'yes',
  claude: '/home/dev/.local/bin/claude', claude_version: '2.1.330 (Claude Code)', projects: 'yes', kit_alias: '', kit_version: '',
};

const output = (over: Record<string, string> = {}): string =>
  Object.entries({ ...GOOD, ...over }).map(([key, value]) => `${key}=${value}`).join('\n');

describe('preflight in plain words', () => {
  it('a ready server has nothing missing', () => {
    const report = parsePreflight(output(), 'mars');
    expect(report.missing).toEqual([]);
    expect(report.ready).toBe(true);
    expect(report.values).toMatchObject({ os: 'Linux', python: '3.12', tmux: '3.4', claude_version: '2.1.330', ready: 'yes' });
    expect(report.home).toBe('/home/dev');
    expect(report.claudeVersion).toBe('2.1.330');
  });

  it('names each missing item: Python below 3.10, tmux, tar, mktemp, Claude Code', () => {
    expect(parsePreflight(output({ python: '3.8' }), 'mars').missing).toEqual(['Python 3.10 or later (python3); this server has Python 3.8']);
    expect(parsePreflight(output({ python: '' }), 'mars').missing).toEqual(['Python 3.10 or later (python3)']);
    expect(parsePreflight(output({ tmux: '' }), 'mars').missing).toEqual(['tmux']);
    expect(parsePreflight(output({ tar: 'no' }), 'mars').missing).toEqual(['tar']);
    expect(parsePreflight(output({ mktemp: 'no' }), 'mars').missing).toEqual(['mktemp']);
    expect(parsePreflight(output({ claude: '' }), 'mars', '/opt/claude/bin/claude').missing).toEqual(['Claude Code at /opt/claude/bin/claude']);
    expect(parsePreflight(output({ python: '3.9', tmux: '', claude: '' }), 'mars').ready).toBe(false);
  });

  it('macOS is named plainly and blocks', () => {
    const report = parsePreflight(output({ os: 'Darwin' }), 'mars');
    expect(report.missing).toEqual(['This is a Mac (macOS). The kit runs on Linux servers for now.']);
    expect(report.ready).toBe(false);
  });

  it('a kit installed for another alias is shown, but does not block', () => {
    const report = parsePreflight(output({ kit_alias: '"host_alias": "cedar"', kit_version: "__version__ = '2.1.0'" }), 'mars');
    expect(report.missing).toEqual(['The kit there was installed for another name (cedar). Installing it here renames it to mars.']);
    expect(report.ready).toBe(true);
    expect(report.kitAlias).toBe('cedar');
    expect(report.kitVersion).toBe('2.1.0');
    expect(parsePreflight(output({ kit_alias: '"host_alias": "mars"' }), 'mars').missing).toEqual([]);
  });

  it('treats the output as hostile: unknown keys, control characters, odd values and floods are dropped', () => {
    const hostile = [
      'evil=<script>alert(1)</script>', 'home=/home/dev; rm -rf /', `python=3.12\u001b[31m`, 'tmux=tmux 3.4', 'tar=yes', 'mktemp=yes',
      'claude=../../bin/claude', 'kit_alias="host_alias": "a b"', 'os=Linux', ...Array.from({ length: 500 }, (_v, i) => `os=Other${i}`),
    ].join('\n');
    const lines = readPreflightLines(hostile);
    expect(lines).not.toHaveProperty('evil');
    expect(lines.python).toBe('3.12[31m');
    const report = parsePreflight(hostile, 'mars');
    expect(report.home).toBeNull();
    expect(report.values.python).toBe('');
    expect(report.values.claude).toBe('');
    expect(report.kitAlias).toBeNull();
    expect(report.values.os).toBe('Linux');
    expect(Object.keys(report.values)).not.toContain('evil');
  });

  it('this computer: the platform, the alias and the local probe in the same shape', () => {
    const local = { python: '3.12.3', tmux: '3.4', claude: '2.1.330', missing: [] };
    const linux = localReport(local, { platform: 'linux', hostId: 'computer', home: '/home/me', kitAlias: null, kitVersion: null, projects: true });
    expect(linux.missing).toEqual([]);
    expect(linux.ready).toBe(true);
    const mac = localReport(local, { platform: 'darwin', hostId: 'computer', home: '/Users/me', kitAlias: 'cedar', kitVersion: '2.1.0', projects: true });
    expect(mac.missing).toEqual([
      'This computer is a Mac (macOS). The kit runs on Linux for now.',
      'The kit there was installed for another name (cedar). Installing it here renames it to computer.',
    ]);
    expect(mac.ready).toBe(false);
    const old = localReport({ ...local, missing: ['tmux 3.2 or later'] }, {
      platform: 'linux', hostId: 'computer', home: '/home/me', kitAlias: null, kitVersion: null, projects: false,
    });
    expect(old.missing).toEqual(['tmux 3.2 or later']);
    expect(old.values.projects).toBe('no');
  });
});
