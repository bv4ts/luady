import { describe, expect, it } from 'vitest';
import { parseMailQuery } from '../../src/mail/query.js';

const NOW = new Date('2026-10-10T16:00:00.000Z');

describe('parseMailQuery', () => {
  it('turns Gmail operators into IMAP criteria', () => {
    expect(parseMailQuery('from:sam@harbor.example subject:"Team pictures" newer_than:7d is:unread', NOW)).toEqual({
      from: 'sam@harbor.example', subject: 'Team pictures', since: new Date('2026-10-03T16:00:00.000Z'), seen: false,
    });
    expect(parseMailQuery('after:2026/10/01 before:2026-10-05', NOW)).toEqual({
      since: new Date('2026-10-01T00:00:00.000Z'), before: new Date('2026-10-05T00:00:00.000Z'),
    });
  });

  it('keeps plain words and phrases as text, drops operators IMAP cannot answer', () => {
    expect(parseMailQuery('invoice OR "bank transfer" has:attachment in:inbox -from:noreply', NOW)).toEqual({ text: 'invoice bank transfer' });
    expect(parseMailQuery('harbor', NOW)).toEqual({ text: 'harbor' });
    expect(parseMailQuery('', NOW)).toEqual({});
  });
});
