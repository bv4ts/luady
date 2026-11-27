import { describe, expect, it } from 'vitest';
import type { QuestionDTO, ServerDTO, SessionDTO } from '@luady/shared';
import {
  alreadyNotice, answerDeliveredAck, approvedAck, cancelledAck, charCount, failedPinNotice, formatBatch,
  formatConfirmation, formatEnded, formatError, formatFinished, formatPending, formatPermission, formatQuestion,
  helpText, pinLockedNotice, questionDetail, questionLabel, sentAck, splitForChat, statusText, truncateChars, waitingNotice,
  wrongPinNotice,
} from '../../src/notify/format.js';

describe('what the manager reads of a permission request (question_list)', () => {
  const permission = (inputPreview: string) => question({ kind: 'permission', questions: [], permission: { toolName: 'mcp__shell__run', inputPreview } });

  it('says the owner answers yes or no only when the chat can allow it; a request too long for the chat says so', () => {
    expect(questionDetail(permission('ls -la'))).toContain('the owner answers yes/no by replying to it');
    const long = questionDetail(permission('x'.repeat(700)));
    expect(long).not.toContain('yes/no');
    expect(long).toContain('too long for the chat');
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FENCE = '`'.repeat(3);
const HINT = '↩️ Reply to this message: a number (1,3 for several), or your own answer.';

function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 'cedar:cc-meadow-hr:0.0', host: 'cedar', target: 'cc-meadow-hr:0.0', claudeSessionId: 'c-1',
    cwd: '/home/dev/projects/meadow-hr', project: 'meadow-hr', displayName: 'meadow-hr', state: 'idle',
    origin: 'owner', registered: true, lastEventAt: null, turnStartedAt: null, pendingQid: null,
    unexpectedEnd: false, ...over,
  };
}

function question(over: Partial<QuestionDTO> = {}): QuestionDTO {
  return {
    qid: 'ABCDEFGH', kind: 'question', host: 'cedar', sessionId: 'cedar:cc-meadow-hr:0.0', sessionLabel: 'meadow-hr',
    questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
    permission: null, state: 'pending', createdAt: '2026-10-09T12:00:00.000Z', resolvedAt: null,
    resolvedVia: null, ...over,
  };
}

describe('truncateChars', () => {
  it('returns short text unchanged', () => {
    expect(truncateChars('hello', 10)).toBe('hello');
  });

  it('cuts to max characters including the ellipsis', () => {
    const out = truncateChars('abcdefghij', 5);
    expect(out).toBe('abcd…');
    expect(charCount(out)).toBe(5);
  });

  it('never splits emoji, ZWJ sequences or surrogate pairs', () => {
    expect(truncateChars('😀'.repeat(10) + 'مرحبا', 6)).toBe('😀😀😀😀😀…');
    expect(truncateChars('ab👨‍👩‍👧cd', 5)).toBe('ab…');
    expect(LONE_SURROGATE.test(truncateChars('😀'.repeat(50), 7))).toBe(false);
  });
});

describe('splitForChat', () => {
  it('keeps short text as one chunk and drops blank text', () => {
    expect(splitForChat('hi', 3500)).toEqual(['hi']);
    expect(splitForChat('  \n ', 3500)).toEqual([]);
  });

  it('prefers newline boundaries and keeps every chunk within 3500', () => {
    const line = 'x'.repeat(99);
    const text = Array.from({ length: 80 }, () => line).join('\n');
    const chunks = splitForChat(text, 3500);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length <= 3500)).toBe(true);
    expect(chunks.every((c) => c.split('\n').every((l) => l === line))).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });

  it('falls back to spaces, then to hard cuts that never break an emoji', () => {
    const words = Array.from({ length: 800 }, () => 'word').join(' ');
    const byWords = splitForChat(words, 3500);
    expect(byWords).toHaveLength(2);
    expect(byWords.join(' ')).toBe(words);
    const emoji = '😀'.repeat(2000);
    const byEmoji = splitForChat(emoji, 3500);
    expect(byEmoji.map((c) => c.length)).toEqual([3500, 500]);
    expect(byEmoji.some((c) => LONE_SURROGATE.test(c))).toBe(false);
    expect(byEmoji.join('')).toBe(emoji);
  });
});

describe('labels', () => {
  it('builds "{host} · {displayName}" and falls back to the question label', () => {
    expect(questionLabel(question(), session())).toBe('cedar · meadow-hr');
    expect(questionLabel(question(), undefined)).toBe('cedar · meadow-hr');
    expect(questionLabel(question({ sessionLabel: 'birch · orchard' }), undefined)).toBe('birch · orchard');
  });
});

describe('notification templates', () => {
  it('formats a single question with numbered options', () => {
    const text = formatQuestion('cedar · meadow-hr', 'ABCDEFGH', [
      { question: 'Which DB?', options: [{ label: 'Postgres', description: 'robust' }, { label: 'SQLite' }] },
    ]);
    expect(text).toBe(['🔴 *Needs your answer* · cedar · meadow-hr  #ABCDEFGH', 'Which DB?', '1) Postgres — robust', '2) SQLite', HINT].join('\n'));
  });

  it('numbers questions and adds the one-line-per-question hint for 2+ questions', () => {
    const text = formatQuestion('cedar · meadow-hr', 'ABCDEFGH', [
      { question: 'Which DB?', options: [{ label: 'Postgres' }] },
      { question: 'Which ORM?', options: [{ label: 'Drizzle' }] },
    ]);
    expect(text).toBe([
      '🔴 *Needs your answer* · cedar · meadow-hr  #ABCDEFGH', '1. Which DB?', '1) Postgres', '2. Which ORM?', '1) Drizzle', HINT,
      '(2+ questions: one line per question, in order.)',
    ].join('\n'));
  });

  it('formats a permission request with a fenced preview of at most 600 characters; a command cut to fit offers no yes', () => {
    const text = formatPermission('birch · orchard', 'QRSTUVWX', 'Bash', 'x'.repeat(700));
    expect(text).toBe([
      '🔴 *Needs your OK* · birch · orchard  #QRSTUVWX', 'Wants to use *Bash*:', `${FENCE}${'x'.repeat(599)}…${FENCE}`,
      '_This request is too long to show here in full. Answer it on the website or in the terminal, where you can see all of it._',
      '↩️ Reply *no* to deny (anything else = deny with your message).',
    ].join('\n'));
    expect(formatPermission('birch · orchard', 'QRSTUVWX', 'Bash', 'x'.repeat(600))).toContain('Reply *yes* to allow');
    const pending = question({ kind: 'permission', questions: [], permission: { toolName: 'Bash', inputPreview: 'ls' } });
    expect(formatPending('cedar · meadow-hr', pending)).toContain('Wants to use *Bash*:');
    expect(formatPending('cedar · meadow-hr', question())).toContain('1) Postgres');
  });

  it('formats finished, error and ended notices with their excerpt limits', () => {
    expect(formatFinished('cedar · meadow-hr', 840, 'Done.')).toBe(
      '✅ *cedar · meadow-hr* finished (14m)\n\nDone.\n\n↩️ Reply to this message to continue this session.',
    );
    expect(formatFinished('cedar · meadow-hr', 840, 'y'.repeat(800))).toContain('y'.repeat(800));
    expect(formatFinished('cedar · meadow-hr', 840, 'y'.repeat(9000))).toContain(`${'y'.repeat(7999)}…`);
    expect(formatFinished('cedar · meadow-hr', 840, '  ')).toBe(
      '✅ *cedar · meadow-hr* finished (14m)\n\n↩️ Reply to this message to continue this session.',
    );
    expect(formatError('birch · orchard', 'z'.repeat(600))).toBe(`⚠️ *birch · orchard* error\n${'z'.repeat(499)}…`);
    expect(formatEnded('ash · harbor', 'pane gone')).toBe('💤 *ash · harbor* ended unexpectedly (pane gone).');
  });

  it('formats a confirmation request whose summary already carries the reason, the id on the first line', () => {
    expect(formatConfirmation("stop cedar · meadow-hr\nLuady's reason: it is stuck", 'A7')).toBe([
      '⚠️ Luady wants to: stop cedar · meadow-hr (#A7)',
      "Luady's reason: it is stuck",
      'Reply to this message with your PIN to approve, or *no* to cancel. Expires in 30 min.',
    ].join('\n'));
  });

  it('combines batched lines under one header', () => {
    expect(formatBatch(['✅ a', '⚠️ b'])).toBe('📦 *2 updates*\n✅ a\n⚠️ b');
  });
});

describe('acknowledgements and notices', () => {
  it('renders every notice exactly', () => {
    expect(answerDeliveredAck('cedar · meadow-hr')).toBe('✔ Answer delivered to cedar · meadow-hr');
    expect(sentAck('cedar · meadow-hr')).toBe('✔ Sent to cedar · meadow-hr');
    expect(approvedAck('A7', 'stopped')).toBe('✔ Approved #A7: stopped');
    expect(approvedAck('A7', null)).toBe('✔ Approved #A7');
    expect(approvedAck('A7', 'r'.repeat(600))).toBe(`✔ Approved #A7: ${'r'.repeat(499)}…`);
    expect(cancelledAck('A7')).toBe('✖ Cancelled #A7');
    expect(alreadyNotice('ABCDEFGH', 'answered')).toBe('ℹ️ #ABCDEFGH was already answered — your reply was not sent.');
    expect(waitingNotice('cedar · meadow-hr', 'ABCDEFGH')).toBe(
      'ℹ️ cedar · meadow-hr is waiting for an answer to #ABCDEFGH — reply to that question first.',
    );
    expect(wrongPinNotice(2)).toBe('⛔ Wrong PIN (2 tries left)');
    expect(pinLockedNotice('2026-10-09T15:42:00.000Z')).toBe('🔒 PIN locked until 7:42 PM');
    expect(failedPinNotice('web', 1)).toBe('⚠️ Failed PIN attempt via web (1 tries left)');
  });
});

describe('status and help', () => {
  it('summarises servers, live sessions, counts and Luady state', () => {
    const servers: ServerDTO[] = [
      { name: 'cedar', host: 'h', status: 'online', lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null },
      { name: 'birch', host: 'h', status: 'offline', lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null },
    ];
    const text = statusText({
      servers,
      sessions: [
        session({ state: 'working' }),
        session({ id: 'birch:cc-orchard:0.0', host: 'birch', displayName: 'orchard', pendingQid: 'ABCDEFGH', state: 'waiting_question' }),
        session({ id: 'ash:cc-old:0.0', host: 'ash', displayName: 'old', state: 'ended' }),
        session({ id: 'hq:manager:0.0', host: 'hq', displayName: 'manager', origin: 'system' }),
      ],
      pendingQuestions: 1, pendingActions: 0, luady: 'running', away: false,
    });
    expect(text).toBe([
      '📊 *Status*', 'Servers: cedar 🟢 · birch 🔴', '• cedar · meadow-hr — working', '• birch · orchard — waiting for #ABCDEFGH',
      'Questions: 1 · Confirmations: 0', 'Luady: running · Away: off',
    ].join('\n'));
  });

  it('says so when there are no servers or sessions', () => {
    const text = statusText({ servers: [], sessions: [], pendingQuestions: 0, pendingActions: 0, luady: 'down', away: true });
    expect(text).toContain('Servers: none');
    expect(text).toContain('No live sessions');
    expect(text).toContain('Luady: down · Away: on');
  });

  it('lists every command in /help', () => {
    const text = helpText();
    for (const cmd of ['/status', '/q', '/away', '/back', '/local <qid>', '/help', '/todo <text>']) {
      expect(text).toContain(cmd);
    }
  });
});
