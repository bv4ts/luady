/**
 * Jira's rich text (Atlassian Document Format) to Markdown for reading, and plain text to a Jira document for writing.
 * The Markdown goes through the website's sanitising renderer (GFM, single line breaks kept); no HTML is ever produced.
 */

/** One ADF node as Jira sends it; everything is optional because the input is outside data. */
export interface AdfNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly attrs?: unknown;
  readonly marks?: unknown;
  readonly content?: unknown;
}

/** What the hub writes: a document of paragraphs with text and hard breaks only. */
export interface AdfDoc {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly AdfBlock[];
}
interface AdfBlock { readonly type: 'paragraph'; readonly content: readonly AdfInline[] }
type AdfInline = { readonly type: 'text'; readonly text: string } | { readonly type: 'hardBreak' };

const ATTACHMENT = '[attachment]';
const MAX_DEPTH = 40;
const SAFE_LINK_RE = /^(https?:|mailto:)/i;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const nodeType = (node: AdfNode): string => str(node.type);
const attr = (node: AdfNode, name: string): unknown => (isObject(node.attrs) ? node.attrs[name] : undefined);
const children = (node: AdfNode): readonly AdfNode[] =>
  Array.isArray(node.content) ? node.content.filter((child): child is AdfNode => isObject(child)) : [];

/** Characters that would turn plain Jira text into Markdown formatting. */
function escapeInline(text: string): string {
  return text.replace(/[\\`*[\]<>~]/g, (char) => `\\${char}`);
}

/** Longer Jira text than this is cut before any pattern runs over it. */
const TEXT_SCAN_MAX = 100_000;
/** Indentation is spaces and tabs only, so a match never runs on into the next lines (which would cost n² steps). */
const LINE_START_MARK_RE = /^([ \t]*)(#|>|[-+](?=\s)|\d+(?=\.\s))/gm;

/** A line that Markdown would read as a heading, quote or list item gets its first mark escaped. */
function escapeLineStart(text: string): string {
  const scanned = text.length > TEXT_SCAN_MAX ? text.slice(0, TEXT_SCAN_MAX) : text;
  return scanned.replace(LINE_START_MARK_RE, (_m, space: string, mark: string) => `${space}\\${mark}`);
}

function markNames(node: AdfNode): Array<{ type: string; href: string }> {
  if (!Array.isArray(node.marks)) return [];
  return node.marks.filter(isObject).map((mark) => ({
    type: str(mark.type),
    href: isObject(mark.attrs) ? str(mark.attrs.href) : '',
  }));
}

function textWithMarks(node: AdfNode): string {
  const raw = str(node.text);
  if (raw === '') return '';
  const marks = markNames(node);
  if (marks.some((mark) => mark.type === 'code')) return `\`${raw.replace(/`/g, "'")}\``;
  let out = escapeInline(raw);
  for (const mark of marks) {
    if (mark.type === 'strong') out = `**${out}**`;
    else if (mark.type === 'em') out = `*${out}*`;
    else if (mark.type === 'strike') out = `~~${out}~~`;
  }
  const link = marks.find((mark) => mark.type === 'link' && SAFE_LINK_RE.test(mark.href));
  return link === undefined ? out : `[${out}](${link.href.replace(/[()\s]/g, encodeURIComponent)})`;
}

function dateText(node: AdfNode): string {
  const raw = attr(node, 'timestamp');
  const stamp = typeof raw === 'number' ? raw : Number(str(raw));
  return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString().slice(0, 10) : '';
}

function inline(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  switch (nodeType(node)) {
    case 'text':
      return textWithMarks(node);
    case 'hardBreak':
      return '\n';
    case 'mention': {
      const name = str(attr(node, 'text')) || 'someone';
      return escapeInline(name.startsWith('@') ? name : `@${name}`);
    }
    case 'emoji':
      return str(attr(node, 'text')) || str(attr(node, 'shortName'));
    case 'inlineCard': {
      const url = str(attr(node, 'url'));
      return SAFE_LINK_RE.test(url) ? `<${url}>` : '';
    }
    case 'date':
      return dateText(node);
    case 'status':
      return escapeInline(str(attr(node, 'text')));
    case 'mediaInline':
    case 'media':
      return ATTACHMENT;
    default:
      return children(node).map((child) => inline(child, depth + 1)).join('') || escapeInline(str(node.text));
  }
}

function inlineOf(node: AdfNode, depth: number): string {
  return escapeLineStart(children(node).map((child) => inline(child, depth + 1)).join(''));
}

const indent = (text: string, pad: string): string => text.split('\n').map((line) => (line === '' ? line : `${pad}${line}`)).join('\n');

function listItem(node: AdfNode, marker: string, depth: number): string {
  const body = children(node).map((child) => block(child, depth + 1)).filter((part) => part !== '').join('\n');
  const pad = ' '.repeat(marker.length);
  const [first = '', ...rest] = body.split('\n');
  return [`${marker}${first}`, ...rest.map((line) => (line === '' ? line : `${pad}${line}`))].join('\n');
}

function list(node: AdfNode, ordered: boolean, depth: number): string {
  const startAttr = Number(attr(node, 'order'));
  const start = Number.isInteger(startAttr) && startAttr > 0 ? startAttr : 1;
  return children(node)
    .map((item, index) => {
      if (nodeType(item) === 'taskItem') return listItem(item, attr(item, 'state') === 'DONE' ? '- [x] ' : '- [ ] ', depth);
      return listItem(item, ordered ? `${start + index}. ` : '- ', depth);
    })
    .join('\n');
}

/**
 * Every `|` in a cell's Markdown escaped, so no pipe from Jira can end the cell. A pipe is bare when an even number of
 * backslashes stands before it (escaped text always has an even number); raw text (code, an emoji, a card's address)
 * can bring an odd number, and that pipe is escaped already: one more backslash would pair with them and free it.
 */
const escapeCellPipes = (text: string): string =>
  text.replace(/\\+\|?|\|/g, (run) => (run.endsWith('|') && run.length % 2 === 1 ? `${run.slice(0, -1)}\\|` : run));

function cellText(cell: AdfNode, depth: number): string {
  const text = children(cell).map((child) => block(child, depth + 1)).join(' ');
  // One line per cell: split and trim (linear), not a `\s*\n\s*` pattern that rescans a long run of spaces.
  const flat = text.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ');
  return escapeCellPipes(flat).trim();
}

function table(node: AdfNode, depth: number): string {
  const rows = children(node).filter((row) => nodeType(row) === 'tableRow').map((row) => children(row).map((cell) => cellText(cell, depth)));
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return '';
  const line = (cells: readonly string[]): string => `| ${Array.from({ length: width }, (_v, i) => cells[i] ?? '').join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [line(head), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n');
}

function quote(text: string): string {
  return text.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

function blocks(node: AdfNode, depth: number, joiner = '\n\n'): string {
  return children(node).map((child) => block(child, depth + 1)).filter((part) => part !== '').join(joiner);
}

function block(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return '';
  switch (nodeType(node)) {
    case 'doc':
      return blocks(node, depth);
    case 'paragraph':
      return inlineOf(node, depth);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(attr(node, 'level')) || 1));
      return `${'#'.repeat(level)} ${inlineOf(node, depth).replace(/\n/g, ' ')}`;
    }
    case 'bulletList':
    case 'taskList':
    case 'decisionList':
      return list(node, false, depth);
    case 'orderedList':
      return list(node, true, depth);
    case 'codeBlock': {
      const language = str(attr(node, 'language')).replace(/[^\w+-]/g, '');
      const code = children(node).map((child) => str(child.text)).join('').replace(/```/g, "'''");
      return `\`\`\`${language}\n${code}\n\`\`\``;
    }
    case 'blockquote':
    case 'panel':
      return quote(blocks(node, depth));
    case 'rule':
      return '---';
    case 'table':
      return table(node, depth);
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return ATTACHMENT;
    case 'expand':
    case 'nestedExpand': {
      const title = str(attr(node, 'title'));
      const body = blocks(node, depth);
      return title === '' ? body : `**${escapeInline(title)}**\n\n${body}`;
    }
    case 'blockCard':
    case 'embedCard': {
      const url = str(attr(node, 'url'));
      return SAFE_LINK_RE.test(url) ? `<${url}>` : '';
    }
    case 'listItem':
    case 'taskItem':
    case 'decisionItem':
      return listItem(node, '- ', depth);
    default:
      return children(node).length > 0 ? blocks(node, depth, '\n') : inline(node, depth);
  }
}

/** Markdown of a Jira document; anything that is not a document (null, a plain string from an old field) is handled too. */
export function adfToMarkdown(doc: unknown): string {
  if (typeof doc === 'string') return escapeLineStart(escapeInline(doc));
  if (!isObject(doc)) return '';
  return block(doc, 0).replace(/\n{3,}/g, '\n\n').trim();
}

/** A Jira document from plain text: a blank line starts a new paragraph, a single line break is a hard break. */
export function textToAdf(text: string): AdfDoc {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((part) => part.replace(/^\n+|\n+$/g, ''))
    .filter((part) => part.trim() !== '');
  const content = paragraphs.map((part): AdfBlock => {
    const lines = part.split('\n');
    const nodes = lines.flatMap((line, index): AdfInline[] => {
      const pieces: AdfInline[] = index > 0 ? [{ type: 'hardBreak' }] : [];
      return line === '' ? pieces : [...pieces, { type: 'text', text: line }];
    });
    return { type: 'paragraph', content: nodes };
  });
  return { type: 'doc', version: 1, content };
}
