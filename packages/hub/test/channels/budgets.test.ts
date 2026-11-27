import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DELIVER_PER_MINUTE, INBOX_FILE_MAX_BYTES, OUTBOX_FILE_MAX_BYTES, OUTBOX_TOTAL_MAX_BYTES, OUTBOX_TOTAL_MAX_FILES,
} from '../../src/channels/budgets.js';
import { createOutbox } from '../../src/channels/outbox.js';
import { FileTooBigError, copyCapped } from '../../src/channels/paths.js';
import { handleDeliver } from '../../src/channels/service.js';
import { importMedia } from '../../src/inbound/media.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { CHAT, TOOLS, flush, rig } from './helpers.js';

/** An add-on can fill neither the disk nor the notice list. */
const MIB = 1024 * 1024;

describe('the named limits', () => {
  it('keep a single file well below 2 GB, and the outbox and inbox bounded', () => {
    expect(OUTBOX_FILE_MAX_BYTES).toBeLessThanOrEqual(256 * MIB);
    expect(OUTBOX_TOTAL_MAX_BYTES).toBeGreaterThan(OUTBOX_FILE_MAX_BYTES);
    expect(OUTBOX_TOTAL_MAX_FILES).toBeGreaterThan(0);
    expect(INBOX_FILE_MAX_BYTES).toBeLessThanOrEqual(OUTBOX_FILE_MAX_BYTES);
  });
});

describe('the outbox quota: refused, never deleting the oldest', () => {
  function outbox(limits: { fileBytes: number; totalBytes: number; totalFiles: number }) {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'luady-quota-')), 'data');
    return { dataDir, outbox: createOutbox({ config: { dataDir }, clock: createFakeClock(), log: silentLogger(), limits }) };
  }

  it('refuses a file over the per-file cap, inline or from disk, and leaves nothing behind', async () => {
    const { dataDir, outbox: box } = outbox({ fileBytes: 10, totalBytes: 1000, totalFiles: 10 });
    await expect(box.put({ name: 'a.bin', mime: 'application/octet-stream', data: Buffer.alloc(11) })).rejects.toThrow(/too big for the website/);
    const big = join(dataDir, '..', 'big.bin');
    writeFileSync(big, Buffer.alloc(20));
    await expect(box.put({ name: 'big.bin', mime: 'application/octet-stream', fromPath: big })).rejects.toThrow(/too big for the website/);
    expect(existsSync(join(dataDir, 'outbox')) ? readdirSync(join(dataDir, 'outbox')) : []).toEqual([]);
  });

  it('refuses past the file count and the total bytes; what is already kept stays', async () => {
    const { outbox: box } = outbox({ fileBytes: 100, totalBytes: 150, totalFiles: 2 });
    const first = await box.put({ name: 'one.txt', mime: 'text/plain', data: Buffer.alloc(100) });
    await expect(box.put({ name: 'two.txt', mime: 'text/plain', data: Buffer.alloc(60) })).rejects.toThrow(/file store is full/);
    await box.put({ name: 'two.txt', mime: 'text/plain', data: Buffer.alloc(40) });
    await expect(box.put({ name: 'three.txt', mime: 'text/plain', data: Buffer.alloc(1) })).rejects.toThrow(/already keeps 2 files/);
    expect(box.get(first.id)?.name).toBe('one.txt');
  });

  it('two copies at once cannot both pass the quota', async () => {
    const { outbox: box } = outbox({ fileBytes: 100, totalBytes: 150, totalFiles: 10 });
    const results = await Promise.allSettled([
      box.put({ name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(100) }),
      box.put({ name: 'b.txt', mime: 'text/plain', data: Buffer.alloc(100) }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('copyCapped and the inbox cap', () => {
  it('stops a copy that passes the cap and removes the partial file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luady-cap-'));
    writeFileSync(join(dir, 'src.bin'), Buffer.alloc(64 * 1024));
    await expect(copyCapped(await open(join(dir, 'src.bin'), 'r'), join(dir, 'out.bin'), 1024, 0o600)).rejects.toBeInstanceOf(FileTooBigError);
    expect(existsSync(join(dir, 'out.bin'))).toBe(false);
    await expect(copyCapped(await open(join(dir, 'src.bin'), 'r'), join(dir, 'ok.bin'), 64 * 1024, 0o600)).resolves.toBe(64 * 1024);
  });

  it('an owner file bigger than the inbox cap is refused with a plain reason, and not copied', async () => {
    const base = mkdtempSync(join(tmpdir(), 'luady-inbox-cap-'));
    const root = join(base, 'files');
    mkdirSync(root);
    writeFileSync(join(root, 'huge.mov'), Buffer.alloc(4096));
    const media = { kind: 'video' as const, path: join(root, 'huge.mov'), mime: 'video/quicktime', fileName: 'huge.mov', size: 4096, error: null };
    const kept = await importMedia(media, { root, inboxDir: join(base, 'inbox'), msgId: 'm1', nowMs: 0, maxBytes: 1024 });
    expect(kept).toMatchObject({ path: null, error: 'the file was refused (the file is bigger than 0 MB)' });
    expect(existsSync(join(base, 'inbox')) ? readdirSync(join(base, 'inbox')) : []).toEqual([]);
  });
});

describe('deliver: one at a time, a few a minute, refusals told to the add-on', () => {
  function deliverRig() {
    const r = rig([CHAT, TOOLS]);
    const clock = createFakeClock('2026-11-21T08:00:00.000Z');
    const sent: string[] = [];
    let release: (() => void) | null = null;
    const deliver = handleDeliver({
      host: r.host, addons: r.addons, owner: r.owner, clock, log: silentLogger(),
      text: {
        isUp: () => false,
        send: async (text) => {
          sent.push(text);
          await new Promise<void>((resolve) => { release = resolve; });
          return null;
        },
      },
    });
    const socket = r.connect('helper-tools');
    return { r, clock, sent, deliver, socket, release: () => release?.() };
  }

  it('a second deliver while the first runs is refused; the next one after it is taken', async () => {
    const t = deliverRig();
    const first = t.deliver('helper-tools', { t: 'deliver', ref: 'd1', text: 'one' });
    await t.deliver('helper-tools', { t: 'deliver', ref: 'd2', text: 'two' });
    expect(t.socket.of('delivered')).toEqual([{ t: 'delivered', ref: 'd2', ok: false, error: 'one delivery at a time: wait for "delivered" before the next' }]);
    t.release();
    await first;
    expect(t.socket.of('delivered').at(-1)).toEqual({ t: 'delivered', ref: 'd1', ok: true, error: null });
    expect(t.sent).toHaveLength(1);
  });

  it(`at most ${DELIVER_PER_MINUTE} a minute per add-on`, async () => {
    const t = deliverRig();
    for (let i = 0; i < DELIVER_PER_MINUTE + 1; i += 1) {
      const running = t.deliver('helper-tools', { t: 'deliver', ref: `d${i}`, text: `n${i}` });
      await flush();
      t.release();
      await running;
    }
    expect(t.socket.of('delivered').at(-1)).toMatchObject({ ok: false, error: `at most ${DELIVER_PER_MINUTE} deliveries a minute; try again shortly` });
    t.clock.advance(61_000);
    const again = t.deliver('helper-tools', { t: 'deliver', ref: 'later', text: 'later' });
    await flush();
    t.release();
    await again;
    expect(t.socket.of('delivered').at(-1)).toMatchObject({ ref: 'later', ok: true });
  });

  it('a full outbox is told to the add-on plainly', async () => {
    const r = rig([CHAT, TOOLS]);
    const socket = r.connect('helper-tools');
    const filesDir = r.addons.filesDir('helper-tools');
    writeFileSync(join(filesDir, 'too-big.bin'), Buffer.alloc(16));
    const full = { ...r.owner, sendFile: async () => { throw new (await import('../../src/core/errors.js')).RefusedError("The website's file store is full (2048 MB); it takes more once older files expire."); } };
    const deliver = handleDeliver({ host: r.host, addons: r.addons, owner: full as never, text: r.owner, clock: createFakeClock(), log: silentLogger() });
    await deliver('helper-tools', {
      t: 'deliver', ref: 'f1', file: { kind: 'document', path: join(filesDir, 'too-big.bin'), mime: 'application/octet-stream', fileName: 'x.bin', caption: '' },
    });
    expect(socket.of('delivered')).toEqual([{ t: 'delivered', ref: 'f1', ok: false, error: "The website's file store is full (2048 MB); it takes more once older files expire." }]);
  });
});

describe('what an add-on delivers says which add-on it came from', () => {
  it('text and file captions start with the add-on name; a tools add-on never reads as the hub', async () => {
    const r = rig([CHAT, TOOLS]);
    const socket = r.connect('helper-tools');
    const texts: string[] = [];
    const captions: string[] = [];
    const owner = { ...r.owner, sendFile: async (file: { caption: string }) => { captions.push(file.caption); return { via: 'chat' as const, msgId: 'x' }; } };
    const deliver = handleDeliver({
      host: r.host, addons: r.addons, owner: owner as never, clock: createFakeClock(), log: silentLogger(),
      text: { isUp: () => true, send: async (text) => { texts.push(text); return null; } },
    });
    await deliver('helper-tools', { t: 'deliver', ref: 'a', text: '⚠️ Luady: the server is down' });
    writeFileSync(join(r.addons.filesDir('helper-tools'), 'f.txt'), 'x');
    await deliver('helper-tools', {
      t: 'deliver', ref: 'b', file: { kind: 'document', path: join(r.addons.filesDir('helper-tools'), 'f.txt'), mime: 'text/plain', fileName: 'f.txt', caption: '' },
    });
    expect(texts).toEqual(['🧩 Helper tools: ⚠️ Luady: the server is down']);
    expect(captions).toEqual(['🧩 Helper tools']);
    expect(socket.of('delivered').map((d) => d.ok)).toEqual([true, true]);
  });
});
