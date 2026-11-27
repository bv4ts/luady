import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUTBOX_KEEP_MS, createOutbox, safeFileName, safeMime } from '../../src/channels/outbox.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

function setup() {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'luady-outbox-')), 'data');
  const clock = createFakeClock('2026-11-21T08:00:00.000Z');
  return { dataDir, clock, outbox: createOutbox({ config: { dataDir }, clock, log: silentLogger() }) };
}

describe('the outbox', () => {
  it('keeps a file under <dataDir>/outbox/<id> at 0600 with its record, and finds it by its notice', async () => {
    const { dataDir, outbox, clock } = setup();
    const file = await outbox.put({ name: 'report.pdf', mime: 'application/pdf', data: Buffer.from('%PDF') });
    expect(file).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', size: 4, noticeId: null });
    const path = outbox.pathOf(file.id);
    expect(path).toBe(join(dataDir, 'outbox', file.id));
    expect(readFileSync(path ?? '', 'utf8')).toBe('%PDF');
    if (process.platform !== 'win32') expect(statSync(path ?? '').mode & 0o777).toBe(0o600);
    outbox.attach(file.id, 'n-1');
    expect(outbox.byNotice('n-1')?.id).toBe(file.id);
    // A restart reads the records back.
    const again = createOutbox({ config: { dataDir }, clock, log: silentLogger() });
    expect(again.get(file.id)).toMatchObject({ name: 'report.pdf', noticeId: 'n-1' });
  });

  it('copies a file from disk, and refuses a link swapped in for it', async () => {
    const { outbox, dataDir } = setup();
    const source = join(dataDir, '..', 'made.png');
    writeFileSync(source, 'png-bytes');
    const file = await outbox.put({ name: 'made.png', mime: 'image/png', fromPath: source });
    expect(readFileSync(outbox.pathOf(file.id) ?? '', 'utf8')).toBe('png-bytes');
    const link = join(dataDir, '..', 'link.png');
    try {
      symlinkSync(source, link);
    } catch {
      return;
    }
    if (process.platform === 'win32') return;
    await expect(outbox.put({ name: 'link.png', mime: 'image/png', fromPath: link })).rejects.toThrow();
  });

  it('removes files older than 30 days, and bytes left without a record', async () => {
    const { outbox, clock, dataDir } = setup();
    const old = await outbox.put({ name: 'old.txt', mime: 'text/plain', data: Buffer.from('old') });
    clock.advance(OUTBOX_KEEP_MS - 1000);
    const fresh = await outbox.put({ name: 'fresh.txt', mime: 'text/plain', data: Buffer.from('new') });
    const stray = join(dataDir, 'outbox', '00000000-0000-4000-8000-000000000000');
    writeFileSync(stray, 'stray');
    clock.advance(2000);
    expect(outbox.sweep()).toBe(2);
    expect(outbox.get(old.id)).toBeNull();
    expect(existsSync(join(dataDir, 'outbox', old.id))).toBe(false);
    expect(existsSync(stray)).toBe(false);
    expect(outbox.get(fresh.id)?.name).toBe('fresh.txt');
  });

  it('answers nothing for an id that is not one of its own', () => {
    const { outbox } = setup();
    expect(outbox.get('../secrets.env')).toBeNull();
    expect(outbox.pathOf('../../hub.db')).toBeNull();
    expect(outbox.pathOf('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('cleans names and types for the download', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\x\\a"b\r\n.txt')).toBe('ab.txt');
    expect(safeFileName('..')).toBe('file');
    expect(safeMime('Image/PNG')).toBe('image/png');
    expect(safeMime('text/html; charset=utf-8')).toBe('application/octet-stream');
  });
});
