import { describe, expect, it } from 'vitest';
import { adfToMarkdown, textToAdf } from '../../src/jira/adf.js';
import { HOSTILE_INPUT_BUDGET_MS, elapsedMs } from '../helpers/timing.js';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, ...marks: unknown[]) => (marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text });
const li = (...content: unknown[]) => ({ type: 'listItem', content });

describe('adfToMarkdown', () => {
  it('paragraphs, headings and hard breaks', () => {
    const md = adfToMarkdown(doc(
      { type: 'heading', attrs: { level: 2 }, content: [t('Steps')] },
      p(t('Line one'), { type: 'hardBreak' }, t('Line two')),
      p(t('Second paragraph')),
    ));
    expect(md).toBe('## Steps\n\nLine one\nLine two\n\nSecond paragraph');
  });

  it('inline marks: bold, italic, strike, code and a link', () => {
    const md = adfToMarkdown(doc(p(
      t('bold', { type: 'strong' }), t(' '), t('it', { type: 'em' }), t(' '), t('gone', { type: 'strike' }), t(' '),
      t('npm test', { type: 'code' }), t(' '), t('docs', { type: 'link', attrs: { href: 'https://example.com/a b' } }),
    )));
    expect(md).toBe('**bold** *it* ~~gone~~ `npm test` [docs](https://example.com/a%20b)');
  });

  it('drops links that are not http(s) or mailto', () => {
    expect(adfToMarkdown(doc(p(t('click', { type: 'link', attrs: { href: 'javascript:alert(1)' } }))))).toBe('click');
  });

  it('bullet and numbered lists with nesting', () => {
    const md = adfToMarkdown(doc(
      { type: 'bulletList', content: [
        li(p(t('One')), { type: 'orderedList', attrs: { order: 3 }, content: [li(p(t('Three'))), li(p(t('Four')))] }),
        li(p(t('Two'))),
      ] },
    ));
    expect(md).toBe('- One\n  3. Three\n  4. Four\n- Two');
  });

  it('code block, quote, panel, rule, media, emoji and mention', () => {
    const md = adfToMarkdown(doc(
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;\nconst b = 2;')] },
      { type: 'blockquote', content: [p(t('Quoted'))] },
      { type: 'panel', attrs: { panelType: 'info' }, content: [p(t('Heads up'))] },
      { type: 'rule' },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
      p({ type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }, t(' '), { type: 'mention', attrs: { id: 'a1', text: '@Sara' } }),
    ));
    expect(md).toBe('```ts\nconst a = 1;\nconst b = 2;\n```\n\n> Quoted\n\n> Heads up\n\n---\n\n[attachment]\n\n😄 @Sara');
  });

  it('a simple table with a header row and escaped pipes', () => {
    const cell = (type: string, text: string) => ({ type, content: [p(t(text))] });
    const md = adfToMarkdown(doc({ type: 'table', content: [
      { type: 'tableRow', content: [cell('tableHeader', 'Name'), cell('tableHeader', 'Value')] },
      { type: 'tableRow', content: [cell('tableCell', 'a|b'), cell('tableCell', '2')] },
    ] }));
    expect(md).toBe('| Name | Value |\n| --- | --- |\n| a\\|b | 2 |');
  });

  it('a backslash from raw Jira text (code, an emoji, a card) cannot free a pipe and end the cell', () => {
    const row = (...inline: unknown[]) => adfToMarkdown(doc({ type: 'table', content: [
      { type: 'tableRow', content: [{ type: 'tableCell', content: [p(...inline)] }, { type: 'tableCell', content: [p(t('2'))] }] },
    ] })).split('\n')[0];
    // An odd number of backslashes before a pipe escapes it already; `\\|` would be a backslash and a bare pipe.
    expect(row(t('a\\|b', { type: 'code' }))).toBe('| `a\\|b` | 2 |');
    expect(row({ type: 'emoji', attrs: { text: '\\' } }, t('|forged'))).toBe('| \\|forged | 2 |');
    expect(row({ type: 'inlineCard', attrs: { url: 'https://example.com/a\\|b' } })).toBe('| <https://example.com/a\\|b> | 2 |');
    // Escaped text keeps its pairs of backslashes, and its pipes get one more, as before.
    expect(row(t('a\\|b'))).toBe('| a\\\\\\|b | 2 |');
    expect(row(t('a\\\\|b', { type: 'code' }))).toBe('| `a\\\\\\|b` | 2 |');
    const slashes = { type: 'tableCell', content: [p(t(`${'\\'.repeat(200_000)}|`, { type: 'code' }))] };
    expect(elapsedMs(() => adfToMarkdown(doc({ type: 'table', content: [{ type: 'tableRow', content: [slashes] }] })))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
  });

  it('an unknown node becomes its text; plain text that looks like Markdown is escaped', () => {
    const md = adfToMarkdown(doc(
      { type: 'futureThing', content: [t('Kept text')] },
      p(t('# not a heading and *not bold* <b>')),
    ));
    expect(md).toBe('Kept text\n\n\\# not a heading and \\*not bold\\* \\<b\\>');
  });

  it('tolerates null, strings and junk', () => {
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown('plain *text*')).toBe('plain \\*text\\*');
    expect(adfToMarkdown({ type: 'doc', content: [42, null, { type: 'paragraph', content: 'x' }] })).toBe('');
  });

  it('escapes a Markdown mark after spaces or tabs only, and handles hostile text well under a second', () => {
    expect(adfToMarkdown(doc(p(t('a'), { type: 'hardBreak' }, t('  # b'), { type: 'hardBreak' }, t('\t- c'))))).toBe('a\n  \\# b\n\t\\- c');
    const breaks = Array.from({ length: 50_000 }, () => ({ type: 'hardBreak' }));
    expect(elapsedMs(() => adfToMarkdown(doc(p(...breaks, t('x')))))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
    expect(elapsedMs(() => adfToMarkdown(`${'\n'.repeat(200_000)}x`))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
    const cell = { type: 'tableCell', content: [p(t(`${' '.repeat(200_000)}x`))] };
    expect(elapsedMs(() => adfToMarkdown(doc({ type: 'table', content: [{ type: 'tableRow', content: [cell] }] })))).toBeLessThan(HOSTILE_INPUT_BUDGET_MS);
  });

  it('task lists, dates and status lozenges', () => {
    const md = adfToMarkdown(doc(
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('Ship')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('Test')] }] },
      p({ type: 'date', attrs: { timestamp: '1763164800000' } }, t(' '), { type: 'status', attrs: { text: 'BLOCKED' } }),
    ));
    expect(md).toBe('- [x] Ship\n- [ ] Test\n\n2025-11-15 BLOCKED');
  });
});

describe('textToAdf', () => {
  it('a blank line is a new paragraph, a single break is a hard break, no formatting marks', () => {
    expect(textToAdf('Hello *there*\nsecond line\n\nNew paragraph')).toEqual({
      type: 'doc', version: 1, content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello *there*' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'New paragraph' }] },
      ],
    });
  });

  it('handles CRLF, extra blank lines and empty text', () => {
    expect(textToAdf('a\r\n\r\n\r\nb').content).toHaveLength(2);
    expect(textToAdf('   ')).toEqual({ type: 'doc', version: 1, content: [] });
  });

  it('round-trips through the reader', () => {
    expect(adfToMarkdown(textToAdf('One\ntwo\n\nThree'))).toBe('One\ntwo\n\nThree');
  });
});
