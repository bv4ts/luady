import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The website bundles the Pixelify Sans font files (they land in the build's assets/ folder). Its licence (SIL OFL 1.1)
 * must travel with them, so public/assets/ holds an unchanged copy of licenses/PixelifySans-OFL.txt, which the build
 * puts beside the font files.
 */
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('the pixel font licence', () => {
  it('ships beside the font files, unchanged from the copy in licenses/', () => {
    const shipped = read('../../public/assets/PixelifySans-OFL.txt');
    expect(shipped).toBe(read('../../../../licenses/PixelifySans-OFL.txt'));
    expect(shipped).toContain('SIL OPEN FONT LICENSE');
  });
});
