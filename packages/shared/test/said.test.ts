import { describe, expect, it } from 'vitest';
import { SaidDTOSchema, SaidListDTOSchema } from '../src/said.js';

const said = { sessionId: 'birch:cc-orchard:0.0', kind: 'reply', text: 'All 42 tests pass.', truncated: false, at: '2026-11-15T09:00:00.000Z' };

describe('SaidDTOSchema', () => {
  it('parses a reply, a report and a list', () => {
    expect(SaidDTOSchema.parse(said)).toEqual(said);
    expect(SaidDTOSchema.parse({ ...said, kind: 'report', truncated: true }).kind).toBe('report');
    expect(SaidListDTOSchema.parse({ items: [said] })).toEqual({ items: [said] });
  });

  it('caps the text at 1200 characters and pins the two kinds', () => {
    expect(SaidDTOSchema.safeParse({ ...said, text: 'x'.repeat(1200) }).success).toBe(true);
    expect(SaidDTOSchema.safeParse({ ...said, text: 'x'.repeat(1201) }).success).toBe(false);
    expect(SaidDTOSchema.safeParse({ ...said, kind: 'question' }).success).toBe(false);
  });
});
