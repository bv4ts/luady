import { describe, expect, it } from 'vitest';
import { LIMITS, type PermissionPreview, type QuestionDTO } from '@luady/shared';
import { formatPending, formatPermission } from '../../src/notify/format.js';
import { chatCut, chatNoAllowReason, lineChanges } from '../../src/notify/permission-text.js';

const FENCE = '```';
const HINT = '↩️ Reply *yes* to allow or *no* to deny (anything else = deny with your message).';
const OLD = 'export function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}';
const NEW = 'export function total(items: Item[]): number {\n  let sum = 0;\n  for (const item of items) sum += item.price * item.quantity;\n'
  + '  return Math.round(sum * 100) / 100;\n}';

function preview(over: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    tool: 'Edit', kind: 'edit', command: null, path: '/home/dev/projects/app/src/app.ts', cwd: '/home/dev/projects/app',
    edits: [{ old: OLD, new: NEW }], truncated: false, always: { label: 'Edit' }, ...over,
  };
}

const raw = JSON.stringify({ file_path: '/home/dev/projects/app/src/app.ts', old_string: OLD, new_string: NEW });

describe('the chat text of a permission request, built from the structured preview', () => {
  it('an edit: tool and file first, then "−N +M lines" and the changed lines, never the raw JSON', () => {
    const text = formatPermission('birch · app', 'QRSTUVWX', 'Edit', raw, preview());
    expect(text).toBe([
      '🔴 *Needs your OK* · birch · app  #QRSTUVWX',
      'Wants to use *Edit* on /home/dev/projects/app/src/app.ts',
      '−3 +3 lines',
      `${FENCE}- export function total(items) {`,
      '+ export function total(items: Item[]): number {',
      '-   for (const item of items) sum += item.price;',
      '-   return sum;',
      '+   for (const item of items) sum += item.price * item.quantity;',
      `+   return Math.round(sum * 100) / 100;${FENCE}`,
      HINT,
    ].join('\n'));
    expect(text).not.toContain('old_string');
  });

  it('a command: tool and folder first, then the command', () => {
    const text = formatPermission('cedar · api', 'ABCDEFGH', 'Bash', '{"command":"npm test"}', preview({
      tool: 'Bash', kind: 'command', command: 'npm test', path: null, edits: [],
    }));
    expect(text.split('\n').slice(1, 3)).toEqual(['Wants to use *Bash* in /home/dev/projects/app', `${FENCE}npm test${FENCE}`]);
  });

  it('a new file counts its lines as added', () => {
    const text = formatPermission('cedar · api', 'ABCDEFGH', 'Write', '{}', preview({ tool: 'Write', kind: 'write', edits: [{ old: '', new: 'a\nb' }] }));
    expect(text).toContain('−0 +2 lines');
  });

  it.for([
    ['an edit cut by the kit', preview({ truncated: true })],
    ['an edit with a redacted line', preview({ edits: [{ old: '', new: 'TOKEN=[redacted]' }] })],
    ['an MCP tool cut by the kit', preview({ tool: 'mcp__shell__run_command', kind: 'other', path: null, edits: [], truncated: true })],
  ] as const)('a request with a hidden part says why and asks only for a deny: %s', ([, value]) => {
    const text = formatPermission('cedar · api', 'ABCDEFGH', value.tool, '{}', value);
    expect(text.split('\n').slice(-2)).toEqual([
      '_Part of this request is hidden. Answer it in the terminal, where you can see all of it._',
      '↩️ Reply *no* to deny (anything else = deny with your message).',
    ]);
    expect(text).not.toContain('*yes*');
  });

  it.for([
    ['cut to the chat length', preview({ edits: [{ old: '', new: 'x'.repeat(LIMITS.chatPermissionPreview * 2) }] })],
  ] as const)('offers only no, and says why, when %s', ([, value]) => {
    const text = formatPermission('cedar · api', 'ABCDEFGH', value.tool, '{}', value);
    expect(text).toContain('_This request is too long to show here in full. Answer it on the website or in the terminal, where you can see all of it._');
    expect(text).not.toContain(HINT);
    expect(text.length).toBeLessThan(LIMITS.chatPermissionPreview + 400);
  });

  it.for([
    ['the kit offers no Allow', preview({ tool: 'Bash', kind: 'command', command: 'npm test', path: null, edits: [], always: null, allow: false })],
    ['an older kit redacted it', preview({ tool: 'Bash', kind: 'command', command: 'cat [redacted]', path: null, edits: [] })],
    ['an older kit cut it', preview({ tool: 'Bash', kind: 'command', command: 'echo x…', path: null, edits: [], truncated: true })],
  ] as const)('a command with a hidden part says why and asks only for a deny when %s', ([, value]) => {
    const text = formatPermission('cedar · api', 'ABCDEFGH', 'Bash', '{}', value);
    expect(text.split('\n').slice(-2)).toEqual([
      '_Part of this command is hidden. Answer it in the terminal, where you can see all of it._',
      '↩️ Reply *no* to deny (anything else = deny with your message).',
    ]);
    expect(text).not.toContain('_Part of this is hidden._');
    expect(text).not.toContain('*yes*');
  });

  it('a kit-1 command shown redacted asks only for a deny too', () => {
    const text = formatPermission('cedar · api', 'ABCDEFGH', 'Bash', 'curl -u bob:[redacted] https://x.test');
    expect(text).toContain('_Part of this command is hidden. Answer it in the terminal, where you can see all of it._');
    expect(text).not.toContain('*yes*');
  });

  it('a request without a preview (kit 1) keeps its old text', () => {
    expect(formatPermission('cedar · api', 'ABCDEFGH', 'Bash', 'npm test')).toBe(
      ['🔴 *Needs your OK* · cedar · api  #ABCDEFGH', 'Wants to use *Bash*:', `${FENCE}npm test${FENCE}`, HINT].join('\n'),
    );
  });

  it('formatPending (the question message and its notice) uses the preview when the question has one', () => {
    const question = {
      qid: 'QRSTUVWX', kind: 'permission', host: 'birch', sessionId: 'birch:cc-app:0.0', sessionLabel: 'birch · app', questions: [],
      permission: { toolName: 'Edit', inputPreview: raw, preview: preview() }, state: 'pending', createdAt: '2026-11-14T10:00:00.000Z',
      resolvedAt: null, resolvedVia: null,
    } as QuestionDTO;
    expect(formatPending('birch · app', question)).toContain('−3 +3 lines');
  });
});

describe('a request the chat had to cut, of any kind', () => {
  const long = 'x'.repeat(LIMITS.chatPermissionPreview + 100);
  const offersOnlyNo = (text: string): void => {
    expect(text).toContain('_This request is too long to show here in full. Answer it on the website or in the terminal, where you can see all of it._');
    expect(text.endsWith('↩️ Reply *no* to deny (anything else = deny with your message).')).toBe(true);
    expect(text).not.toContain('Reply *yes*');
  };

  it('offers only no for the input of an MCP tool, a file change and a kit-1 request, as for a command', () => {
    const mcp = preview({ tool: 'mcp__shell__run', kind: 'other', path: null, cwd: null, edits: [], always: null, allow: true });
    offersOnlyNo(formatPermission('cedar · api', 'ABCDEFGH', 'mcp__shell__run', long, mcp));
    const lines = Array.from({ length: 70 }, (_, i) => `echo line ${i}`).join('\n');
    const write = preview({ tool: 'Write', kind: 'write', path: '/home/dev/.bashrc', edits: [{ old: '', new: lines }], allow: true });
    offersOnlyNo(formatPermission('cedar · api', 'ABCDEFGH', 'Write', '{}', write));
    offersOnlyNo(formatPermission('cedar · api', 'ABCDEFGH', 'mcp__shell__run', long));
    offersOnlyNo(formatPermission('cedar · api', 'ABCDEFGH', 'Bash', 'echo ' + long));
  });

  it('counts as cut only a fenced text longer than the chat shows', () => {
    const at = (size: number) => ({ toolName: 'Bash', inputPreview: 'x'.repeat(size) });
    expect(chatCut(at(LIMITS.chatPermissionPreview))).toBe(false);
    expect(chatCut(at(LIMITS.chatPermissionPreview + 1))).toBe(true);
    const fewLines = preview({ tool: 'Write', kind: 'write', edits: [{ old: '', new: 'a' }], allow: true });
    expect(chatCut({ toolName: 'Write', inputPreview: 'x'.repeat(5000), preview: fewLines })).toBe(false);
  });

  it('keeps yes for a request the chat shows whole', () => {
    const mcp = preview({ tool: 'mcp__shell__run', kind: 'other', path: null, cwd: null, edits: [], always: null, allow: true });
    expect(formatPermission('cedar · api', 'ABCDEFGH', 'mcp__shell__run', 'ls -la', mcp).endsWith(HINT)).toBe(true);
  });

  it('gives the hidden-part reason, not the website, when the kit withholds Allow and the chat cut it too', () => {
    const withheld = preview({ tool: 'Bash', kind: 'command', command: long, path: null, edits: [], always: null, allow: false });
    const text = formatPermission('cedar · api', 'ABCDEFGH', 'Bash', long, withheld);
    expect(text).toContain('Part of this command is hidden. Answer it in the terminal');
    expect(text).not.toContain('on the website');
    expect(chatNoAllowReason({ toolName: 'Bash', inputPreview: long, preview: withheld })).toMatch(/^Part of this command is hidden/);
    expect(chatNoAllowReason({ toolName: 'Bash', inputPreview: long, preview: { ...withheld, allow: true } })).toBe('This request is too long to show here in full. Answer it on the website or in the terminal, where you can see all of it.');
    expect(chatNoAllowReason({ toolName: 'Bash', inputPreview: 'ls', preview: { ...withheld, command: 'ls', allow: true } })).toBeNull();
  });
});

describe('lineChanges', () => {
  it('counts only the lines that changed', () => {
    expect(lineChanges(OLD, NEW).map((change) => change.sign)).toEqual(['-', '+', '-', '-', '+', '+']);
    expect(lineChanges('a\nb', 'a\nb')).toEqual([]);
  });
});
