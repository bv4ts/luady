import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOutbox } from '../../src/channels/outbox.js';
import { confineAddonFile, openAddonFile, sameFile } from '../../src/channels/paths.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

const base = mkdtempSync(join(tmpdir(), 'luady-paths-'));
const root = join(base, 'addons', 'test-channel', 'files');
mkdirSync(join(root, 'sub'), { recursive: true });
writeFileSync(join(root, 'photo.jpg'), 'jpg');
writeFileSync(join(root, 'sub', 'note.txt'), 'note');
writeFileSync(join(base, 'secrets.env'), 'SESSION_SECRET=x');

/** Symbolic links need extra rights on Windows; the cases with links run where they can be made. */
function linkOrSkip(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

describe('confineAddonFile: a file an add-on names must be inside its own files folder', () => {
  it('accepts a plain file inside, and answers its real path and size', async () => {
    await expect(confineAddonFile(root, join(root, 'photo.jpg'))).resolves.toMatchObject({ ok: true, size: 3 });
    await expect(confineAddonFile(root, join(root, 'sub', 'note.txt'))).resolves.toMatchObject({ ok: true });
  });

  it('refuses .. out of the folder, a relative path, a folder, a missing file and NUL', async () => {
    await expect(confineAddonFile(root, join(root, '..', '..', '..', 'secrets.env'))).resolves.toEqual({ ok: false, reason: 'outside' });
    await expect(confineAddonFile(root, 'photo.jpg')).resolves.toEqual({ ok: false, reason: 'not-absolute' });
    await expect(confineAddonFile(root, join(root, 'sub'))).resolves.toEqual({ ok: false, reason: 'not-a-file' });
    await expect(confineAddonFile(root, root)).resolves.toEqual({ ok: false, reason: 'outside' });
    await expect(confineAddonFile(root, join(root, 'gone.jpg'))).resolves.toEqual({ ok: false, reason: 'missing' });
    await expect(confineAddonFile(root, `${join(root, 'photo.jpg')}\0`)).resolves.toEqual({ ok: false, reason: 'not-absolute' });
  });

  it('refuses another add-on\'s folder next to it', async () => {
    const other = join(base, 'addons', 'test-channel-2', 'files');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'x.txt'), 'x');
    await expect(confineAddonFile(root, join(other, 'x.txt'))).resolves.toEqual({ ok: false, reason: 'outside' });
  });

  it('refuses a link that leads out, and accepts one that stays inside', async (context) => {
    const out = join(root, 'escape.env');
    if (!linkOrSkip(join(base, 'secrets.env'), out)) {
      context.skip();
      return;
    }
    await expect(confineAddonFile(root, out)).resolves.toEqual({ ok: false, reason: 'outside' });
    const inside = join(root, 'alias.jpg');
    linkOrSkip(join(root, 'photo.jpg'), inside);
    await expect(confineAddonFile(root, inside)).resolves.toMatchObject({ ok: true, path: expect.stringMatching(/photo\.jpg$/) });
  });

  it('opens first and compares the handle with what the checked path names (device and inode)', async () => {
    expect(sameFile({ dev: 1, ino: 5 }, { dev: 1, ino: 5 })).toBe(true);
    expect(sameFile({ dev: 1, ino: 5 }, { dev: 1, ino: 6 })).toBe(false);
    expect(sameFile({ dev: 1, ino: 5 }, { dev: 2, ino: 5 })).toBe(false);
    // A platform without inode numbers reports 0: only the device can be compared then.
    expect(sameFile({ dev: 1, ino: 0 }, { dev: 1, ino: 7 })).toBe(true);
    const opened = await openAddonFile(root, join(root, 'photo.jpg'));
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect((await opened.handle.stat()).size).toBe(3);
      await opened.handle.close();
    }
  });

  it('a later copy refuses a file that is no longer the one the check saw', async () => {
    const checked = await confineAddonFile(root, join(root, 'photo.jpg'));
    if (!checked.ok) throw new Error('not confined');
    const outbox = createOutbox({ config: { dataDir: join(base, 'data') }, clock: createFakeClock(), log: silentLogger() });
    await expect(outbox.put({ name: 'p.jpg', mime: 'image/jpeg', fromPath: checked.path, identity: checked.identity })).resolves.toMatchObject({ size: 3 });
    const other = { dev: checked.identity.dev + 1, ino: checked.identity.ino };
    await expect(outbox.put({ name: 'p.jpg', mime: 'image/jpeg', fromPath: checked.path, identity: other })).rejects.toThrow(/changed after it was checked/);
  });

  it('refuses a folder link that leads out', async (context) => {
    const dirLink = join(root, 'up');
    if (!linkOrSkip(base, dirLink)) {
      context.skip();
      return;
    }
    await expect(confineAddonFile(root, join(dirLink, 'secrets.env'))).resolves.toEqual({ ok: false, reason: 'outside' });
  });
});
