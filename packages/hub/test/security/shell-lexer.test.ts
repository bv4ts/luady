import { describe, expect, it } from 'vitest';
import { lexCommand, type LexResult } from '../../src/security/shell-lexer.js';

function texts(result: LexResult): unknown {
  return result.ok ? result.segments.map((segment) => segment.map((word) => word.text)) : result.reason;
}

const ACCEPTED: Array<{ input: string; expected: string[][] }> = [
  { input: 'ls -la /tmp', expected: [['ls', '-la', '/tmp']] },
  { input: '  ls   -la  ', expected: [['ls', '-la']] },
  { input: 'ls\t-la', expected: [['ls', '-la']] },
  { input: 'grep ";" notes.txt', expected: [['grep', ';', 'notes.txt']] },
  { input: "grep 'a && b' f", expected: [['grep', 'a && b', 'f']] },
  { input: `grep "it's" f`, expected: [['grep', "it's", 'f']] },
  { input: String.raw`grep "say \"hi\"" f`, expected: [['grep', 'say "hi"', 'f']] },
  { input: String.raw`grep "\$HOME" f`, expected: [['grep', '$HOME', 'f']] },
  { input: String.raw`grep "a\b" f`, expected: [['grep', 'a\\b', 'f']] },
  { input: String.raw`cat a\ b.txt`, expected: [['cat', 'a b.txt']] },
  { input: String.raw`ls\;rm`, expected: [['ls;rm']] },
  { input: "cat ''", expected: [['cat', '']] },
  { input: `ab"cd"'ef'`, expected: [['abcdef']] },
  { input: 'tail -n 5 log | grep error | wc -l', expected: [['tail', '-n', '5', 'log'], ['grep', 'error'], ['wc', '-l']] },
  { input: "grep 'x'|wc -l", expected: [['grep', 'x'], ['wc', '-l']] },
];

const REJECTED: Array<{ input: string; reason: string }> = [
  { input: '', reason: 'empty command' },
  { input: '   ', reason: 'empty command' },
  { input: 'ls; rm x', reason: ';' },
  { input: 'ls && rm x', reason: '&&' },
  { input: 'ls || rm x', reason: '||' },
  { input: 'sleep 9 &', reason: 'background' },
  { input: 'ls\nrm x', reason: 'newline' },
  { input: 'ls\rrm x', reason: 'newline' },
  { input: 'ls > out', reason: 'output redirection' },
  { input: 'ls >> out', reason: 'append redirection' },
  { input: 'ls 2> err', reason: 'output redirection' },
  { input: 'ls &> all', reason: '&>' },
  { input: 'cat < in', reason: 'input redirection' },
  { input: 'cat <<EOF', reason: 'here-document' },
  { input: 'cat <<< hi', reason: 'here-string' },
  { input: 'diff <(ls) x', reason: 'process substitution' },
  { input: 'ls |& cat', reason: '|&' },
  { input: 'ls | | wc', reason: 'empty pipeline segment' },
  { input: '| ls', reason: 'empty pipeline segment' },
  { input: 'ls |', reason: 'empty pipeline segment' },
  { input: 'echo $(id)', reason: 'command substitution' },
  { input: 'echo `id`', reason: 'backtick' },
  { input: 'echo ${HOME}', reason: 'parameter expansion' },
  { input: 'echo $HOME', reason: 'variable expansion' },
  { input: 'grep "$x" f', reason: 'variable expansion' },
  { input: 'grep "`id`" f', reason: 'backtick' },
  { input: "echo $'\\x3b'", reason: 'quoting' },
  { input: '(ls)', reason: 'subshell' },
  { input: 'ls {a,b}', reason: 'brace' },
  { input: "grep 'open", reason: 'unterminated single quote' },
  { input: 'grep "open', reason: 'unterminated double quote' },
  { input: 'ls \\', reason: 'trailing backslash' },
  { input: 'ls\u0000', reason: 'control character' },
  { input: "grep 'a\nb' f", reason: 'newline' },
  { input: 'grep "a\nb" f', reason: 'newline' },
];

describe('lexCommand', () => {
  it.for(ACCEPTED)('splits $input', ({ input, expected }) => {
    expect(texts(lexCommand(input))).toEqual(expected);
  });

  it('marks only unquoted glob characters', () => {
    expect(lexCommand(String.raw`ls *.log '*.txt' "a?" \*.md a[bc] plain`)).toEqual({
      ok: true,
      segments: [
        [
          { text: 'ls', glob: false },
          { text: '*.log', glob: true },
          { text: '*.txt', glob: false },
          { text: 'a?', glob: false },
          { text: '*.md', glob: false },
          { text: 'a[bc]', glob: true },
          { text: 'plain', glob: false },
        ],
      ],
    });
  });

  it.for(REJECTED)('rejects $input', ({ input, reason }) => {
    const result = lexCommand(input);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain(reason);
  });
});
