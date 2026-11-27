import type { TranscriptItemDTO } from '@luady/shared';

export interface ParsedItem {
  item: TranscriptItemDTO;
  /** Byte offset of the JSONL line the item came from (a reader cursor). */
  lineStart: number;
}

export interface ParseResult {
  items: ParsedItem[];
  /** Unknown record types plus unparseable lines. */
  unknown: number;
}

export const TOOL_INPUT_MAX = 120;
export const TOOL_RESULT_MAX = 160;
export const SYSTEM_TEXT_MAX = 300;

const SKIPPED_TYPES: ReadonlySet<string> = new Set(['file-history-snapshot', 'queue-operation', 'summary']);
const INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill'] as const;
/** A slash command names itself near the start of its message: nothing past this many characters is searched. */
export const COMMAND_SCAN_MAX = 64 * 1024;
const COMMAND_STDOUT_RE = /^<local-command-stdout>([\s\S]*?)<\/local-command-stdout>$/;

type JsonObject = Record<string, unknown>;
type ToolUse = readonly [id: string, name: string];

interface RecordOutcome {
  items: TranscriptItemDTO[];
  toolUses: ToolUse[];
  known: boolean;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clips by code points (never splits an emoji) and marks the cut with `…`. */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function item(uuid: string, index: number, role: TranscriptItemDTO['role'], text: string, ts: string | null, toolName: string | null): TranscriptItemDTO {
  return { uuid: index === 0 ? uuid : `${uuid}:${index}`, role, text, ts, toolName };
}

function parseJsonObject(line: string): JsonObject | null {
  if (line.trim() === '') return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The text between the first `<tag>` and the next `</tag>` after it, found with indexOf: a line full of open tags
 * costs one pass, where a lazy pattern would rescan the rest of the line from every one of them.
 */
function tagText(content: string, tag: string): string | undefined {
  const head = content.length > COMMAND_SCAN_MAX ? content.slice(0, COMMAND_SCAN_MAX) : content;
  const open = `<${tag}>`;
  const start = head.indexOf(open);
  if (start === -1) return undefined;
  const end = head.indexOf(`</${tag}>`, start + open.length);
  return end === -1 ? undefined : head.slice(start + open.length, end);
}

function commandOrText(content: string): { role: 'user' | 'system'; text: string } {
  const name = tagText(content, 'command-name')?.trim();
  if (name !== undefined) {
    const args = tagText(content, 'command-args')?.trim() ?? '';
    return { role: 'user', text: args === '' ? name : `${name} ${args}` };
  }
  const stdout = COMMAND_STDOUT_RE.exec(content.trim())?.[1];
  if (stdout !== undefined) return { role: 'system', text: clipText(oneLine(stdout), SYSTEM_TEXT_MAX) };
  return { role: 'user', text: content };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      if (!isObject(block)) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return block.type === 'image' ? '[image]' : '';
    })
    .filter((text) => text !== '')
    .join('\n');
}

function resultLine(content: unknown, isError: boolean): string {
  const first = resultText(content).split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '(no output)';
  return `↳ ${isError ? '✖ ' : ''}${clipText(first, TOOL_RESULT_MAX)}`;
}

function toolSummary(input: unknown): string {
  if (!isObject(input)) return '';
  for (const key of INPUT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return clipText(oneLine(value), TOOL_INPUT_MAX);
  }
  const json = JSON.stringify(input);
  return json === '{}' ? '' : clipText(oneLine(json), TOOL_INPUT_MAX);
}

function userItems(uuid: string, ts: string | null, message: unknown, toolNames: ReadonlyMap<string, string>): TranscriptItemDTO[] {
  const content = isObject(message) ? message.content : undefined;
  if (typeof content === 'string') {
    const parsed = commandOrText(content);
    return parsed.text === '' ? [] : [item(uuid, 0, parsed.role, parsed.text, ts, null)];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown, index): TranscriptItemDTO[] => {
    if (!isObject(block)) return [];
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return [item(uuid, index, 'user', block.text, ts, null)];
    }
    if (block.type !== 'tool_result') return [];
    const name = typeof block.tool_use_id === 'string' ? (toolNames.get(block.tool_use_id) ?? null) : null;
    return [item(uuid, index, 'tool', resultLine(block.content, block.is_error === true), ts, name)];
  });
}

function assistantOutcome(uuid: string, ts: string | null, message: unknown): RecordOutcome {
  const content = isObject(message) ? message.content : undefined;
  if (typeof content === 'string') {
    return { items: content.trim() === '' ? [] : [item(uuid, 0, 'assistant', content, ts, null)], toolUses: [], known: true };
  }
  const blocks: unknown[] = Array.isArray(content) ? content : [];
  const items = blocks.flatMap((block: unknown, index): TranscriptItemDTO[] => {
    if (!isObject(block)) return [];
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return [item(uuid, index, 'assistant', block.text, ts, null)];
    }
    if (block.type !== 'tool_use' || typeof block.name !== 'string') return [];
    const summary = toolSummary(block.input);
    return [item(uuid, index, 'tool', summary === '' ? `🔧 ${block.name}` : `🔧 ${block.name}: ${summary}`, ts, block.name)];
  });
  const toolUses = blocks.flatMap((block: unknown): ToolUse[] =>
    isObject(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [[block.id, block.name]]
      : [],
  );
  return { items, toolUses, known: true };
}

function systemItems(uuid: string, ts: string | null, content: unknown): TranscriptItemDTO[] {
  if (typeof content !== 'string' || content.trim() === '') return [];
  return [item(uuid, 0, 'system', clipText(oneLine(content), SYSTEM_TEXT_MAX), ts, null)];
}

function recordItems(record: JsonObject, uuid: string | null, toolNames: ReadonlyMap<string, string>): RecordOutcome {
  const type = typeof record.type === 'string' ? record.type : '';
  const empty: RecordOutcome = { items: [], toolUses: [], known: true };
  if (SKIPPED_TYPES.has(type) || record.isMeta === true || record.isSidechain === true) return empty;
  if (uuid === null) return { ...empty, known: false };
  const ts = typeof record.timestamp === 'string' ? record.timestamp : null;
  if (type === 'user') return { ...empty, items: userItems(uuid, ts, record.message, toolNames) };
  if (type === 'assistant') return assistantOutcome(uuid, ts, record.message);
  if (type === 'system') return { ...empty, items: systemItems(uuid, ts, record.content) };
  return { ...empty, known: false };
}

/** Lenient Claude Code JSONL → chat items. `data` holds complete lines starting at byte `baseOffset`. */
export function parseTranscriptChunk(data: string, baseOffset: number): ParseResult {
  const lines = data.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const seen = new Set<string>();
  const toolNames = new Map<string, string>();
  const items: ParsedItem[] = [];
  let unknown = 0;
  let offset = baseOffset;
  for (const raw of lines) {
    const lineStart = offset;
    offset += Buffer.byteLength(raw, 'utf8') + 1;
    const record = parseJsonObject(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (record === null) {
      if (raw.trim() !== '') unknown += 1;
      continue;
    }
    const uuid = typeof record.uuid === 'string' ? record.uuid : null;
    if (uuid !== null && seen.has(uuid)) continue;
    if (uuid !== null) seen.add(uuid);
    const outcome = recordItems(record, uuid, toolNames);
    for (const [id, name] of outcome.toolUses) toolNames.set(id, name);
    if (!outcome.known) unknown += 1;
    for (const entry of outcome.items) items.push({ item: entry, lineStart });
  }
  return { items, unknown };
}
