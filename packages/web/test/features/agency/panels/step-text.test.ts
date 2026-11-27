import { describe, expect, it } from 'vitest';
import { clock, currentLine, helpersLine, stepSuffix } from '../../../../src/features/agency/panels/agent/step-text.js';
import { detail, step } from '../../../fixtures.js';

const openStep = step({ id: 'o', tool: 'Bash', kind: 'run', title: 'npm test', endedAt: null, ok: null, added: null, removed: null });

describe('currentLine', () => {
  it('a pause that hit says Paused', () => {
    expect(currentLine({ state: 'working', detail: detail({ paused: true, pauseHit: true }) })).toEqual({ icon: 'pause', text: 'Paused' });
  });

  it('a pause that has not hit yet says so, with the step that is still running', () => {
    expect(currentLine({ state: 'working', detail: detail({ paused: true, current: openStep }) }))
      .toEqual({ icon: 'pause', text: 'Pausing after this step… npm test' });
    expect(currentLine({ state: 'idle', detail: detail({ paused: true }) })).toEqual({ icon: 'pause', text: 'Pausing after this step…' });
  });

  it('a running step shows its title and its tool bubble, or the tool name when the title is empty', () => {
    expect(currentLine({ state: 'working', detail: detail({ current: openStep }) })).toEqual({ icon: 'term', text: 'npm test' });
    const untitled = { ...openStep, tool: 'mcp__x__y', kind: 'other' as const, title: '' };
    expect(currentLine({ state: 'working', detail: detail({ current: untitled }) })).toEqual({ icon: 'gear', text: 'mcp__x__y' });
  });

  it('working without a step is thinking; other states are said in words', () => {
    expect(currentLine({ state: 'working', detail: null })).toEqual({ icon: 'dots', text: 'Thinking…' });
    expect(currentLine({ state: 'idle', detail: null })).toEqual({ icon: null, text: 'Idle' });
    expect(currentLine({ state: 'waiting_question', detail: null })).toEqual({ icon: 'bang', text: 'Waiting for your answer' });
    expect(currentLine({ state: 'waiting_permission', detail: null })).toEqual({ icon: 'key', text: 'Waiting for your answer' });
    expect(currentLine({ state: 'error', detail: null }).text).toBe('Stopped with an error');
    expect(currentLine({ state: 'ended', detail: detail({ paused: true }) }).text).toBe('Ended');
    expect(currentLine({ state: 'starting', detail: null }).text).toBe('Starting');
  });
});

describe('stepSuffix', () => {
  it('counts changed lines, says failed, and is empty for an open step', () => {
    expect(stepSuffix(step())).toBe('+12 −3');
    expect(stepSuffix(step({ tool: 'Write', added: 12, removed: null }))).toBe('+12');
    expect(stepSuffix(step({ ok: false }))).toBe('failed');
    expect(stepSuffix(openStep)).toBe('');
    expect(stepSuffix(step({ kind: 'read', added: null, removed: null }))).toBe('');
  });
});

describe('clock and helpers', () => {
  it('clock is the owner time', () => {
    expect(clock('2026-11-14T11:20:00Z')).toBe('3:20 PM');
    expect(clock('not a time')).toBe('');
  });

  it('helpersLine names the helpers', () => {
    const helper = (agentType: string | null) => ({ agentId: String(agentType), agentType, startedAt: '2026-11-14T11:20:00Z' });
    expect(helpersLine([])).toBeNull();
    expect(helpersLine([helper('Explore')])).toBe('1 helper: Explore');
    expect(helpersLine([helper('Explore'), helper('general-purpose')])).toBe('2 helpers: Explore, general-purpose');
    expect(helpersLine([helper(null)])).toBe('1 helper');
  });
});
