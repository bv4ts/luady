import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GATE = fileURLToPath(new URL('../../../brain/.manager/prompt_gate.py', import.meta.url));
const PYTHON = ['python3', 'python'].find((bin) => spawnSync(bin, ['--version']).status === 0);
const CC_SKILL = 'skills/cc-prompt/SKILL.md';
const IMAGE_SKILL = 'skills/image-prompt/SKILL.md';

let brain: string;

beforeEach(() => {
  brain = mkdtempSync(join(tmpdir(), 'luady-gate-'));
  for (const skill of [CC_SKILL, IMAGE_SKILL]) {
    mkdirSync(join(brain, skill, '..'), { recursive: true });
    writeFileSync(join(brain, skill), '# skill');
  }
});

afterEach(() => {
  rmSync(brain, { recursive: true, force: true });
});

const read = (skill: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `/home/luady/brain/${skill}` } }] } });
const compaction = { type: 'system', subtype: 'compact_boundary' };

function gate(tool: string, input: Record<string, unknown>, transcript: object[]): { code: number | null; stderr: string } {
  const path = join(brain, 'transcript.jsonl');
  writeFileSync(path, transcript.map((entry) => JSON.stringify(entry)).join('\n'));
  const result = spawnSync(PYTHON ?? 'python3', [GATE], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, transcript_path: path }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: brain }, encoding: 'utf8',
  });
  return { code: result.status, stderr: result.stderr };
}

describe.skipIf(PYTHON === undefined)('prompt_gate.py', () => {
  it('refuses image_generate until skills/image-prompt/SKILL.md was Read since the last compaction', () => {
    const image = 'mcp__hub__image_generate';
    const refused = gate(image, { prompt: 'a cat' }, [read(CC_SKILL)]);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(`Read ${IMAGE_SKILL}`);
    expect(gate(image, { prompt: 'a cat' }, [read(IMAGE_SKILL)]).code).toBe(0);
    expect(gate(image, { prompt: 'a cat' }, [read(IMAGE_SKILL), compaction]).code).toBe(2);
  });

  it('keeps gating new session tasks on the cc-prompt skill only', () => {
    expect(gate('mcp__hub__session_start', { prompt: 'build x' }, [read(IMAGE_SKILL)]).code).toBe(2);
    expect(gate('mcp__hub__session_start', { prompt: 'build x' }, [read(CC_SKILL)]).code).toBe(0);
    expect(gate('mcp__hub__session_send', { text: 'yes' }, []).code).toBe(0);
    expect(gate('mcp__hub__fleet_status', {}, []).code).toBe(0);
  });

  it('fails open when the skill file is missing or the transcript cannot be read', () => {
    rmSync(join(brain, IMAGE_SKILL));
    expect(gate('mcp__hub__image_generate', { prompt: 'a cat' }, []).code).toBe(0);
    const broken = spawnSync(PYTHON ?? 'python3', [GATE], { input: '{"tool_name": "mcp__hub__session_start", "tool_input": {"prompt": "x"}, "transcript_path": "/nope"}', env: { ...process.env, CLAUDE_PROJECT_DIR: brain } });
    expect(broken.status).toBe(0);
  });
});
