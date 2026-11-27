import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The import fence let the built-in chat channel, transcription, the video downloader and the old chat sign-in be
 * deleted. They are gone; this keeps them gone: none of their modules exists, and nothing imports one.
 */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const REMOVED = ['stt', 'media/downloader.ts'];
const FENCED = [/\/stt\//, /media\/downloader(?:\.js)?['"]/];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : name.endsWith('.ts') ? [path] : [];
  });
}

const importLines = (text: string): string[] => text.split('\n').filter((line) => /^\s*(?:import|export)\b.*\bfrom\s+['"]/.test(line));

describe('wire: the removed modules stay removed', () => {
  it('transcription and the video downloader are not in the hub, and nothing imports them', () => {
    for (const path of REMOVED) expect(existsSync(join(SRC, path)), path).toBe(false);
    const crossings: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const rel = relative(SRC, path).split(sep).join('/');
      for (const line of importLines(readFileSync(path, 'utf8'))) {
        if (FENCED.some((fenced) => fenced.test(line))) crossings.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(crossings).toEqual([]);
  });

  it('the fence would catch a planted import', () => {
    const planted = "import { createVideoDownloader } from '../media/downloader.js';";
    expect(importLines(planted).some((line) => FENCED.some((fenced) => fenced.test(line)))).toBe(true);
  });

  it('the channels folder holds only the add-on host and its parts', () => {
    const files = readdirSync(join(SRC, 'channels')).sort();
    expect(files).toEqual(['addon-tools.ts', 'addons-file.ts', 'budgets.ts', 'host.ts', 'link-store.ts', 'outbox.ts', 'owner-channel.ts', 'paths.ts', 'service.ts']);
  });

  it('app.ts is composition only: it imports wire modules and types, never a channel', () => {
    const app = readFileSync(join(SRC, 'app.ts'), 'utf8');
    expect(importLines(app).filter((line) => /channels\//.test(line))).toEqual([]);
  });
});
