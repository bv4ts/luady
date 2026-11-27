import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from '../../src/core/errors.js';
import {
  ActionsQuerySchema,
  EmptyBodySchema,
  MemoryFileQuerySchema,
  PageQuerySchema,
  TerminalQuerySchema,
} from '../../src/web/schemas.js';
import { parseBody, parseQuery, parseWith } from '../../src/web/validate.js';

describe('parse helpers', () => {
  it('returns typed data on success', () => {
    expect(parseWith(z.strictObject({ a: z.number() }), { a: 1 }, 'body')).toEqual({ a: 1 });
  });

  it('rejects unknown fields with a ValidationError naming the input', () => {
    const schema = z.strictObject({ a: z.number() });
    expect(() => parseBody(schema, { a: 1, extra: true })).toThrow(ValidationError);
    expect(() => parseBody(schema, { a: 1, extra: true })).toThrow(/Invalid body/);
  });

  it('treats a missing body as {}', () => {
    expect(parseBody(EmptyBodySchema, undefined)).toEqual({});
    expect(() => parseBody(EmptyBodySchema, { pin: '123456' })).toThrow(ValidationError);
  });
});

describe('web request schemas', () => {
  it('page query: empty cursor is null, limit defaults to 50 and is bounded', () => {
    expect(parseQuery(PageQuerySchema, { cursor: '', limit: '20' })).toEqual({ cursor: null, limit: 20 });
    expect(parseQuery(PageQuerySchema, {})).toEqual({ cursor: null, limit: 50 });
    expect(parseQuery(PageQuerySchema, { cursor: 'abc' })).toEqual({ cursor: 'abc', limit: 50 });
    expect(() => parseQuery(PageQuerySchema, { limit: '0' })).toThrow(ValidationError);
    expect(() => parseQuery(PageQuerySchema, { limit: '201' })).toThrow(ValidationError);
  });

  it('actions query: an empty status is ignored, an unknown status is rejected', () => {
    expect(parseQuery(ActionsQuerySchema, { status: '', limit: '100' })).toEqual({ limit: 100 });
    expect(parseQuery(ActionsQuerySchema, { status: 'done' })).toEqual({ status: 'done', limit: 100 });
    expect(() => parseQuery(ActionsQuerySchema, { status: 'bogus' })).toThrow(ValidationError);
  });

  it('memory file names must be .md without NUL or backslash', () => {
    expect(parseQuery(MemoryFileQuerySchema, { name: 'journal/2026-10-09.md' })).toEqual({ name: 'journal/2026-10-09.md' });
    expect(() => parseQuery(MemoryFileQuerySchema, { name: 'secrets.env' })).toThrow(ValidationError);
    expect(() => parseQuery(MemoryFileQuerySchema, { name: '..\\x.md' })).toThrow(ValidationError);
  });

  it('terminal tickets must be url-safe tokens', () => {
    expect(parseQuery(TerminalQuerySchema, { ticket: 'a'.repeat(64) })).toEqual({ ticket: 'a'.repeat(64) });
    expect(() => parseQuery(TerminalQuerySchema, { ticket: 'short' })).toThrow(ValidationError);
    expect(() => parseQuery(TerminalQuerySchema, { ticket: `${'a'.repeat(20)}/../x` })).toThrow(ValidationError);
  });
});
