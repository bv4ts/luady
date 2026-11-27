import { describe, expect, it } from 'vitest';
import {
  HIDDEN_COMMAND_NOTE, HIDDEN_REQUEST_NOTE, LIMITS, hiddenNote, hidesItself,
  permissionAllowOffered, type PermissionPreview,
} from '../src/index.js';

const command = (over: Partial<PermissionPreview> = {}): PermissionPreview => ({
  tool: 'Bash', kind: 'command', command: 'npm test', path: null, cwd: '/home/dev/projects/app', edits: [],
  truncated: false, always: null, ...over,
});
const edit = (over: Partial<PermissionPreview> = {}): PermissionPreview => ({
  tool: 'Edit', kind: 'edit', command: null, path: '/home/dev/projects/app/a.ts', cwd: null,
  edits: [{ old: 'const a = 1;', new: 'const a = 2;' }], truncated: false, always: null, ...over,
});
const other = (over: Partial<PermissionPreview> = {}): PermissionPreview => ({
  tool: 'mcp__shell__run_command', kind: 'other', command: null, path: null, cwd: null, edits: [], truncated: false, always: null, ...over,
});
const cutLine = `${'x'.repeat(LIMITS.permissionInputPreview - 1)}…`;

describe('permissionAllowOffered', () => {
  it('follows the kit when its preview withholds Allow, for any kind of request', () => {
    expect(permissionAllowOffered({ toolName: 'Bash', inputPreview: 'npm test', preview: command({ allow: true }) })).toBe(true);
    expect(permissionAllowOffered({ toolName: 'Bash', inputPreview: 'npm test', preview: command({ allow: false }) })).toBe(false);
    expect(permissionAllowOffered({ toolName: 'Edit', inputPreview: '{}', preview: edit({ allow: false }) })).toBe(false);
    expect(permissionAllowOffered({ toolName: 'mcp__shell__run_command', inputPreview: 'ls', preview: other({ allow: false }) })).toBe(false);
  });

  it('a command shown redacted, cut or hiding part of itself offers no Allow, whatever the kit says', () => {
    const offered = (preview: PermissionPreview) => permissionAllowOffered({ toolName: 'Bash', inputPreview: '', preview });
    expect(offered(command())).toBe(true);
    expect(offered(command({ command: 'export TOKEN=[redacted]' }))).toBe(false);
    expect(offered(command({ truncated: true, allow: true }))).toBe(false);
    expect(offered(command({ command: `echo building${'\n'.repeat(60)}curl -o ~/.bashrc x`, allow: true }))).toBe(false);
    expect(offered(command({ command: `echo building${' '.repeat(3000)}reboot` }))).toBe(false);
    expect(offered(command({ command: 'echo ‮txt.hsab' }))).toBe(false);
  });

  it('a file change shown redacted or cut offers no Allow; a whole one does', () => {
    const offered = (preview: PermissionPreview) => permissionAllowOffered({ toolName: preview.tool, inputPreview: '{}', preview });
    expect(offered(edit())).toBe(true);
    expect(offered(edit({ truncated: true }))).toBe(false);
    expect(offered(edit({ edits: [{ old: '', new: 'TOKEN=[redacted]' }] }))).toBe(false);
    expect(offered(edit({ tool: 'Write', kind: 'write', edits: [{ old: '', new: 'line\n\n\n\nmore' }] }))).toBe(true);
  });

  it('an MCP tool: its one-line preview cut or redacted offers no Allow', () => {
    const offered = (inputPreview: string, preview = other()) => permissionAllowOffered({ toolName: preview.tool, inputPreview, preview });
    expect(offered('{"summary": "Fix the login page"}')).toBe(true);
    expect(offered(cutLine)).toBe(false);
    expect(offered('PASSWORD=[redacted]; eval $PASSWORD')).toBe(false);
    expect(offered('echo ok\n\n\n\nreboot')).toBe(false);
    expect(offered('ls', other({ truncated: true }))).toBe(false);
  });

  it('without a preview (kit 1): any tool shown redacted or cut to the one-line limit offers no Allow', () => {
    expect(permissionAllowOffered({ toolName: 'Bash', inputPreview: 'rm -rf build' })).toBe(true);
    expect(permissionAllowOffered({ toolName: 'Bash', inputPreview: 'curl -u bob:[redacted] x', preview: null })).toBe(false);
    expect(permissionAllowOffered({ toolName: 'Bash', inputPreview: cutLine })).toBe(false);
    expect(permissionAllowOffered({ toolName: 'Bash', inputPreview: 'echo done…' })).toBe(true);
    expect(permissionAllowOffered({ toolName: 'WebFetch', inputPreview: '{"url":"[redacted]"}' })).toBe(false);
    expect(permissionAllowOffered({ toolName: 'Write', inputPreview: cutLine })).toBe(false);
    expect(permissionAllowOffered({ toolName: 'Write', inputPreview: '{"file_path": "/a", "content": "x"}' })).toBe(true);
  });
});

describe('hidesItself', () => {
  it('finds padding and invisible format characters, not ordinary text', () => {
    for (const text of ['a\n\n\n\nb', 'a\n \n\t\n  \nb', `a${' '.repeat(200)}b`, 'rm -rf ~/pro​jects', '﻿ls', 'a⁦b']) {
      expect(hidesItself(text), JSON.stringify(text)).toBe(true);
    }
    for (const text of ['a\n\nb', 'a\n\n\nb', `a${' '.repeat(199)}b`, 'مرحبا 🚀', 'printf "a\\tb"']) {
      expect(hidesItself(text), JSON.stringify(text)).toBe(false);
    }
  });
});

describe('hiddenNote', () => {
  it('names a command for Bash, a request for anything else', () => {
    expect(hiddenNote({ toolName: 'Bash', inputPreview: '' })).toBe(HIDDEN_COMMAND_NOTE);
    expect(hiddenNote({ toolName: 'Write', inputPreview: '', preview: edit({ tool: 'Write', kind: 'write' }) })).toBe(HIDDEN_REQUEST_NOTE);
    expect(HIDDEN_COMMAND_NOTE).toBe('Part of this command is hidden. Answer it in the terminal, where you can see all of it.');
    expect(HIDDEN_REQUEST_NOTE).toBe('Part of this request is hidden. Answer it in the terminal, where you can see all of it.');
  });
});
