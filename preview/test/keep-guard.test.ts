import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_MARKER, assertKeepFolder, realHubFolders } from '../guards.ts';

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'luady-keep-test-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('assertKeepFolder (npm run demo -- --keep <dir>)', () => {
  it('accepts a new folder, an empty one and one the preview made', () => {
    const home = tempDir();
    const root = tempDir();
    expect(() => assertKeepFolder(join(root, 'new'), {}, home)).not.toThrow();
    expect(() => assertKeepFolder(root, {}, home)).not.toThrow();
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'data', 'hub.db'), '');
    writeFileSync(join(root, PREVIEW_MARKER), '');
    expect(() => assertKeepFolder(root, {}, home)).not.toThrow();
  });

  it('refuses a folder that is not empty and was not made by the preview, whatever it holds', () => {
    const home = tempDir();
    for (const [sub, file] of [['data', 'hub.db'], ['brain', 'CLAUDE.md'], ['run', 'hub.sock'], ['.', 'notes.txt']] as const) {
      const root = tempDir();
      mkdirSync(join(root, sub), { recursive: true });
      writeFileSync(join(root, sub, file), '');
      expect(() => assertKeepFolder(root, {}, home), `${sub}/${file}`).toThrow(/preview-refused: .* is not empty and the preview did not make it/);
    }
    const file = join(tempDir(), 'a-file');
    writeFileSync(file, '');
    expect(() => assertKeepFolder(file, {}, home)).toThrow(/is not a folder/);
  });

  it('refuses the real data and config folders and anything inside them, also through a symlink', () => {
    const home = tempDir();
    const data = join(home, '.local', 'share', 'luady');
    mkdirSync(data, { recursive: true });
    for (const dir of [data, join(data, 'demo'), join(home, '.config', 'luady'), join(home, '.config', 'luady', 'x')]) {
      expect(() => assertKeepFolder(dir, {}, home), dir).toThrow(/preview-refused: .* inside the hub's own folder/);
    }
    const link = join(tempDir(), 'innocent');
    symlinkSync(data, link, 'junction');
    expect(() => assertKeepFolder(link, {}, home)).toThrow(/inside the hub's own folder/);
    expect(() => assertKeepFolder(join(home, '.local', 'share', 'luady-demo'), {}, home)).not.toThrow();
  });

  it('follows XDG_CONFIG_HOME and XDG_DATA_HOME like the hub', () => {
    const home = tempDir();
    const xdg = tempDir();
    const env = { XDG_DATA_HOME: join(xdg, 'data'), XDG_CONFIG_HOME: join(xdg, 'cfg') };
    expect(() => assertKeepFolder(join(xdg, 'data', 'luady'), env, home)).toThrow(/preview-refused/);
    expect(() => assertKeepFolder(join(xdg, 'cfg', 'luady', 'kept'), env, home)).toThrow(/preview-refused/);
    expect(realHubFolders({ XDG_DATA_HOME: 'relative' }, home)).not.toContain(join('relative', 'luady'));
  });
});
