import { describe, expect, it } from 'vitest';
import { INTERNAL_PATHS, ToolResponseSchema } from '../src/ipc.js';

describe('ToolResponseSchema', () => {
  it('accepts the ok and error shapes only', () => {
    expect(ToolResponseSchema.parse({ ok: true, text: 'done' })).toEqual({ ok: true, text: 'done' });
    expect(ToolResponseSchema.parse({ ok: false, error: 'PIN locked' })).toEqual({ ok: false, error: 'PIN locked' });
    expect(ToolResponseSchema.safeParse({ ok: true, error: 'x' }).success).toBe(false);
  });
});

describe('INTERNAL_PATHS', () => {
  it('pins the hub.sock routes (the add-on socket is /internal/addon/:id)', () => {
    expect(INTERNAL_PATHS).toEqual({ tools: '/internal/tools', health: '/internal/health', status: '/internal/status' });
  });
});
