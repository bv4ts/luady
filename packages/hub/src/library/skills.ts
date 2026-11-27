import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS, type SkillDTO } from '@luady/shared';

/** Luady's own skills: `<brainDir>/skills/<name>/SKILL.md`, read from their front matter (name and description). */

const SKILL_FILE = 'SKILL.md';
const READ_MAX_BYTES = 64_000;
const NAME_MAX = 100;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) return trimmed.slice(1, -1);
  return trimmed;
}

/** `key: value` pairs of a YAML front matter block, with folded (`>`, `>-`) and literal (`|`) values joined into one line. */
export function frontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return {};
  const lines = (match[1] ?? '').split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (pair === null) continue;
    const [, key = '', raw = ''] = pair;
    if (/^[>|][+-]?$/.test(raw.trim())) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? '')) block.push((lines[(i += 1)] ?? '').trim());
      out[key] = block.join(' ');
    } else {
      out[key] = unquote(raw);
    }
  }
  return out;
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function skillFromFile(dirName: string, text: string): SkillDTO {
  const meta = frontMatter(text);
  return {
    name: cut(meta.name ?? dirName, NAME_MAX) || dirName,
    description: cut(meta.description ?? '', LIMITS.skillDescriptionMax),
    source: 'user',
    path: `skills/${dirName}/${SKILL_FILE}`,
  };
}

async function readHead(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, 'utf8');
    return text.slice(0, READ_MAX_BYTES);
  } catch {
    return null;
  }
}

/** Every skill folder of Luady's brain with a SKILL.md, by name. A missing folder is no skills. */
export async function readLuadySkills(brainDir: string): Promise<SkillDTO[]> {
  const root = join(brainDir, 'skills');
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  const skills = await Promise.all(dirs.map(async (dir) => {
    const text = await readHead(join(root, dir, SKILL_FILE));
    return text === null ? null : skillFromFile(dir, text);
  }));
  return skills.filter((skill): skill is SkillDTO => skill !== null).slice(0, LIMITS.skillsMax);
}
