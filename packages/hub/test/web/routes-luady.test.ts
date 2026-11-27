import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { LuadyMessageSentDTOSchema } from '@luady/shared';
import { ValidationError } from '../../src/core/errors.js';
import { isInside, resolveMemoryPath } from '../../src/web/memory-files.js';
import { looksLikePin, normalizeDigits, PIN_LIKE_MESSAGE } from '../../src/web/pin-guard.js';
import { call, harnessFactory, LUADY_STATUS, sampleChat, type Harness } from './helpers.js';

const harness = harnessFactory();
const USER_MD = '# Owner\nAlex runs cedar, birch and ash.\n';
const JOURNAL_MD = 'Shipped the web API.\n';
/** U+0661–U+0666 (Arabic-Indic) and U+06F1–U+06F8 (Extended Arabic-Indic), written as escapes for clarity. */
const ARABIC_123456 = '\u0661\u0662\u0663\u0664\u0665\u0666';
const PERSIAN_12345678 = '\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8';

/** memory/{USER.md, journal/2026-10-09.md, notes.txt}, plus memory/escape → a sibling dir that holds secret.md. */
function seedMemory(h: Harness): void {
  const memory = join(h.dirs.brainDir, 'memory');
  mkdirSync(join(memory, 'journal'), { recursive: true });
  writeFileSync(join(memory, 'USER.md'), USER_MD);
  writeFileSync(join(memory, 'journal', '2026-10-09.md'), JOURNAL_MD);
  writeFileSync(join(memory, 'notes.txt'), 'not markdown');
  writeFileSync(join(h.dirs.brainDir, 'CLAUDE.md'), 'brain instructions');
  const outside = join(h.dirs.root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.md'), 'TOP SECRET');
  // 'junction' needs no admin rights on Windows; Linux ignores the type and creates a directory symlink.
  symlinkSync(outside, join(memory, 'escape'), 'junction');
}

function memoryFile(h: Harness, name: string) {
  return call(h, 'GET', `/api/manager/memory/file?name=${name}`, undefined, { session: h.login() });
}

describe('Luady chat and status', () => {
  it('pages messages with cursor and limit', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/manager/messages?cursor=c1&limit=10', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [sampleChat()], nextCursor: null });
    expect(h.deps.luady.messages).toHaveBeenCalledWith('c1', 10);
  });

  it('posts an owner message through the web channel', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/manager/messages', { text: 'مرحبا Luady, status?' }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(h.deps.luady.postOwnerMessage).toHaveBeenCalledWith('مرحبا Luady, status?', 'web');
  });

  it('while Luady is signed out the answer says the message is held', async () => {
    const h = await harness();
    h.deps.luady.signedOut = () => true;
    const res = await call(h, 'POST', '/api/manager/messages', { text: 'are you there?' }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(LuadyMessageSentDTOSchema.parse(res.json())).toEqual({ ok: true, held: true });
    expect(h.deps.luady.postOwnerMessage).toHaveBeenCalledWith('are you there?', 'web');
  });

  it("tells the notices which kind of tab wrote: one whose session said hello, or an old one", async () => {
    const h = await harness();
    const session = h.login();
    vi.mocked(h.deps.presence.sessionSaidHello).mockImplementation((sid: string) => sid === session.sid);
    await call(h, 'POST', '/api/manager/messages', { text: 'from the new website' }, { session });
    await call(h, 'POST', '/api/manager/messages', { text: 'from an old tab' }, { session: h.login() });
    expect(vi.mocked(h.deps.notices.webMessage).mock.calls).toEqual([[true], [false]]);
  });

  it('a failing notice update never stops the message of the owner', async () => {
    const h = await harness();
    vi.mocked(h.deps.notices.webMessage).mockImplementation(() => {
      throw new Error('database is locked');
    });
    const res = await call(h, 'POST', '/api/manager/messages', { text: 'still delivered' }, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.luady.postOwnerMessage).toHaveBeenCalledWith('still delivered', 'web');
  });

  it('puts what the message is about in front of the text Luady receives', async () => {
    const h = await harness();
    const session = h.login();
    const card = await call(h, 'POST', '/api/manager/messages', { text: 'Ask about this', about: { kind: 'todo', id: '12' } }, { session });
    expect(card.statusCode).toBe(200);
    expect(h.deps.luady.postOwnerMessage).toHaveBeenCalledWith('Ask about this', 'web', expect.objectContaining({
      kind: 'todo', id: '12', label: '#12 Fix the checkout total', block: expect.stringMatching(/^\(About the board card #12/),
    }));
    await call(h, 'POST', '/api/manager/messages', { text: 'Read it', about: { kind: 'note', id: 'n:4' } }, { session });
    expect(h.deps.luady.postOwnerMessage).toHaveBeenLastCalledWith('Read it', 'web', expect.objectContaining({ kind: 'note', label: 'Stand-up' }));
    const ticket = await call(h, 'POST', '/api/manager/messages', { text: 'Start this one', about: { kind: 'jira', id: 'birch:ORC-123' } }, { session });
    expect(ticket.statusCode).toBe(200);
    expect(h.deps.luady.postOwnerMessage).toHaveBeenLastCalledWith('Start this one', 'web', expect.objectContaining({ kind: 'jira', id: 'birch:ORC-123' }));
  });

  it('a note that is gone answers 404 and a bad reference 400; nothing reaches Luady', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', '/api/manager/messages', { text: 'x', about: { kind: 'note', id: 'n:5' } }, { session })).statusCode).toBe(404);
    expect((await call(h, 'POST', '/api/manager/messages', { text: 'x', about: { kind: 'todo', id: 'abc' } }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/manager/messages', { text: 'x', about: { kind: 'jira', id: 'ORC-1' } }, { session })).statusCode).toBe(400);
    expect(h.deps.luady.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('rejects an unknown about kind and unknown keys with 400', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', '/api/manager/messages', { text: 'x', about: { kind: 'email', id: '1' } }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/manager/messages', { text: 'x', html: '<b>' }, { session })).statusCode).toBe(400);
    expect(h.deps.luady.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('rejects an empty message with 400', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/manager/messages', { text: '' }, { session: h.login() });
    expect(res.statusCode).toBe(400);
    expect(h.deps.luady.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('refuses a PIN-like message in ASCII digits with 400 and never forwards it', async () => {
    const h = await harness();
    const session = h.login();
    for (const text of ['123456', '  987654321012\n']) {
      const res = await call(h, 'POST', '/api/manager/messages', { text }, { session });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: { code: 'validation', message: PIN_LIKE_MESSAGE } });
    }
    expect(h.deps.luady.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('refuses a PIN-like message written with Arabic-Indic or Extended Arabic-Indic digits', async () => {
    const h = await harness();
    const session = h.login();
    // The third text mixes both ranges with one ASCII digit: ٤٥٦7۸۹ → 456789.
    for (const text of [ARABIC_123456, PERSIAN_12345678, ' \u0664\u0665\u06667\u06F8\u06F9 ']) {
      const res = await call(h, 'POST', '/api/manager/messages', { text }, { session });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: { code: 'validation', message: PIN_LIKE_MESSAGE } });
    }
    expect(h.deps.luady.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('forwards messages that are not PIN-shaped', async () => {
    const h = await harness();
    const session = h.login();
    const texts = ['12345', '1234567890123', 'deploy build 123456 to birch', `PIN ${ARABIC_123456}`];
    for (const text of texts) {
      expect((await call(h, 'POST', '/api/manager/messages', { text }, { session })).statusCode).toBe(200);
    }
    expect(h.deps.luady.postOwnerMessage).toHaveBeenCalledTimes(texts.length);
    expect(h.deps.luady.postOwnerMessage).toHaveBeenLastCalledWith(`PIN ${ARABIC_123456}`, 'web');
  });

  it('normalizeDigits maps both Arabic digit ranges to ASCII', () => {
    expect(normalizeDigits('\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669')).toBe('0123456789');
    expect(normalizeDigits('\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9')).toBe('0123456789');
    expect(normalizeDigits(`PIN ${ARABIC_123456}`)).toBe('PIN 123456');
    expect(looksLikePin(` ${ARABIC_123456} `)).toBe(true);
    expect(looksLikePin('12345')).toBe(false);
  });

  it('returns the Luady status', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/manager/status', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(LUADY_STATUS);
  });
});

describe('memory browser', () => {
  it('lists *.md files recursively with relative names, skipping links and other files', async () => {
    const h = await harness();
    seedMemory(h);
    const res = await call(h, 'GET', '/api/manager/memory', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      files: [
        { name: 'USER.md', size: Buffer.byteLength(USER_MD) },
        { name: 'journal/2026-10-09.md', size: Buffer.byteLength(JOURNAL_MD) },
      ],
    });
  });

  it('returns an empty list when the memory dir does not exist', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/manager/memory', undefined, { session: h.login() });
    expect(res.json()).toEqual({ files: [] });
  });

  it('reads a memory file by relative name', async () => {
    const h = await harness();
    seedMemory(h);
    expect((await memoryFile(h, 'USER.md')).json()).toEqual({ name: 'USER.md', content: USER_MD });
    expect((await memoryFile(h, 'journal/2026-10-09.md')).json()).toEqual({
      name: 'journal/2026-10-09.md',
      content: JOURNAL_MD,
    });
  });

  it('rejects traversal names with 400', async () => {
    const h = await harness();
    seedMemory(h);
    for (const name of ['../CLAUDE.md', '..%2FCLAUDE.md', 'journal/../../CLAUDE.md', '/etc/passwd.md']) {
      const res = await memoryFile(h, name);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'validation' } });
      expect(res.body).not.toContain('brain instructions');
    }
  });

  it('rejects a junction or symlink that escapes the memory dir', async () => {
    const h = await harness();
    seedMemory(h);
    const res = await memoryFile(h, 'escape/secret.md');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation' } });
    expect(res.body).not.toContain('TOP SECRET');
  });

  it('returns 404 for a missing file and 400 for a non-markdown name', async () => {
    const h = await harness();
    seedMemory(h);
    expect((await memoryFile(h, 'nope.md')).statusCode).toBe(404);
    expect((await memoryFile(h, 'notes.txt')).statusCode).toBe(400);
  });

  it('isInside is a path-prefix check, not a substring check', () => {
    const root = resolve('brain-root', 'memory');
    expect(isInside(root, resolve(root, 'USER.md'))).toBe(true);
    expect(isInside(root, resolve('brain-root', 'memory-evil', 'x.md'))).toBe(false);
    expect(isInside(root, root)).toBe(false);
    expect(() => resolveMemoryPath(root, '../memory-evil/x.md')).toThrow(ValidationError);
  });
});
