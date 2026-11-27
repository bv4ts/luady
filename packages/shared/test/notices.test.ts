import { describe, expect, it } from 'vitest';
import {
  NOTICE_KINDS,
  NoticeDTOSchema,
  NoticeKindSchema,
  NoticeListDTOSchema,
  NoticeRefSchema,
  PresenceDTOSchema,
  PresenceForceBodySchema,
} from '../src/notices.js';

const AT = '2026-11-14T10:00:00.000Z';
const notice = {
  id: 'n_01',
  kind: 'question',
  text: 'cedar · meadow-hr asks: Which database?',
  ref: { kind: 'question', id: 'ABCDEFGH' },
  createdAt: AT,
  chatDueAt: '2026-11-14T10:10:00.000Z',
  chatSentAt: null,
  settledAt: null,
  settledVia: null,
};
const presence = { mode: 'here', online: true, clients: 2, forcedUntil: null };

describe('NOTICE_KINDS', () => {
  it('has the nine kinds in order', () => {
    expect(NOTICE_KINDS).toEqual(['reply', 'result', 'question', 'permission', 'alert', 'mail', 'meeting', 'morning', 'system']);
    expect(NoticeKindSchema.options).toEqual([...NOTICE_KINDS]);
  });
});

describe('NoticeDTOSchema', () => {
  it('parses a sample notice', () => {
    expect(NoticeDTOSchema.parse(notice)).toEqual(notice);
  });

  it('parses a settled notice without a ref', () => {
    const settled = { ...notice, kind: 'system', ref: null, chatDueAt: null, chatSentAt: AT, settledAt: AT, settledVia: 'test-channel' };
    expect(NoticeDTOSchema.parse(settled)).toEqual(settled);
  });

  it.each(['web', 'chat-two', 'answer', 'expired', 'test-channel'])('accepts settledVia %s', (via) => {
    expect(NoticeDTOSchema.safeParse({ ...notice, settledAt: AT, settledVia: via }).success).toBe(true);
  });

  it('accepts 8000 characters of text and rejects 8001', () => {
    expect(NoticeDTOSchema.safeParse({ ...notice, text: 'x'.repeat(8000) }).success).toBe(true);
    expect(NoticeDTOSchema.safeParse({ ...notice, text: 'x'.repeat(8001) }).success).toBe(false);
  });

  it.each([
    ['ref.kind todo', { ref: { kind: 'todo', id: 'x' } }],
    ['a ref id over 200 characters', { ref: { kind: 'session', id: 'x'.repeat(201) } }],
    ['settledVia phone', { settledVia: 'phone' }],
    ['kind sms', { kind: 'sms' }],
    ['an id over 64 characters', { id: 'x'.repeat(65) }],
    ['a missing chatDueAt', { chatDueAt: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(NoticeDTOSchema.safeParse({ ...notice, ...patch }).success).toBe(false);
  });

  it('NoticeRefSchema pins the four ref kinds', () => {
    expect(NoticeRefSchema.shape.kind.options).toEqual(['question', 'action', 'session', 'manager']);
  });

  it('NoticeListDTOSchema wraps items', () => {
    expect(NoticeListDTOSchema.parse({ items: [] })).toEqual({ items: [] });
    expect(NoticeListDTOSchema.parse({ items: [notice] })).toEqual({ items: [notice] });
  });
});

describe('PresenceDTOSchema', () => {
  it('parses a presence sample and a forced one', () => {
    expect(PresenceDTOSchema.parse(presence)).toEqual(presence);
    const forced = { mode: 'chat', online: true, clients: 1, forcedUntil: AT };
    expect(PresenceDTOSchema.parse(forced)).toEqual(forced);
  });

  it.each([
    ['mode away', { mode: 'away' }],
    ['a negative client count', { clients: -1 }],
    ['a fractional client count', { clients: 1.5 }],
  ])('rejects %s', (_label, patch) => {
    expect(PresenceDTOSchema.safeParse({ ...presence, ...patch }).success).toBe(false);
  });
});

describe('PresenceForceBodySchema', () => {
  it.each([[{ chat: true }], [{ chat: false }]])('accepts %j', (body) => {
    expect(PresenceForceBodySchema.parse(body)).toEqual(body);
  });

  it.each([[{}], [{ chat: true, hours: 2 }], [{ chat: 'yes' }], [{ whatsapp: true }]])('rejects %j', (body) => {
    expect(PresenceForceBodySchema.safeParse(body).success).toBe(false);
  });
});
